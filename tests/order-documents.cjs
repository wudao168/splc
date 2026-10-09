const { _electron: electron, expect } = require('playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'caidan-documents-'));
  const env = { ...process.env, CAIDAN_DATA: temp, CAIDAN_PROFILE: path.join(temp, 'profile') };
  delete env.ELECTRON_RUN_AS_NODE;
  const client = await electron.launch({ executablePath: path.join(root, 'release/Caidan-win32-x64/Caidan.exe'), env, timeout: 60000 });
  console.log('Isolated client launched');
  try {
    const shell = await client.firstWindow();
    await shell.waitForFunction(() => document.querySelector('#status').textContent.includes('采购信息'));
    let page;
    for (let i = 0; i < 100; i++) {
      page = client.context().pages().find(p => p.url().startsWith('http://127.0.0.1:'));
      if (page) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(page, 'business WebContentsView is ready');
    page.setDefaultTimeout(15000);
    await page.getByRole('button', { name: '采购', exact: true }).waitFor();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const origin = new URL(page.url()).origin;
    console.log('Business page ready:', origin);
    const state = async () => (await page.request.get(origin + '/api/state')).json();
    const post = async (url, body) => {
      const r = await page.request.post(origin + '/api' + url, { data: body, timeout: 15000 });
      const result = await r.json();
      assert.equal(r.status(), 200, JSON.stringify(result));
      return result;
    };
    const purchases = [];
    for (const code of ['A', 'B']) {
      // Same customer and recipient: filtering must use the order, not customer identity.
      const order = await post('/orders', { customer: '单据测试客户', po: 'PO-' + code, address: '测试地址', lines: [{ name: '料品' + code, quantity: 2, price: 10 }] });
      await post(`/orders/${order.id}/confirm`, {});
      const line = (await state()).order_lines.find(l => l.order_id === order.id);
      const purchase = await post('/purchases', { platform: '淘宝', shop: '店铺' + code, platform_order: 'BUY-' + code, amount: 20, lines: [{ order_line_id: line.id, quantity: 2, cost: 20 }] });
      purchases.push(purchase.id);
      const pl = (await state()).purchase_lines.find(l => l.purchase_id === purchase.id);
      const pkg = await post('/packages', { carrier: '测试快递', tracking: 'TRACK-' + code, lines: [{ purchase_line_id: pl.id, quantity: 2 }] });
      await post(`/packages/${pkg.id}/tracking`, { status: '运输中' });
    }
    await page.reload();
    const nav = page.getByRole('navigation', { name: '主导航' });
    await expect(nav.getByRole('button')).toHaveCount(5);
    await expect(nav.getByRole('button', { name: '采购发票', exact: true })).toHaveCount(0);
    await expect(nav.getByRole('button', { name: '送货单', exact: true })).toHaveCount(0);
    const row = code => page.locator('tbody tr').filter({ has: page.getByRole('cell', { name: code, exact: true }) });
    await row('BUY-A').getByRole('button', { name: /查看 \/ 登记/ }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '登记收票', exact: true }).click();
    await expect(dialog.getByLabel('开票方 *', { exact: true })).toHaveValue('店铺A');
    await expect(dialog).not.toContainText('BUY-B');
    await dialog.getByLabel('发票号码 *', { exact: true }).fill('INV-A');
    await dialog.locator('input[type=file]').setInputFiles({ name: 'invoice.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 TEST INVOICE') });
    await dialog.getByRole('button', { name: '保存并核对收票' }).click();
    await expect(dialog.getByRole('cell', { name: 'INV-A', exact: true })).toBeVisible();
    const invoiced = await state();
    assert.deepEqual(invoiced.invoice_allocations.map(a => a.purchase_id), [purchases[0]]);
    assert.equal(invoiced.purchases.find(p => p.id === purchases[1]).received_cents, 0);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await row('BUY-B').getByRole('button', { name: /查看 \/ 登记/ }).click();
    await expect(dialog).not.toContainText('INV-A');
    await dialog.getByRole('button', { name: '跟进 / 设置', exact: true }).click();
    await dialog.getByLabel('本次跟进 / 店铺回复').fill('等待开票');
    await dialog.getByRole('button', { name: '保存跟进', exact: true }).click();
    await expect(dialog.getByText('本笔采购尚未登记发票')).toBeVisible();
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    if (process.env.CAIDAN_QA_DIR) await page.screenshot({ path: path.join(process.env.CAIDAN_QA_DIR, 'purchases-invoices.png') });
    await nav.getByRole('button', { name: '订单', exact: true }).click();
    await row('PO-A').getByRole('button', { name: '查看 / 生成', exact: true }).click();
    await dialog.getByRole('button', { name: '生成送货单', exact: true }).click();
    await expect(dialog.getByLabel('开单选择料品A', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('开单选择料品B', { exact: true })).toHaveCount(0);
    await dialog.getByLabel('送货单公司抬头 *').fill('测试供货公司');
    await dialog.getByLabel('开单选择料品A', { exact: true }).check();
    await dialog.getByRole('button', { name: '生成送货单', exact: true }).click();
    await expect(dialog.getByRole('link', { name: 'PDF', exact: true })).toBeVisible();
    await expect(dialog).not.toContainText('PO-B');
    for (const label of ['PDF', 'Excel', '打印']) {
      const href = await dialog.getByRole('link', { name: label, exact: true }).getAttribute('href');
      assert.equal((await page.request.get(origin + href)).status(), 200);
    }
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(row('PO-A').getByRole('button', { name: '1 张有效 · 查看', exact: true })).toBeVisible();
    if (process.env.CAIDAN_QA_DIR) await page.screenshot({ path: path.join(process.env.CAIDAN_QA_DIR, 'orders-deliveries.png') });
    await row('PO-B').getByRole('button', { name: '查看 / 生成', exact: true }).click();
    await expect(dialog.getByText('还没有送货单', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.goto(origin + '/#invoices');
    await expect(nav.getByRole('button', { name: '采购', exact: true })).toHaveAttribute('aria-current', 'page');
    await page.goto(origin + '/#deliveries');
    await expect(nav.getByRole('button', { name: '订单', exact: true })).toHaveAttribute('aria-current', 'page');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, checks: ['merged navigation', 'invoice purchase association', 'invoice isolation', 'follow-up', 'delivery order isolation', 'generation', 'exports', 'legacy routes'], errors }));
  } catch (error) { console.error(error); throw error; }
  finally { await Promise.race([client.close(), new Promise(resolve => setTimeout(resolve, 10000))]); }
})().catch(e => { console.error(e); process.exitCode = 1; });
