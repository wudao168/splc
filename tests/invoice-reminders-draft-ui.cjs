const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-remind-draft-'));
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
    const context = await browser.newContext({ viewport: { width: 1625, height: 892 }, deviceScaleFactor: 2 });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const page = await context.newPage();
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
    await post('/company', { name: '上海思品利诚智能科技有限公司', tax_number: '91310000MA1FL0TEST', address: '上海市宝山区逸仙路2816号1幢1层', phone: '021-55556666', bank_name: '中国工商银行上海宝山支行', bank_account: '1001234501234567890', email: 'finance@splc.example', company_code: 'SPLC' });
    const draftOf = (order, status, shop) => ({ platform_order: order, source_url: `https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=${order}`, shop, seller_nick: '测试旺旺号', amount: '35.00', transaction_status: status, purchased_date: '2026-10-16', purchased_at: '2026-10-16 17:10:00' });
    const draft = await post('/purchase-drafts', draftOf('3316506062147162599', '交易成功', '测试淘宝店'));
    await post('/purchase-drafts', draftOf('3316506062147162600', '买家已付款', '未成交测试店'));
    await page.reload();
    await page.getByRole('button', { name: /^发票催办/ }).click();
    const modal = page.getByRole('dialog', { name: /发票催办/ });
    await modal.waitFor();
    const rows = modal.locator('tbody tr');
    await rows.first().waitFor();
    assert.equal(await rows.count(), 1, '只应列出交易成功的淘宝订单（买家已付款不列）');
    const rowText = await rows.first().innerText();
    assert.ok(rowText.includes('淘宝订单'), `应标识来源为淘宝订单（实际 ${rowText}）`);
    assert.ok(rowText.includes('测试淘宝店'), `应显示店铺（实际 ${rowText}）`);
    assert.ok(rowText.includes('3316506062147162599'), `应显示订单号（实际 ${rowText}）`);
    assert.ok(rowText.includes('¥35.00'), `应显示金额（实际 ${rowText}）`);
    assert.ok(rowText.includes('未登记采购'), `淘宝订单应标注未登记采购（实际 ${rowText}）`);
    const chatLink = rows.first().getByRole('link', { name: '打开旺旺聊天' });
    assert.equal(await chatLink.count(), 1, '读到卖家旺旺号时应提供旺旺聊天直达链接');
    const chatHref = await chatLink.getAttribute('href');
    assert.ok(chatHref.includes('amos.alicdn.com') && decodeURIComponent(chatHref).includes('uid=测试旺旺号'), `旺旺链接不正确：${chatHref}`);
    await rows.first().getByRole('button', { name: '复制催票话术', exact: true }).click();
    await page.locator('.toast').filter({ hasText: '催票话术已复制' }).waitFor();
    const script = await page.evaluate(() => navigator.clipboard.readText());
    for (const expected of ['公司名称：上海思品利诚智能科技有限公司', '税号：91310000MA1FL0TEST', '地址：上海市宝山区逸仙路2816号1幢1层', '电话：021-55556666', '开户行：中国工商银行上海宝山支行', '账号：1001234501234567890', '收票邮箱：finance@splc.example']) {
      assert.ok(script.includes(expected), `催票话术应包含「${expected}」（实际 ${script}）`);
    }
    assert.ok(script.includes('3316506062147162599') && script.includes('¥35.00'), `话术应包含订单号与实付金额（实际 ${script}）`);
    await rows.first().getByRole('button', { name: '记一次催票', exact: true }).click();
    await page.locator('.toast').filter({ hasText: '已记录一次催票' }).waitFor();
    await page.waitForFunction(() => {
      const row = document.querySelector('.modal tbody tr');
      return row && /1\s*次/.test(row.innerText);
    }, null, { timeout: 10000 });
    const state = await page.evaluate(async () => (await (await fetch('/api/state')).json()));
    const saved = state.purchase_drafts.find(item => item.id === draft.id);
    assert.equal(saved.payload.invoice_remind_count, 1, '淘宝订单应记录催票次数');
    assert.ok(saved.payload.next_followup, '淘宝订单应设置下次跟进日');
    assert.deepEqual(errors, [], `页面不应有脚本错误：${errors.join(' | ')}`);
    console.log('OK 发票催办已纳入淘宝订单：列出交易成功订单、可记催票并持久化');
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exit(1); });
