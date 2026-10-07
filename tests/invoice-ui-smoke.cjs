const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-invoice-ui-'));
  const python = process.env.CAIDAN_PYTHON || path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
  const server = spawn(python, ['-u', '-m', 'server.app', '--port', '0'], {
    cwd:root, env:{...process.env, CAIDAN_DATA:path.join(temp, 'data'), CAIDAN_INTERNAL_TOKEN:'invoice-ui-test'}, windowsHide:true
  });
  let browser;
  try {
    const origin = await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('服务启动超时')), 30000);
      server.on('error', reject);
      server.on('exit', code => reject(new Error(`服务退出：${code}`)));
      server.stdout.on('data', chunk => {
        output += chunk.toString();
        const match = output.match(/Caidan running at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
    });
    browser = await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless:true});
    const page = await browser.newPage({viewport:{width:1916, height:1080}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(origin + '/#purchases');
    await page.getByLabel('账号', {exact:true}).fill('admin');
    await page.getByLabel('密码', {exact:true}).fill('11111111');
    await page.getByRole('button', {name:'登录', exact:true}).click();
    await page.getByRole('button', {name:'采购记录', exact:true}).waitFor();
    const post = (route, body) => page.evaluate(async ({route,body}) => {
      const response = await fetch('/api' + route, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }, {route,body});
    const order = await post('/orders', {customer:'测试客户', po:'INVOICE-UI', address:'测试地址', lines:[{name:'测试料品', quantity:10}]});
    await post(`/orders/${order.id}/confirm`, {});
    const line = await page.evaluate(async () => (await (await fetch('/api/state')).json()).order_lines[0]);
    const platformOrder = '3316438922003035380', number = '26337000000000000001';
    const purchase = await post('/purchases', {platform:'淘宝', shop:'测试店铺', platform_order:platformOrder, amount:'26.50', lines:[{order_line_id:line.id, quantity:1, cost:'26.50'}]});
    await page.goto(origin + '/#purchases');
    await page.reload();
    const listSync = page.getByRole('button', {name:'获取所选发票'});
    await page.getByLabel(`选择采购订单：${platformOrder}`).waitFor();
    const list = page.locator('.purchases-list');
    const row = list.locator('tbody tr').first();
    await row.locator('.purchase-invoice-status').getByText('待查询', {exact:true}).waitFor();
    assert.deepEqual((await list.locator('th').allTextContents()).slice(7, 10), ['开票状态', '发票文件', '收票情况']);
    assert.equal(await row.locator('.purchase-invoice-files').innerText(), '未获取');
    await page.evaluate(() => { window.caidanDesktop = {syncInvoices: async ids => { window.__syncedPurchaseIds = ids; return {checked:ids.length, matched:0, downloaded:0}; }}; });
    assert.equal(await listSync.isDisabled(), true);
    await page.getByLabel(`选择采购订单：${platformOrder}`).check();
    await listSync.click();
    await page.getByText('所选订单匹配 0/1 笔').waitFor();
    assert.deepEqual(await page.evaluate(() => window.__syncedPurchaseIds), [purchase.id]);
    await page.evaluate(() => { window.caidanDesktop.syncInvoices = async ids => ({checked:ids.length, matched:1, downloaded:0, downloadFailed:1, downloadErrors:[{message:'发票下载超时，请重试。'}]}); });
    await listSync.click();
    const failure = page.getByRole('alert');
    await failure.getByText(/1 份未下载：发票下载超时/).waitFor();
    assert.equal(await failure.evaluate(element => element.classList.contains('toast-error')), true);
    assert.equal((await failure.innerText()).includes('。。'), false);
    const internal = async (route, body) => {
      const response = await fetch(origin + '/api' + route, {method:'POST', headers:{'Content-Type':'application/json','X-Caidan-Internal':'invoice-ui-test'}, body:JSON.stringify(body)});
      const text = await response.text();
      assert.equal(response.status, 200, text);
      return JSON.parse(text);
    };
    const entries = [{platform_order:platformOrder, status:'已开票', amount:'26.50', title:'测试企业', invoice_type:'普通发票-电子', date:'2026-10-03'}];
    const detail = {platform_order:platformOrder, invoices:[{number, amount:'26.50', date:'2026-10-03', invoice_type:'普通发票-电子', title:'测试企业'}]};
    await internal('/taobao/invoices', {entries:[{...entries[0], status:'申请中'}]});
    await page.reload();
    const pending = row.locator('.purchase-invoice-status');
    await pending.getByText('未开票 · 申请中', {exact:true}).waitFor();
    assert.equal(await row.locator('.purchase-invoice-files').innerText(), '待开票');
    assert.equal(await pending.locator('.badge.orange').count(), 1);
    await internal('/taobao/invoices', {entries,details:[detail]});
    await page.reload();
    await row.locator('.purchase-invoice-status').getByText('已开票', {exact:true}).waitFor();
    assert.equal(await row.locator('.purchase-invoice-status .badge.green').count(), 1);
    await page.getByRole('button', {name:/查看 \/ 确认/}).first().click();
    let dialog = page.getByRole('dialog');
    assert.equal(await dialog.getByRole('heading', {name:'发票信息'}).count(), 1);
    assert.equal(await dialog.getByRole('button', {name:'获取发票', exact:true}).count(), 1);
    assert.equal(await dialog.getByRole('button', {name:'获取发票', exact:true}).isDisabled(), true);
    assert.equal(await dialog.getByText(/自动获取需在采单客户端中完成/).count(), 1);
    assert.equal(await dialog.locator('th, td').evaluateAll(elements => elements.every(el => getComputedStyle(el).textAlign === 'center')), true);
    assert.equal(await dialog.getByText('跟进 / 设置').count(), 0);
    assert.equal(await dialog.getByText(/已收发票/).count(), 0);
    await dialog.getByRole('button', {name:'关闭'}).click();
    const attachment = await internal('/attachments', {name:'invoice.pdf', content:Buffer.from('%PDF-1.4 test').toString('base64')});
    detail.invoices[0].attachment_id = attachment.id;
    await internal('/taobao/invoices', {entries,details:[detail]});
    await page.reload();
    await row.locator('.purchase-invoice-receipt .badge.orange').getByText('待确认', {exact:true}).waitFor();
    assert.equal(await row.locator('.purchase-invoice-files').getByText('已获取', {exact:true}).count(), 1);
    assert.equal(await row.getByRole('link', {name:'查看文件', exact:true}).getAttribute('href'), `/api/files/${attachment.id}`);
    assert.equal((await page.request.get(origin + `/api/files/${attachment.id}`)).status(), 200);
    assert.equal(await list.locator('th, td').evaluateAll(elements => elements.every(el => getComputedStyle(el).textAlign === 'center')), true);
    await page.getByRole('button', {name:/查看 \/ 确认/}).first().click();
    dialog = page.getByRole('dialog');
    assert.equal(await dialog.getByText('已获取', {exact:true}).count(), 1);
    await dialog.getByRole('button', {name:'确认收票'}).click();
    await dialog.getByText('已确认收票').waitFor();
    assert.equal(await dialog.getByText(/自动获取需在采单客户端中完成/).count(), 0);
    assert.equal(await dialog.getByRole('row').count(), 2);
    if (process.env.CAIDAN_QA_SCREENSHOT) await dialog.screenshot({path:process.env.CAIDAN_QA_SCREENSHOT});
    await dialog.getByRole('button', {name:'关闭'}).click();
    await row.locator('.purchase-invoice-receipt').getByText('已确认', {exact:true}).waitFor();
    assert.equal(await row.locator('.purchase-invoice-receipt').getByText('待确认', {exact:true}).count(), 0);
    const secondFile = await internal('/attachments', {name:'invoice-2.pdf', content:Buffer.from('%PDF-1.4 test 2').toString('base64')});
    for (const [index, stage] of ['待查询', '申请中', '待确认'].entries()) {
      const orderNumber = String(2000000000000000000n + BigInt(index));
      await post('/purchases', {platform:'淘宝', shop:`自动化配件测试店 · ${stage}`, platform_order:orderNumber, amount:'26.50', lines:[{order_line_id:line.id, quantity:1, cost:'26.50'}]});
      if (stage !== '待查询') await internal('/taobao/invoices', {
        entries:[{...entries[0], platform_order:orderNumber, status:stage === '申请中' ? '申请中' : '已开票'}],
        details:stage === '待确认' ? [{platform_order:orderNumber, invoices:[
          {number:'26337000000000000002', amount:'13.25', date:'2026-10-03', attachment_id:attachment.id},
          {number:'26337000000000000003', amount:'13.25', date:'2026-10-03', attachment_id:secondFile.id}
        ]}] : []
      });
    }
    await page.reload();
    await list.getByRole('button', {name:'查看文件（2）'}).click();
    dialog = page.getByRole('dialog');
    assert.equal(await dialog.getByText('已获取', {exact:true}).count(), 2, 'multiple files remain accessible in the invoice drawer');
    await dialog.getByRole('button', {name:'关闭'}).click();
    assert.match(await page.title(), /采单/);
    assert.equal(await list.locator('tbody tr').count(), 4);
    assert.equal(await page.locator('vite-error-overlay').count(), 0);
    assert.equal(await list.locator('td[class^="purchase-invoice-"]').evaluateAll(cells => cells.every(cell => cell.scrollWidth <= cell.clientWidth)), true, 'invoice cells do not clip content');
    assert.equal(await list.locator('.purchase-invoice-amounts').evaluateAll(cells => cells.every(cell => getComputedStyle(cell).whiteSpace === 'nowrap')), true);
    const qaDir = process.env.CAIDAN_QA_DIR;
    if (qaDir) {
      await fs.mkdir(qaDir, {recursive:true});
      await page.screenshot({path:path.join(qaDir, 'invoice-columns-desktop.png')});
      await list.screenshot({path:path.join(qaDir, 'invoice-columns-table.png')});
    }
    await page.setViewportSize({width:1440, height:940});
    await list.locator('.table-scroll').evaluate(el => { el.scrollLeft = el.scrollWidth; });
    if (qaDir) await page.screenshot({path:path.join(qaDir, 'invoice-columns-client.png')});
    await page.setViewportSize({width:390, height:844});
    await list.locator('.table-scroll').evaluate(el => { el.scrollLeft = el.scrollWidth; });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'narrow screens scroll the table, not the page');
    if (qaDir) await page.screenshot({path:path.join(qaDir, 'invoice-columns-mobile.png')});
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({passed:true, origin, viewports:[1916,1440,390], checks:['three columns', 'status distinction', 'file link', 'multiple files', 'manual confirmation', 'no clipped amounts', 'no console errors']}));
  } finally {
    if (browser) await browser.close();
    server.kill();
    await fs.rm(temp, {recursive:true, force:true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
