const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-order-status-'));
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
    const customer = await post('/customers', { name: '状态列测试客户', addresses: [{ address: '江苏省苏州市昆山市许塘路8号' }] });
    const order = await post('/orders', {
      customer_id: customer.id, customer: '状态列测试客户', po: 'PO-STATUS-1', address: '江苏省苏州市昆山市许塘路8号',
      lines: [{ name: '空压机', spec: 'VA-6', quantity: 10, unit: '个', price: 47.83 }]
    });
    await post(`/orders/${order.id}/confirm`, {});
    const state = await page.evaluate(async () => (await fetch('/api/state')).json());
    const orderLine = state.order_lines.find(line => line.order_id === order.id);
    await post('/purchases', {
      platform: '淘宝', shop: '状态列测试店铺', platform_order: 'TB-STATUS-1', amount: '478.30', purchased_date: '2026-10-09',
      lines: [{ order_line_id: orderLine.id, quantity: 10, cost: '478.30', receive_mode: 'direct' }]
    });
    await page.reload();
    await page.locator('.orders-list .date-range').waitFor({ timeout: 20000 });

    const cell = page.locator('.orders-list tbody tr').filter({ hasText: 'PO-STATUS-1' }).locator('td.order-status');
    const badge = cell.locator('.badge');
    const badgeText = (await badge.innerText()).trim();
    const title = await cell.getAttribute('title');
    const titleLines = title.split('\n');
    assert.equal(titleLines[0], badgeText, `预览首行应为当前状态：${titleLines[0]} / ${badgeText}`);
    assert.equal(titleLines.includes('采购在途 10'), true, '预览包含采购在途明细：' + title);
    assert.equal(titleLines.includes('备货 10/10'), true, '预览包含备货明细：' + title);

    // 单元格只显示当前状态，不再溢出
    assert.equal(await cell.locator('small').count(), 0, '状态列不再输出明细行');
    const box = await cell.locator('.fixed-cell-content').evaluate(node => ({ clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth }));
    assert.equal(box.scrollHeight <= box.clientHeight + 1, true, `内容没有纵向溢出：${box.scrollHeight}/${box.clientHeight}`);
    assert.equal(box.scrollWidth <= box.clientWidth + 1, true, `内容没有横向溢出：${box.scrollWidth}/${box.clientWidth}`);
    const rowHeights = await page.locator('.orders-list tbody tr').evaluateAll(rows => rows.map(row => Math.round(row.getBoundingClientRect().height)));
    assert.equal(new Set(rowHeights).size, 1, '所有行高度一致（状态列不再撑高）：' + rowHeights.join(','));
    assert.deepEqual(errors, [], 'console errors: ' + errors.join(' | '));
    console.log(JSON.stringify({ passed: true, badgeText, titleLines, rowHeights, box }));
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exit(1); });
