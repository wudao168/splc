// 开票信息改为「设置 · 公司信息」内嵌表单（不再弹窗）：保存、复制、导出、印章、响应式。
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-billing-ui-'));
  const python = process.env.CAIDAN_PYTHON || path.join(root, '.venv/Scripts/python.exe');
  const server = spawn(python, ['-u', '-m', 'server.app', '--port', '0'], {
    cwd: root, env: { ...process.env, CAIDAN_DATA: path.join(temp, 'data') }, windowsHide: true
  });
  let browser;
  try {
    const origin = await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('服务启动超时')), 30000);
      server.on('error', reject);
      server.stdout.on('data', chunk => {
        output += chunk.toString();
        const match = output.match(/Caidan running at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
    });
    browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const context = await browser.newContext({ viewport: { width: 1916, height: 1080 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(origin + '/#settings');
    await page.getByLabel('账号', { exact: true }).fill('admin');
    await page.getByLabel('密码', { exact: true }).fill('11111111');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('button', { name: '公司信息', exact: true }).click();
    const panel = page.locator('.settings-page .panel').filter({ hasText: '开票信息' }).last();
    const profile = { '公司名称 *': '测试智能科技有限公司', '税号': '91310120MADL4XAW73', '开户行': '中国工商银行测试支行', '账号': '0011291909300214567', '地址': '测试市测试路1088弄7号', '电话': '18551211185', '邮箱': 'test@example.com' };
    for (const [label, value] of Object.entries(profile)) await panel.getByLabel(label, { exact: true }).fill(value);
    await panel.getByRole('button', { name: '保存开票信息', exact: true }).click();
    await panel.getByRole('status').filter({ hasText: '开票信息已保存' }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: '公司信息', exact: true }).click();
    const reopened = page.locator('.settings-page .panel').filter({ hasText: '开票信息' }).last();
    for (const [label, value] of Object.entries(profile)) assert.equal(await reopened.getByLabel(label, { exact: true }).inputValue(), value);
    await reopened.getByLabel('开户行', { exact: true }).fill('中国工商银行测试支行（未保存）');
    await reopened.getByRole('button', { name: '复制开票信息' }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(copied.includes('中国工商银行测试支行（未保存）'));
    assert.ok(copied.includes(profile['账号']));
    for (const [label, extension] of [['导出 PDF', 'pdf'], ['导出 Excel', 'xlsx']]) {
      const downloadPromise = page.waitForEvent('download');
      await reopened.getByRole('button', { name: label }).click();
      const download = await downloadPromise;
      assert.equal(download.suggestedFilename(), '开票付款资料.' + extension);
      await download.saveAs(path.join(temp, 'billing.' + extension));
    }
    const saved = await page.evaluate(async () => (await (await fetch('/api/state')).json()).company);
    assert.equal(saved.bank_name, profile['开户行']);
    assert.equal(saved.bank_account, profile['账号']);
    // 公司印章仍在弹窗里维护
    const fixture = spawnSync(python, ['-c', "from PIL import Image; import sys; Image.new('RGBA',(180,180),'red').save(sys.argv[1]); Image.new('RGBA',(180,180),'blue').save(sys.argv[2])", path.join(temp, 'red.png'), path.join(temp, 'blue.png')]);
    assert.equal(fixture.status, 0);
    for (const [title, file] of [['合同章', 'red.png'], ['发货章', 'blue.png']]) {
      await page.getByRole('button', { name: '维护' + title, exact: true }).click();
      const stamp = page.getByRole('dialog', { name: title + '维护', exact: true });
      await stamp.locator('input[type=file]').setInputFiles(path.join(temp, file));
      await stamp.getByText(file, { exact: true }).waitFor();
      await stamp.getByRole('button', { name: '保存印章', exact: true }).click();
      await stamp.waitFor({ state: 'hidden' });
      await page.getByRole('img', { name: title + '预览', exact: true }).waitFor();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const box = await reopened.boundingBox();
    assert.ok(box.x >= 0 && box.width <= 390);
    for (const label of ['保存开票信息', '导出 PDF', '导出 Excel']) {
      const button = reopened.getByRole('button', { name: label, exact: true });
      await button.scrollIntoViewIfNeeded();
      assert.ok(await button.isVisible());
    }
    await page.screenshot({ path: path.join(temp, 'settings.png'), fullPage: false });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, artifacts: temp, checks: ['inline save/reopen', 'copy draft', 'PDF/XLSX download draft', 'stamps', 'mobile'] }));
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
