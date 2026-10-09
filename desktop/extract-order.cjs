// Runs in an isolated world in the currently displayed Taobao order page.
function extractOrder() {
  const tmall = location.hostname === 'trade.tmall.com' && location.pathname === '/detail/orderDetail.htm';
  if (!tmall && (location.hostname !== 'trade.taobao.com' || location.pathname !== '/trade/detail/trade_order_detail.htm')) {
    throw new Error('请打开一笔淘宝或天猫订单详情后再提取。');
  }
  const text = el => (el?.innerText || '').trim();
  const visible = el => !!el?.getClientRects().length;
  const leaf = (root, label) => [...root.querySelectorAll('*')].find(el => visible(el) && text(el) === label && ![...el.children].some(child => text(child) === label));
  const right = document.querySelector('.tbpc-order-detail-main-right-content-container') || document;
  const value = label => {
    const el = leaf(right, label);
    const row = el?.closest('[class*="detailInfoContent--"]');
    return row ? text(row).replace(label, '').replace(/复制\s*$/, '').trim() : '';
  };
  const transaction_status = ['交易关闭','订单关闭','交易取消','订单已取消','交易成功','等待买家付款','付款确认中','退款中的订单','买家已付款','卖家已发货'].find(status => leaf(document, status)) || '';
  const pageText = text(document.body);
  const order = value('订单编号').match(/^\d{8,30}$/)?.[0] || (tmall ? pageText.match(/订单编号\s*(\d{8,30})/)?.[1] : '');
  if (!order) throw new Error('尚未读取到订单编号，请等待订单详情加载完成。');
  const params = new URL(location.href).searchParams;
  const urlOrder = params.get('biz_order_id') || params.get('bizOrderId');
  if (urlOrder && urlOrder !== order) throw new Error('页面订单号与链接不一致，请刷新后重试。');
  const source_url = tmall ? `https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=${order}` : `https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=${order}`;
  const paid = leaf(right, '实付款');
  const amount = (text(paid?.closest('[class*="detailInfoContent--"]') || paid?.parentElement).match(/[￥¥]\s*([\d,]+(?:\.\d{1,2})?)/)?.[1] || (tmall ? pageText.match(/实付款[^￥¥]{0,30}[￥¥]\s*([\d,]+(?:\.\d{1,2})?)/)?.[1] : '') || '').replaceAll(',', '');
  const shop = (text(document.querySelector('a[class*="shopInfoName--"]')) || (tmall ? pageText.match(/(?:天猫|淘宝)\s*([^\n]{2,80}(?:旗舰店|专营店|专卖店|店铺))/)?.[1] : '') || '').slice(0,200);
  const createdMatch = (value('创建时间') || (tmall ? pageText : '')).match(/\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?/);
  const createdText = (createdMatch?.[0] || '').replace('T', ' ');
  const purchased_date = createdText.slice(0, 10);
  const purchased_at = createdText.length > 10 ? createdText : '';
  const remarkLabel = leaf(right, '订单备注');
  let remark = '';
  for (let node = remarkLabel?.parentElement, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
    const candidate = text(node).replace(/^订单备注\s*/, '').trim();
    if (candidate && candidate.length <= 500 && !/订单编号|支付方式|交易快照/.test(candidate)) { remark = candidate; break; }
  }
  if (!remark && tmall) remark = pageText.match(/订单备注\s*([^\n]{1,500})/)?.[1] || '';
  const packages = [];
  for (const header of document.querySelectorAll('[class*="logisticsPackageHeader--"]')) {
    if (!visible(header)) continue;
    const carrier = text(header.querySelector('[class*="logisticsPackageEXTxt--"]')).slice(0,80);
    const tracking = text(header).match(/\b[A-Z]{1,5}\d{8,25}\b|\b\d{10,25}\b/)?.[0];
    if (tracking && !packages.some(p => p.tracking === tracking)) {
      // Timeline wrappers vary between Taobao versions; keep each package isolated.
      let detail = header;
      for (let node = header.parentElement, depth = 0; node && node !== document.body && depth < 5; node = node.parentElement, depth++) {
        if (node.querySelectorAll('[class*="logisticsPackageHeader--"]').length !== 1) break;
        if (/订单编号|实付款|订单信息/.test(text(node))) break;
        detail = node;
      }
      const events = [];
      const lines = text(detail).split(/\n+/).map(s => s.trim()).filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        // The date, time and description can be separate DOM lines.
        let line = lines[i];
        if (/^(?:20\d{2}[-/.年])?\d{1,2}[-/.月]\d{1,2}日?$/.test(line) && /^\d{1,2}:\d{2}/.test(lines[i + 1] || '')) line += ' ' + lines[++i];
        const match = line.match(/((?:20\d{2}[-/.年])?\d{1,2}[-/.月]\d{1,2}日?)\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*(.*)/);
        if (!match) continue;
        const parts = match[1].replace(/日$/, '').split(/[-/.年月]/);
        if (parts.length === 2) parts.unshift(String(new Date().getFullYear()));
        const [year, month, day] = parts;
        const clock = match[2].split(':');
        const occurred_at = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${clock[0].padStart(2, '0')}:${clock[1]}:${clock[2] || '00'}+08:00`;
        const description = (match[3] || lines[i + 1] || '').trim().slice(0,200);
        if (description && !/^(?:20\d{2}[-/.年])?\d{1,2}[-/.月]\d{1,2}/.test(description) && !Number.isNaN(Date.parse(occurred_at)) && !events.some(e => e.occurred_at === occurred_at && e.description === description)) events.push({occurred_at, description});
      }
      const statusText = text(detail).replace(carrier, '').replace(tracking, '');
      const status = /已签收|签收成功|已收货|本人签收|代签收/.test(statusText) ? '已签收' : /派送中|正在派送|派件|配送中/.test(statusText) ? '派送中' : /退回|退件/.test(statusText) ? '退回' : /异常/.test(statusText) ? '异常' : /运输中|运输|已揽收|已发货|已到达|已收件|揽件|转运|离开|到达/.test(statusText) ? '运输中' : '';
      packages.push({carrier, tracking, ...(status ? {status} : {}), ...(events.length ? {events:events.slice(0, 50)} : {})});
    }
  }
  if (tmall && !packages.length) {
    const packageText = pageText.split(/包裹\s*\d+/).slice(1).join('\n').split(/订单信息|订单服务/)[0];
    for (const match of packageText.matchAll(/([^\s\n]{2,20}(?:快递|速递|物流))\s*([A-Z0-9]{10,30})/g)) {
      if (!packages.some(p => p.tracking === match[2])) packages.push({carrier:match[1], tracking:match[2]});
    }
  }
  const products = [];
  for (const row of document.querySelectorAll('.trade-order-detail-order-info')) {
    const link = row.querySelector('a[class*="title--"]');
    if (!visible(link)) continue;
    const name = text(link).slice(0,500);
    if (!name) continue;
    const url = new URL(link.href);
    const id = url.searchParams.get('id') || url.pathname.match(/^\/i(\d+)\.htm$/)?.[1];
    if (!id || !/^\d+$/.test(id)) continue;
    const productLink = `https://item.taobao.com/item.htm?id=${id}`;
    const spec = text(row.querySelector('[class*="baseInfoLeft--"] [class*="info--"]')).slice(0,500);
    const quantity = text(row?.querySelector('[class*="quantity"], [class*="Quantity"]')).match(/\d+(?:\.\d+)?/)?.[0] || '';
    const amount = text(row.querySelector('[class*="baseInfoRight--"]')).match(/[￥¥]\s*([\d,]+(?:\.\d{1,2})?)/)?.[1]?.replaceAll(',', '') || '';
    if (!products.some(p => p.link === productLink && p.spec === spec)) products.push({name, spec, quantity, amount, link:productLink});
  }
  const warnings = ['仅提取页面已展示的商品和包裹；如有折叠内容，请展开后重新提取。'];
  if (!shop) warnings.push('未识别到店铺，请手工填写。');
  if (!amount) warnings.push('未识别到实付款，请手工核对。');
  if (!purchased_date) warnings.push('未识别到创建日期，请手工填写。');
  if (!packages.length) warnings.push('页面未显示可识别的运单号，发货后可再次提取。');
  if (!products.length || products.some(p => !p.spec || !p.quantity)) warnings.push('商品规格或数量未完整识别，请对照订单页面核对。');
  const invoiceText = pageText.split(/\n/).map(line=>line.trim()).filter(line=>/发票|已开票|待开票/.test(line)).slice(0,8).join('；').slice(0,500);
  const invoiceStatus = /已开票|开票成功|已开具/.test(invoiceText) ? '已开票' : /开票中|开票处理中/.test(invoiceText) ? '开票中' : /未开票|待开票|申请发票/.test(invoiceText) ? '未开票' : '未提取';
  return {platform:'淘宝', transaction_status, platform_order:order, source_url, shop, amount, purchased_date, purchased_at, remark:remark.slice(0,500), invoice_info:{status:invoiceStatus,text:invoiceText}, packages:packages.slice(0,100), products:products.slice(0,100), warnings};
}
module.exports = { extractOrder };
