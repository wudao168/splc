import React, { useRef, useState } from 'react';
import Reports from './Reports';
import { money } from './api';
import { FileText, Package, Truck, Receipt, Warehouse, PackagePlus, PackageCheck, BellRing, ClipboardList, AlertTriangle } from 'lucide-react';
import { isInvoiceRemindCandidate } from './InvoiceReminders';

export default function Dashboard({ data }) {
  const [reportSelection, setReportSelection] = useState({kind:'orders'});
  const reportRef = useRef(null);
  const openReport = (kind, scope = '') => { setReportSelection({kind,scope}); reportRef.current?.scrollIntoView({behavior:'smooth',block:'start'}); };
  const goTo = route => { window.location.hash = route; };
  const activeOrderIds = new Set(data.orders.filter(o => o.status === 'confirmed' && !o.archived_at).map(o => o.id));
  const pending = data.order_lines.filter(x => activeOrderIds.has(x.order_id) && x.demand_quantity - x.purchased > .000001).length;
  const missing = data.purchases.filter(x => x.remaining_cents > 0 && x.invoice_stage !== '不需开票');
  const shipments = new Map(data.purchases.flatMap(p => (p.taobao_source?.packages || []).map(k => [k.tracking, k])));
  data.packages.forEach(k => shipments.set(k.tracking, k));
  const invoices = (data.sales_invoices || []).filter(i => i.status === 'active');
  const paid = invoices.reduce((sum,i) => sum + i.paid_cents,0), remaining = invoices.reduce((sum,i) => sum + i.remaining_cents,0);
  const inventory = data.inventory_totals || { items: 0, on_hand: 0, reserved: 0, available: 0, value_cents: 0, incoming: 0 };
  const toReceive = data.purchase_lines.filter(l => (l.receive_mode || 'direct') === 'stock'
    && Number(l.quantity) - Number(l.received_quantity || 0) > .000001).length;
  const toDeliver = data.order_lines.filter(l => activeOrderIds.has(l.order_id)
    && (l.demand_quantity ?? l.quantity) - (l.logistics_dispatched_quantity || 0) > .000001).length;
  const reminders = data.purchases.filter(isInvoiceRemindCandidate).length;
  const openCases = data.orders.reduce((sum, o) => sum + (o.open_cases || 0), 0)
    + (data.purchase_cases || []).filter(c => ['pending','processing'].includes(c.status)).length;
  const abnormal = [...shipments.values()].filter(x => ['异常','退回'].includes(x.status)).length;
  const stats = [
    [FileText, '客户订单', activeOrderIds.size, () => openReport('orders')],
    [Package, '待采购料品', pending, () => openReport('pending')],
    [PackagePlus, '待入库料品', toReceive, () => goTo('inventory?tab=receipts')],
    [Warehouse, '库存金额', money(inventory.value_cents), () => goTo('inventory?tab=overview')],
    [PackageCheck, '待交付料品', toDeliver, () => openReport('delivery')],
    [Truck, '在途包裹', [...shipments.values()].filter(x => ['待揽收','运输中','派送中'].includes(x.status)).length, () => openReport('purchases', 'transit')],
    [AlertTriangle, '异常包裹', abnormal, () => openReport('purchases', 'transit')],
    [Receipt, '待收发票', missing.length, () => openReport('invoices', 'missing')],
    [BellRing, '待催票', reminders, () => goTo('purchases?remind=1')],
    [ClipboardList, '待办变更 / 售后', openCases, () => goTo('orders')],
    [Receipt, '已回款', money(paid), () => goTo('sales-invoices')],
    [Receipt, '待回款', money(remaining), () => goTo('sales-invoices')],
  ];
  return <>
    <div className="metrics dashboard-metrics">{stats.map(([Icon, label, value, action], i) => <button className="metric" key={label} onClick={action}><span className={`metric-icon color-${i % 4}`}><Icon size={25}/></span><span><span className="metric-label">{label}</span><strong>{value}</strong></span></button>)}</div>
    <div ref={reportRef}><Reports selection={reportSelection} data={data}/></div>
  </>;
}
