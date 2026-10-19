const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-page-state-'));
  const python = process.env.CAIDAN_PYTHON || path.join(root, '.venv', 'Scripts', 'python.exe');
  const server = spawn(python, ['-u', '-m', 'server.app', '--port', '0'], { cwd: root, env: { ...process.env, CAIDAN_DATA: path.join(temp, 'data') }, windowsHide: true });
  let browser;
  try {
    const origin = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('服务启动超时')), 30000);
      server.on('error', reject);
      server.on('exit', code => reject(new Error('服务已退出 ' + code)));
      server.stdout.on('data', chunk => {
        output += chunk.toString();
        const match = output.match(/Caidan running at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1805, height: 991 } });
    const errors = [];
    page.on('pageerror', error => errors.push('pageerror: ' + error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push('console: ' + message.text()); });
    await page.goto(origin + '/#purchases');
    await page.getByLabel('账号', { exact: true }).fill('admin');
    await page.getByLabel('密码', { exact: true }).fill('11111111');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.locator('.purchases-list .toolbar').waitFor({ timeout: 20000 });
    const nav = name => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true });
    const purchaseTab = name => page.locator('.page-pane:not([hidden]) .tabs').getByRole('button', { name, exact: true });
    const activePurchaseTab = async () => (await page.locator('.page-pane:not([hidden]) .tabs button.active').innerText()).trim();
    const activeOrderTab = async () => (await page.locator('.tabs:visible button.active').first().innerText()).trim();

    // 采购页：切到“淘宝订单”页签并输入搜索条件
    await purchaseTab('淘宝订单').click();
    await page.locator('.page-pane:not([hidden]) .search input').fill('页面状态');
    assert.equal(await activePurchaseTab(), '淘宝订单', '采购页可切到淘宝订单页签');

    // 切到订单页再回采购页：页签与搜索内容都应保留
    await nav('订单').click();
    await page.locator('.orders-list .date-range').waitFor({ timeout: 20000 });
    assert.equal(await page.locator('.page-pane:not([hidden]) .orders-list').count(), 1, '订单页为当前显示页面');
    await nav('采购').click();
    await page.locator('.page-pane:not([hidden]) .purchase-drafts-list .toolbar').waitFor({ timeout: 20000 });
    assert.equal(await activePurchaseTab(), '淘宝订单', '切回采购页仍停留在淘宝订单页签');
    assert.equal(await page.locator('.page-pane:not([hidden]) .search input').inputValue(), '页面状态', '采购页搜索条件保留');

    // 订单页：切到回收站，离开再回来仍停留在回收站
    await nav('订单').click();
    await page.locator('.orders-list .date-range').waitFor({ timeout: 20000 });
    await page.locator('.tabs:visible').getByRole('button', { name: '回收站', exact: true }).click();
    await page.waitForTimeout(300);
    assert.equal(await activeOrderTab(), '回收站', '订单页可切到回收站页签');
    await nav('库存').click();
    await page.locator('.inventory-page').first().waitFor({ timeout: 20000 });
    await nav('订单').click();
    await page.locator('.orders-list .date-range').waitFor({ timeout: 20000 });
    assert.equal(await activeOrderTab(), '回收站', '切回订单页仍停留在回收站页签');

    // 未访问过的页面不提前挂载；访问过的页面保持挂载（切页只隐藏）
    await nav('产品').click();
    await page.locator('.products-page').first().waitFor({ timeout: 20000 });
    assert.equal(await page.locator('.page-pane[hidden] .purchase-drafts-list').count(), 1, '离开采购页后采购页保持挂载但隐藏');
    assert.equal(await page.locator('.page-pane:not([hidden]) .products-page').count(), 1, '产品页为当前显示页面');

    assert.deepEqual(errors, [], `页面报错：${errors.join(' | ')}`);
    console.log('OK 切换导航后各页面保留页签与筛选状态；截图：', temp);
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exit(1); });
