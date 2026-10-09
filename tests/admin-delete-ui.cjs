const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {chromium} = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-delete-ui-'));
  const python = process.env.CAIDAN_PYTHON || path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
  const server = spawn(python, ['-u', '-m', 'server.app', '--port', '0'], {cwd:root,
    env:{...process.env, CAIDAN_DATA:path.join(temp, 'data')}, windowsHide:true});
  let browser;
  try {
    const origin = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('服务启动超时')), 30000);
      server.on('error', reject);
      server.on('exit', code => reject(new Error(`服务退出：${code}`)));
      server.stdout.on('data', chunk => {
        output += chunk.toString();
        const match = output.match(/Caidan running at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    browser = await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless:true});
    const page = await browser.newPage();
    page.on('dialog', dialog => dialog.accept());
    await page.goto(origin + '/#purchases');
    await page.getByLabel('账号', {exact:true}).fill('admin');
    await page.getByLabel('密码', {exact:true}).fill('11111111');
    await page.getByRole('button', {name:'登录', exact:true}).click();
    await page.getByRole('navigation', {name:'主导航'}).getByRole('button', {name:'采购', exact:true}).waitFor();
    const post = (route, body) => page.evaluate(async ({route, body}) => {
      const response = await fetch('/api' + route, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }, {route, body});
    const order = await post('/orders', {customer:'测试客户', po:'PO-DELETE-UI', address:'测试地址', lines:[{name:'测试料品', quantity:1}]});
    await post(`/orders/${order.id}/confirm`, {});
    const state = await page.evaluate(async () => (await (await fetch('/api/state')).json()));
    await post('/purchases', {platform:'淘宝', shop:'测试店铺', platform_order:'TB-DELETE-UI', amount:'10',
      lines:[{order_line_id:state.order_lines[0].id, quantity:1, cost:'10'}]});
    await page.goto(origin + '/#purchases');
    await page.reload();
    const purchaseRow = page.getByRole('row').filter({hasText:'TB-DELETE-UI'});
    await purchaseRow.getByRole('checkbox').check();
    await page.locator('.purchases-list').getByRole('button', {name:/删除选中/}).click();
    await page.getByRole('dialog', {name:'删除 1 条采购记录'}).getByRole('button', {name:'确认删除'}).click();
    await purchaseRow.waitFor({state:'detached'});
    await page.getByRole('button', {name:'订单', exact:true}).click();
    const orderRow = page.getByRole('row').filter({hasText:'PO-DELETE-UI'});
    await orderRow.getByRole('checkbox').check();
    await page.locator('.orders-list').getByRole('button', {name:/删除选中/}).click();
    await page.getByRole('dialog', {name:'删除 1 条记录'}).getByRole('button', {name:'确认删除'}).click();
    await orderRow.waitFor({state:'detached'});
    const finalState = await page.evaluate(async () => (await (await fetch('/api/state')).json()));
    assert.equal(finalState.orders.length, 0);
    assert.equal(finalState.purchases.length, 0);
    await post('/customers', {name:'待删除客户', contacts:[{name:'张三', phone:'13900000000'}],
      addresses:[{address:'测试地址', contact:'张三', phone:'13900000000'}]});
    await page.goto(origin + '/#customers');
    await page.reload();
    const customerRow = page.getByRole('row').filter({hasText:'待删除客户'});
    await customerRow.getByRole('button', {name:'删除'}).click();
    await customerRow.waitFor({state:'detached'});
    const customerState = await page.evaluate(async () => (await (await fetch('/api/state')).json()));
    assert.equal(customerState.customers.length, 0);
    console.log('管理员删除采购记录、客户订单及客户资料：通过');
  } finally {
    if (browser) await browser.close();
    server.kill();
    await fs.rm(temp, {recursive:true, force:true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
