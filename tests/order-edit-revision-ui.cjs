const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-order-revision-'));
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
      server.on('exit', code => reject(new Error('服务已退出 ' + code)));
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
    const customer = await post('/customers', { name: '昆山阿普顿自动化系统有限公司', contacts: [{ name: '葛建辉', phone: '18011111111' }], addresses: [{ address: '江苏省苏州市昆山市许塘路8号', contact: '葛建辉', phone: '18011111111' }] });
    const order = await post('/orders', {
      customer_id: customer.id, customer: '昆山阿普顿自动化系统有限公司', po: 'PO-REVISE-1', contact: '葛建辉', phone: '18011111111', address: '江苏省苏州市昆山市许塘路8号',
      lines: [{ name: '空压机', spec: 'VA-6', quantity: 2, unit: '个', price: 47.83 }]
    });
    await post(`/orders/${order.id}/confirm`, {});
    await page.reload();
    await page.locator('.orders-list .date-range').waitFor({ timeout: 20000 });

    // 打开订单详情 → 修改订单
    const row = page.locator('.orders-list tbody tr').filter({ hasText: 'PO-REVISE-1' });
    await row.getByRole('button', { name: '查看', exact: true }).first().click();
    const drawer = page.getByRole('dialog', { name: 'PO-REVISE-1 · 客户订单' });
    await drawer.getByRole('button', { name: '修改订单' }).click();
    await page.getByText('该订单已确认（第 1 版）').waitFor({ timeout: 20000 });
    const saveButton = page.getByRole('button', { name: '保存为第 2 版' });
    assert.equal(await saveButton.count(), 1, '编辑已确认订单时保存按钮显示版本号');

    // 改数量与单价后保存
    await page.getByLabel('第1行数量').fill('5');
    await page.getByLabel('第1行单价（含税）', { exact: true }).fill('50');
    await page.getByLabel('已核对料品、规格、数量与收货信息').check();
    await saveButton.click();
    await page.getByText('已保存为第 2 版并保持已确认').waitFor({ timeout: 20000 });

    const state = await page.evaluate(async () => (await fetch('/api/state')).json());
    const updated = state.orders.find(o => o.po === 'PO-REVISE-1');
    assert.equal(updated.status, 'confirmed', '修改后仍保持已确认');
    assert.equal(updated.version, 2, '版本号 +1：' + updated.version);
    const lines = state.order_lines.filter(l => l.order_id === updated.id);
    assert.equal(lines.length, 1, '料品数量不变');
    assert.equal(Number(lines[0].quantity), 5, '数量已更新：' + lines[0].quantity);
    assert.equal(lines[0].price_cents, 5000, '单价已更新：' + lines[0].price_cents);
    const versions = state.quotes.filter(q => q.order_id === updated.id).map(q => q.version).sort();
    assert.deepEqual(versions, [1, 2], '报价历史保留两个版本：' + versions.join(','));

    // 回归：订单行原来挂的料品被停用后，导入页保存不应把旧料品编号原样回传。
    // 旧行为会把 item_id 一起提交，服务端因“料品已停用”拒绝保存，页面看起来“保存后没有变化”。
    const linkedItem = state.items.find(i => i.id === lines[0].item_id);
    assert.ok(linkedItem, '订单行已关联料品档案：' + lines[0].item_id);
    // 查重规则按名称+标准型号+品牌比对，这里用同品牌的启用料品作为“停用后应改挂”的目标
    const twin = await post('/items', { name: linkedItem.name, spec: linkedItem.spec, brand: linkedItem.brand, unit: linkedItem.unit });
    await post(`/items/${linkedItem.id}`, { name: linkedItem.name, spec: linkedItem.spec, brand: linkedItem.brand, unit: linkedItem.unit, active: false });
    await page.reload();
    await page.locator('.orders-list .date-range').waitFor({ timeout: 20000 });
    const again = page.locator('.orders-list tbody tr').filter({ hasText: 'PO-REVISE-1' });
    await again.getByRole('button', { name: '查看', exact: true }).first().click();
    await page.getByRole('dialog', { name: 'PO-REVISE-1 · 客户订单' }).getByRole('button', { name: '修改订单' }).click();
    await page.getByLabel('已核对料品、规格、数量与收货信息').check();
    await page.getByRole('button', { name: '保存为第 3 版' }).click();
    await page.getByText('已保存为第 3 版并保持已确认').waitFor({ timeout: 20000 });
    const relinked = (await page.evaluate(async () => (await fetch('/api/state')).json())).order_lines.filter(l => l.order_id === updated.id);
    assert.equal(relinked.length, 1, '料品数量不变');
    assert.equal(relinked[0].item_id, twin.id, '保存后应重新关联启用中的料品：' + relinked[0].item_id + ' ≠ ' + twin.id);

    assert.deepEqual(errors, [], 'console errors: ' + errors.join(' | '));
    console.log(JSON.stringify({ passed: true, status: updated.status, version: updated.version, quantity: lines[0].quantity, price_cents: lines[0].price_cents, versions, relinked_item: relinked[0].item_id }));
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exit(1); });
