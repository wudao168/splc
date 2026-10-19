import React, { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, RefreshCw, ClipboardList, ShoppingBag, Copy } from 'lucide-react';
import { api, upload, money, q, indexById } from './api';
import Pagination, { usePagination } from './Pagination';
import { Panel, Table, FixedCell, Empty, Button, Badge, Modal, SearchBox, SaveBar, InputField, Field, SearchSelect, matchCustomer } from './components';
import { Trash } from './Lifecycle';
import Logistics from './Logistics';
import BillingInfo from './BillingInfo';
import Invoices from './Invoices';
import TaobaoSource from './TaobaoSource';
import SyncNow from './SyncNow';
import InvoiceReminders, { invoiceRemindCandidates, isInvoiceRemindCandidate, invoiceScriptFor, tradeStatus } from './InvoiceReminders';
import { copyText } from './clipboard';
import { suggestOrderLineIds, similarOrderLineScores } from './orderRemarkMatch';
import ProductPicker from './ProductPicker';
import PurchaseLineTable from './PurchaseLineTable';
import PurchaseItemCell from './PurchaseItemPreview';
import { ColumnSettings, useColumnSettings } from './columnSettings';

const OPTIONAL_ORDER_PLATFORMS = ['其他', '对公'];
/** 开票状态查询：与采购记录“开票状态”列一一对应（申请中/已拒绝并入“未开票”）。 */
const INVOICE_STATE_OPTIONS = ['待查询', '未开票', '店铺称已开票', '已开票', '不需开票', '未登记'];
const TRADE_STATUS_OPTIONS = ['买家已付款', '卖家已发货', '交易成功', '交易关闭', '交易取消', '退款中的订单', '未同步'];
const invoiceStateKey = purchase => invoiceStatus(purchase).label.split(' · ')[0];
/** 金额输入：只保留数字与一个小数点，避免被格式化后无法继续输入。 */
const typedAmount = value => { const cleaned = String(value ?? '').replace(/[^\d.]/g, ''); const [head, ...rest] = cleaned.split('.'); return rest.length ? `${head}.${rest.join('')}` : head; };
/** 左侧选择面板：打开立即挂载，关闭时保留一小段时间播放消失动画。 */
export function usePaneVisible(open, duration = 200) {
  const [visible, setVisible] = useState(open), [closing, setClosing] = useState(false);
  useEffect(() => {
    if (open) { setVisible(true); setClosing(false); return undefined; }
    if (!visible) return undefined;
    setClosing(true);
    const timer = setTimeout(() => { setVisible(false); setClosing(false); }, duration);
    return () => clearTimeout(timer);
  }, [open, visible, duration]);
  return [visible, closing];
}
const draftInvoiceStatus = draft => {
  const payload = draft.payload || {};
  const entries = payload.invoice_entries || [], details = payload.invoice_details || [], info = payload.invoice_info || {};
  if (details.length || entries.some(item => item?.status === '已开票') || info.status === '已开票') return {label:'已开票', tone:'green'};
  if (entries.some(item => item?.status === '申请中') || info.status === '开票中') return {label:'未开票 · 申请中', tone:'blue'};
  if (entries.some(item => item?.status === '商家拒绝')) return {label:'未开票 · 已拒绝', tone:'red'};
  if (info.status === '未开票') return {label:'未开票', tone:'orange'};
  return {label:'待查询', tone:'gray'};
};
const draftInvoiceFiles = draft => [...new Set((draft.payload?.invoice_details || []).map(item => item.attachment_id).filter(Boolean))];
const draftCanRemind = draft => draft.payload?.transaction_status === '交易成功' && draftInvoiceStatus(draft).label === '待查询';
const PURCHASE_COLUMNS = [['shop','平台 / 店铺'],['items','料品 / 规格'],['logistics','物流'],['po','客户PO'],['project','项目号'],['platform_order','平台订单号'],['amount','实付款'],['status','采购状态'],['purchased_date','采购日期'],['sync_at','同步时间'],['created_at','登记日期'],['trade_status','交易状态'],['invoice','开票状态'],['invoice_file','发票文件']];
const LOGISTICS_STATUSES = ['待揽收', '运输中', '派送中', '已签收', '异常', '退回'];
import { itemLabel } from './Items';
import { orderDetailURL } from './orderLink';
import { invoiceStatus } from './invoiceStatus';
import { allocatePurchaseCosts } from './purchaseAllocation';
import { purchaseStatuses, purchaseStatusKeys } from './purchaseStatus';

/** 采购单里的料品条目（客户料品行取订单料品，备货行取料品档案），用于列表预览。 */
export const purchaseItems = (data, ol, purchase) => data.purchase_lines.filter(line => line.purchase_id === purchase.id).map(line => {
  const orderLine = line.order_line_id ? ol[line.order_line_id] : null;
  return { id: line.id, name: orderLine?.name || line.item_name || (line.item_id ? `料品 #${line.item_id}` : '待匹配料品'),
           spec: orderLine?.spec || line.purchase_spec || '', quantity: line.original_quantity ?? line.quantity, unit: line.purchase_unit || '个' };
});

/** 采购列表搜索：平台单号、店铺、客户 PO、料品名称/规格、项目号、料品编号、物流单号等。 */
export const purchaseSearchText = (data, ol, orders, purchase, packages = []) => {
  const lines = data.purchase_lines.filter(line => line.purchase_id === purchase.id);
  const items = data.items || [];
  const parts = [purchase.platform_order, purchase.platform, purchase.shop, purchase.account, purchase.note];
  packages.forEach(pkg => parts.push(pkg.carrier, pkg.tracking, pkg.status));
  lines.forEach(line => {
    const orderLine = line.order_line_id ? ol[line.order_line_id] : null;
    const item = items.find(x => x.id === line.item_id);
    parts.push(orderLine?.name, orderLine?.spec, orderLine?.project_code, orderLine?.subproject_code,
      line.purchase_spec, line.item_name, line.link, item?.code, item?.name, item?.spec, item?.customer_code);
    const order = orderLine ? orders[orderLine.order_id] : null;
    if (order) parts.push(order.po, order.customer);
  });
  return parts.filter(Boolean).join(' ').toLowerCase();
};

