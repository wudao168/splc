const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-picker-rows-'));
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
    await page.goto(origin + '/#purchases');
    await page.getByLabel('账号', { exact: true }).fill('admin');
    await page.getByLabel('密码', { exact: true }).fill('11111111');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.locator('.purchases-list .toolbar').waitFor({ timeout: 20000 });
    const post = (route, body) => page.evaluate(async ({ route, body }) => {
      const response = await fetch('/api' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error);
      return payload;
    }, { route, body });
    const customer = await post('/customers', { name: '抽屉行高客户', contacts: [{ name: '张工', phone: '13800000001' }], addresses: [{ address: '抽屉行高路 1 号', contact: '张工', phone: '13800000001' }] });
    for (const po of ['PO-ROWS-1', 'PO-ROWS-2']) {
      const order = await post('/orders', { customer_id: customer.id, customer: '抽屉行高客户', contact: '张工', phone: '13800000001', address: '抽屉行高路 1 号', po, lines: [{ name: `料品 ${po}`, quantity: 1, unit: '个', price: 10 }] });
      await post(`/orders/${order.id}/confirm`, {});
    }
    await post('/items', { name: '产品库行高料品', spec: 'ROWS-1', unit: '个' });
    await page.reload();
    await page.locator('.purchases-list .toolbar').waitFor({ timeout: 20000 });

    await page.getByRole('button', { name: '平台采购', exact: true }).click();
    const modal = page.locator('.modal');
    await modal.waitFor({ timeout: 10000 });
    await modal.getByRole('button', { name: '关联料品', exact: true }).click();
    const picker = page.locator('.purchase-line-picker');
    await picker.locator('tbody tr').first().waitFor({ timeout: 10000 });
    const pickerHeights = await picker.locator('tbody tr').evaluateAll(rows => rows.map(row => Math.round(row.getBoundingClientRect().height)));
    assert.equal(pickerHeights.length, 2, '关联料品抽屉应有 2 条订单料品');
    assert.deepEqual([...new Set(pickerHeights)], [50], `关联料品行高应固定 50px：${JSON.stringify(pickerHeights)}`);

    // 客户 PO 多选：勾选两个 PO，列表同时显示两个 PO 的料品
    const poFilter = picker.locator('.picker-po-filter');
    await poFilter.locator('summary').click();
    const poBoxes = poFilter.locator('.picker-po-filter-menu input[type=checkbox]');
    assert.equal(await poBoxes.count(), 3, '客户 PO 菜单应有“全部”加 2 个 PO');
    await poBoxes.nth(1).check();
    await poBoxes.nth(2).check();
    assert.equal((await poFilter.locator('summary').innerText()).trim(), '已选 2 个客户 PO', '摘要应显示已选 2 个客户 PO');
    assert.equal(await picker.locator('tbody tr').count(), 2, '多选后应显示两个 PO 的料品');
    await poBoxes.nth(1).uncheck();
    const remaining = (await poFilter.locator('summary').innerText()).trim();
    assert.match(remaining, /^PO-ROWS-[12]$/, '取消一个后摘要应显示剩余 PO');
    assert.equal(await picker.locator('tbody tr').count(), 1, '取消一个后应只剩该 PO 的料品');
    assert.equal((await picker.locator('tbody tr').first().innerText()).includes(remaining), true, '剩余行应属于摘要里的 PO');
    await poBoxes.nth(0).check();
    assert.equal((await poFilter.locator('summary').innerText()).trim(), '全部客户 PO', '勾选“全部”应恢复全部客户 PO');
    assert.equal(await picker.locator('tbody tr').count(), 2, '恢复全部后应显示全部料品');

    // 产品库抽屉同样 50px 行高
    await picker.getByRole('button', { name: '取消', exact: true }).click();
    await modal.getByRole('button', { name: '关闭', exact: true }).click();
    await modal.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: '常规采购', exact: true }).click();
    const regularModal = page.locator('.modal');
    await regularModal.waitFor({ timeout: 10000 });
    await regularModal.getByRole('button', { name: '产品库选择', exact: true }).click();
    const productPicker = page.locator('.purchase-line-picker.product-picker');
    await productPicker.locator('tbody tr').first().waitFor({ timeout: 10000 });
    const productHeights = await productPicker.locator('tbody tr').evaluateAll(rows => rows.map(row => Math.round(row.getBoundingClientRect().height)));
    assert.deepEqual([...new Set(productHeights)], [50], `产品库行高应固定 50px：${JSON.stringify(productHeights)}`);

    assert.deepEqual(errors, [], `页面报错：${errors.join(' | ')}`);
    console.log('OK 关联料品/产品库抽屉行高固定 50px、客户 PO 支持多选；截图：', temp);
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exit(1); });
