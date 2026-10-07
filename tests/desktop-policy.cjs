const {test} = require('node:test');
const assert = require('node:assert/strict');
const {isTaobaoURL,isOrderURL,isTaobaoLoginRedirect} = require('../desktop/policy.cjs');
const {needsInvoiceFile, selectInvoicePurchases} = require('../desktop/invoice-targets.cjs');
const {isInvoiceDownloadURL} = require('../desktop/download-invoice.cjs');

test('invoice download accepts HTTPS file hosts but rejects local or executable URLs', () => {
  for (const url of ['https://invoice-ua.taobao.com/download/1', 'https://invoice-files.example.com/file.pdf?signature=test', 'blob:https://invoice-ua.taobao.com/file']) assert.equal(isInvoiceDownloadURL(url), true);
  for (const url of ['http://example.com/a.pdf', 'https://localhost/a.pdf', 'https://127.0.0.1/a.pdf', 'https://2130706433/a.pdf', 'https://[::1]/a.pdf', 'https://printer.local/a.pdf', 'https://example.com.:443/a.pdf', 'file:///a.pdf', 'javascript:alert(1)', 'https://user:pass@example.com/a.pdf', 'blob:http://127.0.0.1/file']) assert.equal(isInvoiceDownloadURL(url), false, url);
});
test('navigation limits protocols and checks domain boundaries', () => {
  for(const url of ['https://login.taobao.com/','https://trade.taobao.com/trade/detail/trade_order_detail.htm','https://login.alipay.com/']) assert.equal(isTaobaoURL(url),true);
  for(const url of ['http://trade.taobao.com/','file:///C:/test','javascript:alert(1)','https://taobao.com.evil.test/','https://eviltaobao.com/','https://127.0.0.1/','https://u:p@taobao.com/']) assert.equal(isTaobaoURL(url),false);
  assert.equal(isOrderURL('https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=123'),true);
  assert.equal(isOrderURL('https://trade.tmall.com/detail/orderDetail.htm?spm=test&bizOrderId=123'),true);
  assert.equal(isOrderURL('https://trade.tmall.com/detail/other.htm?bizOrderId=123'),false);
  assert.equal(isOrderURL('https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm'),false);
});

test('invoice sync recognizes an interrupted Taobao login redirect', () => {
  assert.equal(isTaobaoLoginRedirect(new Error("ERR_ABORTED (-3) loading 'https://passport.taobao.com/new/havanaone/login/continue.htm?contextToken=secret'")), true);
  assert.equal(isTaobaoLoginRedirect(new Error('ERR_ABORTED (-3)'), 'https://login.taobao.com/member/login.jhtml'), true);
  assert.equal(isTaobaoLoginRedirect(new Error('ERR_ABORTED (-3)'), 'https://invoice-ua.taobao.com/detail/pc'), false);
  assert.equal(isTaobaoLoginRedirect(new Error('ERR_ABORTED (-3) loading https://passport.taobao.com.evil.test/')), false);
});

test('invoice sync targets only selected orders with missing files', () => {
  const purchase = (id, details = [], extra = {}) => ({id, platform:'淘宝', platform_order:String(id), invoice_stage:'待申请',
    remaining_cents:2650, received_cents:0, invoice_expected_cents:2650, taobao_source:{invoice_details:details}, ...extra});
  const purchases = [purchase(1), purchase(2, [{amount_cents:2650, attachment_id:'file'}]),
    purchase(3, [{amount_cents:2650}]), purchase(4, [], {platform:'京东'}),
    purchase(5, [{amount_cents:1000, attachment_id:'file'}]),
    purchase(6, [{amount_cents:1000, attachment_id:'file'}], {received_cents:1000, remaining_cents:1650})];
  assert.deepEqual(selectInvoicePurchases(purchases, [2, 3, 4, 5, 6]).map(item => item.id), [3, 6]);
  assert.equal(needsInvoiceFile(purchases[0]), true);
  assert.equal(needsInvoiceFile(purchases[1]), false);
  assert.throws(() => selectInvoicePurchases(purchases, []), /先选择/);
  assert.throws(() => selectInvoicePurchases(purchases, [9]), /无效/);
});
