export function invoiceStatus(purchase) {
  const entries = purchase.taobao_source?.invoice_entries || [];
  if (purchase.invoice_stage === '不需开票') return {label:'不需开票', tone:'gray'};
  if (purchase.received_cents > 0 || purchase.taobao_source?.invoice_details?.length || entries.some(item => item.status === '已开票')) return {label:'已开票', tone:'green'};
  if (entries.some(item => item.status === '申请中') || purchase.invoice_stage === '已申请待开票') return {label:'未开票 · 申请中', tone:'orange'};
  if (entries.some(item => item.status === '商家拒绝')) return {label:'未开票 · 已拒绝', tone:'red'};
  if (purchase.invoice_stage === '店铺表示已开票') return {label:'店铺称已开票', tone:'orange'};
  return {label:purchase.platform === '淘宝' ? '待查询' : '未登记', tone:'gray'};
}
