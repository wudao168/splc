import React, { useState } from 'react';
import { Plus, Download, RefreshCw, ChartColumn } from 'lucide-react';
import { Trash, OrderLifecycle } from './Lifecycle';
import Deliveries from './Deliveries';
import OrderReturnForm, { returnableDeliveries } from './OrderReturn';
import OrderCancelForm, { canCancelOrder } from './OrderCancel';
import { ReserveForm, OutboundForm, ItemBinder } from './Inventory';
import { itemLabel } from './Items';
import { ColumnSettings, useColumnSettings } from './columnSettings';

const ORDER_COLUMNS = [['po','客户 PO'],['customer','客户'],['created_at','订单时间'],['quote','报价'],['cost','采购成本'],['profit','毛利润'],['margin','利润率'],['invoice','开票状态'],['collection','回款状态'],['detail','订单明细'],['due','交期'],['delivery','送货单'],['salesperson','业务员'],['items','料品'],['note','订单备注'],['status','订单状态']];
import { OrderSalesSummary } from './SalesInvoices';
import { api, money, q } from './api';
import Pagination, { usePagination } from './Pagination';
/** 订单当前阶段：按“异常 / 退货 / 签收 / 在途 / 待发货 / 采购中 / 未采购”优先取一个主状态。 */
const ORDER_PHASES = { draft: '报价草稿', cancelled: '已取消', pending: '未采购', purchasing: '采购中', ready: '待发货', transit: '在途', received: '已签收', completed: '已完成', returning: '退货中', exception: '有异常' };
const ORDER_PHASE_TONES = { completed: 'green', received: 'green', exception: 'red', returning: 'orange', transit: 'orange', ready: 'orange', purchasing: 'orange' };
const ORDER_PHASE_FILTERS = [['intake','未完成草稿'],['draft','报价草稿'],['cancelled','已取消'],['pending','未采购'],['purchasing','采购中'],['ready','待发货'],['transit','在途'],['received','已签收'],['completed','已完成'],['returning','退货中'],['exception','有异常']];
const orderLineTotals = lines => ({
  demand: lines.reduce((sum, line) => sum + Number((line.demand_quantity ?? line.quantity) || 0), 0),
  purchased: lines.reduce((sum, line) => sum + Number(line.purchased || 0), 0),
  secured: lines.reduce((sum, line) => sum + Number(line.secured_quantity || 0), 0),
  dispatched: lines.reduce((sum, line) => sum + Number(line.dispatched_quantity || 0), 0),
  signed: lines.reduce((sum, line) => sum + Number(line.signed || 0), 0),
  returning: lines.reduce((sum, line) => sum + Number(line.returning_quantity || 0), 0),
  cancelled: lines.reduce((sum, line) => sum + Number(line.cancelled_quantity || 0), 0),
});
const orderPackages = (data, orderId) => {
  const lineIds = new Set((data.order_lines || []).filter(line => line.order_id === orderId).map(line => line.id));
  const purchaseIds = new Set((data.purchase_lines || []).filter(line => lineIds.has(line.order_line_id)).map(line => line.purchase_id));
  const packageIds = new Set((data.package_lines || []).filter(line => (data.purchase_lines || []).some(pl => pl.id === line.purchase_line_id && purchaseIds.has(pl.purchase_id))).map(line => line.package_id));
  return (data.packages || []).filter(pkg => packageIds.has(pkg.id));
};
function orderPhase(data, order) {
  if (order.status === 'cancelled') return 'cancelled';
  if (order.status === 'draft') return 'draft';
  const lines = (data.order_lines || []).filter(line => line.order_id === order.id);
  const totals = orderLineTotals(lines);
  const packages = orderPackages(data, order.id);
  const full = totals.demand > 1e-6;
  const cases = (data.order_cases || []).filter(item => lines.some(line => line.id === item.order_line_id) && item.status !== 'void');
  const afterSales = cases.some(item => ['return', 'exchange'].includes(item.kind) && item.status !== 'completed');
  if (packages.some(pkg => pkg.status === '异常' || pkg.status === '退回')) return 'exception';
  if (totals.returning > 1e-6 || afterSales) return 'returning';
  if (full && !order.open_cases && totals.signed >= totals.demand - 1e-6 && (totals.secured >= totals.demand - 1e-6 || totals.dispatched >= totals.demand - 1e-6)) return 'completed';
  if (full && totals.signed >= totals.demand - 1e-6) return 'received';
  if (packages.some(pkg => ['待揽收', '运输中', '派送中'].includes(pkg.status)) || totals.dispatched > 1e-6) return 'transit';
  if (full && totals.secured >= totals.demand - 1e-6 && totals.dispatched <= 1e-6) return 'ready';
  if (totals.secured > 1e-6 || totals.purchased > 1e-6 || totals.dispatched > 1e-6) return 'purchasing';
  return 'pending';
}
const orderPhaseDetail = lines => {
  const totals = orderLineTotals(lines);
  const parts = [
    totals.purchased > 1e-6 ? `采购在途 ${q(totals.purchased)}` : '',
    totals.secured > 1e-6 ? `备货 ${q(totals.secured)}/${q(totals.demand)}` : '',
    totals.dispatched > 1e-6 ? `发货 ${q(totals.dispatched)}/${q(totals.demand)}` : '',
    totals.signed > 1e-6 ? `签收 ${q(totals.signed)}` : '',
    totals.returning > 1e-6 ? `退货中 ${q(totals.returning)}` : '',
  ].filter(Boolean);
  return parts.length ? parts : ['尚未开始采购'];
};
const orderPhaseTitle = (data, order) => {
  const lines = (data.order_lines || []).filter(line => line.order_id === order.id);
  const totals = orderLineTotals(lines);
  const packages = orderPackages(data, order.id);
  const counts = ['待揽收', '运输中', '派送中', '已签收', '异常', '退回'].map(name => [name, packages.filter(pkg => pkg.status === name).length]).filter(([, count]) => count).map(([name, count]) => `${name} ${count}`);
  const pendingAmount = (data.order_cases || []).filter(item => lines.some(line => line.id === item.order_line_id) && item.status !== 'void' && item.amount_cents > 0 && !item.finance_confirmed_at).reduce((sum, item) => sum + item.amount_cents, 0);
  return [
    ORDER_PHASES[orderPhase(data, order)],
    ...orderPhaseDetail(lines),
    '',
    `需求 ${q(totals.demand)} · 已落实备货 ${q(totals.secured)}（采购在途 ${q(totals.purchased)}） · 已发货 ${q(totals.dispatched)} · 已签收 ${q(totals.signed)}`,
    totals.returning ? `退货待收回 ${q(totals.returning)}` : '',
    totals.cancelled ? `已取消数量 ${q(totals.cancelled)}` : '',
    counts.length ? `包裹：${counts.join('、')}` : '暂无物流包裹',
    order.open_cases ? `${order.open_cases} 项变更／售后待处理` : '',
    pendingAmount ? `待确认售后金额 ${money(pendingAmount)}` : '',
    order.cancellation_reason ? `取消原因：${order.cancellation_reason}` : '',
    order.version > 1 ? `第 ${order.version} 版报价` : '',
  ].filter(Boolean).join('\n');
};

