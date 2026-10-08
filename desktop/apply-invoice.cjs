// 在淘宝发票中心页面为指定订单尝试点击「申请开票」。
// 只在页面上真的存在可点击入口时才点击；找不到就返回原因，由客户端提示手动处理。
function applyInvoiceInPage(platformOrder) {
  const order = String(platformOrder || '').trim();
  if (location.hostname !== 'i.taobao.com') return { error: '当前不是淘宝发票中心页面' };
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
