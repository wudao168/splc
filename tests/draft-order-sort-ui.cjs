const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-draft-sort-'));
  const python = process.env.CAIDAN_PYTHON || path.join(root, '.venv', 'Scripts', 'python.exe');
  const server = spawn(python, ['-u', '-m', 'server.app', '--port', '0'], {
    cwd: root, env: { ...process.env, CAIDAN_DATA: path.join(temp, 'data'), CAIDAN_INTERNAL_TOKEN: 'draft-sort' }, windowsHide: true
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
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/#purchases');
    await page.getByLabel('账号', { exact: true }).fill('admin');
    await page.getByLabel('密码', { exact: true }).fill('11111111');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('button', { name: '平台采购', exact: true }).waitFor({ timeout: 20000 });
    const internal = async (route, body) => {
      const response = await fetch(origin + '/api' + route, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Caidan-Internal': 'draft-sort' }, body: JSON.stringify(body)
      });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      return JSON.parse(text);
    };
    // 同一天三笔订单，采集顺序与下单时间顺序故意不一致（用当天日期，避免超出采集时间窗）
    const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const orders = [
      { platform_order: '3317000000000000001', purchased_at: `${day} 09:30` },
      { platform_order: '3317000000000000002', purchased_at: `${day} 18:05` },
      { platform_order: '3317000000000000003', purchased_at: `${day} 12:15` },
    ];
    for (const item of orders) {
      await internal('/purchase-drafts', {
        platform_order: item.platform_order, transaction_status: '卖家已发货', purchased_date: day,
        purchased_at: item.purchased_at, shop: '排序测试店', amount: '10',
        source_url: `https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=${item.platform_order}`,
        products: [{ name: '测试商品' }], packages: [{ tracking: 'TRACK' + item.platform_order.slice(-8), status: '运输中' }]
      });
    }
    await page.reload();
    await page.getByRole('button', { name: '平台采购', exact: true }).waitFor({ timeout: 20000 });
    await page.locator('.tabs').getByRole('button', { name: '淘宝订单', exact: true }).click();
    await page.locator('.purchase-drafts-list tbody tr').first().waitFor();
    const listed = await page.locator('.purchase-drafts-list tbody tr:not(.purchase-summary) td:nth-child(2)').allInnerTexts();
    assert.deepEqual(listed, [orders[1].platform_order, orders[2].platform_order, orders[0].platform_order],
      '淘宝订单应按订单时间从近到远排列');
    assert.deepEqual(errors, []);
    console.log('draft order sort ok:', listed.join(' > '));
  } finally {
    if (browser) await browser.close();
    server.kill();
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
