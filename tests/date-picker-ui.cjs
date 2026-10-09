const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

// 日期框整块可点：点击框内任意位置、以及两个日期之间的“至/－”分隔文字都应唤起日历。
(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-date-picker-'));
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
    await page.goto(origin + '/#orders');
    await page.getByLabel('账号', { exact: true }).fill('admin');
    await page.getByLabel('密码', { exact: true }).fill('11111111');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '订单', exact: true }).waitFor();
    await page.evaluate(() => {
      window.__opened = [];
      window.__pickerErrors = [];
      const original = HTMLInputElement.prototype.showPicker;
      HTMLInputElement.prototype.showPicker = function () {
        window.__opened.push(this.getAttribute('aria-label') || this.closest('label')?.querySelector('span')?.textContent || '未命名');
        try { original?.call(this); } catch (error) { window.__pickerErrors.push(String(error?.name || error)); }
      };
    });
    const opened = () => page.evaluate(() => window.__opened);
    const go = async (hash, ready) => { await page.evaluate(next => { location.hash = next; }, hash); await ready(); };

    await go('#orders', () => page.locator('.date-range input[type=date]').first().waitFor());
    await page.locator('.date-range > span').click();
    assert.deepEqual(await opened(), ['订单起始日期'], '点击“至”应打开更近的起始日期');
    await page.getByLabel('订单起始日期').click({ position: { x: 8, y: 8 } });
    assert.deepEqual(await opened(), ['订单起始日期', '订单起始日期'], '点击日期框内文字区域也应打开日历');
    await page.getByLabel('订单起始日期').fill('2026-09-01');
    assert.equal(await page.locator('.date-range').getByRole('button', { name: '清除' }).count(), 1);
    await page.locator('.date-range').getByRole('button', { name: '清除' }).click();
    assert.deepEqual(await opened(), ['订单起始日期', '订单起始日期'], '“清除”按钮不应弹出日历');
    assert.equal(await page.getByLabel('订单起始日期').inputValue(), '', '清除后日期应被清空');
    await page.screenshot({ path: path.join(temp, 'orders-toolbar.png'), clip: { x: 208, y: 90, width: 1060, height: 210 } });

    await go('#dashboard', () => page.getByLabel('报表开始日期').waitFor());
    await page.getByLabel('报表开始日期').click({ position: { x: 8, y: 8 } });
    assert.deepEqual(await opened(), ['订单起始日期', '订单起始日期', '报表开始日期']);

    await go('#import', () => page.getByLabel('期望交期').waitFor());
    await page.getByLabel('期望交期').click({ position: { x: 8, y: 8 } });
    assert.equal((await opened()).at(-1), '期望交期');
    const count = (await opened()).length;
    await page.locator('.order-header-grid .field').filter({ has: page.getByLabel('期望交期') }).locator('span').first().click();
    // 浏览器会把 label 上的点击转发给日期输入框，因此点标题同样会打开该日期框
    assert.equal((await opened()).length, count + 1, '点击字段标题也应打开对应的日期框');
    assert.equal((await opened()).at(-1), '期望交期');

    const pickerErrors = await page.evaluate(() => window.__pickerErrors);
    assert.deepEqual(pickerErrors, [], `真实 showPicker 调用报错：${pickerErrors.join(' | ')}`);
    assert.deepEqual(errors, [], `页面报错：${errors.join(' | ')}`);
    console.log('OK 日期框整块可点；截图：', path.join(temp, 'orders-toolbar.png'));
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exit(1); });
