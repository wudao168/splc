const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-order-tabs-'));
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
    await page.goto(origin + '/#orders');
    await page.getByLabel('账号', { exact: true }).fill('admin');
    const setup = await page.getByLabel('姓名', { exact: true }).count();
    if (setup) await page.getByLabel('姓名', { exact: true }).fill('管理员');
    await page.getByLabel('密码', { exact: true }).fill('11111111');
    await page.getByRole('button', { name: setup ? '创建并进入' : '登录', exact: true }).click();
    await page.locator('.orders-list .date-range').waitFor({ timeout: 20000 });
    const post = (route, body) => page.evaluate(async ({ route, body }) => {
      const response = await fetch('/api' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(route + ': ' + (payload.error || ''));
      return payload;
    }, { route, body });
    const customer = await post('/customers', { name: '页签测试客户', addresses: [{ address: '成都市武侯区' }] });
    const order = await post('/orders', { customer_id: customer.id, customer: '页签测试客户', po: 'POSL20261009001', address: '成都市武侯区', lines: [{ name: '空压机', quantity: 2, unit: '个', price: 100 }] });
    await post(`/orders/${order.id}/confirm`, {});
    await page.reload();
    await page.locator('.orders-list .date-range').waitFor({ timeout: 20000 });

    const tabs = page.locator('.tabs:visible');
    assert.deepEqual(await tabs.getByRole('button').allInnerTexts(), ['客户订单', '已归档', '回收站', '客户列表'], '客户订单页签右侧新增已归档/回收站两个页签');
    assert.equal(await page.locator('.view-switch').count(), 0, '工具栏内的视图切换已移除');
    const activeTab = async () => (await tabs.locator('button.active').innerText()).trim();
    assert.equal(await activeTab(), '客户订单');

    // 已归档
    await tabs.getByRole('button', { name: '已归档', exact: true }).click();
    await page.waitForTimeout(400);
    assert.equal(await activeTab(), '已归档', '切换到已归档页签');
    assert.equal(await page.locator('.orders-list tbody tr').count(), 0, '没有已归档订单时列表为空');

    // 回收站
    await tabs.getByRole('button', { name: '回收站', exact: true }).click();
    await page.waitForTimeout(400);
    assert.equal(await activeTab(), '回收站', '切换到回收站页签');
    await page.getByRole('heading', { name: '回收站' }).waitFor({ timeout: 10000 });

    // 回到客户订单
    await tabs.getByRole('button', { name: '客户订单', exact: true }).click();
    await page.waitForTimeout(400);
    assert.equal(await activeTab(), '客户订单');
    assert.equal(await page.locator('.orders-list tbody tr').filter({ hasText: 'POSL20261009001' }).count(), 1, '客户订单列表恢复');

    // 客户列表页签仍在；离开订单页再回来时保留原页签（切换导航不再重置右侧内容页）
    await tabs.getByRole('button', { name: '客户列表', exact: true }).click();
    await page.waitForTimeout(400);
    assert.equal(await activeTab(), '客户列表');
    await tabs.getByRole('button', { name: '回收站', exact: true }).click();
    await page.waitForTimeout(300);
    const nav = name => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true });
    await nav('采购').click();
    await page.waitForTimeout(400);
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '订单', exact: true }).click();
    await page.waitForTimeout(400);
    assert.equal(await activeTab(), '回收站', '离开订单页再回来时保留原页签');
    assert.deepEqual(errors, [], 'console errors: ' + errors.join(' | '));
    console.log(JSON.stringify({ passed: true, tabs: await tabs.getByRole('button').allInnerTexts() }));
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exit(1); });