const orderShippedQty = lines => lines.reduce((sum, line) => sum + Number(line.dispatched_quantity || 0), 0);
const orderDemandQty = lines => lines.reduce((sum, line) => sum + Number((line.demand_quantity ?? line.quantity) || 0), 0);
import { Panel, Table, FixedCell, Empty, Button, Badge, Modal, SearchBox, SaveBar, SearchSelect, matchCustomer } from './components';

export default function Orders({ data, run, busy, refresh, navigate, user }) {
  const requestedOrderId = Number(new URLSearchParams(location.hash.split('?')[1] || '').get('order'));
  const [search, setSearch] = useState(''), [status, setStatus] = useState(''), [selected, setSelected] = useState(() => data.orders.some(o => o.id === requestedOrderId) ? requestedOrderId : null);
  const [selectedKeys, setSelectedKeys] = useState([]), [pendingDelete, setPendingDelete] = useState([]);
  const [view, setView] = useState('active'), [returnOrderId, setReturnOrderId] = useState(null), [cancelOrderId, setCancelOrderId] = useState(null), [showSummary, setShowSummary] = useState(false);
  const [invoiceStatus, setInvoiceStatus] = useState('');
  const [collectionStatus, setCollectionStatus] = useState('');
  const [salesperson, setSalesperson] = useState('');
  const [orderSort, setOrderSort] = useState({ key: '', descending: true });
  const [deliveryOrderId, setDeliveryOrderId] = useState(null);
  const { hidden, toggle, reset, attr } = useColumnSettings(user, 'orders');
  const deliveryOrder = data.orders.find(o => o.id === deliveryOrderId);
  const [customer, setCustomer] = useState(''), [purchaseStatus, setPurchaseStatus] = useState('');
  const [dateFrom, setDateFrom] = useState(''), [dateTo, setDateTo] = useState('');
  const inDateRange = value => (!dateFrom || value >= dateFrom) && (!dateTo || value <= dateTo);
  const customers = [...new Set([...data.orders.map(o => o.customer), ...(data.intake_drafts || []).map(d => d.payload.form?.customer)].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const isPurchased = o => { const lines = data.order_lines.filter(l => l.order_id === o.id && (l.demand_quantity ?? l.quantity) > .000001); return lines.length > 0 && lines.every(l => l.purchased >= (l.demand_quantity ?? l.quantity) - .000001); };
  const receivedCents = o => (o.paid_cents || 0) - (o.refunded_cents || 0);
  const salespersonName = id => (data.users || []).find(user => user.id === Number(id))?.display_name || '';
  const salespersonOptions = [{ value: '', label: '全部业务员' }, { value: '__none__', label: '未指定' }, ...(data.users || []).filter(user => user.active).map(user => ({ value: user.display_name, label: user.display_name }))];
  const matchesSalesperson = id => !salesperson || (salesperson === '__none__' ? !id : matchCustomer(salesperson, salespersonName(id)));
  const orderSortValue = o => {
    if (!orderSort.key) return 0;
    const lines = data.order_lines.filter(l => l.order_id === o.id);
    const quote = lines.reduce((sum, l) => sum + l.quote_cents, 0), cost = lines.reduce((sum, l) => sum + l.cost_cents, 0);
    if (orderSort.key === 'created') return (o.created_at || '').slice(0, 10) || '';
    if (orderSort.key === 'quote') return quote;
    if (orderSort.key === 'cost') return cost;
    if (orderSort.key === 'profit') return quote - cost;
    return quote ? (quote - cost) / quote : 0;
  };
  const orderSortHeader = (key, label) => <button type="button" className="draft-sort-button" aria-label={`${label}排序`} onClick={() => { setOrderSort(current => ({ key, descending: current.key === key ? !current.descending : true })); pagination.setPage(1); setSelectedKeys([]); }}>{label}<span className="sort-triangles" aria-hidden="true"><span className={orderSort.key === key && !orderSort.descending ? 'active' : ''}>▲</span><span className={orderSort.key === key && orderSort.descending ? 'active' : ''}>▼</span></span></button>;
  const collectionState = o => { const received = receivedCents(o), receivable = o.receivable_cents || 0; return received <= 0 ? '未回款' : receivable > 0 && received < receivable ? '部分回款' : '已回款'; };
  const term = search.toLowerCase();
  const filteredOrders = data.orders.filter(o => (view === 'archived' ? !!o.archived_at : view === 'active' && !o.archived_at) && inDateRange((o.created_at || '').slice(0, 10)) && (!invoiceStatus || o.invoice_status === invoiceStatus) && matchCustomer(customer, o.customer) && (!purchaseStatus || (purchaseStatus === 'complete' ? isPurchased(o) : !isPurchased(o))) && (!status || (status !== 'intake' && orderPhase(data, o) === status)) && (!collectionStatus || collectionState(o) === collectionStatus) && matchesSalesperson(o.salesperson_id) && `${o.customer} ${o.po} ${o.contact} ${o.phone || ''} ${o.address || ''} ${salespersonName(o.salesperson_id)} ${o.note || ''} ${data.order_lines.filter(l => l.order_id === o.id).map(l => `${l.name} ${l.spec} ${l.remark || ''}`).join(' ')}`.toLowerCase().includes(term));
  if (orderSort.key) filteredOrders.sort((a, b) => { const x = orderSortValue(a), y = orderSortValue(b); const result = typeof x === 'string' ? x.localeCompare(y) : x - y; return (orderSort.descending ? -1 : 1) * result || b.id - a.id; });
  const filteredDrafts = !!invoiceStatus || !!collectionStatus || view !== 'active' || purchaseStatus === 'complete' || (status && status !== 'intake') ? [] : (data.intake_drafts || []).filter(d => inDateRange((d.created_at || d.updated_at || '').slice(0, 10)) && matchCustomer(customer, d.payload.form?.customer) && matchesSalesperson(d.payload.form?.salesperson_id) && `${d.payload.form?.customer || ''} ${d.payload.form?.po || ''} ${d.payload.form?.note || ''} ${d.payload.source?.filename || ''} ${(d.payload.lines || []).map(l => `${l.name || ''} ${l.spec || ''} ${l.remark || ''}`).join(' ')}`.toLowerCase().includes(term));
  const pagination = usePagination(filteredDrafts.length + filteredOrders.length);
  const pageDrafts = filteredDrafts.slice(pagination.start, pagination.end);
  const pageOrders = filteredOrders.slice(Math.max(0, pagination.start - filteredDrafts.length), Math.max(0, pagination.end - filteredDrafts.length));
  const lineToOrder = new Map(data.order_lines.map(line => [line.id, line.order_id]));
  const purchaseProtectedOrders = new Set(data.purchase_lines.map(line => lineToOrder.get(line.order_line_id)));
  const deliveryProtectedOrders = new Set(data.delivery_lines.map(line => lineToOrder.get(line.order_line_id)).filter(Boolean));
  const otherProtectedOrders = new Set([...(data.order_cases || []).map(c => lineToOrder.get(c.order_line_id)), ...(data.order_receipts || []).map(r => r.order_id), ...(data.sales_invoice_orders || []).map(a => a.order_id)]);
  const protectedOrders = new Set([...purchaseProtectedOrders, ...deliveryProtectedOrders, ...otherProtectedOrders]);
  const canDelete = !!user;
  const selectableItems = [
    ...pageDrafts.map(d => ({ type: 'intake', id: d.id, label: d.payload.form?.po || d.payload.source?.filename || `草稿 ${d.id}` })),
    ...pageOrders.map(o => ({ type: 'order', id: o.id, label: o.po, protected: protectedOrders.has(o.id) })),
  ];
  const keyFor = item => `${item.type}:${item.id}`;
  const selectedItems = selectableItems.filter(item => selectedKeys.includes(keyFor(item)));
  const allSelected = selectableItems.length > 0 && selectedItems.length === selectableItems.length;
  const toggleItem = item => setSelectedKeys(keys => keys.includes(keyFor(item)) ? keys.filter(key => key !== keyFor(item)) : [...keys, keyFor(item)]);
  const toggleAll = () => setSelectedKeys(keys => allSelected ? keys.filter(key => !selectableItems.some(item => keyFor(item) === key)) : [...new Set([...keys, ...selectableItems.map(keyFor)])]);
  const pickedOrder = selectedItems.length === 1 && selectedItems[0].type === 'order' ? data.orders.find(o => o.id === selectedItems[0].id) : null;
  const pickedDraft = selectedItems.length === 1 && selectedItems[0].type === 'intake' ? selectedItems[0] : null;
  const pickedCanCancel = pickedOrder ? canCancelOrder(data, pickedOrder) : false;
  const pickedCanReturn = pickedOrder ? returnableDeliveries(data, pickedOrder.id).length > 0 : false;
  const canDeleteSelected = canDelete && selectedItems.length > 0 && selectedItems.every(item => !item.protected);
  const confirmDelete = () => run(async () => {
    await api('/orders/delete', { items: pendingDelete.map(({ type, id }) => ({ type, id })) });
    setPendingDelete([]); setSelectedKeys([]);
  }, `已删除 ${pendingDelete.length} 条记录`);
  const order = data.orders.find(o => o.id === selected);
  const returnOrder = data.orders.find(o => o.id === returnOrderId);
  const cancelOrder = data.orders.find(o => o.id === cancelOrderId);
  const summary = filteredOrders.reduce((acc, o) => {
    const lines = data.order_lines.filter(l => l.order_id === o.id);
    return {
      quote: acc.quote + lines.reduce((sum, l) => sum + l.quote_cents, 0),
      receivable: acc.receivable + Number(o.receivable_cents || 0),
      adjustment: acc.adjustment + Number(o.adjustment_cents || 0),
      cost: acc.cost + lines.reduce((sum, l) => sum + l.cost_cents, 0),
      paid: acc.paid + Number(o.paid_cents || 0),
      refunded: acc.refunded + Number(o.refunded_cents || 0),
    };
  }, { quote: 0, receivable: 0, adjustment: 0, cost: 0, paid: 0, refunded: 0 });
  const summaryProfit = summary.receivable - summary.cost;
  const summaryOpen = Math.max(0, summary.receivable - (summary.paid - summary.refunded));
  return <><Panel className="orders-list" data-hidden-columns={attr}><div className="toolbar"><div className="toolbar-filters"><SearchBox placeholder="搜索订单、客户、料品或备注..." value={search} onChange={value => { setSearch(value); pagination.setPage(1); setSelectedKeys([]); }}/><SearchSelect label="客户筛选" allowText value={customer} onChange={value => { setCustomer(value); pagination.setPage(1); setSelectedKeys([]); }} options={customers}/><SearchSelect label="业务员筛选" placeholder="全部业务员" allowText value={salesperson} onChange={value => { setSalesperson(value); pagination.setPage(1); setSelectedKeys([]); }} options={salespersonOptions}/><select aria-label="开票状态筛选" value={invoiceStatus} onChange={e => { setInvoiceStatus(e.target.value); pagination.setPage(1); setSelectedKeys([]); }}><option value="">全部开票状态</option>{['未开票','部分开票','已开齐'].map(s=><option key={s}>{s}</option>)}</select><select aria-label="回款状态筛选" value={collectionStatus} onChange={e => { setCollectionStatus(e.target.value); pagination.setPage(1); setSelectedKeys([]); }}><option value="">全部回款状态</option>{['未回款','部分回款','已回款'].map(s=><option key={s}>{s}</option>)}</select><select aria-label="料品购齐筛选" value={purchaseStatus} onChange={e => { setPurchaseStatus(e.target.value); pagination.setPage(1); setSelectedKeys([]); }}><option value="">全部采购情况</option><option value="complete">已购齐</option><option value="incomplete">未购齐</option></select><select aria-label="订单状态筛选" value={status} onChange={e => { setStatus(e.target.value); pagination.setPage(1); setSelectedKeys([]); }}><option value="">全部订单状态</option>{ORDER_PHASE_FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><div className="date-range"><input type="date" aria-label="订单起始日期" title="订单起始日期" value={dateFrom} onChange={e => { setDateFrom(e.target.value); pagination.setPage(1); setSelectedKeys([]); }}/><span>至</span><input type="date" aria-label="订单结束日期" title="订单结束日期" value={dateTo} onChange={e => { setDateTo(e.target.value); pagination.setPage(1); setSelectedKeys([]); }}/>{dateFrom || dateTo ? <button type="button" className="text-button" onClick={() => { setDateFrom(''); setDateTo(''); pagination.setPage(1); setSelectedKeys([]); }}>清除</button> : null}</div></div><div className="order-toolbar-actions"><Button onClick={() => navigate('import')}><Plus size={16}/>新增订单</Button><Button secondary disabled={busy} onClick={refresh}><RefreshCw size={16}/>刷新</Button><ColumnSettings columns={ORDER_COLUMNS} hidden={hidden} onToggle={toggle} onReset={reset}/><Button secondary className="selection-action" disabled={busy || (!pickedOrder && !pickedDraft)} onClick={() => { if (pickedOrder) setSelected(pickedOrder.id); else if (pickedDraft) navigate('import', null, pickedDraft.id); }}>{pickedDraft ? '继续编辑' : '查看明细'}</Button><Button secondary className="selection-action" disabled={busy || !pickedCanCancel} onClick={() => setCancelOrderId(pickedOrder.id)}>取消订单</Button><Button secondary className="selection-action" disabled={busy || !pickedCanReturn} onClick={() => setReturnOrderId(pickedOrder.id)}>退货</Button><Button secondary danger className="selection-action" disabled={busy || !canDeleteSelected} onClick={() => setPendingDelete(selectedItems)}>删除选中{selectedItems.length ? `（${selectedItems.length}）` : ''}</Button><span className="view-switch">{[["active", "当前订单"], ["archived", "已归档"], ["trash", "回收站"]].map(([key, label]) => <button key={key} type="button" className={`text-button${view === key ? ' active' : ''}`} onClick={() => { setView(key); pagination.setPage(1); setSelectedKeys([]); }}>{label}</button>)}</span><Button secondary onClick={() => setShowSummary(x => !x)}><ChartColumn size={16}/>{showSummary ? '收起汇总' : '展开汇总'}</Button></div></div>
    {view !== 'trash' && showSummary ? <div className="list-summary" role="group" aria-label="当前筛选订单汇总"><span className="list-summary-title">汇总 · {filteredOrders.length} 笔订单{filteredDrafts.length ? `（另有 ${filteredDrafts.length} 笔未完成草稿未计入）` : ''}</span><span className="list-summary-item" title={`原始报价合计 ${money(summary.quote)} − 退货/取消等调整 ${money(summary.adjustment)}`}><small>订单金额（已扣退货/取消）</small><strong>{money(summary.receivable)}</strong></span><span className="list-summary-item" title={`原始报价合计 ${money(summary.quote)}`}><small>退货·取消调整</small><strong>{summary.adjustment ? `-${money(summary.adjustment)}` : money(0)}</strong></span><span className="list-summary-item"><small>采购成本</small><strong>{money(summary.cost)}</strong></span><span className="list-summary-item"><small>毛利润</small><strong>{money(summaryProfit)}</strong></span><span className="list-summary-item"><small>毛利率</small><strong>{summary.receivable ? `${(summaryProfit / summary.receivable * 100).toFixed(2)}%` : '—'}</strong></span><span className="list-summary-item"><small>已回款</small><strong>{money(summary.paid)}</strong></span><span className="list-summary-item"><small>未回款</small><strong>{money(summaryOpen)}</strong></span>{summary.refunded ? <span className="list-summary-item"><small>已退款</small><strong>{money(summary.refunded)}</strong></span> : null}</div> : null}
    <Table minWidth={1840} headers={[canDelete ? <input type="checkbox" aria-label="全选当前页订单" checked={allSelected} disabled={!selectableItems.length || busy} onChange={toggleAll}/> : null, '客户 PO', '客户', orderSortHeader('created', '订单时间'), orderSortHeader('quote', '报价'), orderSortHeader('cost', '采购成本'), orderSortHeader('profit', '毛利润'), orderSortHeader('margin', '利润率'), '开票状态', '回款状态', '订单明细', '交期', '送货单', '业务员', '料品', '订单备注', '订单状态']}>{pageDrafts.map(d => { const form = d.payload.form || {}, lines = d.payload.lines || [], item = { type: 'intake', id: d.id, label: form.po || d.payload.source?.filename || `草稿 ${d.id}` }; return <tr key={`intake-${d.id}`} className={selectedKeys.includes(keyFor(item)) ? 'row-selected' : undefined}><FixedCell>{canDelete ? <input type="checkbox" aria-label={`选择草稿：${item.label}`} checked={selectedKeys.includes(keyFor(item))} disabled={busy} onChange={() => toggleItem(item)}/> : null}</FixedCell><FixedCell title={form.po || '待填写'}><button className="text-button mono" onClick={() => navigate('import', null, d.id)}>{form.po || '待填写'}</button></FixedCell><FixedCell title={form.customer || '未选客户'}><strong>{form.customer || '未选客户'}</strong></FixedCell><FixedCell title={`草稿创建于 ${d.created_at || d.updated_at}`}>{(d.created_at || d.updated_at || '').slice(0, 10) || '—'}</FixedCell><FixedCell>—</FixedCell><FixedCell>—</FixedCell><FixedCell>—</FixedCell><FixedCell>—</FixedCell><FixedCell>—</FixedCell><FixedCell>—</FixedCell><FixedCell>—</FixedCell><FixedCell>{form.due_date || '未指定'}</FixedCell><FixedCell>—</FixedCell><FixedCell title={salespersonName(form.salesperson_id) || '未指定业务员'}>{salespersonName(form.salesperson_id) || '—'}</FixedCell><FixedCell>{lines.length} 项<small>待核对</small></FixedCell><FixedCell title={form.note || '—'}>{form.note || '—'}</FixedCell><FixedCell><Badge>未完成草稿</Badge><small>暂存于 {d.updated_at.slice(0, 10)}</small></FixedCell></tr>; })}{pageOrders.map(o => { const lines = data.order_lines.filter(l => l.order_id === o.id), canReturn = returnableDeliveries(data, o.id).length > 0, canCancel = canCancelOrder(data, o), phase = orderPhase(data, o), quote = lines.reduce((sum, l) => sum + l.quote_cents, 0), cost = lines.reduce((sum, l) => sum + l.cost_cents, 0), profit = quote - cost, purchasedCount = lines.filter(l => l.purchased >= (l.demand_quantity ?? l.quantity) - .000001).length, protectedOrder = protectedOrders.has(o.id), protectionReason = purchaseProtectedOrders.has(o.id) ? '已关联采购，不能删除' : deliveryProtectedOrders.has(o.id) ? '已关联送货单，请更正或归档' : otherProtectedOrders.has(o.id) ? '已有售后或收款，请归档' : '', item = { type: 'order', id: o.id, label: o.po }; return <tr key={o.id} className={selectedKeys.includes(keyFor(item)) ? 'row-selected' : undefined}><FixedCell>{canDelete ? <input type="checkbox" aria-label={`选择订单：${o.po}`} title={protectedOrder ? protectionReason : `选择订单：${o.po}`} checked={selectedKeys.includes(keyFor(item))} disabled={busy} onChange={() => toggleItem(item)}/> : null}</FixedCell><FixedCell className="mono" title={o.po}>{o.po}</FixedCell><FixedCell title={o.customer}><strong>{o.customer}</strong></FixedCell><FixedCell title={`订单录入时间 ${o.created_at}`}>{(o.created_at || '').slice(0, 10) || '—'}</FixedCell><FixedCell>{money(quote)}</FixedCell><FixedCell>{money(cost)}</FixedCell><FixedCell title="报价减采购成本，采购未完成时为当前毛利润">{money(profit)}</FixedCell><FixedCell title="毛利润 ÷ 报价">{quote ? `${(profit / quote * 100).toFixed(2)}%` : '—'}</FixedCell><FixedCell title={`已开票 ${money(o.invoiced_cents)} / 应收 ${money(o.receivable_cents)}`}><Badge>{o.invoice_status || '未开票'}</Badge>{o.invoice_excess_cents>0?<small className="text-orange">超开待红冲</small>:null}</FixedCell><FixedCell title={`已回款 ${money(receivedCents(o))} / 应收 ${money(o.receivable_cents)}${o.refunded_cents > 0 ? `（已退款 ${money(o.refunded_cents)}）` : ''}`}><Badge>{collectionState(o)}</Badge>{receivedCents(o) > 0 ? <small className={o.refunded_cents > 0 ? 'text-orange' : undefined}>{money(receivedCents(o))}</small> : null}</FixedCell><FixedCell><button className="text-button" onClick={() => setSelected(o.id)}>查看</button></FixedCell><FixedCell>{o.due_date || '未指定'}</FixedCell><FixedCell title={`已发货 ${q(orderShippedQty(lines))} / 需求 ${q(orderDemandQty(lines))}，点击查看送货单`}><button className="text-button" onClick={() => setDeliveryOrderId(o.id)}><span className={orderDemandQty(lines) > 0 && orderShippedQty(lines) >= orderDemandQty(lines) ? 'order-shipped-complete' : 'order-shipped-incomplete'}>{q(orderShippedQty(lines))}</span><span className="order-purchase-total"> / {q(orderDemandQty(lines))}</span></button></FixedCell><FixedCell title={salespersonName(o.salesperson_id) || '未指定业务员'}>{salespersonName(o.salesperson_id) || '—'}</FixedCell><FixedCell title={`${purchasedCount} / ${lines.length} 项已采购齐`}><span className={purchasedCount === lines.length ? 'order-purchase-complete' : 'order-purchase-incomplete'}>{purchasedCount}</span><span className="order-purchase-total"> / {lines.length}</span></FixedCell><FixedCell title={o.note || '—'}>{o.note || '—'}</FixedCell><FixedCell className={`order-status${phase === 'exception' ? ' text-orange' : ''}`} title={orderPhaseTitle(data, o)}><Badge tone={ORDER_PHASE_TONES[phase]}>{ORDER_PHASES[phase]}</Badge></FixedCell></tr>; })}</Table>
    {view !== 'trash' ? <Pagination label="客户订单" total={filteredDrafts.length + filteredOrders.length} pagination={pagination} onPageChange={page => { pagination.setPage(page); setSelectedKeys([]); }} onPageSizeChange={size => { pagination.setPageSize(size); setSelectedKeys([]); }}/> : null}
    {view !== 'trash' && !filteredDrafts.length && !filteredOrders.length ? <Empty title={search || status || customer || purchaseStatus || dateFrom || dateTo ? '没有符合条件的订单' : '还没有客户订单'}/> : null}</Panel>
    {view === 'trash' ? <Trash data={data} table="orders" run={run} busy={busy} user={user}/> : null}
    {returnOrder ? <OrderReturnForm order={returnOrder} data={data} run={run} busy={busy} user={user} onClose={() => setReturnOrderId(null)}/> : null}
    {cancelOrder ? <OrderCancelForm order={cancelOrder} data={data} run={run} busy={busy} user={user} onClose={() => setCancelOrderId(null)}/> : null}
    {order ? <Modal wide title={`${order.po} · 客户订单`} onClose={() => { setSelected(null); if (location.hash.includes('?order=')) history.replaceState(null, '', '#orders'); }}><OrderDetail key={`${order.id}-${order.version}-${order.status}`} order={order} data={data} run={run} busy={busy} user={user} onEdit={() => navigate('import',order.id)} onDeliveries={() => { setSelected(null); setDeliveryOrderId(order.id); }}/></Modal> : null}
    {deliveryOrder ? <Modal wide title={`送货单 · ${deliveryOrder.po}`} onClose={() => setDeliveryOrderId(null)}><Deliveries key={deliveryOrder.id} orderId={deliveryOrder.id} data={data} run={run} busy={busy} user={user}/></Modal> : null}

    {pendingDelete.length ? <Modal title={`删除 ${pendingDelete.length} 条记录`} onClose={() => setPendingDelete([])}><p>确定删除以下记录吗？</p><ul className="delete-order-list">{pendingDelete.slice(0, 6).map(item => <li key={keyFor(item)}>{item.type === 'intake' ? '未完成草稿' : '客户订单'} · {item.label}</li>)}{pendingDelete.length > 6 ? <li>另有 {pendingDelete.length - 6} 条</li> : null}</ul><p className="muted">仅适用于录错、重复录入且没有后续业务的记录。移入回收站后保留历史，可由管理员恢复；已有后续业务请在订单明细中调整或归档。</p><div className="save-bar"><Button secondary onClick={() => setPendingDelete([])}>取消</Button><Button secondary danger disabled={busy} onClick={confirmDelete}>确认删除</Button></div></Modal> : null}
  </>;
}

function OrderDetail({ order, data, run, busy, user, onEdit, onDeliveries }) {
  const lines = data.order_lines.filter(l => l.order_id === order.id);
  const [panel, setPanel] = useState(null);
  const [prices, setPrices] = useState(Object.fromEntries(lines.map(x => [x.id, x.price_cents / 100])));
  const [taxRates, setTaxRates] = useState(Object.fromEntries(lines.map(x => [x.id, x.tax_rate ?? 13])));
  const [netPrices, setNetPrices] = useState(Object.fromEntries(lines.map(x => [x.id, (x.price_cents / 100 / (1 + (x.tax_rate ?? 13) / 100)).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')])));
  const [quantities, setQuantities] = useState(Object.fromEntries(lines.map(x => [x.id, x.quantity])));
  const [remarks, setRemarks] = useState(Object.fromEntries(lines.map(x => [x.id, x.remark || ""])));
  const total = lines.reduce((s, x) => s + x.quote_cents, 0), cost = lines.reduce((s, x) => s + x.cost_cents, 0);
  const quotes = data.quotes.filter(x => x.order_id === order.id);
  const readOnly = order.status === 'cancelled' || !!order.archived_at;
  const save = () => api(`/orders/${order.id}/adjust`, { lines: lines.map(l => ({ id: l.id, quantity: quantities[l.id], price: prices[l.id], tax_rate: taxRates[l.id], remark: remarks[l.id] })) });
  const orderActions = <>{order.source_id ? <a className="order-source-link" href={`/api/files/${order.source_id}`} target="_blank" rel="noreferrer">查看客户原文件</a> : null}{!readOnly && lines.every(l => l.purchased === 0) ? <Button secondary onClick={onEdit}>修改订单</Button> : null}{!readOnly ? <Button secondary onClick={() => setPanel('reserve')}>占用库存</Button> : null}{!readOnly ? <Button secondary onClick={() => setPanel('outbound')}>安排出库</Button> : null}<Button secondary onClick={onDeliveries}>送货单</Button></>;
  const customer = (data.customers || []).find(item => item.id === order.customer_id);
  const contacts = (customer?.contacts || []).filter(item => item.name || item.phone);
  const selected = contacts.find(item => item.name === order.contact && item.phone === order.phone);
  const ordered = selected ? [selected, ...contacts.filter(item => item !== selected)] : contacts;
  const person = [order.contact, order.phone].filter(Boolean).join(' ');
  const isRecipient = !selected && (customer?.addresses || []).some(item => item.contact === order.contact && item.phone === order.phone);
  const contactText = ordered.length ? ordered.map(item => [item.name, item.phone].filter(Boolean).join(' ')).join(' / ') : (isRecipient ? '' : person);
  const addressText = [isRecipient ? person : '', order.address].filter(Boolean).join('　');
  if (panel === 'reserve') return <><div className="delivery-heading"><h3>安排库存占用 · {order.po}</h3><Button secondary onClick={() => setPanel(null)}>返回订单</Button></div><ReserveForm orderId={order.id} data={data} run={run} busy={busy} onDone={() => setPanel(null)} onCancel={() => setPanel(null)}/></>;
  if (panel === 'outbound') return <><div className="delivery-heading"><h3>安排出库并生成送货单 · {order.po}</h3><Button secondary onClick={() => setPanel(null)}>返回订单</Button></div><OutboundForm orderId={order.id} data={data} run={run} busy={busy} onDone={() => setPanel(null)} onCancel={() => setPanel(null)}/></>;
  return <>{data.company.name ? <div className="order-company"><strong>{data.company.name}</strong><span>{[data.company.name_en, data.company.address, data.company.phone].filter(Boolean).join(' · ')}</span></div> : null}<div className="detail-grid order-detail-header"><div><small>客户</small><strong>{order.customer}</strong></div><div><small>联系人</small><strong>{contactText || '—'}</strong></div><div><small>业务员</small><strong>{(data.users || []).find(user => user.id === order.salesperson_id)?.display_name || '未指定'}</strong></div><div className="wide"><small>收货地址</small><strong>{addressText}</strong></div><div><small>报价合计（含税）</small><strong>{money(total)}</strong></div><div><small>已登记采购成本</small><strong>{money(cost)}</strong></div></div>
    {order.status === 'cancelled' ? <p className="notice warning">订单已于 {order.cancelled_at?.slice(0, 10)} 取消。原因：{order.cancellation_reason}。关联采购和已生成送货记录仍保留，需由经办人处理。</p> : null}
    <OrderSalesSummary data={data} order={order}/>
    {order.note ? <p className="muted">备注：{order.note}</p> : null}
    <form className="order-detail-form" onSubmit={e => { e.preventDefault(); run(save, '订单调整已保存'); }}><div className="order-quote-toolbar">{order.status !== 'draft' ? <div className="save-bar"><Badge>{order.status === 'cancelled' ? '已取消' : '已确认'} · 第 {order.version} 版</Badge>{orderActions}<a className="button secondary" href={`/api/orders/${order.id}/quote/xlsx`}><Download size={15}/>导出Excel</a><a className="button secondary" href={`/api/orders/${order.id}/quote/pdf`}><Download size={15}/>导出PDF</a>{!readOnly ? <Button type="submit" disabled={busy}>保存订单调整</Button> : null}</div> : <SaveBar busy={busy} label="保存报价">{orderActions}<Button secondary disabled={busy} onClick={() => run(async () => { await save(); await api(`/orders/${order.id}/confirm`, {}); }, '报价已确认，可以登记采购')}>保存并确认报价</Button></SaveBar>}{quotes.length ? <details><summary>已确认报价历史 · {quotes.length} 个版本</summary>{quotes.map(v => <div className="history" key={v.id}><strong>第 {v.version} 版 · {v.created_at.slice(0, 10)}</strong><span>{money(JSON.parse(v.snapshot).reduce((a, l) => a + Math.round(l.quantity * l.price_cents), 0))}</span></div>)}</details> : null}</div><Table className="order-inline-edit-table" columnWidths={[116,86,78,42,42,54,56,72,86,72,88,46,96,96,54,64]} headers={['料品 / 规格','品牌 / 描述','料品编号','需求','已购','签收','现存量','可用库存','预计可供量','本单缺口','单价','税率','单价（含税）','小计（含税）','项目号','备注']}>
      {lines.map(l => { const item = (data.items || []).find(x => x.id === l.item_id); return <tr key={l.id}><td title={`${l.name} / ${l.spec || '规格未提供'}`}><strong>{l.name}</strong><small>{l.spec || '规格未提供'}</small></td><td title={`${l.brand || '—'} / ${l.description || ''}`}>{l.brand || '—'}<small>{l.description}</small></td><td title={item ? itemLabel(item) : '尚未匹配料品档案'}>{item ? <span className="mono">{item.code}</span> : <ItemBinder line={l} data={data} run={run} busy={busy}/>}</td><td><input className="small-input" aria-label={`${l.name}需求数量`} type="number" min=".000001" step=".000001" required disabled={readOnly} value={quantities[l.id]} onChange={e => setQuantities(current => ({ ...current, [l.id]: e.target.value }))}/></td><td className={l.purchased > 0 && l.purchased >= (l.demand_quantity ?? l.quantity) - .000001 ? 'purchase-complete' : undefined} title={`采购在途（直发 ${q(l.stock_incoming_direct || 0)} / 入库 ${q(l.stock_incoming_stock || 0)}）`}>{q(l.purchased)}</td><td title={`实际已发货 ${q(l.dispatched_quantity || 0)} / 已签收 ${q(l.signed)}`}>{q(l.shipped)} / {q(l.signed)}</td><td title={`仓库现存量；本单已占用 ${q(l.stock_reserved || 0)}`}>{q(l.stock_on_hand || 0)}</td><td title={`现存量 − 全部订单占用，本单占用 ${q(l.stock_reserved || 0)}`}>{q(l.stock_available || 0)}</td><td title={`可用库存 ${q(l.stock_available || 0)} + 未分配采购在途 ${q(l.stock_pool || 0)}`}>{q(l.stock_expected || 0)}</td><td title={`需求 − 已发货 − 已落实（采购 ${q(l.purchased)} + 占用 ${q(l.stock_reserved || 0)}）`} className={l.gap_quantity > .000001 ? 'text-orange' : undefined}>{q(l.gap_quantity || 0)}</td><td><input className="small-input" aria-label={`${l.name}未税单价`} type="number" min="0" step="any" required disabled={readOnly} value={netPrices[l.id]} onChange={e => { const value = e.target.value; setNetPrices(p => ({...p,[l.id]:value})); setPrices(p => ({...p,[l.id]:value === "" ? "" : (Number(value) * (1 + taxRates[l.id] / 100)).toFixed(2)})); }}/></td><td><select aria-label={`${l.name}税率`} disabled={readOnly} value={taxRates[l.id]} onChange={e => { const rate = Number(e.target.value); setTaxRates(p => ({...p,[l.id]:rate})); setNetPrices(p => ({...p,[l.id]:(Number(prices[l.id]) / (1 + rate / 100)).toFixed(6)})); }}>{[...new Set([...(data.tax_settings?.rates || [13,6,9]),taxRates[l.id]])].map(rate => <option key={rate} value={rate}>{rate}%</option>)}</select></td><td><input className="small-input" aria-label={`${l.name}单价`} type="number" min="0" step=".01" required disabled={readOnly} value={prices[l.id]} onChange={e => { const value = e.target.value; setPrices(p => ({ ...p, [l.id]: value })); setNetPrices(p => ({...p,[l.id]:value === "" ? "" : (Number(value) / (1 + taxRates[l.id] / 100)).toFixed(6)})); }}/></td><td>{money(Math.round(Number(prices[l.id] || 0) * 100 * Number(quantities[l.id] || 0)))}</td><td title={`${l.project_code || '—'} / ${l.subproject_code || '—'}`}>{l.project_code || '—'}<small>{l.subproject_code || '—'}</small></td><td><input aria-label={`${l.name}备注`} value={remarks[l.id]} disabled={readOnly} maxLength={2000} title={remarks[l.id]} onChange={e => setRemarks(current => ({ ...current, [l.id]: e.target.value }))}/></td></tr>; })}</Table>
    </form>
    <OrderLifecycle order={order} data={data} run={run} busy={busy} user={user}/>
  </>;
}

