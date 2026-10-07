export function orderDetailURL(purchase) {
  if (purchase.platform !== '淘宝' || !/^\d{8,30}$/.test(purchase.platform_order)) return '';
  const source = purchase.taobao_source?.source_url;
  if (source) {
    try {
      const url = new URL(source);
      const routes = {
        'trade.taobao.com/trade/detail/trade_order_detail.htm':'biz_order_id',
        'trade.tmall.com/detail/orderDetail.htm':'bizOrderId',
      };
      const parameter = routes[url.hostname + url.pathname];
      if (url.protocol === 'https:' && !url.username && !url.password && parameter && url.searchParams.get(parameter) === purchase.platform_order) return url.href;
    } catch { /* Use the standard Taobao order URL below. */ }
  }
  return `https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=${purchase.platform_order}`;
}
