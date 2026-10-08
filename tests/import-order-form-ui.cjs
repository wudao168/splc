const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-auto-po-'));
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
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(origin + '/#import');
    await page.getByLabel('账号', { exact: true }).fill('admin');
    await page.getByLabel('密码', { exact: true }).fill('11111111');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('button', { name: '询价导入', exact: true }).waitFor();
    const post = (route, body) => page.evaluate(async ({ route, body }) => {
      const response = await fetch('/api' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error);
      return payload;
    }, { route, body });
    const auto = page.getByLabel('按规则自动生成内部 PO 号');
    const poInput = page.getByLabel('客户 PO / 询价单号 *');

    await auto.click();
    await page.getByText('请先在“设置 · 公司信息”中填写公司代码').waitFor();
    assert.equal(await auto.isChecked(), false, '缺少公司代码时不应勾选');
    assert.equal(await poInput.inputValue(), '');

    await post('/company', { name: '上海思品利诚智能科技有限公司', company_code: 'sl' });
    await post('/customers', { name: '自动编号客户', contacts: [{ name: '张三', phone: '13900000000' }], addresses: [{ address: '测试地址1088号', contact: '张三', phone: '13900000000' }] });
    await page.reload();
    await page.getByRole('button', { name: '询价导入', exact: true }).waitFor();

    await auto.click();
    await page.getByText('已按规则生成内部 PO 号').waitFor();
    const generated = await poInput.inputValue();
    assert.match(generated, /^POSL\d{8}001$/, `生成号码格式应为 PO+公司代码+日期+流水号：${generated}`);
    assert.equal(await poInput.isEditable(), false, '自动生成的号码应为只读');
    await page.screenshot({ path: path.join(temp, 'header.png'), clip: { x: 470, y: 60, width: 1100, height: 300 } });

    const address = await page.locator('.address-combobox').boundingBox();
    const due = await page.getByLabel('期望交期').boundingBox();
    assert.ok(Math.abs(address.width - due.width) < 2, `收货地址应与其他输入框等宽：${address.width} vs ${due.width}`);

    await page.getByLabel('客户名称').fill('自动编号客户');
    await page.getByRole('option', { name: '自动编号客户' }).click();
    await page.getByLabel('收货地址 *').click();
    await page.locator('.address-options button').first().click();
    await page.getByLabel('业务员').selectOption({ label: '管理员' });
    await page.getByLabel('第1行料品名称').fill('测试料品');
    await page.getByLabel('第1行数量').fill('2');
    await page.getByLabel('第1行备注').fill('加急');
    await page.getByRole('checkbox', { name: '已核对料品、规格、数量与收货信息' }).check();
    await page.getByRole('button', { name: '保存订单' }).click();
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '客户订单', exact: true }).waitFor();
    const saved = await page.evaluate(async () => {
      const state = await (await fetch('/api/state')).json();
      return { orders: state.orders.map(order => ({ po: order.po, salesperson_id: order.salesperson_id })), remarks: state.order_lines.map(line => line.remark) };
    });
    assert.deepEqual(saved.orders, [{ po: generated, salesperson_id: 1 }], `订单应使用自动生成的号码并记录业务员：${JSON.stringify(saved.orders)}`);
    assert.deepEqual(saved.remarks, ['加急'], `料品备注应随订单保存：${JSON.stringify(saved.remarks)}`);

    await page.goto(origin + '/#import');
    await page.getByRole('button', { name: '询价导入', exact: true }).waitFor();
    const next = await page.evaluate(async () => (await (await fetch('/api/orders/next-po', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).po);
    assert.match(next, /^POSL\d{8}002$/);

    await page.goto(origin + '/#settings');
    await page.getByRole('button', { name: '公司信息', exact: true }).click();
    const codeInput = page.getByLabel('公司代码');
    assert.equal(await codeInput.inputValue(), 'SL');
    await codeInput.fill('zj');
    await page.getByRole('button', { name: '保存公司信息' }).click();
    await page.getByText('公司信息已保存').waitFor();
    const code = await page.evaluate(async () => (await (await fetch('/api/state')).json()).company.company_code);
    assert.equal(code, 'ZJ', '公司代码应自动转为大写保存');
    await page.locator('.settings-company-form').screenshot({ path: path.join(temp, 'settings.png') });

    assert.deepEqual(errors, [], `页面报错：${errors.join(' | ')}`);
    console.log('OK 生成的内部 PO 号：', generated, '下一个：', next);
    console.log('截图：', path.join(temp, 'header.png'));
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exit(1); });
