const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-logistics-head-'));
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
    await page.route('**/api/state', async route => {
      const response = await route.fetch();
      const body = await response.json();
      body.purchases = [{ id: 9001, platform: '淘宝', platform_order: 'TB-LOG-1', shop: '测试店铺', amount_cents: 1000, purchased_date: '2026-10-09', created_at: '2026-10-09T10:00:00+08:00',
        taobao_source: { sync_checked_at: '2026-10-09T10:46:34+08:00', packages: [{ carrier: '申通快递', tracking: '773445148754617', status: '已签收', events: [] }] } }, ...(body.purchases || [])];
      await route.fulfill({ response, json: body });
    });
    await page.reload();
    await page.locator('.purchases-list .toolbar').waitFor();
    await page.locator('.purchase-logistics-link').first().click();
    const modal = page.locator('.modal').filter({ hasText: '采购物流详情' });
    const head = modal.locator('.logistics-package-head');
    await head.waitFor();
    const badge = head.locator('.badge');
    assert.equal((await badge.innerText()).trim(), '已签收');
    const badgeBox = await badge.evaluate(el => { const rect = el.getBoundingClientRect(); return { width: Math.round(rect.width), height: Math.round(rect.height) }; });
    assert.deepEqual(badgeBox, { width: 70, height: 30 }, `状态标签应为 70×30（实际 ${badgeBox.width}×${badgeBox.height}）`);
    const copy = modal.getByRole('button', { name: '复制运单信息', exact: true });
    assert.equal(await copy.count(), 1, '复制按钮应存在');
    const geometry = await modal.evaluate(el => {
      const badge = el.querySelector('.logistics-package-head > .badge').getBoundingClientRect();
      const copy = el.querySelector('.logistics-package-head .logistics-copy').getBoundingClientRect();
      return { gap: Math.round(copy.left - badge.right), centerDiff: Math.round(Math.abs((badge.top + badge.bottom) / 2 - (copy.top + copy.bottom) / 2)) };
    });
    assert.ok(geometry.gap >= -2 && geometry.gap <= 30, `复制按钮应紧靠状态标签右侧（间距 ${geometry.gap}）`);
    assert.ok(geometry.centerDiff <= 2, `复制按钮应与状态标签上下居中对齐（偏差 ${geometry.centerDiff}）`);
    await page.screenshot({ path: path.join(temp, 'logistics.png') });
    assert.deepEqual(errors, [], `页面报错：${errors.join(' | ')}`);
    console.log('OK 物流详情：状态标签 70×30，复制按钮位于其右侧并对齐；截图：', temp);
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exit(1); });
