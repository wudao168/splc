const { _electron: electron, expect } = require('playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { extractOrder } = require('../desktop/extract-order.cjs');

(async () => {
  const root = path.resolve(__dirname,'..');
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(),'caidan-desktop-test-'));
  const evidence = process.env.CAIDAN_QA_DIR || dataDir;
  await fs.mkdir(evidence,{recursive:true});
  const env = {...process.env,CAIDAN_DATA:dataDir,CAIDAN_PROFILE:path.join(dataDir,'profile')};
  delete env.ELECTRON_RUN_AS_NODE;
  const packaged = process.env.CAIDAN_TEST_EXE;
  const client = await electron.launch({executablePath:packaged || path.join(root,'node_modules/electron/dist/electron.exe'),args:packaged ? [] : [root],env,timeout:60000});
  try {
    const shell = await client.firstWindow();
    await shell.waitForFunction(() => document.querySelector('#status').textContent.includes('采购信息'),null,{timeout:60000});
    let business;
    for(let i=0;i<100;i++) { business = client.context().pages().find(p=>p.url().startsWith('http://127.0.0.1:')); if(business) break; await new Promise(r=>setTimeout(r,100)); }
    assert.ok(business,'business WebContentsView should be present');
    const errors=[];
    business.on('pageerror',e=>errors.push(e.message));
    await business.getByRole('heading',{name:/登录|创建首个账号/}).waitFor();
    const setup = await business.getByLabel('姓名',{exact:true}).count();
    if (setup) await business.getByLabel('姓名',{exact:true}).fill('管理员');
    await business.getByLabel('账号',{exact:true}).fill('admin');
    await business.getByLabel('密码',{exact:true}).fill('11111111');
    await business.getByRole('button',{name: setup ? '创建并进入' : '登录',exact:true}).click();
    await business.getByRole('button',{name:'平台采购',exact:true}).waitFor();
    const post = async (url,payload) => {
      const result = await business.evaluate(async ({url,payload}) => {
        const response = await fetch('/api'+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
        return {status:response.status,body:await response.json()};
      },{url,payload});
      assert.equal(result.status,200,JSON.stringify(result.body));
      return result.body;
    };
    const state = () => business.evaluate(async () => (await fetch('/api/state')).json());
    const order=await post('/orders',{customer:'客户端测试客户',po:'CLIENT-QA',address:'测试地址',lines:[{name:'测试螺栓',quantity:3,price:'10'}]});
    await post(`/orders/${order.id}/confirm`,{});
    await business.reload();
    await business.getByRole('button',{name:'平台采购',exact:true}).waitFor();
    // Serve synthetic markup at the real order URL; no production account or database is touched.
    const fixture = await fs.readFile(path.join(__dirname,'fixtures','taobao-order.html'),'utf8');
    const tmallFixture = await fs.readFile(path.join(__dirname,'fixtures','tmall-order.html'),'utf8');
    await client.evaluate(({session}, pages) => session.fromPartition('persist:taobao').protocol.handle('https', request => new Response(request.url.startsWith('https://trade.tmall.com/') ? pages.tmall : pages.taobao, {headers:{'Content-Type':'text/html; charset=utf-8'}})), {taobao:fixture,tmall:tmallFixture});
    await shell.locator('#address').fill('https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=1234567890123456789');
    await shell.locator('#address').press('Enter');
    let taobao;
    for(let i=0;i<100;i++) { taobao=client.context().pages().find(p=>p.url().startsWith('https://trade.taobao.com/'));if(taobao)break;await new Promise(r=>setTimeout(r,100)); }
    if (!taobao) console.log(JSON.stringify({status:await shell.locator('#status').innerText(),pages:client.context().pages().map(p=>p.url()),contents:await client.evaluate(({webContents})=>webContents.getAllWebContents().map(w=>({id:w.id,url:w.getURL(),type:w.getType()})))}));
    assert.ok(taobao,'Taobao WebContentsView should be present');
    await taobao.locator('.shopInfoName--fixture').waitFor();
    const extracted = await taobao.evaluate(extractOrder);
    assert.equal(extracted.amount,'30.00');
    assert.equal(extracted.products.length,1);
    assert.equal(extracted.products[0].quantity,'3');
    assert.equal(extracted.products[0].amount,'30.00');
    assert.equal(extracted.products[0].spec,'M8;镀锌');
    assert.equal(extracted.packages.length,2);
    assert.equal(extracted.packages[0].status,'运输中');
    assert.equal(extracted.packages[0].events[0].description,'快件已揽收');
    assert.ok(!JSON.stringify(extracted).includes('不应读取'));
    await shell.locator('#extract').click();
    await business.getByLabel('供应商 *',{exact:true}).waitFor();
    assert.equal(await business.getByLabel('供应商 *',{exact:true}).inputValue(),'测试店铺');
    assert.equal(await business.getByLabel('订单号 *',{exact:true}).inputValue(),'1234567890123456789');
    await business.getByRole('button',{name:/选择客户订单中的待采购料品/}).click();
    await business.getByRole('dialog',{name:'选择客户订单料品'}).getByRole('checkbox',{name:/选择料品：CLIENT-QA · 测试螺栓/}).check();
    await business.getByRole('dialog',{name:'选择客户订单料品'}).getByRole('button',{name:/确认选择/}).click();
    assert.equal(await business.getByLabel('测试螺栓分摊金额',{exact:true}).inputValue(),'30.00');
    await business.getByRole('heading',{name:'淘宝提取信息 · 请核对'}).scrollIntoViewIfNeeded();
    await business.screenshot({path:path.join(evidence,'desktop-import.png')});
    await business.getByRole('button',{name:'保存采购记录',exact:true}).click();
    await business.waitForTimeout(1200);
    // 采购已保存：核对桌面提取的金额、商品、包裹与交易状态均已落库
    await business.waitForTimeout(800);
    const snapshot = await state();
    assert.equal(snapshot.purchases.length,1);
    assert.equal(snapshot.purchase_lines[0].cost_cents,3000);
    assert.equal(snapshot.purchases[0].taobao_source.products[0].amount,'30.00');
    assert.equal(snapshot.purchases[0].taobao_source.packages.length,2);
    assert.equal(snapshot.purchases[0].taobao_source.transaction_status,'卖家已发货');
    assert.deepEqual(errors,[]);
    // Remote content receives no privileged bridge. Local renderer IPC rejects subframes.
    assert.equal(await taobao.evaluate(()=>typeof window.caidanDesktop),'undefined');
    await shell.locator('#address').fill('http://127.0.0.1:1/');
    await shell.locator('#address').press('Enter');
    await shell.waitForFunction(()=>document.querySelector('#status').className === 'error');
    assert.match(await shell.locator('#status').innerText(),/HTTPS/);
    await business.reload();
    await business.getByRole('button',{name:'平台采购',exact:true}).waitFor();
    assert.ok((await business.locator('body').innerText()).includes('测试店铺'));
    // Missing shipment/amount must produce warnings rather than substitute the list price.
    await taobao.evaluate(() => {
      document.querySelectorAll('[class*="logisticsPackageHeader--"]').forEach(e=>e.remove());
      [...document.querySelectorAll('[class*="detailInfoContent--"]')].find(e=>e.innerText.includes('实付款')).remove();
    });
    const incomplete = await taobao.evaluate(extractOrder);
    assert.equal(incomplete.amount,'');
    assert.deepEqual(incomplete.packages,[]);
    assert.ok(incomplete.warnings.some(w=>w.includes('实付款')));
    assert.ok(incomplete.warnings.some(w=>w.includes('运单号')));
    await shell.locator('#address').fill('https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=1234567890123456789');
    await shell.locator('#address').press('Enter');
    await taobao.waitForURL('https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=1234567890123456789');
    const tmallOrder = await taobao.evaluate(extractOrder);
    assert.equal(tmallOrder.platform_order,'1234567890123456789');
    assert.equal(tmallOrder.amount,'12.92');
    assert.equal(tmallOrder.shop,'测试文具旗舰店');
    assert.equal(tmallOrder.purchased_date,'2026-09-25');
    assert.deepEqual(tmallOrder.packages,[{carrier:'中通快递',tracking:'TEST12345678'}]);
    await shell.locator('#extract').click();
    const reimported = business.getByRole('dialog',{name:'淘宝 · 1234567890123456789'});
    await reimported.waitFor();
    assert.ok((await reimported.innerText()).includes('该订单已登记'),'重复提取应提示已登记而不是再次登记');
    console.log(JSON.stringify({passed:true,packaged:!!packaged,evidence,checks:['launch','isolated extraction','product filtering','purchase autofill','source persistence','remote bridge isolation','navigation restrictions','reload','tmall extraction'],consoleErrors:errors}));
  } finally { await client.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
