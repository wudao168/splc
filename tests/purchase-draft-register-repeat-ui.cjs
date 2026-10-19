const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-draft-repeat-'));
  const python = process.env.CAIDAN_PYTHON || path.join(root, '.venv', 'Scripts', 'python.exe');
  const server = spawn(python, ['-u', '-m', 'server.app', '--port', '0'], {
    cwd: root, env: { ...process.env, CAIDAN_DATA: path.join(temp, 'data'), CAIDAN_INTERNAL_TOKEN: 'draft-repeat' }, windowsHide: true
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
    const page = await browser.newPage({ viewport: { width: 1625, height: 892 } });
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
    const internal = async (route, body) => {
      const response = await fetch(origin + '/api' + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Caidan-Internal': 'draft-repeat' }, body: JSON.stringify(body) });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      return JSON.parse(text);
    };
    // 一张已确认的客户订单，作为可关联的料品来源
    const order = await post('/orders', { customer: '草稿登记测试客户', po: 'PO-DRAFT-1', address: '地址', lines: [{ name: '空压机', spec: 'VA-6', quantity: 4, unit: '个', price: 120 }] });
    await post(`/orders/${order.id}/confirm`, {});
    // 两条平台草稿
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    for (const id of ['3317105064002008552', '3316485974032008552']) {
      await internal('/purchase-drafts', {
        platform_order: id, transaction_status: '卖家已发货', purchased_date: today, shop: `店铺${id.slice(-3)}`, amount: '120',
        source_url: `https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=${id}`,
        products: [{ name: '空压机' }], packages: [{ tracking: `TRACK${id.slice(-4)}`, status: '运输中' }]
      });
    }
    await page.reload();
    await page.getByRole('button', { name: '平台采购', exact: true }).waitFor({ timeout: 20000 });
    await page.locator('.tabs').getByRole('button', { name: '淘宝订单', exact: true }).click();
    await page.waitForTimeout(400);
    const draftsTable = page.locator('.purchase-drafts-list');
    const rows = draftsTable.locator('tbody tr:not(.purchase-summary)');
    assert.equal(await rows.count(), 2, '应有两条平台草稿');

    const register = () => draftsTable.getByRole('button', { name: '登记采购', exact: true });
    // 第一次登记
    await rows.nth(0).locator('input[type=checkbox]').check();
    await page.waitForTimeout(200);
    assert.equal(await register().isDisabled(), false, '选中一条草稿后「登记采购」可用');
    await register().click();
    const modal = page.getByRole('dialog', { name: /采购草稿 ·/ });
    await modal.waitFor({ timeout: 10000 });
    await modal.getByRole('button', { name: '关联料品', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '选择客户订单料品' });
    await picker.getByRole('checkbox', { name: /选择料品/ }).first().check();
    await picker.getByRole('button', { name: /确认选择/ }).click();
    await page.waitForTimeout(300);
    await modal.getByLabel('供应商 *').fill('草稿测试店铺');
    await modal.getByRole('button', { name: '保存采购记录' }).click();
    await page.getByText('采购已保存').waitFor({ timeout: 20000 });
    await page.waitForTimeout(400);
    assert.equal(await draftsTable.locator('tbody tr:not(.purchase-summary)').count(), 1, '登记完成后草稿列表少一条');
    // 关键点：登记完成后不能残留选中，否则下一次「登记采购」永远禁用
    const staleCount = await draftsTable.getByRole('button', { name: /删除选中/ }).innerText();
    assert.equal(staleCount.trim(), '删除选中', '删除选中不应残留旧选中计数：' + staleCount);

    // 第二次登记：这里就是用户报的“没有反应”
    const remainingOrder = (await draftsTable.locator('tbody tr:not(.purchase-summary)').first().locator('td').nth(1).innerText()).trim();
    await draftsTable.locator('tbody tr:not(.purchase-summary)').first().locator('input[type=checkbox]').check();
    await page.waitForTimeout(200);
    assert.equal(await register().isDisabled(), false, '接着登记下一条时「登记采购」应可用');
    await register().click();
    await page.getByRole('dialog', { name: /采购草稿 ·/ }).waitFor({ timeout: 10000 });
    assert.ok((await page.getByRole('dialog', { name: /采购草稿 ·/ }).innerText()).includes(remainingOrder), `第二次打开的是下一条草稿（期望 ${remainingOrder}）`);
    await page.screenshot({ path: path.join(temp, 'draft-repeat.png') });
    assert.deepEqual(errors, [], 'console errors: ' + errors.join(' | '));
    console.log(JSON.stringify({ passed: true, registerSecondDraft: true }));
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exit(1); });
