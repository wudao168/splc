const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-import-columns-'));
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
    await page.goto(origin + '/#import');
    await page.getByLabel('账号', { exact: true }).fill('admin');
    const setup = await page.getByLabel('姓名', { exact: true }).count();
    if (setup) await page.getByLabel('姓名', { exact: true }).fill('管理员');
    await page.getByLabel('密码', { exact: true }).fill('11111111');
    await page.getByRole('button', { name: setup ? '创建并进入' : '登录', exact: true }).click();
    const panel = page.locator('.import-lines');
    await panel.locator('thead').waitFor({ timeout: 20000 });

    // 列设置按钮存在、尺寸与右侧按钮一致、垂直居中对齐
    const settings = panel.locator('.column-settings > summary');
    const save = panel.getByRole('button', { name: '保存订单' });
    const settingsBox = await settings.boundingBox();
    const saveBox = await save.boundingBox();
    assert.equal(Math.round(settingsBox.width), 100, '列设置按钮宽 100px');
    assert.equal(Math.round(settingsBox.height), 32, '列设置按钮高 32px');
    assert.equal(Math.abs(settingsBox.y + settingsBox.height / 2 - (saveBox.y + saveBox.height / 2)) <= 1, true, '与保存订单垂直对齐');
    assert.equal(settingsBox.x < saveBox.x, true, '列设置在保存按钮左侧');

    const visibleHeader = async label => panel.locator('thead th', { hasText: label }).first().isVisible();
    const cellBox = async (selector, text) => panel.locator(selector).filter({ hasText: text }).first().boundingBox();
    assert.equal(await visibleHeader('品牌'), true, '默认显示品牌列');
    const headerQuantity = await cellBox('thead th', '数量');
    const totalQuantity = await cellBox('.import-total-row td', '0');

    // 取消勾选「品牌」
    await settings.click();
    await panel.locator('.column-settings-menu').getByLabel('品牌').uncheck();
    await page.waitForTimeout(300);
    assert.equal(await visibleHeader('品牌'), false, '取消勾选后品牌列隐藏');
    assert.equal(await panel.locator('.import-total-row td').count(), 17, '合计行保持逐列单元格');
    const headerQuantityAfter = await cellBox('thead th', '数量');
    assert.equal(Math.abs(headerQuantityAfter.x - headerQuantity.x) > 1, true, '隐藏列后表格重新收拢');
    assert.equal(Math.abs(Math.round(headerQuantityAfter.x) - Math.round(totalQuantity.x - (headerQuantity.x - headerQuantityAfter.x))) <= 4, true, '合计行与表头对齐');

    // 按账号记住选择：刷新 + 接口核对
    await page.reload();
    await panel.locator('thead').waitFor({ timeout: 20000 });
    assert.equal(await visibleHeader('品牌'), false, '刷新后仍隐藏品牌列');
    const status = await page.evaluate(async () => (await fetch('/api/auth/status')).json());
    assert.deepEqual(status.user.column_settings.import_lines, ['brand'], '列设置已按账号保存：' + JSON.stringify(status.user.column_settings));

    // 恢复默认
    await panel.locator('.column-settings > summary').click();
    await panel.locator('.column-settings-menu').getByRole('button', { name: '恢复默认' }).click();
    await page.waitForTimeout(300);
    assert.equal(await visibleHeader('品牌'), true, '恢复默认后重新显示品牌列');
    const statusAfter = await page.evaluate(async () => (await fetch('/api/auth/status')).json());
    assert.deepEqual(statusAfter.user.column_settings.import_lines || [], [], '恢复默认后清空记录');
    assert.deepEqual(errors, [], 'console errors: ' + errors.join(' | '));
    console.log(JSON.stringify({ passed: true, settings: { w: Math.round(settingsBox.width), h: Math.round(settingsBox.height), y: Math.round(settingsBox.y) }, save: { y: Math.round(saveBox.y) } }));
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exit(1); });
