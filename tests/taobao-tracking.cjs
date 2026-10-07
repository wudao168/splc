const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
const {extractOrder} = require('../desktop/extract-order.cjs');

test('reads only the matching order package timeline', async () => {
  const browser = await chromium.launch({headless:true, ...(process.env.CAIDAN_CHROME ? {executablePath:process.env.CAIDAN_CHROME} : {})});
  try {
    const page = await browser.newPage();
    const html = await fs.readFile(path.join(__dirname, 'fixtures', 'taobao-order.html'), 'utf8');
    await page.route('https://trade.taobao.com/**', route => route.fulfill({body:html, contentType:'text/html; charset=utf-8'}));
    await page.goto('https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=1234567890123456789');
    const result = await page.evaluate(extractOrder);
    assert.equal(result.packages[0].status, '运输中');
    assert.deepEqual(result.packages[0].events, [{occurred_at:'2026-09-29T10:00:00+08:00', description:'快件已揽收'}]);
    assert.deepEqual(result.packages[1], {carrier:'测试快递', tracking:'TEST87654321'});
  } finally { await browser.close(); }
});

test('reads split timeline lines in alternate package wrappers without mixing packages', async () => {
  const browser = await chromium.launch({headless:true, ...(process.env.CAIDAN_CHROME ? {executablePath:process.env.CAIDAN_CHROME} : {})});
  try {
    const page = await browser.newPage();
    let html = await fs.readFile(path.join(__dirname, 'fixtures', 'taobao-order.html'), 'utf8');
    html = html.replace('logisticsPackage--fixture', 'logisticsPackageContent--fixture').replace('<div>运输中</div><div>2026-09-29 10:00:00 快件已揽收</div>', '<div>本人签收</div><div>2026年09月29日</div><div>9:00</div><div>包裹已由本人签收</div>');
    await page.route('https://trade.taobao.com/**', route => route.fulfill({body:html, contentType:'text/html; charset=utf-8'}));
    await page.goto('https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=1234567890123456789');
    const result = await page.evaluate(extractOrder);
    assert.equal(result.packages[0].status, '已签收');
    assert.deepEqual(result.packages[0].events, [{occurred_at:'2026-09-29T09:00:00+08:00', description:'包裹已由本人签收'}]);
    assert.deepEqual(result.packages[1], {carrier:'测试快递', tracking:'TEST87654321'});
  } finally { await browser.close(); }
});
