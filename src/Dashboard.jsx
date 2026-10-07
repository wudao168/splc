import React, { useRef, useState } from 'react';
import Reports from './Reports';
import { money } from './api';
import { FileText, Package, Truck, Receipt } from 'lucide-react';

export default function Dashboard({ data }) {
  const [reportSelection, setReportSelection] = useState({kind:'orders'});
  const reportRef = useRef(null);
  const openReport = (kind, scope = '') => { setReportSelection({kind,scope}); reportRef.current?.scrollIntoView({behavior:'smooth',block:'start'}); };
  const activeOrderIds = new Set(data.orders.filter(o => o.status === 'confirmed' && !o.archived_at).map(o => o.id));
  const pending = data.order_lines.filter(x => activeOrderIds.has(x.order_id) && x.demand_quantity - x.purchased > .000001).length;
  const missing = data.purchases.filter(x => x.remaining_cents > 0 && x.invoice_stage !== '不需开票');
  const shipments = new Map(data.purchases.flatMap(p => (p.taobao_source?.packages || []).map(k => [k.tracking, k])));
  data.packages.forEach(k => shipments.set(k.tracking, k));
  const invoices = (data.sales_invoices || []).filter(i => i.status === 'active');
  const paid = invoices.reduce((sum,i) => sum + i.paid_cents,0), remaining = invoices.reduce((sum,i) => sum + i.remaining_cents,0);
  const stats = [[FileText, '客户订单', activeOrderIds.size, 'orders'], [Package, '待采购料品', pending, 'pending'], [Truck, '在途包裹', [...shipments.values()].filter(x => ['待揽收','运输中','派送中'].includes(x.status)).length, 'logistics'], [Receipt, '待收发票', missing.length, 'invoices'], [Receipt, '已回款', money(paid), 'sales-invoices'], [Receipt, '待回款', money(remaining), 'sales-invoices']];
  return <>
    <div className="metrics dashboard-metrics">{stats.map(([Icon, label, value, route], i) => <button className="metric" key={label} onClick={() => route === 'sales-invoices' ? window.location.hash = 'sales-invoices' : openReport(route === 'logistics' ? 'purchases' : route, route === 'logistics' ? 'transit' : route === 'invoices' ? 'missing' : '')}><span className={`metric-icon color-${i % 4}`}><Icon size={25}/></span><span><span className="metric-label">{label}</span><strong>{value}</strong></span></button>)}</div>
    <div ref={reportRef}><Reports selection={reportSelection} data={data}/></div>
  </>;
}
