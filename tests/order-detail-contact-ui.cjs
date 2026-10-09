const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-order-contact-'));
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
    const page = await browser.newPage({ viewport: { width: 1575, height: 892 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/#orders');
    await page.getByLabel('账号', { exact: true }).fill('admin');
    await page.getByLabel('密码', { exact: true }).fill('11111111');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.locator('.orders-list .date-range').waitFor();
    const post = (route, body) => page.evaluate(async ({ route, body }) => {
      const response = await fetch('/api' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error);
      return payload;
    }, { route, body });
    const customer = await post('/customers', { name: '腾科客户', contacts: [{ name: '客户联系人甲', phone: '13800000001' }], addresses: [{ address: '广州市黄埔区云铺一路19号A栋', contact: '宋雪辉', phone: '13711203668' }] });
    const lines = [{ name: '工业插座', quantity: 2, unit: '个', price: 27.5 }];
    const byRecipient = await post('/orders', { customer_id: customer.id, customer: '腾科客户', po: 'PO-RECIPIENT', contact: '宋雪辉', phone: '13711203668', address: '广州市黄埔区云铺一路19号A栋', lines });
    await post('/orders', { customer_id: customer.id, customer: '腾科客户', po: 'PO-CONTACT', contact: '客户联系人甲', phone: '13800000001', address: '广州市黄埔区云铺一路19号A栋', lines });
    await page.reload();
    await page.locator('.orders-list .date-range').waitFor();
    const cellTexts = async po => {
      const row = page.locator('.orders-list tbody tr').filter({ hasText: po });
      await row.getByRole('button', { name: '查看', exact: true }).first().click();
      const dialog = page.getByRole('dialog');
      await dialog.locator('.order-detail-header').waitFor();
      const texts = await dialog.locator('.order-detail-header > div').allInnerTexts();
      return { dialog, texts: texts.map(text => text.replace(/\n/g, '|')) };
    };
    const recipient = await cellTexts('PO-RECIPIENT');
    const contact = recipient.texts.find(text => text.startsWith('联系人'));
    const address = recipient.texts.find(text => text.startsWith('收货地址'));
    assert.ok(contact.includes('客户联系人甲 13800000001'), `联系人应显示客户联系人：${contact}`);
    assert.ok(!contact.includes('宋雪辉'), `联系人不应显示收货人：${contact}`);
    assert.ok(address.includes('宋雪辉 13711203668') && address.includes('广州市黄埔区云铺一路19号A栋'), `收货地址应带出收货人：${address}`);
    await recipient.dialog.screenshot({ path: path.join(temp, 'recipient.png') });
    await recipient.dialog.getByRole('button', { name: '关闭' }).click();

    const direct = await cellTexts('PO-CONTACT');
    const directContact = direct.texts.find(text => text.startsWith('联系人'));
    const directAddress = direct.texts.find(text => text.startsWith('收货地址'));
    assert.ok(directContact.includes('客户联系人甲 13800000001'), `联系人应显示客户联系人：${directContact}`);
    assert.ok(!directAddress.includes('宋雪辉'), `地址不应重复带出联系人：${directAddress}`);

    // 订单详情抽屉：宽度 1200px，金额与税率列表头不换行、不截断
    const drawerWidth = Math.round(await direct.dialog.evaluate(node => node.getBoundingClientRect().width));
    assert.equal(drawerWidth, 1200, `订单详情抽屉宽度应为 1200px，实际 ${drawerWidth}`);
    const headerIssues = await direct.dialog.locator('.order-detail-form thead th').evaluateAll(nodes => nodes
      .map(th => ({ text: th.textContent, clipped: th.scrollWidth > th.clientWidth + 1, height: Math.round(th.getBoundingClientRect().height) }))
      .filter(th => th.clipped || th.height > 40));
    assert.deepEqual(headerIssues, [], `订单详情表头被截断或换行：${JSON.stringify(headerIssues)}`);

    assert.deepEqual(errors, [], `页面报错：${errors.join(' | ')}`);
    console.log('OK 订单详情联系人/收货人显示正确；截图：', path.join(temp, 'recipient.png'));
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exit(1); });
