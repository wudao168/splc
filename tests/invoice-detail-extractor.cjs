const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { extractInvoiceDetail, clickInvoiceDownload } = require('../desktop/extract-invoice-detail.cjs');

(async () => {
  const order = '3316438922003035380', number = '26337000000000000001';
  const browser = await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless:true});
  try {
    const page = await browser.newPage({acceptDownloads:true});
    await page.route('https://invoice-ua.taobao.com/**', route => {
      if (route.request().url().includes('/download/test.pdf')) return route.fulfill({
        body:'%PDF-1.4\nTest invoice', headers:{'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="invoice.pdf"'}
      });
      const fields = [['发票号码',number], ['发票金额','¥30.00'], ['开票日期','2026-10-03']];
      const html = `<div class="invoice-detail-box">${fields.map(([label,value]) => `<div class="invoice-content"><span class="invoice-label">${label}：</span><span class="invoice-value">${value}</span></div>`).join('')}<span class="invoice-value"><a href="https://invoice-ua.taobao.com/download/test.pdf"><span>下载发票</span></a></span></div>`;
      return route.fulfill({body:html, contentType:'text/html; charset=utf-8'});
    });
    await page.goto(`https://invoice-ua.taobao.com/detail/pc#/?orderId=${order}`);
    await page.locator('.invoice-detail-box').waitFor();
    const detail = await page.evaluate(extractInvoiceDetail, order);
    assert.equal(detail.invoices[0].number, number);
    await page.locator('.invoice-detail-box a').evaluate(element => element.addEventListener('click', () => { document.body.dataset.downloadClicked = 'yes'; }));
    const transfer = page.waitForEvent('download', {timeout:30000});
    transfer.catch(() => {});
    assert.equal(await page.evaluate(`(${clickInvoiceDownload.toString()})(${JSON.stringify(order)},${JSON.stringify(number)})`), true);
    assert.equal(await page.evaluate(() => document.body.dataset.downloadClicked), 'yes', 'the nested link, not its wrapper, must receive the click');
    assert.equal((await transfer).suggestedFilename(), 'invoice.pdf');
    console.log('发票详情识别和下载触发：通过');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