export default function Purchases({ data, run, busy, refresh, desktopOrder, dismissDesktopOrder, user }) {
  const [tab, setTab] = useState(location.hash === '#logistics' ? 'logistics' : 'orders');
  const [dateFrom, setDateFrom] = useState(''), [dateTo, setDateTo] = useState('');
  const [draftFrom, setDraftFrom] = useState(''), [draftTo, setDraftTo] = useState('');
  const inDateRange = (value, from, to) => { const day = String(value || '').slice(0, 10); return (!from || day >= from) && (!to || day <= to); };
  const [clearDraftTrash, setClearDraftTrash] = useState(false);
  const [purchaseSort, setPurchaseSort] = useState({ key: 'created_at', descending: true });
  const [draftSearch, setDraftSearch] = useState('');
  const [draftSort, setDraftSort] = useState({ key: 'purchased_date', descending: true });
  const [selectedDraftIds, setSelectedDraftIds] = useState([]);
  const draftTerm = draftSearch.trim().toLowerCase();
  const drafts = (data.purchase_drafts || []).filter(item => (item.status || 'active') === (tab === 'draft-trash' ? 'trash' : 'active')).filter(item => inDateRange(item.payload.purchased_date, draftFrom, draftTo) && `${item.platform_order} ${item.payload.shop || ''} ${(item.payload.products || []).map(product => product.name).join(' ')} ${item.payload.remark || ''}`.toLowerCase().includes(draftTerm)).sort((a, b) => {
    const draftOrderTime = item => String(item.payload.purchased_at || item.payload.purchased_date || '').replace('T', ' '); const difference = draftSort.key === 'amount' ? Number(a.payload.amount || 0) - Number(b.payload.amount || 0) : draftOrderTime(a).localeCompare(draftOrderTime(b));
    return (draftSort.descending ? -difference : difference) || b.id - a.id;
  });
  const draftTotals = drafts.reduce((acc, item) => ({ count: acc.count + 1, amount: acc.amount + Math.round(Number(item.payload.amount || 0) * 100) }), { count: 0, amount: 0 });
  const draftSummaryRow = <tr className="purchase-summary"><td colSpan={5}>汇总（{draftTotals.count} 单）</td><td>{money(draftTotals.amount)}</td><td colSpan={4}/></tr>;
  const draftPagination = usePagination(drafts.length);
  const pageDrafts = drafts.slice(draftPagination.start, draftPagination.end);
  const allDraftsSelected = pageDrafts.length > 0 && pageDrafts.every(item => selectedDraftIds.includes(item.id));
  const toggleAllDrafts = () => setSelectedDraftIds(allDraftsSelected ? [] : pageDrafts.map(item => item.id));
  const toggleDraft = id => setSelectedDraftIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);
  const selectedDrafts = (data.purchase_drafts || []).filter(item => selectedDraftIds.includes(item.id)
    && (item.status || 'active') === (tab === 'draft-trash' ? 'trash' : 'active'));
  const pickedDraftItem = selectedDrafts.length === 1 ? selectedDrafts[0] : null;
  const sortDrafts = key => {
    setDraftSort(current => ({ key, descending: current.key === key ? !current.descending : true }));
    draftPagination.setPage(1);
  };
  const draftSortHeader = (key, label) => <button type="button" className="draft-sort-button" aria-label={`${label}排序`} onClick={() => sortDrafts(key)}>{label}<span className="sort-triangles" aria-hidden="true"><span className={draftSort.key === key && !draftSort.descending ? 'active' : ''}>▲</span><span className={draftSort.key === key && draftSort.descending ? 'active' : ''}>▼</span></span></button>;
  const [draftId, setDraftId] = useState(null);
  const [editingAssociations, setEditingAssociations] = useState(false);
  const draft = (data.purchase_drafts || []).find(item => item.id === draftId);
  const [search, setSearch] = useState(''), [platform, setPlatform] = useState(''), [tradeFilter, setTradeFilter] = useState(''), [modal, setModal] = useState(null);
  const [invoicePurchase, setInvoicePurchase] = useState(null), [invoiceFilter, setInvoiceFilter] = useState('');
  const [selectedPurchaseIds, setSelectedPurchaseIds] = useState([]);
  const [logisticsPurchase, setLogisticsPurchase] = useState(null);
  const [invoiceRemindOpen, setInvoiceRemindOpen] = useState(() => new URLSearchParams(location.hash.split('?')[1] || '').get('remind') === '1'), [returnPurchase, setReturnPurchase] = useState(null);
  const [pendingDeleteIds, setPendingDeleteIds] = useState([]);
  const [previewPurchase, setPreviewPurchase] = useState(null);
  const preview = data.purchases.find(p => p.id === previewPurchase);
  const { hidden, toggle, reset, attr } = useColumnSettings(user, 'purchases');
  const [view, setView] = useState('active'), [statusFilter, setStatusFilter] = useState('');
  const [logisticsFilter, setLogisticsFilter] = useState('');
  const canDelete = !!user;
  const invoice = data.purchases.find(p => p.id === invoicePurchase);
  const [focusPurchase, setFocusPurchase] = useState(null), [pendingPackage, setPendingPackage] = useState(null);
  const openExtracted = () => {
    const existing = data.purchases.find(p => p.platform === '淘宝' && p.platform_order === desktopOrder?.platform_order);
    setTab('orders'); setModal(existing ? existing.id : 'platform');
  };
  useEffect(() => { if (desktopOrder) openExtracted(); }, [desktopOrder?.id]);
  // 公共备货采购没有关联客户订单，用占位对象展示，避免订单信息为空时出错。
  const orders = { ...indexById(data.orders), public: { id: 'public', po: '公共备货', customer: '未关联订单', address: '', status: 'confirmed' } }, ol = { ...indexById(data.order_lines), null: { id: null, order_id: 'public', name: '公共备货', spec: '', unit: '个', item_id: null } };
  const purchaseLineById = indexById(data.purchase_lines), packageById = indexById(data.packages);
  const deliveredPackageLineIds = new Set(data.delivery_lines.filter(line => line.package_line_id).map(line => line.package_line_id));
  const deliveredOrderLineIds = new Set(data.delivery_lines.filter(line => line.order_line_id).map(line => line.order_line_id));
  const protectedPurchases = new Set([...data.package_lines.filter(line => deliveredPackageLineIds.has(line.id)).map(line => purchaseLineById[line.purchase_line_id]?.purchase_id), ...data.purchase_lines.filter(line => deliveredOrderLineIds.has(line.order_line_id)).map(line => line.purchase_id)]);
  data.package_lines.forEach(l => protectedPurchases.add(purchaseLineById[l.purchase_line_id]?.purchase_id));
  data.invoice_allocations.forEach(a => protectedPurchases.add(a.purchase_id));
  (data.purchase_cases || []).forEach(c => protectedPurchases.add(purchaseLineById[c.purchase_line_id]?.purchase_id));
  const packagesByPurchase = {};
  data.package_lines.forEach(line => {
    const purchaseId = purchaseLineById[line.purchase_line_id]?.purchase_id;
    const pkg = packageById[line.package_id];
    if (purchaseId && pkg && !(packagesByPurchase[purchaseId] || []).some(x => x.id === pkg.id)) (packagesByPurchase[purchaseId] ||= []).push(pkg);
  });
  const shipmentsFor = purchase => {
    const shipments = new Map();
    for (const pkg of packagesByPurchase[purchase.id] || []) if (pkg.tracking) shipments.set(pkg.tracking, pkg);
    for (const pkg of purchase.taobao_source?.packages || []) if (pkg.tracking) shipments.set(pkg.tracking, { ...shipments.get(pkg.tracking), ...pkg, status: pkg.status || shipments.get(pkg.tracking)?.status, carrier: pkg.carrier || shipments.get(pkg.tracking)?.carrier });
    return [...shipments.values()];
  };
  const casesByPurchase = {};
  for (const item of data.purchase_cases || []) {
    const id = purchaseLineById[item.purchase_line_id]?.purchase_id;
    if (id) (casesByPurchase[id] ||= []).push(item);
  }
  const statusesByPurchase = Object.fromEntries(data.purchases.map(p => [p.id, purchaseStatusKeys(casesByPurchase[p.id] || []).map(key => key === 'returned' && data.purchase_lines.some(l => l.purchase_id === p.id && l.quantity > .000001) ? 'partial_returned' : key)]));
  const remindDraft = draft => run(async () => {
    const script = invoiceScriptFor({platform_order:draft.platform_order, shop:draft.payload?.shop || '', amount_cents:0}, data.company || {});
    let outcome = null;
    if (window.caidanDesktop?.remindInvoice) {
      outcome = await window.caidanDesktop.remindInvoice(draft.id);
    } else {
      const copied = await copyText(script);
      if (!copied) return { copyFailed: true };
      window.open(`https://trade.taobao.com/trade/detail/trade_order_detail.htm?bizOrderId=${draft.platform_order}`, '_blank', 'noreferrer');
    }
    return outcome;
  }, outcome => {
    if (outcome?.copyFailed) return '当前环境不支持自动复制，请手动复制话术后在淘宝发送';
    if (!window.caidanDesktop?.remindInvoice) return '催票话术已复制并打开淘宝订单，粘贴发送即可';
    if (outcome?.filled) return '已打开商家聊天并填好话术，按回车发送即可';
    return outcome?.opened ? '已打开商家聊天，话术已复制，粘贴发送即可' : '已复制催票话术并打开订单页面，请手动发送';
  });
  const filtered = data.purchases.filter(p => (view === 'archived' ? !!p.archived_at : view === 'active' && !p.archived_at) && inDateRange(p.purchased_date, dateFrom, dateTo) && (!statusFilter || statusesByPurchase[p.id].includes(statusFilter)) && (!platform || p.platform === platform) && (!tradeFilter || tradeStatus(p) === tradeFilter) && (!invoiceFilter || invoiceStateKey(p) === invoiceFilter) && (!logisticsFilter || shipmentsFor(p).some(pkg => (pkg.status || '') === logisticsFilter)) && purchaseSearchText(data, ol, orders, p, shipmentsFor(p)).includes(search.trim().toLowerCase())).sort((a, b) => { const purchaseTime = item => purchaseSort.key === 'purchased_date' ? String(item.purchased_at || item.purchased_date || '').replace('T', ' ') : String(item[purchaseSort.key] || ''); return ((purchaseSort.descending ? -1 : 1) * purchaseTime(a).localeCompare(purchaseTime(b))) || b.id - a.id; });
  const purchaseTotals = filtered.reduce((acc, p) => ({ count: acc.count + 1, amount: acc.amount + p.amount_cents, received: acc.received + p.received_cents, remaining: acc.remaining + p.remaining_cents }), { count: 0, amount: 0, received: 0, remaining: 0 });
  const purchaseSummaryRow = <tr className="purchase-summary"><td colSpan={7}>汇总（{purchaseTotals.count} 笔）</td><td>{money(purchaseTotals.amount)}</td><td colSpan={5}/><td colSpan={2}>已收 {money(purchaseTotals.received)} / 待收 {money(purchaseTotals.remaining)}</td></tr>;
  const pagination = usePagination(filtered.length);
  const purchaseSortHeader = (key, label) => <button type="button" className="draft-sort-button" aria-label={`${label}排序`} onClick={() => { setPurchaseSort(current => ({ key, descending: current.key === key ? !current.descending : true })); pagination.setPage(1); setSelectedPurchaseIds([]); }}>{label}<span className="sort-triangles" aria-hidden="true"><span className={purchaseSort.key === key && !purchaseSort.descending ? 'active' : ''}>▲</span><span className={purchaseSort.key === key && purchaseSort.descending ? 'active' : ''}>▼</span></span></button>;
  const pagePurchases = filtered.slice(pagination.start, pagination.end);
  const allSelected = pagePurchases.length > 0 && pagePurchases.every(p => selectedPurchaseIds.includes(p.id));
  const toggleAll = () => setSelectedPurchaseIds(allSelected ? [] : pagePurchases.map(p => p.id));
  const togglePurchase = id => setSelectedPurchaseIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);
  const pickedPurchase = selectedPurchaseIds.length === 1 ? data.purchases.find(p => p.id === selectedPurchaseIds[0]) : null;
  const pickedPurchaseReturnable = !!pickedPurchase && !pickedPurchase.archived_at;
  const pickedPurchaseEditable = !!pickedPurchase && !pickedPurchase.archived_at;
  const pickedPurchaseRestorable = !!pickedPurchase && (data.purchase_cases || []).some(c => c.kind === 'supplier_return' && c.status !== 'void' && data.purchase_lines.some(l => l.id === c.purchase_line_id && l.purchase_id === pickedPurchase.id));
  const canDeleteSelectedPurchases = canDelete && selectedPurchaseIds.length > 0 && !selectedPurchaseIds.some(id => protectedPurchases.has(id));
  const current = data.purchases.find(p => p.id === modal);
  const showLogistics = id => { setFocusPurchase(id); setModal(null); setTab('logistics'); };
  const getInvoices = purchaseIds => run(async () => {
    if (!window.caidanDesktop?.syncInvoices) throw new Error('请在桌面客户端打开采购系统并登录淘宝后获取发票。');
    return window.caidanDesktop.syncInvoices(purchaseIds);
  }, result => ({error:!!(result.downloadFailed || result.truncated), text:result.truncated
    ? `已扫描 ${result.pages} 页，匹配 ${result.matched}/${result.checked} 笔；仍有更早记录未扫描。`
    : `所选订单匹配 ${result.matched}/${result.checked} 笔，新增下载 ${result.downloaded || 0} 份${result.downloadFailed ? `，${result.downloadFailed} 份未下载：${(result.downloadErrors?.[0]?.message || '请重试').replace(/[。；;]+$/, '')}` : ''}。`}));
  const confirmDelete = () => run(async () => {
    await api('/purchases/delete', {ids:pendingDeleteIds});
    setPendingDeleteIds([]); setSelectedPurchaseIds([]); setInvoicePurchase(null);
  }, `已删除 ${pendingDeleteIds.length} 条采购记录`);
  return <>
    {tab !== 'logistics' ? <div className="tabs"><button className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}><ClipboardList size={18}/>采购记录</button><button className={tab === 'drafts' ? 'active' : ''} onClick={() => setTab('drafts')}><ShoppingBag size={18}/>淘宝订单</button><button className={tab === 'draft-trash' ? 'active' : ''} onClick={() => { setTab('draft-trash'); draftPagination.setPage(1); }}><Trash2 size={18}/>回收站</button><SyncNow data={data} run={run} busy={busy}><>{data.purchase_draft_sync?.checked_at ? (() => { const sync = data.purchase_draft_sync, stats = sync.stats || {}, trash = (data.purchase_drafts || []).filter(item => item.status === 'trash').length, ignored = data.purchase_draft_ignored || 0; const detail = [`扫描 ${stats.pages || 0} 页 / 读取 ${stats.read ?? '—'} 笔 / 新增 ${stats.created || 0}`, stats.deferred ? `按需刷新待处理 ${stats.deferred} 笔（每轮最多 ${stats.details_per_run || 20} 个详情页）` : '', stats.skipped ? `跳过 ${stats.skipped}` : '', stats.excluded_by_list_date ? `${stats.excluded_by_list_date} 笔早于采集起始日（按设置未导入）` : '', trash ? `回收站 ${trash} 笔（待付款／未成交）` : '', ignored ? `已忽略 ${ignored} 笔（可在淘宝订单里重新采集）` : '', stats.warning || (sync.error || '')].filter(Boolean).join('\n'); return <span className={stats.warning ? 'text-orange' : 'muted'} title={detail}>最近采集：{sync.checked_at.replace('T',' ').slice(0,19)} · {sync.error || '已完成'}{trash ? ` · 回收站 ` : ''}{ignored ? ` · 已忽略 ` : ''}{stats.skipped || stats.warning ? ' ⚠' : ''}</span>; })() : <span className="muted">尚未完成后台采集，请保持客户端运行并登录淘宝。</span>}</></SyncNow></div> : null}
    {['drafts','draft-trash'].includes(tab) ? <Panel className="purchase-drafts-list"><div className="toolbar"><SearchBox value={draftSearch} onChange={value => { setDraftSearch(value); draftPagination.setPage(1); }} placeholder="搜索店铺、订单号、商品名称或备注…"/><div className="date-range"><input type="date" aria-label="淘宝订单起始日期" title="淘宝订单起始日期" value={draftFrom} onChange={e => { setDraftFrom(e.target.value); draftPagination.setPage(1); }}/><span>至</span><input type="date" aria-label="淘宝订单结束日期" title="淘宝订单结束日期" value={draftTo} onChange={e => { setDraftTo(e.target.value); draftPagination.setPage(1); }}/>{draftFrom || draftTo ? <button type="button" className="text-button" onClick={() => { setDraftFrom(''); setDraftTo(''); draftPagination.setPage(1); }}>清除</button> : null}</div><div className="toolbar-actions">{tab === 'draft-trash' ? <Button secondary className="selection-action" title={pickedDraftItem && !['买家已付款','卖家已发货','交易成功'].includes(pickedDraftItem.payload.transaction_status) ? '该订单当前交易状态不是「已付款／已发货／交易成功」，暂不能恢复；每轮采集会自动刷新它的状态，状态变为有效后会自动回到淘宝订单' : '把选中的订单恢复到淘宝订单'} disabled={busy || !pickedDraftItem || !['买家已付款','卖家已发货','交易成功'].includes(pickedDraftItem.payload.transaction_status)} onClick={() => run(() => api('/purchase-drafts/restore', {id:pickedDraftItem.id}), '草稿已恢复')}>恢复草稿</Button> : <><Button secondary className="selection-action" disabled={busy || !pickedDraftItem} onClick={() => setDraftId(pickedDraftItem.id)}>登记采购</Button><Button secondary danger className="selection-action" disabled={busy || !selectedDrafts.length} onClick={() => run(async () => { for (const item of selectedDrafts) await api('/purchase-drafts/delete', { id: item.id }); setSelectedDraftIds([]); }, `已删除 ${selectedDrafts.length} 条草稿`)}>删除选中{selectedDrafts.length ? `（${selectedDrafts.length}）` : ''}</Button></>}{tab === 'drafts' && data.purchase_draft_ignored ? <Button secondary disabled={busy} title="重新采集之前“清空回收站”忽略的淘宝订单；已登记采购的不受影响" onClick={() => { if (window.confirm(`将重新采集之前清空回收站时忽略的 ${data.purchase_draft_ignored} 笔淘宝订单。仅仍有效（已付款／已发货／交易成功）且在采集范围内的会重新进入淘宝订单。确定继续？`)) run(() => api('/purchase-drafts/revive', {}), '已重新纳入采集，下一轮同步会补回这些订单'); }}>重新采集已忽略订单（{data.purchase_draft_ignored}）</Button> : null}<Button secondary disabled={busy} onClick={refresh}><RefreshCw size={16}/>刷新</Button><Button secondary title="设置同步间隔与免打扰时段" onClick={() => { location.hash = 'settings?tab=sync'; }}>同步设置</Button>{tab === 'draft-trash' ? <Button secondary danger disabled={busy || !(data.purchase_drafts || []).some(item => item.status === 'trash')} onClick={() => setClearDraftTrash(true)}>清空回收站</Button> : null}</div></div>{tab === 'draft-trash' ? <p className="notice">回收站里的订单每轮采集都会自动刷新交易状态：变成「已付款／已发货／交易成功」后会自动回到淘宝订单；也可以选中后点「恢复草稿」立即恢复。</p> : null}<Table columnWidths={[1,2,2,1.6,1.5,0.9,2,2,1,1.4,1.2,3.3]} headers={[<input type="checkbox" aria-label="全选当前页草稿" checked={allDraftsSelected} disabled={!pageDrafts.length} onChange={toggleAllDrafts}/>, '平台订单号','店铺',draftSortHeader('purchased_date', '采购日期'),'同步时间',draftSortHeader('amount', '实付款'),'商品','物流','交易状态','开票状态','发票文件','订单备注']}>{draftSummaryRow}{pageDrafts.map(item => <tr key={item.id} className={selectedDraftIds.includes(item.id) ? 'row-selected' : undefined}><FixedCell><input type="checkbox" aria-label={`选择采购草稿：${item.platform_order}`} checked={selectedDraftIds.includes(item.id)} onChange={() => toggleDraft(item.id)}/></FixedCell><FixedCell className="mono">{item.payload.source_url ? <a className="mono" href={item.payload.source_url} target="_blank" rel="noreferrer" title="打开淘宝订单详情">{item.platform_order}</a> : item.platform_order}</FixedCell><FixedCell>{item.payload.shop || '待核对'}</FixedCell><FixedCell title={item.payload.purchased_at || item.payload.purchased_date || ''}>{(item.payload.purchased_at || item.payload.purchased_date || '').slice(0, 16) || '—'}</FixedCell><FixedCell className="mono" title={`采集于 ${(item.created_at || '').replace('T', ' ').slice(0, 19)}${item.updated_at && item.updated_at !== item.created_at ? ` · 更新于 ${item.updated_at.replace('T', ' ').slice(0, 19)}` : ''}`}>{(item.updated_at || item.created_at || '').replace('T', ' ').slice(0, 16) || '—'}</FixedCell><FixedCell>{item.payload.amount ? `¥${item.payload.amount}` : '待核对'}</FixedCell><FixedCell>{item.payload.products?.map(p => p.name).join('、') || '待核对'}</FixedCell><FixedCell>{item.payload.packages?.length ? item.payload.packages.map(p => `${p.carrier} ${p.tracking} ${p.status || ''}`).join('；') : '暂无运单'}</FixedCell><FixedCell><Badge>{item.payload.transaction_status || '待同步'}</Badge></FixedCell><FixedCell className="purchase-invoice-status"><Badge tone={draftInvoiceStatus(item).tone}>{draftInvoiceStatus(item).label}</Badge>{draftInvoiceStatus(item).label.includes('申请中') ? <a className="text-button" href="https://i.taobao.com/my_itaobao/invoice?active=application" target="_blank" rel="noreferrer" title="打开淘宝发票申请记录">申请记录</a> : null}{draftCanRemind(item) ? <button type="button" className="text-button" disabled={busy} title="按模板话术向商家催开发票" onClick={() => remindDraft(item)}>催发票</button> : null}</FixedCell><FixedCell className="purchase-invoice-files">{draftInvoiceFiles(item).length ? draftInvoiceFiles(item).map(id => <a key={id} className="badge badge-link green" href={`/api/files/${id}`} target="_blank" rel="noreferrer" title="点击查看发票文件">已获取</a>) : <Badge tone="orange">未获取</Badge>}</FixedCell><td className="purchase-draft-note">{item.payload.remark || "—"}</td></tr>)}</Table><Pagination label="淘宝订单" total={drafts.length} pagination={draftPagination} onPageChange={draftPagination.setPage} onPageSizeChange={draftPagination.setPageSize}/>{!drafts.length ? <Empty title={draftTerm ? "没有符合条件的淘宝订单" : "暂无淘宝订单"}>{draftTerm ? "请调整搜索内容。" : "已采集的淘宝订单会自动显示在这里。"}</Empty> : null}</Panel> : null}
    {invoiceRemindOpen ? <InvoiceReminders data={data} run={run} busy={busy} onClose={() => setInvoiceRemindOpen(false)}/> : null}
    {clearDraftTrash ? <Modal title="清空草稿回收站" onClose={() => setClearDraftTrash(false)}><p>清空后无法恢复，确定清空全部已删除的采购草稿吗？</p><Button danger disabled={busy} onClick={() => run(async () => { await api('/purchase-drafts/clear', {}); setClearDraftTrash(false); }, '草稿回收站已清空')}>确认清空</Button></Modal> : null}
    {draft ? <Modal wide title={`采购草稿 · ${draft.platform_order}`} onClose={() => setDraftId(null)}><PurchaseForm key={`draft-${draft.id}`} draftId={draft.id} source={draft.payload} data={data} run={run} busy={busy} onDone={() => { setDraftId(null); setModal(null); setSelectedDraftIds([]); }}/></Modal> : null}
{desktopOrder ? <p className="notice">已提取淘宝订单 {desktopOrder.platform_order}，尚待核对。<button className="text-button" onClick={openExtracted}>核对提取结果</button> <button className="text-button" onClick={() => { dismissDesktopOrder(); setModal(null); }}>放弃提取结果</button></p> : null}{tab === 'logistics' ? <p><Button secondary onClick={() => { setFocusPurchase(null); setPendingPackage(null); setTab('orders'); }}>返回采购订单</Button></p> : null}
    {tab === 'orders' ? <><Panel className="purchases-list" data-hidden-columns={attr}><div className="toolbar"><SearchBox value={search} onChange={value => { setSearch(value); pagination.setPage(1); setSelectedPurchaseIds([]); }} placeholder="搜索店铺、订单号、客户 PO、料品、规格、项目号、快递单号…"/><select aria-label="平台筛选" value={platform} onChange={e => { setPlatform(e.target.value); pagination.setPage(1); setSelectedPurchaseIds([]); }}><option value="">全部平台</option>{['淘宝','京东','拼多多','闲鱼','阿里巴巴','嘉立创','对公','其他'].map(x => <option key={x}>{x}</option>)}</select><select aria-label="交易状态筛选" title="按订单交易状态筛选" value={tradeFilter} onChange={e => { setTradeFilter(e.target.value); pagination.setPage(1); setSelectedPurchaseIds([]); }}><option value="">全部交易状态</option>{TRADE_STATUS_OPTIONS.map(label => <option key={label} value={label}>{label}</option>)}</select><select aria-label="采购状态筛选" value={statusFilter} onChange={e => { setStatusFilter(e.target.value); pagination.setPage(1); setSelectedPurchaseIds([]); }}><option value="">全部采购状态</option>{Object.entries(purchaseStatuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><select aria-label="开票状态筛选" title="按开票状态筛选采购记录" value={invoiceFilter} onChange={e => { setInvoiceFilter(e.target.value); pagination.setPage(1); setSelectedPurchaseIds([]); }}><option value="">全部开票状态</option>{INVOICE_STATE_OPTIONS.map(label => <option key={label} value={label}>{label}</option>)}</select><select aria-label="采购记录范围" value={view} onChange={e => { setView(e.target.value); pagination.setPage(1); setSelectedPurchaseIds([]); }}><option value="active">当前采购</option><option value="archived">已归档</option><option value="trash">回收站</option></select><select aria-label="物流状态筛选" title="按包裹物流状态筛选采购记录" value={logisticsFilter} onChange={e => { setLogisticsFilter(e.target.value); pagination.setPage(1); setSelectedPurchaseIds([]); }}><option value="">全部物流状态</option>{LOGISTICS_STATUSES.map(label => <option key={label} value={label}>{label}</option>)}</select><div className="date-range"><input type="date" aria-label="采购起始日期" title="采购起始日期" value={dateFrom} onChange={e => { setDateFrom(e.target.value); pagination.setPage(1); setSelectedPurchaseIds([]); }}/><span>至</span><input type="date" aria-label="采购结束日期" title="采购结束日期" value={dateTo} onChange={e => { setDateTo(e.target.value); pagination.setPage(1); setSelectedPurchaseIds([]); }}/>{dateFrom || dateTo ? <button type="button" className="text-button" onClick={() => { setDateFrom(''); setDateTo(''); pagination.setPage(1); setSelectedPurchaseIds([]); }}>清除</button> : null}</div><div className="purchase-toolbar-actions"><Button onClick={() => setModal('platform')}><Plus size={16}/>平台采购</Button><Button secondary onClick={() => setModal('regular')}><Plus size={16}/>常规采购</Button><Button secondary disabled={busy} onClick={refresh}><RefreshCw size={16}/>刷新</Button><ColumnSettings columns={PURCHASE_COLUMNS} hidden={hidden} onToggle={toggle} onReset={reset}/><Button secondary disabled={busy} onClick={() => setInvoiceRemindOpen(true)}>发票催办{invoiceRemindCandidates(data).length ? `（${invoiceRemindCandidates(data).length}）` : ''}</Button><Button secondary disabled={busy || !selectedPurchaseIds.length || !window.caidanDesktop?.syncInvoices} title={window.caidanDesktop?.syncInvoices ? "下载所选采购的发票文件" : "自动获取需在采单客户端中完成，已下载文件可在网页查看、确认"} onClick={() => getInvoices(selectedPurchaseIds)}>{busy ? '正在获取…' : '获取所选发票'}</Button><Button secondary className="selection-action" disabled={busy || !pickedPurchase} onClick={() => { setEditingAssociations(false); setModal(pickedPurchase.id); }}>查看明细</Button><Button secondary className="selection-action" disabled={busy || !pickedPurchaseEditable} onClick={() => { setEditingAssociations(true); setModal(pickedPurchase.id); }}>编辑</Button><Button secondary className="selection-action" disabled={busy || !pickedPurchaseReturnable} onClick={() => setReturnPurchase(pickedPurchase.id)}>退货</Button><Button secondary className="selection-action" disabled={busy || !pickedPurchaseRestorable} onClick={() => run(() => api(`/purchases/${pickedPurchase.id}/restore-return`, {}), '采购已恢复')}>恢复退货</Button><Button secondary danger className="selection-action" disabled={busy || !canDeleteSelectedPurchases} title={selectedPurchaseIds.some(id => protectedPurchases.has(id)) ? '所选采购已有后续业务，请使用采购处理或归档' : '删除选中采购'} onClick={() => setPendingDeleteIds(selectedPurchaseIds)}>删除选中{selectedPurchaseIds.length ? `（${selectedPurchaseIds.length}）` : ''}</Button></div></div>
    <Table minWidth={1520} headers={[<input type="checkbox" aria-label="全选当前页采购" checked={allSelected} disabled={!pagePurchases.length} onChange={toggleAll}/>, '平台 / 店铺','料品 / 规格','物流','客户PO','项目号','平台订单号','实付款','采购状态',purchaseSortHeader('purchased_date', '采购日期'),'同步时间',purchaseSortHeader('created_at', '登记日期'),'交易状态','开票状态','发票文件','收票情况']}>
      {purchaseSummaryRow}{pagePurchases.map(p => {
        const packages = shipmentsFor(p), orderURL = orderDetailURL(p), items = purchaseItems(data, ol, p);
        const linesOfPurchase = data.purchase_lines.filter(line => line.purchase_id === p.id);
        const linkedLines = [...new Set(data.purchase_lines.filter(l => l.purchase_id === p.id).map(l => ol[l.order_line_id]).filter(Boolean))];
        const projects = [...new Set(linkedLines.map(l => l.project_code).filter(Boolean))];
        const subprojects = [...new Set(linkedLines.map(l => l.subproject_code).filter(Boolean))];
        return <tr key={p.id} className={`purchase-row${selectedPurchaseIds.includes(p.id) ? ' row-selected' : ''}`} onClick={event => { if (event.target.closest('a,button,input,select,label,textarea')) return; togglePurchase(p.id); }} onDoubleClick={event => { if (event.target.closest('a,button,input,select,label,textarea')) return; setEditingAssociations(false); setModal(p.id); }}>
          <FixedCell><input type="checkbox" aria-label={`选择采购订单：${p.platform_order}`} checked={selectedPurchaseIds.includes(p.id)} onChange={() => togglePurchase(p.id)}/></FixedCell>
          <FixedCell title={`${p.shop} · ${p.account || '默认采购账号'}${p.open_cases ? ` · ${p.open_cases} 项采购处理待办` : ''}`}><strong className="purchase-shop-name">{p.shop}</strong><small className={p.open_cases ? 'text-orange' : 'muted'}>{p.open_cases ? `${p.open_cases} 项采购处理待办` : `${p.platform} · ${p.account || '默认采购账号'}`}</small></FixedCell>
          <FixedCell title={items.map(x => `${x.name} ${x.spec}`.trim()).join('\n') || '暂无料品'}>
            {items.length ? <PurchaseItemCell items={items} onOpen={() => setPreviewPurchase(p.id)}/> : <span className="muted">暂无料品</span>}
          </FixedCell>
          <FixedCell title={packages.map(pkg => `${pkg.carrier || '快递公司待补充'} · ${pkg.tracking}`).join('\n')}>{packages.length ? packages.map(pkg => <button type="button" key={pkg.tracking} className="text-button purchase-logistics-link" title={`${pkg.carrier || '快递公司待补充'} · ${pkg.tracking}`} onClick={() => setLogisticsPurchase(p.id)}><small className={`logistics-state ${/异常|拒收|退回|失败/.test(pkg.status || '') ? 'red' : /签收/.test(pkg.status || '') ? 'green' : pkg.status ? 'orange' : 'gray'}`}>{pkg.status || '状态未获取'}</small></button>) : <small>暂无物流信息</small>}</FixedCell>
          <FixedCell>{[...new Set(data.purchase_lines.filter(l => l.purchase_id === p.id).map(l => ol[l.order_line_id].order_id))].map((id, i) => <React.Fragment key={id}>{i ? '、' : null}<a href={`#orders?order=${id}`}>{orders[id].po}</a></React.Fragment>)}</FixedCell>
          <FixedCell title={[projects.join('、'), subprojects.join('、')].filter(Boolean).join('\n')}>{projects.length || subprojects.length ? <span className={`purchase-project${projects.length > 1 || subprojects.length > 1 ? ' more' : ''}`}>{projects.join('、') || '—'}<small>{subprojects.join('、') || '—'}</small></span> : '—'}</FixedCell>
          <FixedCell className="mono">{orderURL ? <a href={orderURL} target="_blank" rel="noreferrer" title="打开淘宝订单详情">{p.platform_order}</a> : p.platform_order}</FixedCell>
          <FixedCell>{money(p.amount_cents)}</FixedCell>
          <FixedCell title={statusesByPurchase[p.id].map(key => purchaseStatuses[key]).join('、')}>{statusesByPurchase[p.id].map(key => <Badge key={key} tone={['returning', 'returned', 'partial_returned', 'cancelling'].includes(key) ? 'orange' : undefined}>{purchaseStatuses[key]}</Badge>)}</FixedCell>
          <FixedCell title={(p.purchased_at || p.purchased_date || '').slice(0, 16)}>{((p.purchased_at || p.purchased_date || '') ? (p.purchased_at || p.purchased_date).slice(0, 16) : '—')}</FixedCell>
          <FixedCell className="mono" title={`同步（登记）于 ${(p.created_at || '').replace('T', ' ').slice(0, 19)}`}>{(p.created_at || '').replace('T', ' ').slice(0, 16) || '—'}</FixedCell>
          <FixedCell title={p.created_at?.replace('T', ' ')}>{p.created_at?.slice(0, 10) || '—'}</FixedCell>
          <FixedCell className="purchase-trade-status" title={tradeStatus(p)}><Badge tone={tradeStatus(p) === '交易成功' ? 'green' : ['交易关闭', '交易取消'].includes(tradeStatus(p)) ? 'gray' : undefined}>{tradeStatus(p) || '未同步'}</Badge></FixedCell>
          <PurchaseInvoiceCells purchase={p} data={data} run={run} busy={busy} onOpen={() => setInvoicePurchase(p.id)}/>
          
        </tr>;
      })}
    </Table>
    {view !== 'trash' ? <Pagination label="采购记录" total={filtered.length} pagination={pagination} onPageChange={page => { pagination.setPage(page); setSelectedPurchaseIds([]); }} onPageSizeChange={size => { pagination.setPageSize(size); setSelectedPurchaseIds([]); }}/> : null}
    {view !== 'trash' && !filtered.length ? <Empty title="暂无采购记录">先确认客户报价，再将平台采购关联到料品。</Empty> : null}</Panel>
    {view === 'trash' ? <Trash data={data} table="purchases" run={run} busy={busy} user={user}/> : null}
    {preview ? <Modal title={`料品预览 · ${preview.shop} · ${preview.platform_order}`} onClose={() => setPreviewPurchase(null)}>
      <Table headers={['料品名称','规格型号','采购数量','单位','单价（元）','金额（元）','料品编号']}>{purchaseItems(data, ol, preview).map(item => {
        const line = data.purchase_lines.find(l => l.id === item.id);
        const record = (data.items || []).find(x => x.id === line?.item_id);
        const unitCents = line ? (line.unit_price_cents ?? (line.quantity ? Math.round(line.cost_cents / line.quantity) : line.cost_cents)) : 0;
        return <tr key={item.id}><td>{item.name}</td><td>{item.spec || '—'}</td><td>{q(item.quantity)}</td><td>{item.unit}</td><td>{money(unitCents)}</td><td>{money(line ? line.cost_cents : 0)}</td><td className="mono">{record?.code || '待匹配'}</td></tr>;
      })}</Table>
      <p className="muted footnote">本采购单共 {purchaseItems(data, ol, preview).length} 项料品{(preview.taobao_source?.products || []).length ? `，平台提取商品 ${preview.taobao_source.products.length} 项` : ''}；完整信息请在“查看明细”中核对。</p>
    </Modal> : null}
    {returnPurchase ? <Modal title="登记采购退货" onClose={() => setReturnPurchase(null)}><PurchaseReturnForm purchaseId={returnPurchase} user={user} data={data} run={run} busy={busy} onDone={() => { setModal(returnPurchase); setReturnPurchase(null); }}/></Modal> : null}
    
    {logisticsPurchase ? <Modal title="采购物流详情" onClose={() => setLogisticsPurchase(null)}>{(() => { const purchase = data.purchases.find(p => p.id === logisticsPurchase); if (!purchase) return null; return <><p className="muted">平台订单号：{purchase.platform_order}</p>{purchase.taobao_source?.sync_checked_at ? <p className="notice">最近检查：{purchase.taobao_source.sync_checked_at.replace('T', ' ').slice(0, 19)} · {purchase.taobao_source.sync_error || '已检查'}</p> : null}{shipmentsFor(purchase).map(pkg => { const events = [...(pkg.events || []), ...data.tracking_events.filter(e => e.package_id === pkg.id)].filter((event, index, all) => all.findIndex(e => e.occurred_at === event.occurred_at && e.description === event.description) === index).sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)); return <section key={pkg.tracking}><h3>{pkg.carrier || '快递公司待补充'} · {pkg.tracking}</h3><div className="logistics-package-head"><Badge>{pkg.status || '状态未获取'}</Badge><div className="logistics-package-actions"><button type="button" className="button secondary logistics-copy" title="复制运单信息" aria-label="复制运单信息" onClick={() => run(async () => { const label = `${pkg.carrier || '快递公司待补充'} · ${pkg.tracking}`; if (!(await copyText(label))) throw new Error('复制失败，请手动选择运单信息'); }, '运单信息已复制')}><Copy size={15}/>复制</button></div></div>{events.length ? <div className="timeline">{events.map((event, index) => <div key={index}><p>{event.description}</p><small>{event.occurred_at.replace('T', ' ').slice(0, 19)}</small></div>)}</div> : null}</section>; })}</>; })()}</Modal> : null}
    {modal === 'regular' ? <Modal wide title="登记常规采购" onClose={() => setModal(null)}><PurchaseForm key="regular" mode="regular" data={data} run={run} busy={busy} onDone={() => { setModal(null); setTab('orders'); }}/></Modal> : null}
    {modal === 'platform' ? <Modal wide title="登记平台采购" onClose={() => setModal(null)}><PurchaseForm key={desktopOrder?.id || "manual"} mode="platform" source={desktopOrder} data={data} run={run} busy={busy} onDone={(id, shipment) => { if (desktopOrder) { dismissDesktopOrder(); setModal(null); return; } setModal(null); if (shipment.tracking || shipment.carrier) { setFocusPurchase(id); setPendingPackage(shipment); setTab('logistics'); } }}/></Modal> : null}
    {current ? <Modal wide title={`${current.platform} · ${current.platform_order}`} onClose={() => { setModal(null); setEditingAssociations(false); }}>
      {editingAssociations ? <PurchaseForm mode={data.purchase_lines.filter(line => line.purchase_id === current.id).every(line => !line.order_line_id) ? 'regular' : 'platform'} data={data} run={run} busy={busy} purchase={current} source={current.taobao_source} onDone={() => { setEditingAssociations(false); setModal(null); }} onCancel={() => setEditingAssociations(false)}/> : <div className="purchase-detail-content">
        {desktopOrder?.platform_order === current.platform_order ? <><p className="notice">该订单已登记，核对后可补充商品参考和物流信息；采购金额不会被改写。</p><TaobaoSource source={desktopOrder} data={data}/><Button disabled={busy} onClick={() => run(async () => { await api(`/purchases/${current.id}/taobao`, desktopOrder); dismissDesktopOrder(); }, '淘宝物流信息已补充')}>确认补充提取信息</Button></> : null}
        <TaobaoSource source={current.taobao_source} purchaseSummary={{ shop: current.shop, amount: money(current.amount_cents), count: shipmentsFor(current).length }}/>
        <section className="purchase-order-note"><div className="purchase-association-heading"><h3>采购料品</h3><Button secondary disabled={busy || !!current.archived_at} onClick={() => setEditingAssociations(true)}>编辑采购信息</Button></div>
          {data.purchase_lines.filter(line => line.purchase_id === current.id).map(line => {
            const orderLine = line.order_line_id ? ol[line.order_line_id] : null, item = line.item_id ? (data.items || []).find(x => x.id === line.item_id) : null;
            const original = line.original_quantity ?? line.quantity, remaining = line.quantity;
            return <p key={line.id}>{orderLine ? `关联客户订单 ${orders[orderLine.order_id].po} · ${orderLine.name} · ${orderLine.spec || '—'}` : `备货料品 ${item ? itemLabel(item) : line.item_id ? `#${line.item_id}` : '待匹配'}`} · 数量 {q(original)}{line.received_quantity > 0 ? `（已入库 ${q(line.received_quantity)}）` : ''}{remaining > 1e-6 && remaining < original - 1e-6 ? `，剩余 ${q(remaining)}` : ''} · 单价 {money(line.unit_price_cents ?? (line.quantity ? Math.round(line.cost_cents / line.quantity) : line.cost_cents))} · 金额 {money(line.cost_cents)} · <Badge tone={line.receive_mode === 'stock' ? 'green' : undefined}>{(line.receive_mode || 'direct') === 'stock' ? '入库' : '直发客户'}</Badge></p>;
          })}</section>
        <section className="purchase-order-note" aria-label="订单备注"><h3>订单备注</h3><p>{current.note || '暂无备注'}</p></section>
        <PurchaseAttachments items={(current.attachments || (current.source_id ? [{ attachment_id: current.source_id, name: data.attachments.find(file => file.id === current.source_id)?.name || '采购附件' }] : [])).map(file => ({ id: file.attachment_id, name: file.name }))} busy={busy} onAdd={file => run(() => api(`/purchases/${current.id}/attachments`, { attachment_ids: [file.id] }), '采购附件已添加')} onRemove={id => run(() => api(`/purchases/${current.id}/attachments/remove`, { attachment_id: id }), '采购附件已移除')}/></div>}
    </Modal> : null}</> : tab === 'logistics' ? <Logistics data={data} run={run} busy={busy} purchaseId={focusPurchase} onClearPurchase={() => setFocusPurchase(null)} initialPackage={pendingPackage} onClearInitialPackage={() => setPendingPackage(null)}/> : null}
    {pendingDeleteIds.length ? <Modal title={`删除 ${pendingDeleteIds.length} 条采购记录`} onClose={() => setPendingDeleteIds([])}><p>确定删除以下采购记录吗？</p><ul className="delete-order-list">{pendingDeleteIds.slice(0, 6).map(id => { const purchase = data.purchases.find(item => item.id === id); return <li key={id}>{purchase?.platform} · {purchase?.platform_order}</li>; })}{pendingDeleteIds.length > 6 ? <li>另有 {pendingDeleteIds.length - 6} 条</li> : null}</ul><p className="muted">仅适用于录错、重复录入且没有包裹、送货、收票或后续处理的记录。删除后移入回收站并释放采购占用，管理员可恢复；已有后续业务请办理采购处理或归档。</p><div className="save-bar"><Button secondary onClick={() => setPendingDeleteIds([])}>取消</Button><Button secondary danger disabled={busy} onClick={confirmDelete}>确认删除</Button></div></Modal> : null}
    {invoice ? <Modal wide title={`采购发票 · ${invoice.platform_order}`} onClose={() => setInvoicePurchase(null)}><Invoices key={invoice.id} purchase={invoice} data={data} run={run} busy={busy} onSyncPlatform={() => getInvoices([invoice.id])}/></Modal> : null}
  </>;
}

