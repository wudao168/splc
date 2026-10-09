const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-cancel-'));
  const python = process.env.CAIDAN_PYTHON || path.join(root, '.venv', 'Scripts', 'python.exe');
  const server = spawn(python, ['-u', '-m', 'server.app', '--port', '0'], {
    cwd: root, env: { ...process.env, CAIDAN_DATA: path.join(temp, 'data') }, windowsHide: true
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
    browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1575, height: 892 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/#orders');
    await page.getByLabel('账号', { exact: true }).fill('admin');
    await page.getByLabel('密码', { exact: true }).fill('11111111');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.locator('.orders-list .date-range').waitFor();
    const post = (route, body) => page.evaluate(async ({ route, body }) => {
      const response = await fetch('/api' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error);
      return payload;
    }, { route, body });
    const customer = await post('/customers', { name: '取消单客户', contacts: [{ name: '李工', phone: '13800000003' }], addresses: [{ address: '测试地址2号', contact: '李工', phone: '13800000003' }] });
    const base = { customer_id: customer.id, customer: '取消单客户', contact: '李工', phone: '13800000003', address: '测试地址2号' };
    const orderA = await post('/orders', { ...base, po: 'PO-CANCELA', lines: [{ name: '甲', quantity: 5, unit: '个', price: 10 }, { name: '乙', quantity: 3, unit: '个', price: 10 }] });
    await post(`/orders/${orderA.id}/confirm`, {});
    const orderB = await post('/orders', { ...base, po: 'PO-CANCELB', lines: [{ name: '丙', quantity: 2, unit: '个', price: 10 }] });
    await post(`/orders/${orderB.id}/confirm`, {});

    let mockReturn = false;
    await page.route('**/api/state', async route => {
      const response = await route.fetch();
      const body = await response.json();
      if (mockReturn) {
        const order = body.orders.find(item => item.po === 'PO-CANCELA');
        const line = body.order_lines.find(item => item.order_id === order.id);
        body.deliveries = [...(body.deliveries || []), { id: 9001, order_id: order.id, status: 'active', shipped_at: '2026-10-08 10:00:00', number: 'SHD-TEST-1' }];
        body.delivery_lines = [...(body.delivery_lines || []), { id: 9002, delivery_id: 9001, order_line_id: line.id, quantity: 1 }];
        body.order_cases = [...(body.order_cases || []), { id: 9101, order_line_id: line.id, delivery_line_id: 9003, purchase_line_id: null, kind: 'return', quantity: 1, reason: '测试退货', status: 'processing', received_quantity: 1, financial_type: 'reduce_receivable', amount_cents: 1000, finance_confirmed_at: '2026-10-09T10:00:00+08:00', tracking: '', note: '客户退货已收回并入库存', location: '', evidence_id: null, owner_id: 1, created_at: '2026-10-09T10:00:00+08:00', completed_at: '', destination: 'stock', warehouse_id: 1 }];
        body.orders = body.orders.map(item => item.po === 'PO-CANCELA' ? { ...item, open_cases: (item.open_cases || 0) + 1 } : item);
      }
      await route.fulfill({ response, json: body });
    });
    await page.reload();
    await page.locator('.orders-list .date-range').waitFor();

    const rowOf = po => page.locator('.orders-list tbody tr').filter({ hasText: po });
    const toolbarButton = name => page.getByRole('button', { name, exact: true });
    const pick = async po => { await rowOf(po).getByRole('checkbox').check(); };
    const unpickAll = async () => { for (const box of await page.locator('.orders-list tbody input[type="checkbox"]:checked').all()) await box.uncheck(); };
    await pick('PO-CANCELA');
    await toolbarButton('取消订单').click();
    const form = page.locator('.order-cancel-form');
    await form.waitFor();
    const children = await form.evaluate(el => [...el.children].map(node => node.className));
    assert.ok(children.findIndex(name => name.includes('order-cancel-fields')) < children.findIndex(name => name.includes('table-scroll')), '条件字段应排在明细列表上方');
    const columns = await form.locator('.order-cancel-fields').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    assert.equal(columns, 4, '顶部条件区每行显示 4 项');
    const tableHeight = await form.locator('.table-scroll').evaluate(el => el.getBoundingClientRect().height);
    assert.ok(tableHeight > 250, `明细列表高度应自适应页面：${tableHeight}`);
    const rowInput = name => form.locator('tbody tr').filter({ hasText: name }).locator('input[type="number"]');
    assert.equal(await rowInput('甲').inputValue(), '5', '默认填满甲的可取消数量');
    assert.equal(await rowInput('乙').inputValue(), '3', '默认填满乙的可取消数量');
    const submitButton = form.getByRole('button', { name: '确认取消订单', exact: true });
    assert.equal(await submitButton.isDisabled(), true, '未填取消原因不能提交');
    await form.screenshot({ path: path.join(temp, 'cancel-modal.png') });
    await rowInput('乙').fill('1');
    await form.getByLabel('取消原因 *', { exact: true }).fill('客户只取消部分数量');
    assert.equal(await submitButton.isDisabled(), false);
    await submitButton.click();
    await page.locator('.order-cancel-form').waitFor({ state: 'detached' });
    await page.locator('.toast').filter({ hasText: '已登记取消 2 项未发数量' }).waitFor();

    let state = await page.evaluate(async () => (await fetch('/api/state')).json());
    const savedA = state.orders.find(item => item.po === 'PO-CANCELA');
    assert.equal(savedA.status, 'confirmed', '部分取消后订单保持已确认');
    const cancelled = Object.fromEntries(state.order_lines.filter(line => line.order_id === savedA.id).map(line => [line.name, line.cancelled_quantity]));
    assert.deepEqual(cancelled, { '甲': 5, '乙': 1 }, '取消数量应逐行记录');
    assert.equal(savedA.receivable_cents, 2000, '应收应扣减已取消数量金额');

    const lineB = state.order_lines.find(line => line.order_id === savedA.id && line.name === '乙');
    await post(`/orders/${savedA.id}/cases`, { order_line_id: lineB.id, kind: 'cancel', quantity: 1, reason: '直接登记的取消（不确认金额）' });
    state = await page.evaluate(async () => (await fetch('/api/state')).json());
    assert.equal(state.orders.find(item => item.po === 'PO-CANCELA').receivable_cents, 1000, '冲减应收类登记后立即生效，无需管理员确认');

    await page.reload();
    await page.locator('.orders-list .date-range').waitFor();
    await rowOf('PO-CANCELA').getByRole('button', { name: '查看', exact: true }).click();
    const detail = page.locator('.modal');
    await detail.locator('.lifecycle').waitFor();
    await detail.getByRole('tab', { name: /变更与售后/ }).click();
    await detail.getByText('取消未发数量', { exact: false }).first().waitFor();
    await detail.locator('.lifecycle-card summary').filter({ hasText: '取消未发数量' }).first().click();
    assert.ok(await detail.getByRole('button', { name: '确认完成', exact: true }).first().isVisible(), '订单详情应能完成售后记录');
    await detail.screenshot({ path: path.join(temp, 'detail-modal.png') });
    await detail.getByRole('button', { name: '关闭', exact: true }).click();
    await detail.waitFor({ state: 'detached' });

    await unpickAll();
    await pick('PO-CANCELB');
    await toolbarButton('取消订单').click();
    const formB = page.locator('.order-cancel-form');
    await formB.waitFor();
    assert.equal(await formB.locator('input[type="number"]').first().inputValue(), '2');
    await formB.getByLabel('取消原因 *', { exact: true }).fill('客户整单取消');
    await formB.getByRole('button', { name: '确认取消订单', exact: true }).click();
    await formB.waitFor({ state: 'detached' });
    state = await page.evaluate(async () => (await fetch('/api/state')).json());
    const savedB = state.orders.find(item => item.po === 'PO-CANCELB');
    assert.equal(savedB.status, 'cancelled', '全部数量取消后订单应为已取消');
    assert.ok(savedB.cancellation_reason === '客户整单取消');
    await unpickAll();
    await pick('PO-CANCELB');
    assert.equal(await toolbarButton('取消订单').isDisabled(), true, '已取消订单不能再次取消');
    await unpickAll();

    mockReturn = true;
    await page.reload();
    await page.locator('.orders-list .date-range').waitFor();
    await rowOf('PO-CANCELA').locator('td.order-status .badge').waitFor();
    assert.equal((await rowOf('PO-CANCELA').locator('td.order-status .badge').innerText()).trim(), '退货中', '有未完成退货时订单状态显示退货中');
    await page.locator('.orders-list').first().screenshot({ path: path.join(temp, 'orders-status.png') });
    await pick('PO-CANCELA');
    await toolbarButton('退货').click();
    const returnForm = page.locator('.order-return-form');
    await returnForm.waitFor();
    const returnChildren = await returnForm.evaluate(el => [...el.children].map(node => node.className));
    assert.ok(returnChildren.findIndex(name => name.includes('order-return-fields')) < returnChildren.findIndex(name => name.includes('table-scroll')), '退货条件字段应在明细列表上方');
    const returnColumns = await returnForm.locator('.order-return-fields').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    assert.equal(returnColumns, 4, '退货条件区每行显示 4 项');
    const returnTableHeight = await returnForm.locator('.table-scroll').evaluate(el => el.getBoundingClientRect().height);
    assert.ok(returnTableHeight > 250, `退货明细列表高度应自适应页面：${returnTableHeight}`);
    await returnForm.screenshot({ path: path.join(temp, 'return-modal.png') });
    assert.deepEqual(errors, [], `页面报错：${errors.join(' | ')}`);
    console.log('OK 取消订单入口（部分/整单）与退货、取消弹窗自适应布局；截图：', temp);
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exit(1); });
