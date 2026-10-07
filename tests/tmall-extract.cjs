const {test} = require('node:test');
const assert = require('node:assert/strict');
const {extractOrder} = require('../desktop/extract-order.cjs');

test('extracts visible Tmall order fields and checks the URL order number', () => {
  const previous = {location:global.location, document:global.document};
  global.location = {hostname:'trade.tmall.com',pathname:'/detail/orderDetail.htm',href:'https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=1234567890123456789'};
  global.document = {
    body:{innerText:'淘宝 订单详情\n包裹1(共2件)\n中通快递 TEST12345678\n天猫 测试文具旗舰店\n付款详情\n实付款\n¥12.92\n订单信息\n订单编号\n1234567890123456789 复制\n创建时间\n2026-09-25 16:14:47\n订单备注 普票，PO99999990055，P70208 4-4，欧形端子，VE16-12（500只），数量1'},
    querySelector:() => null, querySelectorAll:() => []
  };
  try {
    const result = extractOrder();
    const status = {innerText:'交易关闭', children:[], getClientRects:()=>[{}]};
    global.document.querySelectorAll = selector => selector === '*' ? [status] : [];
    assert.equal(extractOrder().transaction_status, '交易关闭');
    assert.equal(result.platform_order,'1234567890123456789');
    assert.equal(result.source_url,'https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=1234567890123456789');
    assert.equal(result.amount,'12.92');
    assert.equal(result.shop,'测试文具旗舰店');
    assert.equal(result.purchased_date,'2026-09-25');
    assert.match(result.remark,/PO99999990055.*VE16-12/);
    assert.deepEqual(result.packages,[{carrier:'中通快递',tracking:'TEST12345678'}]);
    global.location.href = 'https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=9999999999999999999';
    assert.throws(extractOrder,/链接不一致/);
  } finally { global.location=previous.location; global.document=previous.document; }
});
