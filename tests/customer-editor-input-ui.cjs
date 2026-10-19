const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-customer-editor-'));
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
    await page.goto(origin + '/#customers');
    await page.getByLabel('账号', { exact: true }).fill('admin');
    await page.getByLabel('密码', { exact: true }).fill('11111111');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.locator('.customer-list .toolbar').waitFor({ timeout: 20000 });

    await page.getByRole('button', { name: '新增客户', exact: true }).click();
    const modal = page.locator('.modal');
    await modal.waitFor({ timeout: 10000 });
    const name = modal.getByLabel('客户名称 *', { exact: true });
    const note = modal.getByLabel('客户备注', { exact: true });
    assert.equal(await name.evaluate(el => document.activeElement === el), true, '打开新增客户后“客户名称”应自动聚焦');
    await page.keyboard.type('自动聚焦客户');
    assert.equal(await name.inputValue(), '自动聚焦客户', '不用先点击即可直接输入客户名称');
    await note.click();
    await page.keyboard.type('备注内容');
    assert.equal(await note.inputValue(), '备注内容', '客户备注可以输入');
    // 顶部时钟每秒重渲染 App：正在输入的字段不能被弹窗抢走焦点（否则光标会跳回客户名称）
    await page.waitForTimeout(1600);
    assert.equal(await note.evaluate(el => document.activeElement === el), true, '时钟刷新后焦点仍应留在客户备注');
    await page.keyboard.type('跨秒');
    await page.waitForTimeout(1300);
    assert.equal(await note.inputValue(), '备注内容跨秒', '跨秒输入不应丢字');
    assert.equal(await note.evaluate(el => document.activeElement === el), true, '输入过程中光标不应跳到客户名称');
    assert.equal(await name.inputValue(), '自动聚焦客户', '客户名称内容不应被串改');
    await modal.getByLabel('联系人 1 *', { exact: true }).count().then(async count => {
      if (!count) await modal.getByRole('button', { name: '添加联系人', exact: true }).click();
    });
    const contact = modal.getByLabel('联系人 1 *', { exact: true });
    await contact.click();
    await page.keyboard.type('张工');
    assert.equal(await contact.inputValue(), '张工', '联系人可以输入');
    await modal.getByRole('button', { name: '保存客户资料', exact: true }).click();
    await page.locator('.customer-list tbody tr').filter({ hasText: '自动聚焦客户' }).first().waitFor({ timeout: 15000 });

    await page.locator('.customer-list tbody tr').filter({ hasText: '自动聚焦客户' }).first().getByRole('button', { name: '编辑', exact: true }).click();
    const editModal = page.locator('.modal');
    await editModal.waitFor({ timeout: 10000 });
    const editName = editModal.getByLabel('客户名称 *', { exact: true });
    assert.equal(await editName.inputValue(), '自动聚焦客户');
    await editName.click();
    await page.keyboard.press('End');
    await page.keyboard.type('二');
    assert.equal(await editName.inputValue(), '自动聚焦客户二', '编辑客户时可以继续输入');
    await editModal.getByRole('button', { name: '保存客户资料', exact: true }).click();
    await page.locator('.customer-list tbody tr').filter({ hasText: '自动聚焦客户二' }).first().waitFor({ timeout: 15000 });

    assert.deepEqual(errors, [], `页面报错：${errors.join(' | ')}`);
    console.log('OK 新增客户打开即可输入（自动聚焦）、备注/联系人可输入、编辑客户可继续输入；截图：', temp);
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exit(1); });
