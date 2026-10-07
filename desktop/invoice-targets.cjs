function needsInvoiceFile(purchase) {
  if (purchase.platform !== '淘宝' || purchase.invoice_stage === '不需开票' || purchase.remaining_cents <= 0) return false;
  const details = purchase.taobao_source?.invoice_details || [];
  if (!details.length || details.some(invoice => !invoice.attachment_id)) return true;
  const downloadedCents = details.reduce((total, invoice) => total + invoice.amount_cents, 0);
  return purchase.received_cents >= downloadedCents && downloadedCents < purchase.invoice_expected_cents;
}

function selectInvoicePurchases(purchases, purchaseIds) {
  if (!Array.isArray(purchaseIds) || !purchaseIds.length || purchaseIds.some(id => !Number.isInteger(id) || id <= 0)) {
    throw new Error('请先选择需要获取发票的采购订单。');
  }
  const selected = new Set(purchaseIds);
  if (selected.size !== purchaseIds.length || purchases.filter(p => selected.has(p.id)).length !== selected.size) {
    throw new Error('所选采购订单无效，请刷新后重试。');
  }
  return purchases.filter(p => selected.has(p.id) && needsInvoiceFile(p));
}

module.exports = {needsInvoiceFile, selectInvoicePurchases};
