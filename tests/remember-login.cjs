const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-remember-test-'));
  const python = process.env.CAIDAN_PYTHON || path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
  const server = spawn(python, ['-u', '-m', 'server.app', '--port', '0'], {
    cwd: root, env: {...process.env, CAIDAN_DATA: path.join(temp, 'data')}, windowsHide: true
  });
  let browser;
  try {
    const origin = await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('本机服务启动超时')), 30000);
      server.on('error', reject);
      server.on('exit', code => reject(new Error(`本机服务退出：${code}`)));
      server.stdout.on('data', chunk => {
        output += chunk.toString();
        const match = output.match(/Caidan running at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
    });
    const options = {executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true};
    browser = await chromium.launchPersistentContext(path.join(temp, 'profile'), options);
    let page = await browser.newPage();
    await page.goto(origin);
    await page.getByText('记住密码（自动登录）').waitFor();
    assert.equal(await page.evaluate(() => document.querySelector('input[type="checkbox"]').checked), false);
    await page.addInitScript(() => { window.caidanDesktop = {
      onOrder: () => () => {}, pendingOrder: () => Promise.resolve(null), onSync: () => () => {}
    }; });
    await page.reload();
    await page.getByText('记住密码（自动登录）').waitFor();
    assert.equal(await page.evaluate(() => document.querySelector('input[type="checkbox"]').checked), true);
    await page.getByLabel('账号', {exact: true}).fill('admin');
    await page.getByLabel('密码', {exact: true}).fill('11111111');
    await page.getByRole('button', {name: '登录', exact: true}).click();
    await page.getByRole('navigation', {name: '主导航'}).getByRole('button', {name: '采购', exact: true}).waitFor();
    await browser.close(); browser = null;
    browser = await chromium.launchPersistentContext(path.join(temp, 'profile'), options);
    page = await browser.newPage();
    await page.goto(origin);
    await page.getByRole('navigation', {name: '主导航'}).getByRole('button', {name: '采购', exact: true}).waitFor();
    console.log('记住登录：重启后直接进入页面');
  } finally {
    if (browser) await browser.close();
    server.kill();
    await fs.rm(temp, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
