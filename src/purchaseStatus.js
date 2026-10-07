export const purchaseStatuses = {
  normal: '正常采购', returning: '退货中', returned: '已退货', partial_returned: '部分已退货',
  cancelling: '取消中', cancelled: '已取消', processing: '处理中', processed: '已处理',
};

export function purchaseStatusKeys(cases) {
  const active = cases.filter(c => c.status !== 'void');
  if (!active.length) return ['normal'];
  return [...new Set(active.map(c => c.kind === 'supplier_return'
    ? c.status === 'completed' ? 'returned' : 'returning'
    : c.kind === 'cancel' ? c.status === 'completed' ? 'cancelled' : 'cancelling'
      : c.status === 'completed' ? 'processed' : 'processing'))];
}
