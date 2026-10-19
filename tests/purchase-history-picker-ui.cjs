const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-history-picker-'));
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
    const page = await browser.newPage({ viewport: { width: 1625, height: 892 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/#purchases');
    await page.getByLabel('账号', { exact: true }).fill('admin');
    await page.getByLabel('密码', { exact: true }).fill('11111111');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('button', { name: '平台采购', exact: true }).waitFor();
    const post = (route, body) => page.evaluate(async ({ route, body }) => {
      const response = await fetch('/api' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error);
      return payload;
    }, { route, body });
    const customer = await post('/customers', { name: '历史订单客户', contacts: [{ name: '周工', phone: '13800000066' }], addresses: [{ address: '测试地址 66 号', contact: '周工', phone: '13800000066' }] });
    const order = await post('/orders', { customer_id: customer.id, customer: '历史订单客户', contact: '周工', phone: '13800000066', address: '测试地址 66 号', po: 'PO-HISTORY-1', lines: [{ name: '历史补充料品', spec: 'H-1', quantity: 10, unit: '个', price: 20 }] });
    await post(`/orders/${order.id}/confirm`, {});
    const before = await page.evaluate(async () => (await (await fetch('/api/state')).json()));
    const line = before.order_lines.find(item => item.name === '历史补充料品');
    await post('/purchases', { platform: '对公', shop: '原采购供应商', purchased_date: '2026-10-17', amount: '200.00', lines: [{ order_line_id: line.id, quantity: 10, cost: '200.00', receive_mode: 'direct', purchase_unit: '个', purchase_spec: 'H-1' }] });
    await page.reload();
    await page.getByRole('button', { name: '平台采购', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '登记平台采购' });
    await dialog.getByRole('button', { name: '关联料品', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '选择客户订单料品' });
    await picker.waitFor();
    await page.waitForTimeout(300);
    assert.equal(await picker.getByText('历史补充料品').count(), 0, '普通模式不应显示已采满的料品');
    const historyButton = picker.getByRole('button', { name: '历史订单', exact: true });
    assert.equal(await historyButton.getAttribute('aria-pressed'), 'false', '历史订单默认不选中');
    await historyButton.click();
    assert.equal(await historyButton.getAttribute('aria-pressed'), 'true', '点击后应处于选中状态');
    const historyRow = picker.locator('tbody tr').filter({ hasText: '历史补充料品' });
    await historyRow.waitFor();
    assert.ok((await historyRow.innerText()).includes('历史'), '历史料品应有历史标记');
    await historyRow.getByRole('button', { name: '选择', exact: true }).click();
    await picker.getByRole('button', { name: /确认选择/ }).click();
    const quantity = dialog.getByLabel('历史补充料品对应需求数量');
    await quantity.waitFor();
    assert.equal(await quantity.inputValue(), '1', '历史料品默认补充数量为 1');
    await dialog.getByLabel('供应商 *').fill('补充采购供应商');
    await dialog.getByLabel('订单号 *').fill('3316506062147162599');
    await dialog.getByLabel('实付款 *').fill('20.00');
    await dialog.getByRole('button', { name: '保存采购记录', exact: true }).click();
    await page.locator('.toast').filter({ hasText: '采购已保存' }).waitFor();
    const after = await page.evaluate(async () => (await (await fetch('/api/state')).json()));
    const saved = after.purchase_lines.filter(item => item.order_line_id === line.id);
    assert.equal(saved.length, 2, '同一客户料品应有两笔采购（原采购 + 补充采购）');
    assert.equal(saved.reduce((sum, item) => sum + item.quantity, 0), 11, '补充采购允许超出客户原需求（10 + 1）');
    assert.deepEqual(errors, [], `页面不应有脚本错误：${errors.join(' | ')}`);
    console.log('OK 历史订单：可切换只显示已采购料品、默认补充 1 个并允许超量保存');
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exit(1); });
