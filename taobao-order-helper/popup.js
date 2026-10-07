function readOrder() {
  if (location.hostname !== 'trade.taobao.com' || !location.pathname.includes('trade_order_detail.htm')) {
    throw new Error('请先打开淘宝订单详情页。');
  }
  const text = el => (el?.innerText || el?.textContent || '').trim();
  const leaf = (root, label) => [...root.querySelectorAll('*')].find(el => text(el) === label && ![...el.children].some(child => text(child) === label));
  const labeled = (root, label) => {
    const el = leaf(root, label);
    return el ? text(el.parentElement?.parentElement).replace(new RegExp(`^${label}\\s*`), '').replace(/复制$/, '').trim() : '';
  };
  const right = document.querySelector('.tbpc-order-detail-main-right-content-container');
  const shop = text(document.querySelector('a[class*="shopInfoName--"]'));
  const order = labeled(right || document, '订单编号');
  const date = labeled(right || document, '创建时间');
  const paid = leaf(right || document, '实付款');
  const amount = text(paid?.parentElement).match(/[￥¥]\s*([\d,]+(?:\.\d{1,2})?)/)?.[1] || '';
  const packageHeader = document.querySelector('[class*="logisticsPackageHeader--"]');
  const carrier = text(packageHeader?.querySelector('[class*="logisticsPackageEXTxt--"]'));
  const tracking = text(packageHeader).match(/\b[A-Z]{1,5}\d{8,25}\b|\b\d{10,25}\b/)?.[0] || '';
  const fields = [
    ['订单编号', order], ['店铺', shop], ['实付款', amount],
    ['下单时间', date], ['快递公司', carrier], ['运单号', tracking]
  ].filter(([, value]) => value);
  if (!order || !shop || !amount) throw new Error('未能识别订单号、店铺或实付款；淘宝页面结构可能已变化。');
  return fields.map(([key, value]) => `${key}：${value}`).join('\n');
}

document.querySelector('#copy').addEventListener('click', async () => {
  const status = document.querySelector('#status');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.startsWith('https://trade.taobao.com/trade/detail/trade_order_detail.htm')) {
      throw new Error('请先打开淘宝订单详情页。');
    }
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readOrder });
    await navigator.clipboard.writeText(result);
    status.textContent = '已复制订单号、店铺、实付款、日期及可见的物流信息。请回采购登记页粘贴并核对。';
  } catch (error) {
    status.textContent = error.message || String(error);
  }
});
