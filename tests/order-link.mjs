import {test} from 'node:test';
import assert from 'node:assert/strict';
import {orderDetailURL} from '../src/orderLink.js';

test('purchase order number links to the saved Taobao or Tmall detail page', () => {
  const purchase = {platform:'淘宝',platform_order:'1234567890123456789'};
  assert.equal(orderDetailURL(purchase),'https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=1234567890123456789');
  assert.equal(orderDetailURL({...purchase,taobao_source:{source_url:'https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=1234567890123456789'}}),'https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=1234567890123456789');
  assert.equal(orderDetailURL({...purchase,taobao_source:{source_url:'https://evil.test/?bizOrderId=1234567890123456789'}}),orderDetailURL(purchase));
  assert.equal(orderDetailURL({...purchase,platform:'京东'}),'');
});
