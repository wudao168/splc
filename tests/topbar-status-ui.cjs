const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-topbar-'));
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
    const page = await browser.newPage({ viewport: { width: 1575, height: 892 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/#purchases');
    await page.getByLabel('账号', { exact: true }).fill('admin');
    await page.getByLabel('密码', { exact: true }).fill('11111111');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.locator('.app-topbar').waitFor();
    await page.waitForFunction(() => document.querySelector('.status-center .status-text')?.textContent.includes('尚未检测到客户端在线'));

    // 顶栏顺序：状态消息 → 日期时间 → 主题 → 管理员 → 退出
    const order = await page.evaluate(() => [...document.querySelectorAll('.app-topbar-actions > *')].map(node => node.className));
    assert.equal(order[0], 'status-center info');
    assert.equal(order[1], 'topbar-clock');
    assert.ok(order[2].includes('theme-picker'));

    // 日期时间窗口：日期 + 星期 + 秒级时间 + 周数，并且每秒跳动
    const clock = page.locator('.topbar-clock');
    const clockBefore = (await clock.textContent()).trim();
    assert.match(clockBefore, /^\d{4}-\d{2}-\d{2} 周[一二三四五六日] \d{2}:\d{2}:\d{2} 第\d{1,2}周$/);
    await page.waitForTimeout(1200);
    assert.notEqual((await clock.textContent()).trim(), clockBefore);

    // 没有客户端心跳时给出提示，点击可展开消息列表
    const summary = page.locator('.status-center > summary');
    await summary.waitFor();
    assert.match(await summary.textContent(), /尚未检测到客户端在线/);
    await summary.click();
    const menu = page.locator('.status-menu');
    await menu.waitFor();
    await page.screenshot({ path: path.join(root, '.data', 'topbar-status.png') });
    assert.ok(await menu.locator('.status-item').count() >= 1);
    assert.match(await menu.locator('.status-item time').first().textContent(), /^\d{2}-\d{2} \d{2}:\d{2}$/);
    // 点击消息项跳转采购页并收起菜单
    await menu.locator('.status-item').first().click();
    await page.waitForFunction(() => location.hash === '#purchases');
    assert.equal(await page.locator('.status-center[open]').count(), 0);

    // 请求立即同步后，状态窗口显示等待客户端执行
    await page.evaluate(async () => {
      const response = await fetch('/api/sync-now', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) throw new Error((await response.json()).error);
    });
    await page.reload();
    await page.locator('.status-center > summary').waitFor();
    await page.waitForFunction(() => document.querySelector('.status-center .status-text')?.textContent.includes('等待客户端执行'));
    assert.ok((await page.locator('.status-center').getAttribute('class')).includes('info'));

    // 窄屏隐藏日期窗口，状态窗口保留
    await page.setViewportSize({ width: 900, height: 800 });
    assert.equal(await clock.isVisible(), false);
    assert.equal(await page.locator('.status-center > summary').isVisible(), true);

    assert.deepEqual(errors, []);
    console.log('topbar status UI ok；截图：', path.join(root, '.data', 'topbar-status.png'));
  } finally {
    if (browser) await browser.close();
    server.kill();
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
