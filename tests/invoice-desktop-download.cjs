const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-invoice-download-test-'));
  const env = {...process.env, CAIDAN_DATA:temp, CAIDAN_PROFILE:path.join(temp, 'profile')};
  delete env.ELECTRON_RUN_AS_NODE;
  const packaged = process.env.CAIDAN_TEST_EXE;
  const client = await electron.launch({executablePath:packaged || path.join(root, 'node_modules/electron/dist/electron.exe'), args:packaged ? [] : [root], env, timeout:60000});
  try {
    const shell = await client.firstWindow();
    await shell.waitForFunction(() => document.querySelector('#status').textContent.includes('采购信息'), null, {timeout:60000});
    let page;
    for (let i = 0; i < 100; i++) {
      page = client.context().pages().find(p => p.url().startsWith('http://127.0.0.1:'));
      if (page) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(page, 'local business page loaded');
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.getByLabel('账号', {exact:true}).fill('admin');
    await page.getByLabel('密码', {exact:true}).fill('11111111');
    await page.getByRole('button', {name:'登录', exact:true}).click();
    await page.getByRole('button', {name:'登记采购', exact:true}).waitFor();
    const post = (route, body) => page.evaluate(async ({route, body}) => {
      const response = await fetch('/api' + route, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }, {route, body});
    const state = () => page.evaluate(async () => (await fetch('/api/state')).json());
    const order = await post('/orders', {customer:'发票下载测试', po:'INVOICE-DOWNLOAD', address:'测试地址', lines:[{name:'测试料品', quantity:10}]});
    await post(`/orders/${order.id}/confirm`, {});
    const line = (await state()).order_lines[0];
    const modes = ['inline', 'popup', 'script', 'invalid', 'ofd'];
    const purchases = [];
    const fixtures = {};
    for (const [index, mode] of modes.entries()) {
      const platformOrder = String(1000000000000000000n + BigInt(index));
      const number = String(26000000000000000000n + BigInt(index));
      const purchase = await post('/purchases', {platform:'淘宝', shop:`测试店铺 ${mode}`, platform_order:platformOrder, amount:'26.50', lines:[{order_line_id:line.id, quantity:1, cost:'26.50'}]});
      await post('/taobao/invoices', {entries:[{platform_order:platformOrder, status:'已开票', amount:'26.50', date:'2026-10-03'}], details:[{platform_order:platformOrder, invoices:[{number, amount:'26.50', date:'2026-10-03'}]}]});
      const url = `https://${mode === 'popup' || mode === 'script' ? 'invoice-files.example.com' : 'invoice-ua.taobao.com'}/files/${mode}${mode === 'popup' ? '' : mode === 'ofd' ? '.ofd' : '.pdf'}`;
      const control = `<span class="invoice-value">${mode === 'script' ? `<a href="javascript:void(0)" onclick="window.open('${url}', '_blank')"><span>下载发票</span></a>` : `<a href="${url}" ${mode === 'popup' ? 'target="_blank"' : ''}><span>下载发票</span></a>`}</span>`;
      fixtures[platformOrder] = `<div class="invoice-detail-box">${[['发票号码', number], ['发票金额', '¥26.50'], ['开票日期', '2026-10-03']].map(([key, value]) => `<div class="invoice-content"><span class="invoice-label">${key}：</span><span class="invoice-value">${value}</span></div>`).join('')}${control}</div>`;
      purchases.push(purchase);
    }
    // All remote requests are synthetic; no Taobao account or real purchase is used.
    await client.evaluate(({session}, fixtures) => {
      globalThis.invoiceRequests = [];
      session.fromPartition('persist:taobao').protocol.handle('https', request => {
        globalThis.invoiceRequests.push(request.url);
        const url = new URL(request.url);
        if (url.pathname === '/detail/pc') return new Response(`<script>document.write(${JSON.stringify(fixtures)}[new URLSearchParams(location.hash.split('?')[1]).get('orderId')])</script>`, {headers:{'Content-Type':'text/html; charset=utf-8'}});
        if (url.pathname.startsWith('/files/')) return new Response(url.pathname.includes('invalid') ? '<html>登录已失效</html>' : url.pathname.endsWith('.ofd') ? 'PK\x03\x04test invoice' : '%PDF-1.4\nTest invoice', {headers:{'Content-Type':url.pathname.endsWith('.ofd') ? 'application/ofd' : 'application/pdf'}});
        return new Response('Unexpected test request', {status:404});
      });
    }, fixtures);
    const results = [];
    for (const [index, mode] of modes.entries()) {
      const result = await page.evaluate(id => window.caidanDesktop.syncInvoices([id]), purchases[index].id);
      if (mode === 'invalid') {
        assert.equal(result.downloadFailed, 1, JSON.stringify(result));
        assert.match(result.downloadErrors[0].message, /不是 PDF/);
        assert.equal((await state()).purchases.find(p => p.id === purchases[index].id).taobao_source.invoice_details[0].attachment_id, undefined);
      } else {
        assert.equal(result.downloaded, 1, `${mode}: ${JSON.stringify(result)}`);
        assert.equal(result.downloadFailed, 0);
        const saved = (await state()).purchases.find(p => p.id === purchases[index].id);
        assert.ok(saved.taobao_source.invoice_details[0].attachment_id);
        assert.equal(saved.taobao_source.invoice_details[0].number, String(26000000000000000000n + BigInt(index)), 'invoice must belong to the selected order');
        assert.equal(saved.received_cents, 0, 'download awaits manual confirmation');
        const requestsBefore = await client.evaluate(() => globalThis.invoiceRequests.length);
        await assert.rejects(page.evaluate(id => window.caidanDesktop.syncInvoices([id]), purchases[index].id), /已全部获取/);
        assert.equal(await client.evaluate(() => globalThis.invoiceRequests.length), requestsBefore, 'pending confirmation never downloads again');
      }
      results.push({mode, downloaded:result.downloaded, failed:result.downloadFailed});
    }
    await page.reload();
    await page.getByRole('button', {name:/查看 \/ 确认/}).first().click();
    const drawer = page.getByRole('dialog');
    await drawer.getByText('已获取', {exact:true}).waitFor();
    assert.equal(await drawer.getByRole('button', {name:'获取发票', exact:true}).count(), 0);
    await drawer.getByRole('button', {name:'确认收票', exact:true}).click();
    await drawer.getByText('已确认收票', {exact:true}).waitFor();
    assert.equal((await state()).purchases[0].received_cents, 2650);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({passed:true, packaged:!!packaged, results, checks:['download saved and linked', 'no duplicate download while pending', 'manual confirmation'], assets:await page.locator('script[src]').evaluateAll(elements => elements.map(el => el.getAttribute('src')))}));
  } finally {
    await client.close();
    await fs.rm(temp, {recursive:true, force:true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
