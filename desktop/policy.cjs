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
function isTaobaoVerifyURL(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    if (/(?:^|\.)sec\.taobao\.com$|(?:^|\.)sec\.tmall\.com$|(?:^|\.)passport\.taobao\.com$|(?:^|\.)login\.taobao\.com$|(?:^|\.)login\.tmall\.com$/.test(u.hostname)) return true;
    return /punish|captcha|verify|nocaptcha/i.test(u.hostname + u.pathname);
  } catch { return false; }
}
function isTaobaoLoginRedirect(error, currentURL = '') {
  return /https:\/\/(?:passport|login)\.taobao\.com(?:[/:?]|$)/i.test(`${error?.message || ''} ${currentURL}`);
}
// 淘宝会在访问部分子站前先跳一次 login.taobao.com/havanaone/render_*.htm
// 刷新 UMID 令牌，随后自动跳回目标页；这类中转页不代表需要人工登录。
function isTaobaoTransientRedirect(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname === 'login.taobao.com' && /render_/.test(u.pathname);
  } catch { return false; }
}
module.exports = { isTaobaoURL, isOrderURL, isTaobaoVerifyURL, isTaobaoLoginRedirect, isTaobaoTransientRedirect };
