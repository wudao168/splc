const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-ship-column-'));
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
    const customer = await post('/customers', { name: '送货列客户', contacts: [{ name: '王工', phone: '13800000002' }], addresses: [{ address: '测试地址1号', contact: '收货人', phone: '13700000000' }] });
    const base = { customer_id: customer.id, customer: '送货列客户', contact: '王工', phone: '13800000002', address: '测试地址1号' };
    await post('/orders', { ...base, po: 'PO-SHIPA', lines: [{ name: '甲', quantity: 4, unit: '个', price: 10 }, { name: '乙', quantity: 2, unit: '个', price: 10 }] });
    await post('/orders', { ...base, po: 'PO-SHIPB', lines: [{ name: '丙', quantity: 2, unit: '个', price: 10 }] });
    await page.route('**/api/state', async route => {
      const response = await route.fetch();
      const body = await response.json();
      body.order_lines = body.order_lines.map(line => ({ ...line, demand_quantity: line.quantity, dispatched_quantity: line.name === '甲' ? 4 : line.name === '乙' ? 0 : line.quantity }));
      await route.fulfill({ response, json: body });
    });
    await page.reload();
    await page.locator('.orders-list .date-range').waitFor();
    const cellOf = po => page.locator('.orders-list tbody tr').filter({ hasText: po }).locator('td[title*="点击查看送货单"]');
    const partial = cellOf('PO-SHIPA');
    assert.equal((await partial.innerText()).replace(/\s/g, ''), '4/6', '部分发货应显示 已发货 / 需求');
    assert.equal(await partial.locator('.order-shipped-incomplete').count(), 1, '未发齐应为橙色');
    const full = cellOf('PO-SHIPB');
    assert.equal((await full.innerText()).replace(/\s/g, ''), '2/2');
    assert.equal(await full.locator('.order-shipped-complete').count(), 1, '发齐应为绿色');
    assert.equal(await cellOf('PO-SHIPA').locator('text=查看').count(), 0, '送货单列不应再显示“查看”');
    await page.locator('.orders-list').first().screenshot({ path: path.join(temp, 'orders.png') });
    assert.deepEqual(errors, [], `页面报错：${errors.join(' | ')}`);
    console.log('OK 送货单列显示已发货/数量；截图：', path.join(temp, 'orders.png'));
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exit(1); });