function PurchaseInvoiceCells({ purchase: p, data, run, busy, onOpen }) {
  const status = invoiceStatus(p);
  const invoiceIds = new Set(data.invoice_allocations.filter(a => a.purchase_id === p.id).map(a => a.invoice_id));
  const registered = data.invoices.filter(invoice => invoiceIds.has(invoice.id));
  const byNumber = new Map(registered.map(invoice => [invoice.number, invoice]));
  const details = p.taobao_source?.invoice_details || [];
  const files = [...new Set([...details, ...registered].map(item => item.attachment_id).filter(Boolean))];
  const missingFiles = details.some(item => !item.attachment_id && !byNumber.get(item.number)?.attachment_id);
  const awaitingConfirmation = details.some(item => item.attachment_id && !byNumber.has(item.number));
  const receipt = awaitingConfirmation ? '待确认' : p.invoice_stage === '不需开票' ? '不需开票' : registered.length && p.receipt_status === '已收齐' ? '已确认' : p.receipt_status;
  const queuedApply = (data.invoice_apply_requests || []).find(request => request.purchase_id === p.id && ['pending', 'running'].includes(request.status));
  const remindCount = Number(p.invoice_remind_count || 0);
  const remindTag = queuedApply ? { label: '申请中', title: queuedApply.message || '平台申请开票任务已排入客户端队列，等待客户端执行' } : remindCount ? { label: `已催${remindCount}次`, title: `已催票 ${remindCount} 次${p.invoice_reminded_at ? `，最近 ${p.invoice_reminded_at.replace('T', ' ').slice(0, 16)}` : ''}${p.next_followup ? `，下次跟进 ${p.next_followup}` : ''}` } : isInvoiceRemindCandidate(p) ? { label: '待催票', title: '交易成功且还没开票：可点工具栏「发票催办」申请开票或直接催发票' } : null;
  const remindInvoice = () => run?.(async () => {
    const script = invoiceScriptFor(p, data.company || {});
    let outcome = null;
    if (window.caidanDesktop?.remindInvoice) {
      outcome = await window.caidanDesktop.remindInvoice(p.id);
    } else {
      const copied = await copyText(script);
      if (!copied) return { copyFailed: true };
      window.open(`https://trade.taobao.com/trade/detail/trade_order_detail.htm?bizOrderId=${p.platform_order}`, '_blank', 'noreferrer');
    }
    await api(`/purchases/${p.id}/invoice-remind`, { channel: '聊天催票' });
    return outcome;
  }, outcome => {
    if (outcome?.copyFailed) return '当前环境不支持自动复制，请手动复制话术后在淘宝发送';
    if (!window.caidanDesktop?.remindInvoice) return '催票话术已复制并打开淘宝订单，粘贴发送即可';
    if (outcome?.filled) return '已打开商家聊天并填好话术，按回车发送即可';
    return outcome?.opened ? '已打开商家聊天，话术已复制，粘贴发送即可' : '已复制催票话术并打开订单页面，请手动发送';
  });
  return <>
    <FixedCell className="purchase-invoice-status" title={status.label === '待查询' ? '淘宝没有提供这笔订单的发票信息：尚未在淘宝申请开票，或卖家未通过淘宝开具电子发票。可用“申请开票”向卖家申请，或收到发票后在“收票情况”登记。' : undefined}><Badge tone={status.tone === 'gray' && p.invoice_stage !== '不需开票' ? 'orange' : status.tone}>{status.label}</Badge>{status.label.includes('申请中') ? <a className="text-button" href="https://i.taobao.com/my_itaobao/invoice?active=application" target="_blank" rel="noreferrer" title="打开淘宝发票申请记录">申请记录</a> : null}{remindTag ? <small className={remindTag.label === '待催票' || remindTag.label === '申请中' ? 'text-orange' : undefined} title={remindTag.title}>{remindTag.label}</small> : null}{isInvoiceRemindCandidate(p) && !queuedApply ? <button type="button" className="text-button" disabled={busy} title="按模板话术向商家催开发票" onClick={remindInvoice}>催发票</button> : null}</FixedCell>
    <FixedCell className="purchase-invoice-files">{files.length ? (files.length === 1
      ? <a className={`badge badge-link ${missingFiles ? 'orange' : 'green'}`} href={`/api/files/${files[0]}`} target="_blank" rel="noreferrer" title="点击查看发票文件">{missingFiles ? '部分获取' : '已获取'}</a>
      : <button type="button" className={`badge badge-button ${missingFiles ? 'orange' : 'green'}`} title={`点击查看发票文件（${files.length} 个）`} onClick={onOpen}>{missingFiles ? '部分获取' : '已获取'}</button>)
      : <Badge tone={p.invoice_stage === '不需开票' ? 'gray' : 'orange'}>{p.invoice_stage === '不需开票' ? '—' : status.label.startsWith('未开票') ? '待开票' : '未获取'}</Badge>}</FixedCell>
    <FixedCell className="purchase-invoice-receipt"><button type="button" className={`badge badge-button ${receipt === '不需开票' ? 'gray' : ['已确认', '已收齐'].includes(receipt) ? 'green' : 'orange'}`} title="点击查看 / 确认收票" onClick={onOpen}>{receipt}</button><small className="purchase-invoice-amounts">已收 {money(p.received_cents)} / 待收 {money(p.remaining_cents)}</small></FixedCell>
  </>;
}

