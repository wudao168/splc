// 在淘宝发票中心页面为指定订单尝试点击「申请开票」。
// 只在页面上真的存在可点击入口时才点击；找不到就返回原因，由客户端提示手动处理。
function applyInvoiceInPage(platformOrder) {
  const order = String(platformOrder || '').trim();
  const visible = element => {
    const rect = element.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  };
  const text = element => (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
  const labels = ['申请开票', '申请发票', '立即申请', '去申请'];
  const hits = label => element => {
    const value = text(element);
    return value && (value === label || value.startsWith(label)) && value.length <= label.length + 8;
  };
  // 订单详情页（淘宝 + 天猫）：同步物流时本来就会打开这一页，可以直接点「申请开票」。
  const onOrderPage = (location.hostname === 'trade.taobao.com' && location.pathname === '/trade/detail/trade_order_detail.htm')
    || (location.hostname === 'trade.tmall.com' && location.pathname === '/detail/orderDetail.htm');
  if (onOrderPage) {
    const pageOrder = (document.body.innerText.match(/订单编号\s*(\d{8,30})/) || [])[1] || '';
    if (pageOrder !== order) return { clicked:false, message:'页面订单号与目标订单不一致' };
    // 订单内容区是异步渲染的：没出现「订单编号」说明内容还没加载出来。
    if (!/订单编号/.test(document.body.innerText)) return { clicked:false, ready:false, message:'订单内容还在加载' };
    // 这些操作项有的是 <button>、有的是 <div>/<span>，按文字找最内层节点再点它的可点击祖先。
    for (const label of labels) {
      const leaves = [...document.querySelectorAll('button, a, [role="button"], div, span, li')]
        .filter(element => visible(element) && text(element) === label);
      if (!leaves.length) continue;
      const target = leaves[leaves.length - 1].closest('button, a, [role="button"]') || leaves[leaves.length - 1];
      target.click();
      return { clicked: true, label, scope: 'order-page' };
    }
    const labelsOnPage = [...document.querySelectorAll('button, a, [role="button"], div, span')]
      .filter(element => visible(element) && element.children.length === 0 && text(element))
      .map(text).filter(value => value.length <= 12).slice(0, 24);
    return { clicked:false, ready:true, message:'订单详情页没有「申请开票」入口（可能已开票或该店铺不支持平台开票）', labels: labelsOnPage };
  }
  if (location.hostname !== 'i.taobao.com') return { error: '当前页面不支持申请开票' };
  const containers = [...document.querySelectorAll('table[role="row"], tbody tr, [class*="group"]')]
    .filter(row => text(row).includes(order));
  const scopes = containers.length ? containers : [];
  const pick = scope => {
    for (const label of labels) {
      const matched = [...scope.querySelectorAll('button, a, [role="button"]')]
        .filter(element => visible(element) && hits(label)(element));
      if (matched.length) return { element: matched[0], label };
    }
    return null;
  };
  for (const scope of scopes) {
    const found = pick(scope);
    if (found) {
      found.element.click();
      return { clicked: true, label: found.label, scope: 'row' };
    }
  }
  for (const scope of [document]) {
    const found = pick(scope);
    if (found) {
      found.element.click();
      return { clicked: true, label: found.label, scope: 'page' };
    }
  }
  const hint = containers[0] ? text(containers[0]).slice(0, 200) : '';
  return {
    clicked: false,
    message: containers.length
      ? `该订单在发票中心没有可点击的申请入口（页面显示：${hint || '—'}）`
      : '发票中心当前分类里没有找到这个订单，可能已申请或需要切换分类'
  };
}

module.exports = { applyInvoiceInPage };
