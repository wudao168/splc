// Read only visible order links and their creation dates; never act on order controls.
function extractOrderList(advance = false) {
  if (location.hostname !== 'buyertrade.taobao.com') throw new Error('淘宝订单列表需要登录或验证');
  const visible = el => !!el.getClientRects().length;
  const text = el => (el?.innerText || '').trim();
  const disabled = el => !!el && (el.disabled || el.getAttribute('aria-disabled') === 'true' || !!el.closest('[disabled],[aria-disabled="true"],[class*="disabled"],[class*="Disabled"]'));
  const paginationSelector = '[class*="pagination"],[class*="Pagination"],[class*="pager"],[class*="Pager"],[aria-label*="分页"]';
  const controls = [...document.querySelectorAll('button,a,[role="button"],li,span,div')].filter(visible);
  const label = el => [text(el), el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' ').trim();
  const isNext = el => {
    const name = label(el);
    const cls = typeof el.className === 'string' ? el.className : '';
    return name.length < 60 && /^(下一页|下页|next(?: page)?)(?:\s|[>›»]|$)/i.test(name) ||
      /(?:^|[-_\s])next(?:$|\s|--|[-_](?:next|btn|button)(?:$|[-_\s]))|(?:^|\s)next(?:Btn|Button)/.test(cls) && (!!el.closest(paginationSelector) || /pagination|pager/i.test(cls));
  };
  // Prefer the actual leaf control; a wrapper named "next-pagination" is not
  // a next-page button. Multiple pagers can have different enabled states.
  const nextControls = controls.filter(isNext).filter(el => ![...el.querySelectorAll('button,a,[role="button"],li,span,div')].some(child => visible(child) && isNext(child)));
  const pagers = [...document.querySelectorAll(paginationSelector)].filter(visible);
  const currentElement = pagers.flatMap(el => [...el.querySelectorAll('[aria-current="page"],[class*="active"],[class*="current"],[class*="selected"]')]).find(el => /^\d+$/.test(text(el)));
  const currentPage = currentElement ? Number(text(currentElement)) : null;
  const numericNext = currentPage == null ? null : controls.find(el => el.closest(paginationSelector) && text(el) === String(currentPage + 1) && !disabled(el) && ![...el.children].some(child => text(child) === String(currentPage + 1)));
  const next = nextControls.find(el => !disabled(el)) || numericNext;
  const pageText = pagers.map(text).join(' ');
  const totalMatch = pageText.match(/共\s*(\d+)\s*页/);
  const totalPages = totalMatch ? Number(totalMatch[1]) : null;
  const hasNext = !!next;
  const lastPage = !hasNext && (nextControls.length > 0 && nextControls.every(disabled) || currentPage != null && totalPages != null && currentPage >= totalPages);
  if (advance) {
    if (next) { next.scrollIntoView({block:'center'}); next.click(); }
    return hasNext;
  }
  const orders = new Map();
  for (const a of document.querySelectorAll('a[href]')) {
    if (!visible(a)) continue;
    let url;
    try { url = new URL(a.href); } catch { continue; }
    if (url.protocol !== 'https:' || url.username || url.password) continue;
    const tmall = url.hostname === 'trade.tmall.com' && url.pathname === '/detail/orderDetail.htm';
    if (!tmall && !(url.hostname === 'trade.taobao.com' && url.pathname === '/trade/detail/trade_order_detail.htm')) continue;
    const id = url.searchParams.get('biz_order_id') || url.searchParams.get('bizOrderId');
    if (!/^\d{8,30}$/.test(id || '')) continue;
    let row = a.parentElement, date = '';
    while (row && row !== document.body) {
      const dates = [...text(row).matchAll(/\b(20\d{2})[-年/](\d{1,2})[-月/](\d{1,2})日?/g)];
      if (dates.length) { date = `${dates[0][1]}-${dates[0][2].padStart(2,'0')}-${dates[0][3].padStart(2,'0')}`; break; }
      row = row.parentElement;
    }
    const source_url = tmall ? `https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=${id}` : `https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=${id}`;
    if (!orders.has(id) || date) orders.set(id, {platform_order:id, date, source_url});
  }
  // Some list layouts use a routed or scripted detail link. The order header
  // still supplies the explicit order identity and date.
  for (const element of document.querySelectorAll('span,div,td,p')) {
    if (!visible(element)) continue;
    const match = text(element).match(/订单号\s*[:：]\s*(\d{8,30})\b/);
    if (!match || [...element.children].some(child => /订单号\s*[:：]\s*\d{8,30}\b/.test(text(child)))) continue;
    const id = match[1];
    let row = element;
    while (row.parentElement && row.parentElement !== document.body) {
      if ([...text(row.parentElement).matchAll(/订单号\s*[:：]\s*\d{8,30}\b/g)].length > 1) break;
      row = row.parentElement;
    }
    const date = text(row).match(/\b(20\d{2})[-年/](\d{1,2})[-月/](\d{1,2})日?/);
    const existing = orders.get(id);
    orders.set(id, {
      platform_order:id,
      date:date ? `${date[1]}-${date[2].padStart(2,'0')}-${date[3].padStart(2,'0')}` : existing?.date || '',
      source_url:existing?.source_url || (/天猫/.test(text(row)) ? `https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=${id}` : `https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=${id}`),
    });
  }
  const empty = /没有(?:符合条件的|相关的|相关)?订单|暂无订单/.test(text(document.body));
  if (!orders.size && !empty) throw new Error('淘宝订单列表尚未加载或需要验证');
  return {orders:[...orders.values()], hasNext, lastPage:lastPage || empty, currentPage, totalPages, pagination:pageText.slice(0, 600)};
}
module.exports = {extractOrderList};
