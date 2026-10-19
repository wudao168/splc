const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

// 回归：登记出库时 (1) 历史遗留的停用同名料品不再让匹配失败；(2) 提交失败后订单与出库数量保留在表单里。
(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-outbound-retry-'));
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
      server.on('exit', code => reject(new Error(`服务已退出 ${code}`)));
      server.stdout.on('data', chunk => {
        output += chunk.toString();
        const match = output.match(/Caidan running at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
    });
    browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1575, height: 892 } });
    const errors = [];
    page.on('pageerror', error => errors.push('pageerror: ' + error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push('console: ' + message.text()); });
    await page.goto(origin + '/#orders');
    await page.getByLabel('账号', { exact: true }).fill('admin');
    const setup = await page.getByLabel('姓名', { exact: true }).count();
    if (setup) await page.getByLabel('姓名', { exact: true }).fill('管理员');
    await page.getByLabel('密码', { exact: true }).fill('11111111');
    await page.getByRole('button', { name: setup ? '创建并进入' : '登录', exact: true }).click();
    await page.locator('.orders-list .date-range').waitFor({ timeout: 20000 });
    const post = (route, body) => page.evaluate(async ({ route, body }) => {
      const response = await fetch('/api' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(route + ': ' + (payload.error || ''));
      return payload;
    }, { route, body });
    const state = () => page.evaluate(async () => await (await fetch('/api/state')).json());
    const raw = (route, body) => page.evaluate(async ({ route, body }) => {
      const response = await fetch('/api' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, error: ((await response.json()) || {}).error || '' };
    }, { route, body });
    const customer = await post('/customers', { name: '出库重试客户', addresses: [{ address: '成都测试路2号' }] });
    const warehouse = (await state()).warehouses[0].id;
    const openOutboundTab = async () => {
      await page.goto(origin + '/#inventory');
      await page.reload();
      await page.locator('.inventory-page').waitFor({ timeout: 15000 });
      await page.getByRole('button', { name: '出库单', exact: true }).click();
      await page.getByText('登记出库').first().waitFor();
    };

    // 场景一：订单明细“待匹配料品”，同名料品里有一个已停用（用户报的现场）
    const spare = await post('/items', { name: '涡旋机机头', spec: 'SRL-5.5', brand: '日立', unit: '个' });
    const active = await post('/items', { name: '涡旋机机头', spec: 'SRL-5.5', brand: '日立', unit: '个' });
    const order = await post('/orders', { customer_id: customer.id, customer: '出库重试客户', contact: '', phone: '', address: '成都测试路2号', po: 'PO-RETRY1',
      lines: [{ name: '涡旋机机头', spec: 'SRL-5.5', brand: '日立', quantity: 6, unit: '个', price: 0 }] });
    await post(`/orders/${order.id}/confirm`, {});
    let current = await state();
    let line = current.order_lines.find(x => x.order_id === order.id);
    assert.equal(line.item_id, null, '两个同名候选时应保持待匹配');
    await post(`/items/${spare.id}`, { name: '涡旋机机头', spec: 'SRL-5.5', brand: '日立', unit: '个', active: false });
    await post('/receipts', { warehouse_id: warehouse, lines: [{ item_id: active.id, quantity: 6, cost: '5' }] });

    await openOutboundTab();
    const orderSelect = page.getByLabel('客户订单 *');
    await orderSelect.selectOption(String(order.id));
    const outboundQuantity = page.getByLabel('涡旋机机头出库数量');
    await outboundQuantity.waitFor();
    const matchedCode = await page.locator('.stock-form table tbody tr').first().locator('td').nth(2).innerText();
    if (!/LP\d{6}/.test(matchedCode)) throw new Error(`待匹配明细应按唯一启用的料品显示编号：${matchedCode}`);
    await outboundQuantity.fill('6');
    await page.getByRole('button', { name: '确认出库并生成送货单' }).click();
    await page.getByText('出库已办理').waitFor({ timeout: 15000 });
    current = await state();
    line = current.order_lines.find(x => x.id === line.id);
    assert.equal(line.item_id, active.id, '出库时应自动关联唯一启用的料品');
    assert.equal(current.stock_outbounds.filter(x => x.order_id === order.id).length, 1);
    assert.equal(current.items.find(x => x.id === active.id).on_hand, 0);

    // 场景二：提交失败时表单保留已选订单和出库数量，重试不需要重新填写
    const bolt = await post('/items', { name: '化学螺栓', spec: 'M20×260', brand: '东明', unit: '个' });
    const second = await post('/orders', { customer_id: customer.id, customer: '出库重试客户', contact: '', phone: '', address: '成都测试路2号', po: 'PO-RETRY2',
      lines: [{ name: '化学螺栓', spec: 'M20×260', brand: '东明', quantity: 10, unit: '个', price: 10 }] });
    await post(`/orders/${second.id}/confirm`, {});
    const receipt = await post('/receipts', { warehouse_id: warehouse, lines: [{ item_id: bolt.id, quantity: 10, cost: '8' }] });

    await openOutboundTab();
    await orderSelect.selectOption(String(second.id));
    const boltQuantity = page.getByLabel('化学螺栓出库数量');
    await boltQuantity.fill('10');
    // 页面加载后库存在服务端被撤销，提交必然失败，用来验证失败后表单不被清空
    await post(`/receipts/${receipt.id}/void`, { reason: '测试库存变化' });
    await page.getByRole('button', { name: '确认出库并生成送货单' }).click();
    await page.locator('.toast').filter({ hasText: '现存量不足' }).waitFor({ timeout: 15000 });
    assert.equal(await orderSelect.inputValue(), String(second.id), '出库失败后应保留已选订单');
    assert.equal(await boltQuantity.inputValue(), '10', '出库失败后应保留已填的出库数量');
    assert.equal((await state()).stock_outbounds.filter(x => x.order_id === second.id).length, 0);

    // 库存补回后直接重试同一张表单
    await post('/receipts', { warehouse_id: warehouse, lines: [{ item_id: bolt.id, quantity: 10, cost: '8' }] });
    await page.getByRole('button', { name: '确认出库并生成送货单' }).click();
    await page.getByText('出库已办理').waitFor({ timeout: 15000 });
    current = await state();
    assert.equal(current.stock_outbounds.filter(x => x.order_id === second.id).length, 1);
    assert.equal(current.items.find(x => x.id === bolt.id).on_hand, 0);

    // 场景三：明细挂在了“已停用”的同名料品上（历史遗留）时，可以在出库页直接改绑并出库
    const spareCode = current.items.find(x => x.id === spare.id).code;
    const activeCode = current.items.find(x => x.id === active.id).code;
    const third = await post('/orders', { customer_id: customer.id, customer: '出库重试客户', contact: '', phone: '', address: '成都测试路2号', po: 'PO-RETRY3',
      lines: [{ name: '涡旋机机头', spec: 'SRL-5.5', brand: '日立', quantity: 3, unit: '个', price: 0 }] });
    await post(`/orders/${third.id}/confirm`, {});
    current = await state();
    const thirdLine = current.order_lines.find(x => x.order_id === third.id);
    const rejected = await raw(`/order-lines/${thirdLine.id}/item`, { item_id: spare.id });
    assert.equal(rejected.status, 400, `停用料品不允许关联：${JSON.stringify(rejected)}`);
    assert.match(rejected.error, /已停用/);
    // 历史数据是先在启用状态下关联、之后才停用的，这里照原样复现
    await post(`/items/${spare.id}`, { name: '涡旋机机头', spec: 'SRL-5.5', brand: '日立', unit: '个', active: true });
    await post(`/order-lines/${thirdLine.id}/item`, { item_id: spare.id });
    await post(`/items/${spare.id}`, { name: '涡旋机机头', spec: 'SRL-5.5', brand: '日立', unit: '个', active: false });
    current = await state();
    assert.equal(current.order_lines.find(x => x.id === thirdLine.id).item_id, spare.id, '应能把明细挂到（之后被停用的）料品上复现历史数据');
    await post('/receipts', { warehouse_id: warehouse, lines: [{ item_id: active.id, quantity: 3, cost: '5' }] });

    await openOutboundTab();
    await orderSelect.selectOption(String(third.id));
    const thirdRow = page.locator('.stock-form table tbody tr').first();
    await thirdRow.getByText(`${spareCode} 已停用`).waitFor();
    await thirdRow.getByLabel('涡旋机机头关联料品').selectOption(String(active.id));
    await thirdRow.getByRole('button', { name: '关联', exact: true }).click();
    await page.getByText('料品已关联').waitFor({ timeout: 15000 });
    const reboundCode = await thirdRow.locator('td').nth(2).innerText();
    if (!reboundCode.includes(activeCode)) throw new Error(`改绑后应显示 ${activeCode}：${reboundCode}`);
    await thirdRow.getByLabel('涡旋机机头出库数量').fill('3');
    await page.getByRole('button', { name: '确认出库并生成送货单' }).click();
    await page.getByText('出库已办理').waitFor({ timeout: 15000 });
    current = await state();
    assert.equal(current.order_lines.find(x => x.id === thirdLine.id).item_id, active.id);
    assert.equal(current.stock_outbounds.filter(x => x.order_id === third.id).length, 1);
    assert.equal(current.items.find(x => x.id === active.id).on_hand, 0);
    // 场景二的失败提交、场景三的停用料品关联被拒都是预期的 400，其余控制台错误都应视为回归
    const expectedRejections = errors.filter(text => /Failed to load resource.*400 \(Bad Request\)/.test(text));
    assert.equal(expectedRejections.length, 2, `应只有两次预期的 400（提交失败 + 停用料品关联被拒）：${JSON.stringify(errors)}`);
    assert.deepEqual(errors.filter(text => !expectedRejections.includes(text)), []);
    console.log('outbound retry ui ok');
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exit(1); });
