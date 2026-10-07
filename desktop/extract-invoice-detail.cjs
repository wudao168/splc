// Runs on the read-only Taobao invoice detail page for one known order.
function extractInvoiceDetail(expectedOrder) {
  if (location.hostname !== 'invoice-ua.taobao.com' || location.pathname !== '/detail/pc') throw new Error('当前不是淘宝发票详情');
  const order = new URLSearchParams(location.hash.split('?')[1] || '').get('orderId');
  if (order !== expectedOrder) throw new Error('发票详情与采购订单号不一致');
  const invoices = [];
  for (const box of document.querySelectorAll('.invoice-detail-box')) {
    const fields = {};
    for (const row of box.querySelectorAll('.invoice-content')) {
      const label = row.querySelector('.invoice-label')?.textContent?.replace(/[：:]/g, '').trim();
      if (label) fields[label] = row.querySelector('.invoice-value')?.textContent?.trim() || '';
    }
    if (!fields['发票号码']) continue;
    invoices.push({
      number: fields['发票号码'],
      code: fields['发票代码'] || '',
      amount: (fields['发票金额'] || '').replace(/[￥¥,\s]/g, ''),
      invoice_type: fields['发票类型'] || '',
      date: fields['开票日期'] || '',
      title: fields['发票抬头'] || '',
      buyer_tax_id: fields['购方税号'] || '',
      content: fields['发票内容'] === '--' ? '' : fields['发票内容'] || ''
    });
  }
  if (!invoices.length) throw new Error('发票详情尚未显示票号');
  return {platform_order: order, invoices: invoices.slice(0, 50)};
}

function clickInvoiceDownload(expectedOrder, invoiceNumber) {
  if (location.hostname !== 'invoice-ua.taobao.com' || location.pathname !== '/detail/pc') return false;
  if (new URLSearchParams(location.hash.split('?')[1] || '').get('orderId') !== expectedOrder) return false;
  for (const box of document.querySelectorAll('.invoice-detail-box')) {
    const number = [...box.querySelectorAll('.invoice-content')].find(row =>
      row.querySelector('.invoice-label')?.textContent?.replace(/[：:]/g, '').trim() === '发票号码'
    )?.querySelector('.invoice-value')?.textContent?.trim();
    if (number !== invoiceNumber) continue;
    const isDownload = element => element.textContent?.trim() === '下载发票' &&
      element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
    // The invoice-value span can contain the actual download link. Clicking that
    // wrapper does not invoke the link's handler even though its text matches.
    const control = [...box.querySelectorAll('a, button, [role="button"]')].find(isDownload) ||
      [...box.querySelectorAll('span')].reverse().find(isDownload);
    if (!control) return false;
    control.click();
    return true;
  }
  return false;
}

module.exports = { extractInvoiceDetail, clickInvoiceDownload };
