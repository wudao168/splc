const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-purchase-registration-'));
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
    await page.goto(origin + '/#purchases');
    await page.getByLabel('账号', { exact: true }).fill('admin');
    const setup = await page.getByLabel('姓名', { exact: true }).count();
    if (setup) await page.getByLabel('姓名', { exact: true }).fill('管理员');
    await page.getByLabel('密码', { exact: true }).fill('11111111');
    await page.getByRole('button', { name: setup ? '创建并进入' : '登录', exact: true }).click();
    await page.getByRole('button', { name: '平台采购', exact: true }).waitFor({ timeout: 20000 });
    const post = (route, body) => page.evaluate(async ({ route, body }) => {
      const response = await fetch('/api' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(route + ': ' + (payload.error || ''));
      return payload;
    }, { route, body });
    const state = () => page.evaluate(async () => (await fetch('/api/state')).json());

    // 工具栏下拉筛选宽度
    const widths = await page.evaluate(() => Array.from(document.querySelectorAll('.purchases-list .toolbar>select')).map(node => ({ label: node.getAttribute('aria-label'), width: Math.round(node.getBoundingClientRect().width) })));
    widths.forEach(entry => assert.equal(entry.width, 130, `${entry.label} 宽度应为 130px，实际 ${entry.width}`));

    /* ---------- 第二种：常规采购（产品库备货、手填单价、实付款自动汇总） ---------- */
    await post('/items', { name: '空压机', spec: 'VA-6', brand: '艾默生', unit: '个', purchase_unit: '个' });
    await page.reload();
    await page.getByRole('button', { name: '常规采购', exact: true }).waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: '常规采购', exact: true }).click();
    const regular = page.getByRole('dialog', { name: '登记常规采购' });
    await regular.getByRole('button', { name: '产品库选择', exact: true }).click();
    const productPicker = page.getByRole('dialog', { name: '从产品库选择料品' });
    await productPicker.getByRole('checkbox', { name: /选择料品/ }).first().check();
    await productPicker.getByRole('button', { name: /确认选择/ }).click();
    await page.waitForTimeout(300);
    const unitPrice = regular.getByLabel('空压机单价');
    assert.equal(await unitPrice.getAttribute('type'), 'text', '单价不使用数字微调控件');
    await unitPrice.click();
    await page.keyboard.type('12.34', { delay: 50 });
    assert.equal(await unitPrice.inputValue(), '12.34', '单价可直接逐字输入小数');
    await unitPrice.press('ArrowUp');
    assert.equal(await unitPrice.inputValue(), '12.34', '单价不再用上下箭头递增递减');
    await regular.getByLabel('空压机数量').fill('3');
    assert.equal((await regular.getByLabel('空压机金额').innerText()).trim(), '¥37.02', '金额 = 单价 × 数量');
    assert.equal(await regular.getByLabel('实付款（自动汇总）').inputValue(), '¥37.02', '实付款自动汇总');
    await regular.getByLabel('供应商 *').fill('常规备货店铺');
    await regular.getByRole('button', { name: '保存常规采购' }).click();
    await page.getByText('常规采购已保存').waitFor({ timeout: 20000 });
    let snapshot = await state();
    const regularLine = snapshot.purchase_lines.at(-1);
    assert.equal(regularLine.cost_cents, 3702, '常规采购行金额：' + regularLine.cost_cents);
    assert.equal(regularLine.unit_price_cents, 1234, '常规采购保存单价：' + regularLine.unit_price_cents);
    assert.equal(regularLine.receive_mode, 'stock', '常规采购固定入库');
    assert.equal(snapshot.purchases.at(-1).amount_cents, 3702, '实付款等于合计');
    assert.ok((await page.locator('.purchases-list tbody').innerText()).includes('常规'), '采购记录显示常规标记');

    /* ---------- 第一种：平台采购（客户料品、自动分摊、可手改锁定） ---------- */
    const order = await post('/orders', {
      customer: '昆山阿普顿自动化系统有限公司', po: 'PO0261008014', address: '江苏省苏州市昆山市许塘路8号',
      lines: [
        { name: '空压机', spec: 'VA-6', quantity: 2, unit: '个', price: 10 },
        { name: '滤芯', spec: '758335', quantity: 1, unit: '个', price: 30 }
      ]
    });
    await post(`/orders/${order.id}/confirm`, {});
    await page.reload();
    await page.getByRole('button', { name: '平台采购', exact: true }).waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: '平台采购', exact: true }).click();
    const platform = page.getByRole('dialog', { name: '登记平台采购' });
    await platform.getByRole('button', { name: '关联料品', exact: true }).click();
    const linePicker = page.getByRole('dialog', { name: '选择客户订单料品' });
    await linePicker.getByRole('checkbox', { name: /选择料品/ }).first().check();
    await linePicker.getByRole('checkbox', { name: /选择料品/ }).nth(1).check();
    await linePicker.getByRole('button', { name: /确认选择/ }).click();
    await page.waitForTimeout(300);
    const amount = platform.getByLabel('实付款 *');
    assert.notEqual(await amount.getAttribute('type'), 'number', '实付款为纯输入（无数字微调控件）');
    await amount.click();
    await page.keyboard.type('100', { delay: 50 });
    assert.equal(await amount.inputValue(), '100', '实付款可直接输入');
    const machineShare = platform.getByLabel('空压机分摊金额');
    const filterShare = platform.getByLabel('滤芯分摊金额');
    assert.equal(await machineShare.inputValue(), '40.00', '按报价单价×数量分摊：' + await machineShare.inputValue());
    assert.equal(await filterShare.inputValue(), '60.00', '按报价单价×数量分摊：' + await filterShare.inputValue());
    assert.equal((await platform.locator('.purchase-amount-summary').innerText()).includes('差额 ¥0.00'), true, '自动分摊后差额为 0');
    // 手改一行 → 其余行重摊
    await machineShare.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('50', { delay: 50 });
    await page.waitForTimeout(200);
    assert.equal(await machineShare.inputValue(), '50', '手改分摊金额后保持原样');
    assert.equal(await filterShare.inputValue(), '50.00', '其余行按比例重摊：' + await filterShare.inputValue());
    assert.equal(await platform.locator('.purchase-manual-tag').count(), 1, '手改行标记“手动”');
    // 手改到与实付款不一致时禁止保存
    await filterShare.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('40', { delay: 50 });
    await page.waitForTimeout(200);
    assert.equal(await platform.getByRole('button', { name: '保存采购记录' }).isDisabled(), true, '差额不为 0 时禁止保存');
    assert.equal((await platform.locator('.purchase-amount-summary').innerText()).includes('差额 ¥10.00'), true, '显示差额');
    await platform.getByRole('button', { name: '恢复滤芯自动分摊' }).click();
    await page.waitForTimeout(200);
    assert.equal(await filterShare.inputValue(), '50.00', '恢复自动分摊');
    assert.equal(await platform.getByRole('button', { name: '保存采购记录' }).isDisabled(), false, '差额为 0 后可以保存');
    await platform.getByLabel('供应商 *').fill('平台店铺');
    await platform.getByLabel('订单号 *').fill('TB-1001');
    await platform.getByRole('button', { name: '保存采购记录' }).click();
    await page.getByText('采购已保存').waitFor({ timeout: 20000 });
    snapshot = await state();
    const platformLines = snapshot.purchase_lines.filter(line => line.order_line_id);
    assert.deepEqual(platformLines.map(line => line.cost_cents).sort((a, b) => a - b), [5000, 5000], '手改后的分摊金额已保存');
    assert.ok(platformLines.every(line => line.unit_price_cents == null), '平台采购单价由成本推算');
    assert.ok(platformLines.every(line => line.receive_mode === 'direct'), '平台采购默认直发客户');
    assert.deepEqual(errors, [], 'console errors: ' + errors.join(' | '));
    console.log(JSON.stringify({ passed: true, widths, regular: { cost_cents: regularLine.cost_cents, unit_price_cents: regularLine.unit_price_cents }, platform: platformLines.map(line => line.cost_cents) }));
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exit(1); });
