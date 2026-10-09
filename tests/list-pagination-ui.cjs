const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-pagination-ui-'));
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
    await page.getByRole('navigation', {name:'主导航'}).getByRole('button', {name:'采购', exact:true}).waitFor();
    const post = (route, body) => page.evaluate(async ({route,body}) => {
      const response = await fetch('/api' + route, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }, {route,body});
    const order = await post('/orders', {customer:'测试客户', po:'PO-0001', address:'测试地址', lines:[{name:'测试料品', quantity:1000}]});
    await post(`/orders/${order.id}/confirm`, {});
    const line = await page.evaluate(async () => (await (await fetch('/api/state')).json()).order_lines[0]);
    await post('/purchases', {platform:'淘宝', shop:'分页测试采购', platform_order:'100000001', amount:'26.50', lines:[{order_line_id:line.id, quantity:1, cost:'26.50'}]});
    const base = await page.evaluate(async () => (await (await fetch('/api/state')).json()));
    const data = structuredClone(base);
    data.customers = Array.from({length:205}, (_, i) => ({id:i + 1, name:`客户-${String(i + 1).padStart(4, '0')} · ${'完整客户名称'.repeat(15)}`, note:'完整备注'.repeat(30),
      contacts:Array.from({length:5}, (_, j) => ({name:`CONTACT-${i + 1}-${j}`, phone:`PHONE-${i + 1}-${j}`})),
      addresses:Array.from({length:5}, (_, j) => ({address:`ADDR-${i + 1}-${j} · ${'完整收货地址'.repeat(15)}`, contact:`收货人 ${j}`, phone:`送货电话 ${j}`}))}));
    data.orders = Array.from({length:205}, (_, i) => ({...base.orders[0], id:i + 1, po:`PO-${String(i + 1).padStart(4, '0')}`, customer:'固定行高测试客户'.repeat(12), contact:'联系人'.repeat(8), open_cases:3, cancellation_reason:'部分退货备注'.repeat(20)}));
    data.order_lines = data.orders.map(o => ({...base.order_lines[0], id:o.id, order_id:o.id, cancelled_quantity:1}));
    data.intake_drafts = Array.from({length:3}, (_, i) => ({id:i + 1, updated_at:'2026-10-05', payload:{form:{customer:'草稿测试客户'.repeat(15), po:`DRAFT-${i + 1}`}, lines:[]}}));
    data.purchases = Array.from({length:205}, (_, i) => ({...base.purchases[0], id:i + 1, platform_order:String(3000000000000000000n + BigInt(i)), shop:`店铺-${String(i + 1).padStart(4, '0')} · ${'长名称测试'.repeat(20)}`, open_cases:3,
      taobao_source:{packages:Array.from({length:6}, (_, j) => ({tracking:`TRACKING-${i}-${j}`, carrier:'测试快递'}))}}));
    data.purchase_lines = data.purchases.map(p => ({...base.purchase_lines[0], id:p.id, purchase_id:p.id, order_line_id:205}));
    await page.route('**/api/state', route => route.fulfill({json:data}));
    const deleted = [];
    await page.route('**/api/purchases/delete', async route => {
      const ids = route.request().postDataJSON().ids;
      deleted.push(...ids);
      data.purchases = data.purchases.filter(p => !ids.includes(p.id));
      data.purchase_lines = data.purchase_lines.filter(p => !ids.includes(p.purchase_id));
      await route.fulfill({json:{ok:true}});
    });
    const heightCheck = async list => {
      const heights = await list.locator('tbody tr').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
      assert.ok(heights.length && heights.every(height => Math.abs(height - 50) < .1), `row heights: ${[...new Set(heights)]}`);
    };
    const qaDir = process.env.CAIDAN_QA_DIR;
    if (qaDir) await fs.mkdir(qaDir, {recursive:true});
    const exercise = async (route, selector, label, total, selectAllLabel) => {
      await page.goto(origin + '/#' + route);
      await page.reload();
      const list = page.locator(selector), rows = list.locator('tbody tr');
      const nav = page.getByRole('navigation', {name:`${label}分页`});
      const size = page.getByLabel(`${label}每页条数`);
      await rows.nth(49).waitFor();
      assert.equal(await rows.count(), 50);
      assert.equal(await size.inputValue(), '50');
      assert.match(await nav.innerText(), new RegExp(`共 ${total} 条`));
      assert.deepEqual(await size.locator('option').evaluateAll(options => options.map(option => option.value)), ['30','50','100','200']);
      await heightCheck(list);
      const firstPage = await rows.allTextContents();
      if (selectAllLabel) {
        await page.getByLabel(selectAllLabel).check();
        assert.equal(await rows.locator('input:checked').count(), 50, 'select all only affects the current page');
      }
      await nav.getByRole('button', {name:'下一页'}).click();
      assert.equal(await rows.locator('input:checked').count(), 0, 'selection clears when changing page');
      const nextPage = await rows.allTextContents();
      assert.ok(nextPage.every(text => !firstPage.includes(text)), 'pages do not overlap');
      if (route === 'orders') {
        assert.ok(firstPage[0].includes('DRAFT-1'));
        assert.ok(firstPage[49].includes('PO-0047'));
        assert.ok(nextPage[0].includes('PO-0048'), 'drafts and orders share the page limit');
      }
      for (const count of [30,100,200]) {
        await size.selectOption(String(count));
        assert.equal(await rows.count(), count);
        assert.match(await nav.innerText(), /第 1 \//);
        await heightCheck(list);
      }
      await nav.getByRole('button', {name:'下一页'}).click();
      assert.equal(await rows.count(), total - 200);
      assert.equal(await nav.getByRole('button', {name:'下一页'}).isDisabled(), true);
      await list.getByRole('textbox', {name:'搜索', exact:true}).fill(route === 'orders' ? 'PO-0001' : route === 'customers' ? '客户-0001' : '店铺-0001');
      assert.equal(await rows.count(), 1, 'search includes the entire list, not just the previous page');
      assert.match(await nav.innerText(), /第 1 \/ 1 页/);
      await list.getByRole('textbox', {name:'搜索', exact:true}).fill('no-matching-record');
      assert.equal(await rows.count(), 0);
      assert.match(await nav.innerText(), /共 0 条 · 0–0 条/);
      await list.getByRole('textbox', {name:'搜索', exact:true}).fill('');
      await size.selectOption('50');
      if (qaDir) {
        await page.screenshot({path:path.join(qaDir, `${route}-rows.png`)});
        await nav.scrollIntoViewIfNeeded();
        await page.screenshot({path:path.join(qaDir, `${route}-pagination.png`)});
      }
      for (const width of [1440,390]) {
        await page.setViewportSize({width, height:900});
        await heightCheck(list);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.setViewportSize({width:1916, height:1080});
      return {list, rows, nav, size};
    };
    const customers = await exercise('customers', '.customer-list', '客户列表', 205);
    const searchCustomers = customers.list.getByRole('textbox', {name:'搜索', exact:true});
    for (const value of ['CONTACT-205-4', 'PHONE-205-4', 'ADDR-205-4']) {
      await searchCustomers.fill(value);
      assert.equal(await customers.rows.count(), 1, 'hidden contacts and addresses remain searchable');
      assert.ok((await customers.rows.innerText()).includes('客户-0205'));
    }
    const editButton = customers.rows.getByRole('button', {name:'编辑', exact:true});
    assert.equal(await editButton.evaluate(button => {
      const rect = button.getBoundingClientRect(), container = button.parentElement.getBoundingClientRect();
      return rect.top >= container.top && rect.bottom <= container.bottom;
    }), true, 'edit button is fully visible in the fixed row');
    await editButton.click();
    const customerDialog = page.getByRole('dialog', {name:'编辑客户资料'});
    assert.equal(await customerDialog.getByLabel('客户名称 *', {exact:true}).inputValue(), data.customers[204].name);
    assert.equal(await customerDialog.getByLabel('联系人 5 *', {exact:true}).inputValue(), 'CONTACT-205-4');
    assert.equal(await customerDialog.getByLabel('收货地址 5 *', {exact:true}).inputValue(), data.customers[204].addresses[4].address);
    await customerDialog.getByRole('button', {name:'取消', exact:true}).click();
    await exercise('orders', '.orders-list', '客户订单', 208, '全选当前页订单');
    const {list, rows, nav, size} = await exercise('purchases', '.purchases-list', '采购记录', 205, '全选当前页采购');
    const originalPurchases = structuredClone(data.purchases), originalLines = structuredClone(data.purchase_lines);
    await size.selectOption('100');
    await nav.getByRole('button', {name:'下一页'}).click();
    await nav.getByRole('button', {name:'下一页'}).click();
    assert.equal(await rows.count(), 5);
    await page.getByLabel('全选当前页采购').check();
    await list.getByRole('button', {name:'删除选中（5）', exact:true}).click();
    await page.getByRole('dialog').getByRole('button', {name:'确认删除', exact:true}).click();
    await nav.getByText('第 2 / 2 页', {exact:true}).waitFor();
    assert.equal(await rows.count(), 100, 'deleting the last page returns to a valid page');
    // 模拟数据 created_at 相同，采购列表按“登记时间倒序 + 编号倒序”排列，最后一页是最早的 5 条
    assert.deepEqual(deleted, [5,4,3,2,1]);
    data.purchases = originalPurchases; data.purchase_lines = originalLines;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await nav.getByText('第 2 / 3 页', {exact:true}).waitFor();
    assert.equal(await rows.count(), 100, 'refresh does not jump back to the old invalid page');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({passed:true, origin, checks:['50px rows at 1916/1440/390', '50 default and 30/100/200 choices', 'draft/order shared limit', 'page-only selection', 'search entire list', 'empty result', 'last-page deletion', 'refresh page stability', 'no console errors']}));
  } finally {
    if (browser) await browser.close();
    server.kill();
    await fs.rm(temp, {recursive:true, force:true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
