const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-purge-'));
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
    const customer = await post('/customers', { name: '彻底删除测试客户', addresses: [{ address: '成都市武侯区' }] });
    const first = await post('/orders', { customer_id: customer.id, customer: '彻底删除测试客户', po: 'PO-PURGE-1', address: '成都市武侯区', lines: [{ name: '空压机', quantity: 2, unit: '个', price: 100 }] });
    const second = await post('/orders', { customer_id: customer.id, customer: '彻底删除测试客户', po: 'PO-PURGE-2', address: '成都市武侯区', lines: [{ name: '滤芯', quantity: 1, unit: '个', price: 30 }] });
    await post(`/orders/${first.id}/confirm`, {});
    await post(`/orders/${second.id}/confirm`, {});
    await post('/orders/delete', { items: [{ type: 'order', id: first.id }] });
    await page.reload();
    await page.locator('.orders-list .date-range').waitFor({ timeout: 20000 });

    // 回收站：恢复 + 彻底删除
    await page.locator('.tabs').getByRole('button', { name: '回收站', exact: true }).click();
    const trash = page.getByRole('heading', { name: '回收站' }).locator('..');
    await page.getByRole('cell', { name: 'PO-PURGE-1' }).waitFor({ timeout: 10000 });
    const row = page.locator('tbody tr').filter({ hasText: 'PO-PURGE-1' });
    assert.equal(await row.getByRole('button', { name: '恢复', exact: true }).count(), 1, '回收站保留恢复按钮');
    await row.getByRole('button', { name: '彻底删除', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '彻底删除记录' });
    await dialog.getByText(/永久删除/).waitFor();
    await dialog.getByRole('button', { name: '确认彻底删除' }).click();
    await page.getByText('记录已彻底删除').waitFor({ timeout: 20000 });
    await page.getByText('回收站为空').waitFor({ timeout: 10000 });
    const state = await page.evaluate(async () => (await fetch('/api/state')).json());
    assert.equal(state.orders.some(o => o.po === 'PO-PURGE-1'), false, '订单已从数据中移除');
    assert.equal(state.trash.some(item => item.label === 'PO-PURGE-1'), false, '回收站不再有该记录');
    assert.equal(state.order_lines.some(line => line.order_id === first.id), false, '订单明细一并删除');

    // 删除后同一客户 PO 可以重新导入
    await page.locator('.tabs').getByRole('button', { name: '客户订单', exact: true }).click();
    await page.waitForTimeout(300);
    const again = await post('/orders', { customer_id: customer.id, customer: '彻底删除测试客户', po: 'PO-PURGE-1', address: '成都市武侯区', lines: [{ name: '空压机', quantity: 2, unit: '个', price: 100 }] });
    assert.ok(again.id > 0, '彻底删除后同一 PO 可以重新导入');
    assert.deepEqual(errors, [], 'console errors: ' + errors.join(' | '));
    console.log(JSON.stringify({ passed: true, purgedOrder: first.id, reimportedOrder: again.id, remaining: (await page.evaluate(async () => (await fetch('/api/state')).json())).orders.map(o => o.po) }));
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exit(1); });
