const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-summary-'));
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
    const customer = await post('/customers', { name: '汇总开关客户', contacts: [{ name: '王工', phone: '13800000011' }], addresses: [{ address: '测试地址11号', contact: '王工', phone: '13800000011' }] });
    await post('/orders', { customer_id: customer.id, customer: '汇总开关客户', contact: '王工', phone: '13800000011', address: '测试地址11号', po: 'PO-SUMMARY-1', lines: [{ name: '甲', quantity: 2, unit: '个', price: 10 }] });
    await page.reload();
    await page.locator('.orders-list .date-range').waitFor();

    assert.equal(await page.locator('.list-summary').count(), 0, '汇总行默认折叠');
    const toggle = page.getByRole('button', { name: '展开汇总', exact: true });
    await toggle.waitFor();
    const positions = await page.locator('.order-toolbar-actions button').evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().right)));
    const toggleRight = await toggle.evaluate(node => Math.round(node.getBoundingClientRect().right));
    assert.equal(toggleRight, Math.max(...positions), '展开汇总按钮应位于按钮区最右侧');

    await toggle.click();
    await page.locator('.list-summary').waitFor();
    assert.match(await page.locator('.list-summary').innerText(), /汇总 · 1 笔订单/, '展开后显示当前筛选汇总');
    await page.screenshot({ path: path.join(temp, 'summary-open.png') });
    await page.getByRole('button', { name: '收起汇总', exact: true }).click();
    await page.locator('.list-summary').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.list-summary').count(), 0, '再次点击收起汇总');
    assert.deepEqual(errors, [], `页面报错：${errors.join(' | ')}`);
    console.log('OK 订单汇总默认折叠、最右侧按钮展开/收起；截图：', path.join(temp, 'summary-open.png'));
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exit(1); });