function PurchaseForm({ mode = 'platform', data, run, busy, onDone, onCancel, source, draftId, purchase }) {
  const orders = indexById(data.orders);
  const existingLines = purchase ? data.purchase_lines.filter(line => line.purchase_id === purchase.id) : [];
  // 常规采购：产品库备货、固定入库、手填单价。平台采购：客户料品、按实付款分摊（可手改锁定）。
  const regular = mode === 'regular' && !source && (!purchase || !existingLines.length || existingLines.every(line => !line.order_line_id));
  const available = data.order_lines.map(line => ({ ...line, purchased: line.purchased - (existingLines.find(item => item.order_line_id === line.id)?.quantity || 0) })).filter(l => existingLines.some(item => item.order_line_id === l.id) || orders[l.order_id].status === 'confirmed' && !orders[l.order_id].archived_at && l.demand_quantity > l.purchased + .000001);
  const suggestedIds = source && !purchase ? suggestOrderLineIds(source.remark, available, orders) : [];
  const itemFor = line => ({ key: `L${line.id}`, order_line_id: line.id, item_id: line.item_id || null, quantity: line.history ? Math.max(1, Number((line.demand_quantity - line.purchased).toFixed(6))) : Number((line.demand_quantity - line.purchased).toFixed(6)), purchase_unit: line.unit, purchase_spec: line.spec, cost: '', link: '', receive_mode: 'direct', warehouse_id: '', manual: false });
  const stockRow = id => { const item = (data.items || []).find(x => x.id === id); return { key: `P${id}`, order_line_id: null, item_id: id, quantity: '', unit_price: '', purchase_unit: item?.purchase_unit || item?.unit || '个', purchase_spec: item?.spec || '', cost: '', link: '', receive_mode: 'stock', warehouse_id: '' }; };
  const [form, setForm] = useState({ platform: regular ? '对公' : '淘宝', account: '', shop: '', platform_order: '', amount: '', purchased_date: data.today, promised_date: '', note: '', ...(source ? { platform: '淘宝', shop: source.shop, platform_order: source.platform_order, amount: source.amount, purchased_date: source.purchased_date, account: source.account || '', promised_date: source.promised_date || '', note: source.remark || '' } : {}), ...(purchase ? { platform: purchase.platform, shop: purchase.shop, account: purchase.account || '', platform_order: purchase.platform_order, amount: (purchase.amount_cents / 100).toFixed(2), purchased_date: purchase.purchased_date, promised_date: purchase.promised_date || '', note: purchase.note || '' } : {}) });
  const [attachments, setAttachments] = useState(() => (source?.attachment_ids || []).map(id=>data.attachments.find(file=>file.id===id)).filter(Boolean)), [uploading, setUploading] = useState(false);
  const [items, setItems] = useState(() => purchase ? existingLines.map(line => ({ ...line, key: line.order_line_id ? `L${line.order_line_id}` : `P${line.item_id}`, cost: (line.cost_cents / 100).toFixed(2), unit_price: ((line.unit_price_cents ?? (line.quantity ? line.cost_cents / line.quantity : line.cost_cents)) / 100).toFixed(2), manual: false })) : []), [pickerOpen, setPickerOpen] = useState(false), [productPickerOpen, setProductPickerOpen] = useState(false);
  const [pickerVisible, pickerClosing] = usePaneVisible(pickerOpen), [productVisible, productClosing] = usePaneVisible(productPickerOpen);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  // 淘宝提取商品：默认全部关联；可取消勾选（本次不关联）或删除（不再出现，跨淘宝同步保留）。
  const productKey = product => ['name', 'spec', 'quantity', 'amount', 'link'].map(key => String(product?.[key] ?? '').trim()).join('|');
  const [removedProducts, setRemovedProducts] = useState(() => new Set(source?.removed_products || []));
  const [unlinkedProducts, setUnlinkedProducts] = useState(() => new Set(source?.unlinked_products || []));
  const sourceProducts = (source?.products || []).filter(product => !removedProducts.has(productKey(product)));
  const linkedProducts = sourceProducts.filter(product => !unlinkedProducts.has(productKey(product)));
  const toggleProduct = product => setUnlinkedProducts(current => { const next = new Set(current); const key = productKey(product); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const removeProduct = product => setRemovedProducts(current => new Set([...current, productKey(product)]));
  const toggleAllProducts = checked => setUnlinkedProducts(checked ? new Set() : new Set(sourceProducts.map(productKey)));
  const productControls = source && !purchase ? { isChecked: product => !unlinkedProducts.has(productKey(product)), onToggle: toggleProduct, onRemove: removeProduct, onToggleAll: toggleAllProducts, allChecked: sourceProducts.length > 0 && linkedProducts.length === sourceProducts.length, checked: linkedProducts.length, total: sourceProducts.length } : null;
  const historyLines = data.order_lines.filter(line => data.purchase_lines.some(purchaseLine => purchaseLine.order_line_id === line.id)).map(line => ({ ...line, history: true, purchased: line.purchased - (existingLines.find(item => item.order_line_id === line.id)?.quantity || 0) }));
  const addMany = ids => setItems(current => {
    const selected = new Set(ids), existing = new Set(current.map(item => item.order_line_id));
    return [...current, ...[...available, ...historyLines].filter(line => selected.has(line.id) && !existing.has(line.id)).map(itemFor)];
  });
  const addProducts = ids => setItems(current => {
    const existing = new Set(current.filter(row => !row.order_line_id).map(row => row.item_id));
    return [...current, ...ids.filter(id => !existing.has(id)).map(stockRow)];
  });
  const rowKey = row => row.key ?? (row.order_line_id ? `L${row.order_line_id}` : `P${row.item_id}`);
  const change = (key, k, v) => setItems(xs => xs.map(x => rowKey(x) === key ? { ...x, [k]: v } : x));
  const editCost = (key, value) => setItems(xs => xs.map(x => rowKey(x) === key ? { ...x, cost: value, manual: true } : x));
  const resetManual = key => setItems(xs => xs.map(x => rowKey(x) === key ? { ...x, manual: false, cost: '' } : x));
  const removeRow = key => setItems(xs => xs.filter(x => rowKey(x) !== key));
  const allocatedItems = allocatePurchaseCosts(items, [], {}, form.amount, available, items.filter(item => item.manual).map(rowKey));
  const regularItems = items.map(row => ({ ...row, receive_mode: 'stock', cost: (Math.round((Number(row.unit_price) || 0) * (Number(row.quantity) || 0) * 100) / 100).toFixed(2), unit_price: row.unit_price }));
  const regularTotalCents = regularItems.reduce((sum, row) => sum + Math.round(Number(row.cost || 0) * 100), 0);
  const amountCents = regular ? regularTotalCents : Math.round((Number(form.amount) || 0) * 100);
  const allocatedCents = allocatedItems.reduce((sum, row) => sum + Math.round(Number(row.cost || 0) * 100), 0);
  const gapCents = amountCents - allocatedCents;
  const missingQuote = regular && items.some(row => !(Number(row.unit_price) > 0) || !(Number(row.quantity) > 0));
  const blocked = !items.length || uploading || (regular ? missingQuote : (!(Number(form.amount) > 0) || gapCents !== 0));
  const payloadLines = regular ? regularItems : allocatedItems;
  const payloadAmount = regular ? (regularTotalCents / 100).toFixed(2) : form.amount;

  const draftButton = source && !purchase ? <Button secondary disabled={busy || uploading} onClick={() => run(async () => { const result = await api('/purchase-drafts/manual', { ...source, products: sourceProducts, removed_products: [...removedProducts], unlinked_products: [...unlinkedProducts], shop:form.shop, amount:form.amount, purchased_date:form.purchased_date, remark:form.note, account:form.account, promised_date:form.promised_date, attachment_ids:attachments.map(file=>file.id) }); if (result.skipped) throw new Error(result.purchase_id ? '该订单已登记采购，请查看现有记录' : '草稿已在回收站，请先恢复'); onDone(null, {}); }, '已保存为采购草稿，可稍后关联料品')}>保存为草稿</Button> : null;
  if (!regular && !available.length && !historyLines.length) return <><TaobaoSource source={source ? { ...source, products: sourceProducts } : source} productControls={productControls} data={data}/>{draftButton}<Empty title="没有可采购的料品">请先创建客户订单并确认报价，再按“关联料品”登记平台采购。</Empty></>;
  if (regular && !(data.items || []).length) return <>{draftButton}<Empty title="产品库还没有料品">请先到“产品库”新增料品，再登记常规采购备货。</Empty></>;
  return <>
    {pickerVisible ? <PurchaseLinePicker closing={pickerClosing} available={available} historyLines={historyLines} orders={orders} initialIds={[...new Set([...items.filter(item => item.order_line_id).map(item => item.order_line_id), ...suggestedIds])]} addedIds={items.filter(item => item.order_line_id).map(item => item.order_line_id)} onDirectAdd={addMany} onDirectRemove={ids => setItems(current => current.filter(item => !item.order_line_id || !ids.includes(item.order_line_id)))} remark={form.note} onClose={() => setPickerOpen(false)} onAdd={ids => { setItems(current => current.filter(item => !item.order_line_id || ids.includes(item.order_line_id))); addMany(ids); setPickerOpen(false); }}/> : null}
    {productVisible ? <ProductPicker closing={productClosing} data={data} addedIds={items.filter(item => !item.order_line_id).map(item => item.item_id)} onAdd={ids => { addProducts(ids); setProductPickerOpen(false); }} onDirectAdd={ids => addProducts(ids)} onRemove={ids => setItems(current => current.filter(item => !item.item_id || !ids.includes(item.item_id)))} onClose={() => setProductPickerOpen(false)}/> : null}
    <form className="purchase-registration-form" onSubmit={e => { e.preventDefault(); if (uploading || blocked) return; run(async () => { const result = purchase ? await api(`/purchases/${purchase.id}`, { ...form, amount: payloadAmount, lines: payloadLines, association_mode: 'order' }) : await api('/purchases', { ...form, amount: payloadAmount, purchase_draft_id:draftId, attachment_ids: attachments.map(file => file.id), lines: payloadLines, taobao_source: source ? { ...source, products: linkedProducts.map(product => ({ ...product, order_line_ids: [] })), removed_products: [...removedProducts], unlinked_products: [...unlinkedProducts] } : undefined }); onDone(result.id, { carrier: form.carrier || '', tracking: form.tracking || '' }); }, purchase ? '采购信息已更新' : (regular ? '常规采购已保存，请到库存登记入库' : '采购已保存')); }}>
    <div className="save-bar"><div className="purchase-link-group">{regular
      ? <Button className="purchase-link-items" disabled={busy} onClick={() => { setPickerOpen(false); setProductPickerOpen(open => !open); }}>产品库选择</Button>
      : <Button className="purchase-link-items" disabled={busy} onClick={() => { setProductPickerOpen(false); setPickerOpen(open => !open); }}>关联料品</Button>}</div>{draftButton}{purchase ? <Button secondary disabled={busy} onClick={onCancel}>取消编辑</Button> : null}<Button type="submit" disabled={busy || blocked}>{purchase ? "保存修改" : regular ? "保存常规采购" : "保存采购记录"}</Button></div>
    <TaobaoSource source={source ? { ...source, products: sourceProducts } : source} productControls={productControls}/>{productControls ? <p className="muted footnote">提取商品默认全部关联：取消勾选表示本次不关联，点删除后该商品不会再出现在这张采购单里（重新同步也不会带回来）。</p> : null}{suggestedIds.length ? <p className="notice">已根据订单备注默认选择对应客户料品，请核对 PO、型号和数量。</p> : null}
    <div className="form-grid purchase-info-grid"><Field label="采购平台 *"><select disabled={!!source && !purchase} value={form.platform} onChange={e => set('platform', e.target.value)}>{['淘宝','京东','拼多多','闲鱼','阿里巴巴','嘉立创','对公','其他'].map(x => <option key={x}>{x}</option>)}</select></Field>
      {regular ? null : <InputField label="采购账号标识" value={form.account} onChange={e => set('account', e.target.value)} placeholder="如：公司采购号"/>}
      <InputField label="供应商 *" required value={form.shop} onChange={e => set('shop', e.target.value)}/><InputField label={OPTIONAL_ORDER_PLATFORMS.includes(form.platform) ? '订单号' : '订单号 *'} readOnly={!!source} required={!OPTIONAL_ORDER_PLATFORMS.includes(form.platform)} value={form.platform_order} onChange={e => set('platform_order', e.target.value)}/>
      {regular
        ? <InputField label="实付款（自动汇总）" readOnly value={money(regularTotalCents)}/>
        : <InputField label="实付款 *" inputMode="decimal" placeholder="0.00" required value={form.amount} onChange={e => set('amount', typedAmount(e.target.value))}/>}
      <InputField label="采购日期 *" type="date" required value={form.purchased_date} onChange={e => set('purchased_date', e.target.value)}/>
      {!source && !purchase ? <><InputField label="快递公司（可选）" value={form.carrier || ''} onChange={e => set('carrier', e.target.value)}/><InputField label="运单号（可选）" value={form.tracking || ''} onChange={e => set('tracking', e.target.value)}/></> : null}
      <InputField label="发货日期" type="date" value={form.promised_date} onChange={e => set('promised_date', e.target.value)}/><InputField label="备注" value={form.note} onChange={e => set('note', e.target.value)}/>
      {purchase ? null : <PurchaseAttachments items={attachments} busy={busy} onBusyChange={setUploading} onAdd={file => setAttachments(current => current.some(item => item.id === file.id) ? current : [...current, file])} onRemove={id => setAttachments(current => current.filter(file => file.id !== id))}/>}
    </div><div className="field"><span>{regular ? '整单备货料品' : '整单关联采购料品'}</span><button type="button" className="purchase-line-trigger" disabled={busy} onClick={() => regular ? (setPickerOpen(false), setProductPickerOpen(open => !open)) : (setProductPickerOpen(false), setPickerOpen(open => !open))}>{regular ? `选择产品库中的备货料品…${items.length ? `（已加入 ${items.length} 项）` : ''}` : `选择客户订单中的待采购料品…${items.length ? `（已加入 ${items.length} 项）` : ''}`}</button></div>
      <PurchaseLineTable mode={regular ? 'regular' : 'platform'} rows={payloadLines} rawRows={items} data={data} available={available} historyLines={historyLines} orders={orders} change={change} remove={removeRow} editCost={editCost} resetManual={resetManual}/>
    {items.length ? (regular
      ? <p className="purchase-amount-summary">合计 {money(regularTotalCents)} · 实付款自动汇总为 {money(regularTotalCents)}（各行 单价 × 数量）。保存后请到“库存 → 登记入库”办理入库，成本按移动加权平均结转。</p>
      : <p className={`purchase-amount-summary${gapCents ? ' gap' : ''}`}>已分摊 {money(allocatedCents)} / 实付款 {money(amountCents)} / 差额 {money(Math.abs(gapCents))}{gapCents ? '（差额必须为 0 才能保存，可手动改某行后其余行自动重摊）' : ''}。客户料品按“报价单价 × 对应需求数量”自动分摊；手动修改过的行会被锁定，其余行自动重摊。</p>) : null}
    </form>
  </>;
}

function PurchaseAttachments({ items, busy, onBusyChange, onAdd, onRemove }) {
  const [uploading, setUploading] = useState(false), [error, setError] = useState('');
  const change = async event => {
    const files = [...event.target.files];
    event.target.value = '';
    if (!files.length) return;
    if (items.length + files.length > 20) { setError('采购附件最多 20 个'); return; }
    setUploading(true); onBusyChange?.(true); setError('');
    try {
      for (const file of files) await onAdd(await upload(file));
    } catch (e) { setError(e.message); }
    finally { setUploading(false); onBusyChange?.(false); }
  };
  return <div className="field purchase-attachments-field"><span>附件</span>
    <div className="upload-inline"><input type="file" aria-label="添加采购附件" accept=".pdf,.png,.jpg,.jpeg,.webp,.xlsx,.ofd" multiple onChange={change} disabled={busy || uploading}/></div>
    {items.length ? <ul className="purchase-attachment-list">{items.map(file => <li key={file.id}><a href={`/api/files/${file.id}`} target="_blank" rel="noreferrer" title={file.name}>{file.name}</a><button type="button" className="icon-button" aria-label={`移除附件 ${file.name}`} disabled={busy || uploading} onClick={() => onRemove(file.id)}><Trash2 size={15}/></button></li>)}</ul> : null}
    {error ? <span className="error">{error}</span> : null}
  </div>;
}

export function PurchaseLinePicker({ available, historyLines = [], orders, addedIds, onClose, onAdd, onDirectAdd, onDirectRemove, remark, initialIds = [], remainingQuantity = line => line.demand_quantity - line.purchased, groupByPo = false, closing = false }) {
  const [search, setSearch] = useState(''), [selected, setSelected] = useState(initialIds), [historyOnly, setHistoryOnly] = useState(false);
  const source = historyOnly ? historyLines : available;
  const [customer, setCustomer] = useState(''), [poIds, setPoIds] = useState([]);
  const availableOrders = [...new Set(source.map(line => line.order_id))].map(id => orders[id]);
  const customers = [...new Set(availableOrders.map(order => order.customer))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const filteredOrders = availableOrders.filter(order => matchCustomer(customer, order.customer));
  const searchRef = useRef(null), dialogRef = useRef(null);
  useEffect(() => { searchRef.current?.focus({ preventScroll: true }); if (dialogRef.current) dialogRef.current.scrollLeft = 0; }, []);
  // 客户 PO 多选菜单：点击菜单外任意位置自动收起
  useEffect(() => {
    const close = event => {
      const open = dialogRef.current?.querySelector('.picker-po-filter[open]');
      if (open && !open.contains(event.target)) open.open = false;
    };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, []);
  const added = new Set(addedIds), term = search.trim().toLowerCase();
  const matchScores = similarOrderLineScores(remark, source);
  const exactIds = new Set(poIds.length ? poIds.flatMap(id => suggestOrderLineIds(remark, source, orders, id)) : suggestOrderLineIds(remark, source, orders, null));
  const visible = source.filter(line => {
    const order = orders[line.order_id];
    return matchCustomer(customer, order.customer) && (!poIds.length || poIds.includes(order.id)) && `${order.po} ${order.customer} ${line.name} ${line.spec} ${line.brand} ${line.description}`.toLowerCase().includes(term);
  });
  visible.sort((a, b) => Number(exactIds.has(b.id)) - Number(exactIds.has(a.id)) || (matchScores.get(b.id) || 0) - (matchScores.get(a.id) || 0));
  const selectable = visible.filter(line => !added.has(line.id));
  const selectedVisible = selected.filter(id => visible.some(line => line.id === id));
  const [expandedOrders, setExpandedOrders] = useState([]);
  const visibleOrders = [...new Set(visible.map(line => line.order_id))].map(id => orders[id]);
  const toggleOrder = id => { const ids = selectable.filter(line => line.order_id === id).map(line => line.id); setSelected(current => ids.every(value => current.includes(value)) ? current.filter(value => !ids.includes(value)) : [...new Set([...current,...ids])]); };
  const allSelected = selectable.length > 0 && selectable.every(line => selected.includes(line.id));
  const toggle = id => setSelected(ids => ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id]);
  const toggleAll = () => setSelected(ids => allSelected ? ids.filter(id => !selectable.some(line => line.id === id)) : [...new Set([...ids, ...selectable.map(line => line.id)])]);
  const togglePo = id => {
    const picked = poIds.includes(id);
    setPoIds(picked ? poIds.filter(value => value !== id) : [...poIds, id]);
    if (!picked) setSelected(ids => [...new Set([...ids, ...suggestOrderLineIds(remark, source, orders, id)])]);
  };
  const onKeyDown = event => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    if (event.key !== 'Tab') return;
    event.stopPropagation();
    const controls = [...dialogRef.current.querySelectorAll('button,input,select,summary')].filter(el => !el.disabled);
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
    if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
  };
  return <div className={`purchase-line-picker-backdrop${closing ? ' closing' : ''}`} onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section className="purchase-line-picker" role="dialog" aria-modal="true" aria-label="选择客户订单料品" ref={dialogRef} onKeyDown={onKeyDown}>
    <div className="purchase-line-picker-head"><h2>{groupByPo ? '关联客户 PO' : '选择客户订单料品'}</h2><div className="purchase-line-picker-actions"><Button secondary={!historyOnly} aria-pressed={historyOnly} title="只看已被采购关联过的历史料品，可补充采购（允许超出客户需求）" onClick={() => { setHistoryOnly(value => !value); setSelected([]); setPoIds([]); }}>历史订单</Button><Button secondary onClick={onClose}>取消</Button><Button onClick={() => onAdd([...new Set([...addedIds, ...selectedVisible])])}>确认选择（{selectedVisible.length}）</Button></div></div>
    <div className="purchase-line-picker-toolbar"><SearchSelect label="筛选客户" allowText value={customer} onChange={value => { setCustomer(value); setPoIds([]); }} options={customers}/><details className="picker-po-filter"><summary aria-label="筛选客户 PO">{poIds.length === 0 ? '全部客户 PO' : poIds.length === 1 ? (orders[poIds[0]]?.po || '已选 1 个客户 PO') : `已选 ${poIds.length} 个客户 PO`}</summary><div className="picker-po-filter-menu"><label className="check-label"><input type="checkbox" aria-label="全部客户 PO" checked={!poIds.length} onChange={() => setPoIds([])}/>全部客户 PO</label>{filteredOrders.map(order => <label key={order.id} className="check-label"><input type="checkbox" aria-label={`筛选 ${order.po}`} checked={poIds.includes(order.id)} onChange={() => togglePo(order.id)}/>{order.po} · {order.customer}</label>)}</div></details>
    {historyOnly && !groupByPo ? <p className="muted footnote purchase-line-picker-history-hint">历史订单：只显示已被采购关联过的客户料品，补充采购可超出客户原需求，成本仍计入原客户订单。</p> : null}
    <div className="purchase-line-picker-search"><input ref={searchRef} aria-label="搜索客户订单料品" placeholder="搜索客户 PO、客户、料品、规格、品牌" value={search} onChange={event => setSearch(event.target.value)}/><span>{visible.length} 项 · 已选 {selectedVisible.length}</span></div></div>
    {groupByPo ? <div className="po-picker-results"><Table minWidth={900} headers={[<input type="checkbox" aria-label="全选搜索结果" checked={allSelected} disabled={!selectable.length} onChange={toggleAll}/>, '客户 PO', '客户', '未开票料品', '含税金额', '操作']}>{visibleOrders.map(order => { const items=visible.filter(line=>line.order_id===order.id); const expanded=expandedOrders.includes(order.id); return <React.Fragment key={order.id}><tr><td><input type="checkbox" aria-label={`选择整个 PO ${order.po}`} checked={items.every(line=>added.has(line.id)||selected.includes(line.id))} disabled={items.every(line=>added.has(line.id))} onChange={()=>toggleOrder(order.id)}/></td><td>{order.po}</td><td>{order.customer}</td><td>{items.length} 项</td><td>{money(items.reduce((sum,line)=>sum+Math.round(line.quantity*line.price_cents),0))}</td><td><button type="button" className="text-button" onClick={()=>setExpandedOrders(ids=>expanded ? ids.filter(id=>id!==order.id) : [...ids,order.id])}>{expanded ? '收起' : '展开料品'}</button></td></tr>{expanded ? <tr><td colSpan={6}><Table headers={['选择','料品名称','规格型号','品牌','数量','含税金额']}>{items.map(line=><tr key={line.id}><td><input type="checkbox" aria-label={`选择料品：${order.po} · ${line.name} · ${line.id}`} checked={added.has(line.id)||selected.includes(line.id)} disabled={added.has(line.id)} onChange={()=>toggle(line.id)}/></td><td>{line.name}</td><td>{line.spec || '—'}</td><td>{line.brand || '—'}</td><td>{q(remainingQuantity(line))} {line.unit}</td><td>{money(Math.round(line.quantity*line.price_cents))}</td></tr>)}</Table></td></tr> : null}</React.Fragment>;})}</Table></div> : <>
    <Table minWidth={900} columnWidths={[0.6, 2.4, 1.8, 3, 1, 1.2, 1, 1]} headers={[<input type="checkbox" aria-label="全选搜索结果" checked={allSelected} disabled={!selectable.length} onChange={toggleAll}/>, 'PO单号', '料品名称', '规格型号', '品牌', '描述', '数量', '状态']}>{visible.map(line => <tr key={line.id}><td><input type="checkbox" aria-label={`选择料品：${orders[line.order_id].po} · ${line.name} · ${line.id}`} checked={added.has(line.id) || selected.includes(line.id)} disabled={added.has(line.id)} onChange={() => toggle(line.id)}/></td><td>{orders[line.order_id]?.po || '—'}</td><td>{line.name}</td><td>{line.spec || '—'}{exactIds.has(line.id) ? <small>备注匹配</small> : matchScores.has(line.id) ? <small>相似型号 · 请核对</small> : null}</td><td>{line.brand || '—'}</td><td title={line.description || ''}>{line.description || '—'}</td><td>{historyOnly ? <>{q(line.quantity)} {line.unit}<small>历史</small></> : <>{q(remainingQuantity(line))} {line.unit}</>}</td><td>{added.has(line.id) ? <Button secondary onClick={() => onDirectRemove?.([line.id])}>取消</Button> : <Button secondary onClick={() => { setSelected(ids => [...new Set([...ids, line.id])]); onDirectAdd([line.id]); }}>选择</Button>}</td></tr>)}</Table></>}

    {!visible.length ? <p className="muted purchase-line-picker-empty">{historyOnly ? '没有符合条件的历史料品' : '没有符合条件的料品'}</p> : null}
  </section></div>;
}


function PurchaseReturnForm({ purchaseId, data, run, busy, onDone }) {
  const lines = data.purchase_lines.filter(l => l.purchase_id === purchaseId && l.quantity - (l.pending_quantity || 0) > .000001);
  const [lineId, setLineId] = useState(lines[0]?.id || ''), [quantity, setQuantity] = useState(() => lines[0] ? Number((lines[0].quantity - (lines[0].pending_quantity || 0)).toFixed(6)) : ''), [reason, setReason] = useState('');
  const line = lines.find(l => l.id === Number(lineId));
  return <form onSubmit={e => { e.preventDefault(); run(async () => {
    await api(`/purchase-lines/${lineId}/cases`, { quantity, reason, kind: 'supplier_return', immediate: true });
    onDone();
  }, '退货已完成，关联数量已释放'); }}>
    <p className="notice">选择料品和数量，提交后立即完成退货并释放关联数量。原因选填。</p>
    <Field label="退货料品"><select required value={lineId} onChange={e => { const selected = lines.find(l => l.id === Number(e.target.value)); setLineId(selected.id); setQuantity(Number((selected.quantity - (selected.pending_quantity || 0)).toFixed(6))); }}>{lines.map(l => <option key={l.id} value={l.id}>{data.order_lines.find(o => o.id === l.order_line_id)?.name} · 可退 {q(l.quantity - (l.pending_quantity || 0))}</option>)}</select></Field>
    {!lines.length ? <p className="notice">暂无可办理数量，请先核对已有采购处理记录。</p> : null}
    <InputField label="退货数量 *" required type="number" min="1" step="1" max={line ? line.quantity - (line.pending_quantity || 0) : 0} value={quantity} onChange={e => setQuantity(e.target.value)}/>
    <InputField label="退货原因（选填）" value={reason} onChange={e => setReason(e.target.value)}/>
    <SaveBar busy={busy} disabled={!line} label="提交退货"/>
  </form>;
}







