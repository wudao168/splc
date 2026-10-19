const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-purchase-edit-'));
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
    const post = (route, body) => page.evaluate(async ({ route, body }) => {
      const response = await fetch('/api' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error);
      return payload;
    }, { route, body });
    const customer = await post('/customers', { name: '编辑测试客户', contacts: [{ name: '李工', phone: '13800000077' }], addresses: [{ address: '测试地址 77 号', contact: '李工', phone: '13800000077' }] });
    const order = await post('/orders', { customer_id: customer.id, customer: '编辑测试客户', contact: '李工', phone: '13800000077', address: '测试地址 77 号', po: 'PO-EDIT-1', lines: [{ name: '采购料品甲', spec: 'S-1', quantity: 10, unit: '个', price: 20 }] });
    await post(`/orders/${order.id}/confirm`, {});
    const state = await page.evaluate(async () => (await (await fetch('/api/state')).json()));
    const line = state.order_lines.find(item => item.name === '采购料品甲');
    assert.ok(line, '应能找到客户料品');
    const purchase = await post('/purchases', {
      platform: '对公', account: '公司采购号', shop: '原供应商', purchased_date: '2026-10-16', amount: '100.00',
      lines: [{ order_line_id: line.id, quantity: 10, cost: '100.00', receive_mode: 'direct', purchase_unit: '个', purchase_spec: 'S-1' }]
    });
    await page.reload();
    const row = page.locator('.purchases-list tbody tr.purchase-row').first();
    await row.waitFor();
    assert.equal(await page.locator('.purchases-list tbody tr.purchase-row').count(), 1, '应有 1 条采购记录');

    // 单击整行 = 选中
    await row.click();
    assert.equal(await row.locator('input[type=checkbox]').isChecked(), true, '单击行应选中该采购记录');
    assert.ok((await row.getAttribute('class')).includes('row-selected'), '选中行应有高亮样式');
    const editButton = page.getByRole('button', { name: '编辑', exact: true });
    assert.equal(await editButton.isDisabled(), false, '选中一条后可编辑');

    // 双击整行 = 打开明细
    await row.dblclick();
    const detail = page.getByRole('dialog', { name: '对公' });
    await detail.getByRole('button', { name: '编辑采购信息', exact: true }).waitFor();
    assert.ok((await detail.innerText()).includes('¥100.00'), '明细应显示原实付款');
    await detail.getByRole('button', { name: '编辑采购信息', exact: true }).click();
    const form = detail.locator('.purchase-registration-form');
    await form.waitFor();
    assert.equal(await form.getByLabel('供应商 *').inputValue(), '原供应商', '编辑表单应带出原供应商');
    assert.equal(await form.getByLabel('实付款 *').inputValue(), '100.00', '编辑表单应带出原实付款');
    assert.equal(await form.getByLabel('采购日期 *').inputValue(), '2026-10-16', '编辑表单应带出原采购日期');
    await form.getByLabel('供应商 *').fill('成都天润博科科技有限公司');
    await form.getByLabel('实付款 *').fill('120.00');
    await form.getByLabel('采购日期 *').fill('2026-10-14');
    await form.getByLabel('备注').fill('已核对：含运费');
    await form.getByRole('button', { name: '保存修改', exact: true }).click();
    await page.getByRole('dialog', { name: '对公' }).waitFor({ state: 'detached' });
    await page.locator('.toast').filter({ hasText: '采购信息已更新' }).waitFor();
    const updated = await row.innerText();
    assert.ok(updated.includes('成都天润博科科技有限公司'), `列表应显示新供应商（实际 ${updated}）`);
    assert.ok(updated.includes('¥120.00'), `列表应显示新实付款（实际 ${updated}）`);
    assert.ok(updated.includes('2026-10-14'), `列表应显示新采购日期（实际 ${updated}）`);
    const after = await page.evaluate(async () => (await (await fetch('/api/state')).json()));
    const saved = after.purchases.find(item => item.id === purchase.id);
    assert.equal(saved.shop, '成都天润博科科技有限公司', '服务端应保存新供应商');
    assert.equal(saved.amount_cents, 12000, '服务端应保存新实付款');
    assert.equal(saved.purchased_date, '2026-10-14', '服务端应保存新采购日期');
    assert.equal(saved.note, '已核对：含运费', '服务端应保存备注');

    // 开票状态查询（按“开票状态”列筛选）
    const invoiceSelect = page.getByLabel('开票状态筛选');
    const options = await invoiceSelect.locator('option').allInnerTexts();
    assert.deepEqual(options.map(text => text.trim()), ['全部开票状态', '待查询', '未开票', '店铺称已开票', '已开票', '不需开票', '未登记'], `开票状态筛选项不正确：${options.join(' / ')}`);
    await invoiceSelect.selectOption('未登记');
    assert.equal(await page.locator('.purchases-list tbody tr.purchase-row').count(), 1, '“未登记”应筛出对公采购');
    await invoiceSelect.selectOption('已开票');
    assert.equal(await page.locator('.purchases-list tbody tr.purchase-row').count(), 0, '“已开票”不应筛出未开票记录');
    await invoiceSelect.selectOption('');
    assert.equal(await page.locator('.purchases-list tbody tr.purchase-row').count(), 1, '恢复全部开票状态后应显示记录');
    assert.deepEqual(errors, [], `页面不应有脚本错误：${errors.join(' | ')}`);
    console.log('OK 采购记录可整行选中并编辑：供应商 / 实付款 / 采购日期 / 备注 均已保存；开票状态查询可用');
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exit(1); });
