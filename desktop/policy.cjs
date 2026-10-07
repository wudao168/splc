function isTaobaoURL(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password && ['taobao.com','tmall.com','alipay.com'].some(d => u.hostname === d || u.hostname.endsWith('.' + d));
  } catch { return false; }
}
function isOrderURL(raw) {
  try { const u = new URL(raw); return u.protocol === 'https:' && ((u.hostname === 'trade.taobao.com' && u.pathname === '/trade/detail/trade_order_detail.htm') || (u.hostname === 'trade.tmall.com' && u.pathname === '/detail/orderDetail.htm')); }
  catch { return false; }
}
function isTaobaoLoginRedirect(error, currentURL = '') {
  return /https:\/\/(?:passport|login)\.taobao\.com(?:[/:?]|$)/i.test(`${error?.message || ''} ${currentURL}`);
}
module.exports = { isTaobaoURL, isOrderURL, isTaobaoLoginRedirect };
