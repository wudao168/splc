const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {submitInvoiceForm} = require('../desktop/apply-invoice-form.cjs');

const form = special => `<!doctype html><html><body>
  <div><span>发票类型</span>
    <label><input type="radio" name="type" value="normal">普通发票-电子</label>
    ${special ? '<label><input type="radio" name="type" value="special">专用发票-电子</label>' : ''}
  </div>
  <div><span>抬头类型</span>
    <label><input type="radio" name="title" value="personal">个人</label>
    <label><input type="radio" name="title" value="company">企业</label>
  </div>
  <div><label>发票抬头</label><input id="title" value=""></div>
  <div><label>纳税人识别号</label><input id="tax" value=""></div>
  <div><span>发票内容</span><label><input type="radio" name="content" value="detail">商品明细</label></div>
  <label><input type="checkbox" id="agree">我已阅读并同意《发票使用确认书》</label>
  <button id="save" onclick="window.__saved=true">保存</button>
</body></html>`;

(async () => {
  const browser = await chromium.launch({executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true});
  try {
    for (const special of [true, false]) {
      const page = await browser.newPage();
      await page.setContent(form(special));
      const result = await page.evaluate(submitInvoiceForm, {name: '上海思品利诚智能科技有限公司', tax_number: '91310120MADL4XAW73'});
      assert.equal(result.chosenType, special ? '专用发票-电子' : '普通发票-电子');
      assert.equal(await page.locator('#title').inputValue(), '上海思品利诚智能科技有限公司');
      assert.equal(await page.locator('#tax').inputValue(), '91310120MADL4XAW73');
      assert.equal(await page.locator('#agree').isChecked(), true);
      assert.equal(await page.evaluate(() => window.__saved === true), true);
      await page.close();
    }
    console.log('invoice form automation ok');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
