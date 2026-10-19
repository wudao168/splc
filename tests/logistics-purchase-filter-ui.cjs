const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-logi-'));
  const python = process.env.CAIDAN_PYTHON || path.join(root, '.venv', 'Scripts', 'python.exe');
  const server = spawn(python, ['-u', '-m', 'server.app', '--port', '0'], { cwd: root, env: { ...process.env, CAIDAN_DATA: path.join(temp, 'data') }, windowsHide: true });
  let browser;
  try {
    const origin = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('服务启动超时')), 30000);
      server.on('error', reject);
      server.stdout.on('data', chunk => {
        output += chunk.toString();
        const match = output.match(/Caidan running at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1805, height: 991 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + '/#purchases');
    await page.getByLabel('账号', { exact: true }).fill('admin');
    await page.getByLabel('密码', { exact: true }).fill('11111111');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('button', { name: '平台采购', exact: true }).waitFor();
    const post = (route, body) => page.evaluate(async ({ route, body }) => {
      const response = await fetch('/api' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(route + ': ' + payload.error);
      return payload;
    }, { route, body });
    const order = await post('/orders', { customer: '物流筛选客户', po: 'PO-LOGI', address: '地址', lines: [{ name: '筛选料品', quantity: 2, unit: '个', price: 10 }] });
    await post(`/orders/${order.id}/confirm`, {});
    const state = await page.evaluate(async () => (await fetch('/api/state')).json());
    const line = state.order_lines.find(l => l.order_id === order.id);
    const purchase = await post('/purchases', { platform: '京东', shop: '筛选店铺', platform_order: 'JD-LOGI', amount: 20,
      lines: [{ order_line_id: line.id, quantity: 2, cost: 20, receive_mode: 'direct' }] });
    const purchaseLine = (await page.evaluate(async () => (await fetch('/api/state')).json())).purchase_lines.find(l => l.purchase_id === purchase.id);
    const pkg = await post('/packages', { carrier: '中通快递', tracking: 'LOGITEST1', lines: [{ purchase_line_id: purchaseLine.id, quantity: 2 }] });
    await post(`/packages/${pkg.id}/tracking`, { status: '派送中', signed_at: '', description: '派送中' });
    await page.reload();
    await page.locator('.purchases-list table').waitFor();
    const filter = page.getByLabel('物流状态筛选');
    assert.equal(await filter.count(), 1, '物流状态筛选框存在');
    await filter.selectOption('派送中');
    await page.waitForTimeout(300);
    const rows = page.locator('.purchases-list tbody tr:not(.purchase-summary)');
    assert.equal(await rows.count(), 1, '仅显示派送中的采购');
    assert.ok((await rows.first().innerText()).includes('JD-LOGI'));
    await filter.selectOption('已签收');
    await page.waitForTimeout(300);
    assert.equal(await rows.count(), 0, '已签收筛选无结果');
    await page.screenshot({ path: 'E:/SPLC/.data/layout-check/logistics-filter.png' });
    assert.deepEqual(errors, []);
    console.log('logistics filter ok');
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exit(1); });
