import React, { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, RefreshCw } from 'lucide-react';
import { api, upload, money, q, indexById } from './api';
import Pagination, { usePagination } from './Pagination';
import { Panel, Table, FixedCell, Empty, Button, Badge, Modal, SearchBox, SaveBar, InputField, Field } from './components';
import { Trash } from './Lifecycle';
import Logistics from './Logistics';
import BillingInfo from './BillingInfo';
import Invoices from './Invoices';
import TaobaoSource from './TaobaoSource';
import SyncNow from './SyncNow';
import { suggestOrderLineIds, similarOrderLineScores } from './orderRemarkMatch';
import { orderDetailURL } from './orderLink';
import { invoiceStatus } from './invoiceStatus';
import { allocatePurchaseCosts } from './purchaseAllocation';
import { purchaseStatuses, purchaseStatusKeys } from './purchaseStatus';

export default function Purchases({ data, run, busy, refresh, desktopOrder, dismissDesktopOrder, user }) {
  const [tab, setTab] = useState(location.hash === '#logistics' ? 'logistics' : 'orders');
  const [clearDraftTrash, setClearDraftTrash] = useState(false);
  const [purchaseSort, setPurchaseSort] = useState({ key: 'created_at', descending: true });
  const [draftSearch, setDraftSearch] = useState('');
  const [draftSort, setDraftSort] = useState({ key: 'purchased_date', descending: true });
  const draftTerm = draftSearch.trim().toLowerCase();
  const drafts = (data.purchase_drafts || []).filter(item => (item.status || 'active') === (tab === 'draft-trash' ? 'trash' : 'active')).filter(item => `${item.platform_order} ${item.payload.shop || ''} ${(item.payload.products || []).map(product => product.name).join(' ')} ${item.payload.remark || ''}`.toLowerCase().includes(draftTerm)).sort((a, b) => {
    const difference = draftSort.key === 'amount' ? Number(a.payload.amount || 0) - Number(b.payload.amount || 0) : (a.payload.purchased_date || '').localeCompare(b.payload.purchased_date || '');
    return (draftSort.descending ? -difference : difference) || b.id - a.id;
  });
  const draftPagination = usePagination(drafts.length);
  const pageDrafts = drafts.slice(draftPagination.start, draftPagination.end);
  const sortDrafts = key => {
    setDraftSort(current => ({ key, descending: current.key === key ? !current.descending : true }));
    draftPagination.setPage(1);
  };
  const draftSortHeader = (key, label) => <button type="button" className="draft-sort-button" aria-label={`${label}排序`} onClick={() => sortDrafts(key)}>{label}<span className="sort-triangles" aria-hidden="true"><span className={draftSort.key === key && !draftSort.descending ? 'active' : ''}>▲</span><span className={draftSort.key === key && draftSort.descending ? 'active' : ''}>▼</span></span></button>;
  const [draftId, setDraftId] = useState(null);
  const [editingAssociations, setEditingAssociations] = useState(false);
  const draft = (data.purchase_drafts || []).find(item => item.id === draftId);
  const [search, setSearch] = useState(''), [platform, setPlatform] = useState(''), [modal, setModal] = useState(null);
  const [invoicePurchase, setInvoicePurchase] = useState(null), [invoiceFilter, setInvoiceFilter] = useState('');
  const [selectedPurchaseIds, setSelectedPurchaseIds] = useState([]);
  const [logisticsPurchase, setLogisticsPurchase] = useState(null);
  const [billingOpen, setBillingOpen] = useState(false), [returnPurchase, setReturnPurchase] = useState(null);
  const [pendingDeleteIds, setPendingDeleteIds] = useState([]);
  const [view, setView] = useState('active'), [statusFilter, setStatusFilter] = useState('');
  const canDelete = !!user;
  const invoice = data.purchases.find(p => p.id === invoicePurchase);
  const [focusPurchase, setFocusPurchase] = useState(null), [pendingPackage, setPendingPackage] = useState(null);
  const openExtracted = () => {
    const existing = data.purchases.find(p => p.platform === '淘宝' && p.platform_order === desktopOrder?.platform_order);
    setTab('orders'); setModal(existing?.id || 'new');
  };
  useEffect(() => { if (desktopOrder) openExtracted(); }, [desktopOrder?.id]);
  const orders = indexById(data.orders), ol = indexById(data.order_lines);
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
  const filtered = data.purchases.filter(p => (view === 'archived' ? !!p.archived_at : view === 'active' && !p.archived_at) && (!statusFilter || statusesByPurchase[p.id].includes(statusFilter)) && (!platform || p.platform === platform) && (!invoiceFilter || (invoiceFilter === 'missing' ? p.remaining_cents > 0 && p.invoice_stage !== '不需开票' : invoiceFilter === 'complete' ? p.remaining_cents === 0 && p.invoice_stage !== '不需开票' : p.invoice_stage === '不需开票')) && `${p.platform_order} ${p.shop} ${p.account} ${shipmentsFor(p).map(pkg => pkg.tracking).join(' ')} ${data.purchase_lines.filter(l => l.purchase_id === p.id).map(l => `${orders[ol[l.order_line_id].order_id].po} ${ol[l.order_line_id].name}`).join(' ')}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => (purchaseSort.descending ? -1 : 1) * (a[purchaseSort.key] || '').localeCompare(b[purchaseSort.key] || '') || b.id - a.id);
  const pagination = usePagination(filtered.length);
  const purchaseSortHeader = (key, label) => <button type="button" className="draft-sort-button" aria-label={`${label}排序`} onClick={() => { setPurchaseSort(current => ({ key, descending: current.key === key ? !current.descending : true })); pagination.setPage(1); setSelectedPurchaseIds([]); }}>{label}<span className="sort-triangles" aria-hidden="true"><span className={purchaseSort.key === key && !purchaseSort.descending ? 'active' : ''}>▲</span><span className={purchaseSort.key === key && purchaseSort.descending ? 'active' : ''}>▼</span></span></button>;
  const pagePurchases = filtered.slice(pagination.start, pagination.end);
  const allSelected = pagePurchases.length > 0 && pagePurchases.every(p => selectedPurchaseIds.includes(p.id));
  const toggleAll = () => setSelectedPurchaseIds(allSelected ? [] : pagePurchases.map(p => p.id));
  const togglePurchase = id => setSelectedPurchaseIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);
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
    {tab !== 'logistics' ? <div className="tabs"><button className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}>采购记录</button><button className={tab === 'drafts' ? 'active' : ''} onClick={() => setTab('drafts')}>平台订单</button><button className={tab === 'draft-trash' ? 'active' : ''} onClick={() => { setTab('draft-trash'); draftPagination.setPage(1); }}>回收站</button><SyncNow data={data} run={run} busy={busy}><>{data.purchase_draft_sync?.checked_at ? <span className="muted">最近采集：{data.purchase_draft_sync.checked_at.replace('T',' ').slice(0,19)} · {data.purchase_draft_sync.error || '已完成'}</span> : <span className="muted">尚未完成后台采集，请保持客户端运行并登录淘宝。</span>}</></SyncNow></div> : null}
    {['drafts','draft-trash'].includes(tab) ? <Panel className="purchase-drafts-list"><div className="toolbar"><SearchBox value={draftSearch} onChange={value => { setDraftSearch(value); draftPagination.setPage(1); }} placeholder="搜索店铺、订单号、商品名称或备注…"/><Button secondary disabled={busy} onClick={refresh}><RefreshCw size={16}/>刷新</Button>{tab === 'draft-trash' ? <Button secondary danger disabled={busy || !(data.purchase_drafts || []).some(item => item.status === 'trash')} onClick={() => setClearDraftTrash(true)}>清空回收站</Button> : null}</div><Table columnWidths={[2,2,1,1,2,2,1,4,2]} headers={['平台订单号','店铺',draftSortHeader('purchased_date', '采购日期'),draftSortHeader('amount', '实付款'),'商品','物流','交易状态','订单备注','操作']}>{pageDrafts.map(item => <tr key={item.id}><FixedCell>{item.platform_order}</FixedCell><FixedCell>{item.payload.shop || '待核对'}</FixedCell><FixedCell>{item.payload.purchased_date}</FixedCell><FixedCell>{item.payload.amount ? `¥${item.payload.amount}` : '待核对'}</FixedCell><FixedCell>{item.payload.products?.map(p => p.name).join('、') || '待核对'}</FixedCell><FixedCell>{item.payload.packages?.length ? item.payload.packages.map(p => `${p.carrier} ${p.tracking} ${p.status || ''}`).join('；') : '暂无运单'}</FixedCell><FixedCell><Badge>{item.payload.transaction_status || '待同步'}</Badge></FixedCell><td className="purchase-draft-note">{item.payload.remark || "—"}</td><FixedCell>{tab === 'draft-trash' ? <button className="text-button" disabled={busy || !['买家已付款','卖家已发货','交易成功'].includes(item.payload.transaction_status)} onClick={() => run(() => api('/purchase-drafts/restore', {id:item.id}), '草稿已恢复')}>恢复</button> : <><button className="text-button" onClick={() => setDraftId(item.id)}>登记</button><button className="text-button delete-action" disabled={busy} onClick={() => run(() => api('/purchase-drafts/delete', {id:item.id}), '草稿已移入回收站')}>删除</button></>}</FixedCell></tr>)}</Table><Pagination label="采购草稿" total={drafts.length} pagination={draftPagination} onPageChange={draftPagination.setPage} onPageSizeChange={draftPagination.setPageSize}/>{!drafts.length ? <Empty title={draftTerm ? "没有符合条件的采购草稿" : "暂无采购草稿"}>{draftTerm ? "请调整搜索内容。" : "已采集的草稿会自动显示在这里。"}</Empty> : null}</Panel> : null}
    {clearDraftTrash ? <Modal title="清空草稿回收站" onClose={() => setClearDraftTrash(false)}><p>清空后无法恢复，确定清空全部已删除的采购草稿吗？</p><Button danger disabled={busy} onClick={() => run(async () => { await api('/purchase-drafts/clear', {}); setClearDraftTrash(false); }, '草稿回收站已清空')}>确认清空</Button></Modal> : null}
    {draft ? <Modal wide title={`采购草稿 · ${draft.platform_order}`} onClose={() => setDraftId(null)}><PurchaseForm key={`draft-${draft.id}`} draftId={draft.id} source={draft.payload} data={data} run={run} busy={busy} onDone={() => { setDraftId(null); setModal(null); }}/></Modal> : null}
{desktopOrder ? <p className="notice">已提取淘宝订单 {desktopOrder.platform_order}，尚待核对。<button className="text-button" onClick={openExtracted}>核对提取结果</button> <button className="text-button" onClick={() => { dismissDesktopOrder(); setModal(null); }}>放弃提取结果</button></p> : null}{tab === 'logistics' ? <p><Button secondary onClick={() => { setFocusPurchase(null); setPendingPackage(null); setTab('orders'); }}>返回采购订单</Button></p> : null}
    {tab === 'orders' ? <><Panel className="purchases-list"><div className="toolbar"><SearchBox value={search} onChange={value => { setSearch(value); pagination.setPage(1); setSelectedPurchaseIds([]); }} placeholder="搜索店铺、平台订单号、客户 PO、快递单号…"/><select aria-label="平台筛选" value={platform} onChange={e => { setPlatform(e.target.value); pagination.setPage(1); setSelectedPurchaseIds([]); }}><option value="">全部平台</option>{['淘宝','京东','拼多多','闲鱼','阿里巴巴','嘉立创','对公','其他'].map(x => <option key={x}>{x}</option>)}</select><select aria-label="采购状态筛选" value={statusFilter} onChange={e => { setStatusFilter(e.target.value); pagination.setPage(1); setSelectedPurchaseIds([]); }}><option value="">全部采购状态</option>{Object.entries(purchaseStatuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><select aria-label="发票筛选" value={invoiceFilter} onChange={e => { setInvoiceFilter(e.target.value); pagination.setPage(1); setSelectedPurchaseIds([]); }}><option value="">全部收票状态</option><option value="missing">未收齐</option><option value="complete">已收齐</option><option value="exempt">不需开票</option></select>{selectedPurchaseIds.length ? <span className="muted">已选 {selectedPurchaseIds.length} 项</span> : null}<select aria-label="采购记录范围" value={view} onChange={e => { setView(e.target.value); pagination.setPage(1); setSelectedPurchaseIds([]); }}><option value="active">当前采购</option><option value="archived">已归档</option><option value="trash">回收站</option></select><div className="purchase-toolbar-actions"><Button secondary disabled={busy} onClick={refresh}><RefreshCw size={16}/>刷新</Button><Button secondary onClick={() => setBillingOpen(true)}>开票信息</Button>{canDelete && selectedPurchaseIds.length ? <Button secondary danger disabled={busy || selectedPurchaseIds.some(id => protectedPurchases.has(id))} title={selectedPurchaseIds.some(id => protectedPurchases.has(id)) ? '所选采购已有后续业务，请使用采购处理或归档' : '删除选中采购'} onClick={() => setPendingDeleteIds(selectedPurchaseIds)}>删除选中（{selectedPurchaseIds.length}）</Button> : null}<Button secondary disabled={busy || !selectedPurchaseIds.length || !window.caidanDesktop?.syncInvoices} title={window.caidanDesktop?.syncInvoices ? "下载所选采购的发票文件" : "自动获取需在采单客户端中完成，已下载文件可在网页查看、确认"} onClick={() => getInvoices(selectedPurchaseIds)}>{busy ? '正在获取…' : '获取所选发票'}</Button><Button onClick={() => setModal('new')}><Plus size={16}/>登记采购</Button></div></div>
    <Table minWidth={1320} headers={[<input type="checkbox" aria-label="全选当前页采购" checked={allSelected} disabled={!pagePurchases.length} onChange={toggleAll}/>, '平台 / 店铺','平台订单号','关联客户 PO','实付款','采购状态','物流',purchaseSortHeader('purchased_date', '采购日期'),purchaseSortHeader('created_at', '登记日期'),'开票状态','发票文件','收票情况','操作']}>{pagePurchases.map(p => { const packages = shipmentsFor(p), orderURL = orderDetailURL(p); return <tr key={p.id}><FixedCell><input type="checkbox" aria-label={`选择采购订单：${p.platform_order}`} checked={selectedPurchaseIds.includes(p.id)} onChange={() => togglePurchase(p.id)}/></FixedCell><FixedCell title={`${p.shop} · ${p.account || '默认采购账号'}${p.open_cases ? ` · ${p.open_cases} 项采购处理待办` : ''}`}><strong className="purchase-shop-name">{p.shop}</strong><small className={p.open_cases ? 'text-orange' : ''}>{p.open_cases ? `${p.open_cases} 项采购处理待办` : `${p.platform} · ${p.account || '默认采购账号'}`}</small></FixedCell><FixedCell className="mono">{orderURL ? <a href={orderURL} target="_blank" rel="noreferrer" title="打开淘宝订单详情">{p.platform_order}</a> : p.platform_order}</FixedCell><FixedCell>{[...new Set(data.purchase_lines.filter(l => l.purchase_id === p.id).map(l => ol[l.order_line_id].order_id))].map((id, i) => <React.Fragment key={id}>{i ? '、' : null}<a href={`#orders?order=${id}`}>{orders[id].po}</a></React.Fragment>)}</FixedCell><FixedCell>{money(p.amount_cents)}</FixedCell><FixedCell title={statusesByPurchase[p.id].map(key => purchaseStatuses[key]).join('、')}>{statusesByPurchase[p.id].map(key => <Badge key={key} tone={['returning', 'returned', 'partial_returned', 'cancelling'].includes(key) ? 'orange' : undefined}>{purchaseStatuses[key]}</Badge>)}</FixedCell><FixedCell title={packages.map(pkg => `${pkg.carrier || '快递公司待补充'} · ${pkg.tracking}`).join('\n')}>{packages.length ? packages.map(pkg => <button type="button" key={pkg.tracking} className="text-button purchase-logistics-link" onClick={() => setLogisticsPurchase(p.id)}><span className="mono">{pkg.carrier || '快递公司待补充'} · {pkg.tracking}</span><small className={`logistics-state ${/异常|拒收|退回|失败/.test(pkg.status || '') ? 'red' : /签收/.test(pkg.status || '') ? 'green' : pkg.status ? 'orange' : 'gray'}`}>{pkg.status || '状态未获取'}</small></button>) : <small>暂无物流信息</small>}</FixedCell><FixedCell title={p.purchased_date?.slice(0, 10)}>{p.purchased_date?.slice(0, 10) || '—'}</FixedCell><FixedCell title={p.created_at?.replace('T', ' ')}>{p.created_at?.slice(0, 10) || '—'}</FixedCell><PurchaseInvoiceCells purchase={p} data={data} onOpen={() => setInvoicePurchase(p.id)}/><FixedCell><div className="order-actions"><button className="text-button" onClick={() => { setEditingAssociations(false); setModal(p.id); }}>查看明细</button><button className="text-button" disabled={busy || !!p.archived_at} onClick={() => setReturnPurchase(p.id)}>退货</button>{(data.purchase_cases || []).some(c => c.kind === 'supplier_return' && c.status !== 'void' && data.purchase_lines.some(l => l.id === c.purchase_line_id && l.purchase_id === p.id)) ? <button className="text-button" disabled={busy} onClick={() => run(() => api(`/purchases/${p.id}/restore-return`, {}), '采购已恢复')}>恢复</button> : null}{canDelete ? <button className="text-button delete-action" disabled={busy || protectedPurchases.has(p.id)} title={protectedPurchases.has(p.id) ? '已有后续业务，请使用采购处理或归档' : '删除采购记录'} onClick={() => setPendingDeleteIds([p.id])}>删除</button> : null}</div></FixedCell></tr>; })}</Table>{view !== 'trash' ? <Pagination label="采购记录" total={filtered.length} pagination={pagination} onPageChange={page => { pagination.setPage(page); setSelectedPurchaseIds([]); }} onPageSizeChange={size => { pagination.setPageSize(size); setSelectedPurchaseIds([]); }}/> : null}{view !== 'trash' && !filtered.length ? <Empty title="暂无采购记录">先确认客户报价，再将平台采购关联到料品。</Empty> : null}</Panel>
    {view === 'trash' ? <Trash data={data} table="purchases" run={run} busy={busy} user={user}/> : null}
    {returnPurchase ? <Modal title="登记采购退货" onClose={() => setReturnPurchase(null)}><PurchaseReturnForm purchaseId={returnPurchase} user={user} data={data} run={run} busy={busy} onDone={() => { setModal(returnPurchase); setReturnPurchase(null); }}/></Modal> : null}
    {billingOpen ? <Modal title="开票信息" onClose={() => setBillingOpen(false)}><BillingInfo user={user} company={data.company} run={run} busy={busy}/></Modal> : null}
    {logisticsPurchase ? <Modal title="采购物流详情" onClose={() => setLogisticsPurchase(null)}>{(() => { const purchase = data.purchases.find(p => p.id === logisticsPurchase); if (!purchase) return null; return <><p className="muted">平台订单号：{purchase.platform_order}</p>{purchase.taobao_source?.sync_checked_at ? <p className="notice">最近检查：{purchase.taobao_source.sync_checked_at.replace('T', ' ').slice(0, 19)} · {purchase.taobao_source.sync_error || '已检查'}</p> : null}{shipmentsFor(purchase).map(pkg => { const events = [...(pkg.events || []), ...data.tracking_events.filter(e => e.package_id === pkg.id)].filter((event, index, all) => all.findIndex(e => e.occurred_at === event.occurred_at && e.description === event.description) === index).sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)); return <section key={pkg.tracking}><h3>{pkg.carrier || '快递公司待补充'} · {pkg.tracking}</h3><Badge>{pkg.status || '状态未获取'}</Badge>{events.length ? <div className="timeline">{events.map((event, index) => <div key={index}><p>{event.description}</p><small>{event.occurred_at.replace('T', ' ').slice(0, 19)}</small></div>)}</div> : null}</section>; })}</>; })()}</Modal> : null}
    {modal === 'new' ? <Modal wide title="登记平台采购" onClose={() => setModal(null)}><PurchaseForm key={desktopOrder?.id || "manual"} source={desktopOrder} data={data} run={run} busy={busy} onDone={(id, shipment) => { if (desktopOrder) { dismissDesktopOrder(); setModal(null); return; } setModal(null); if (shipment.tracking || shipment.carrier) { setFocusPurchase(id); setPendingPackage(shipment); setTab('logistics'); } }}/></Modal> : null}
    {current ? <Modal wide title={`${current.platform} · ${current.platform_order}`} onClose={() => { setModal(null); setEditingAssociations(false); }}>{editingAssociations ? <PurchaseForm data={data} run={run} busy={busy} purchase={current} source={current.taobao_source} onDone={() => { setEditingAssociations(false); setModal(null); }} onCancel={() => setEditingAssociations(false)}/> : <div className="purchase-detail-content">{desktopOrder?.platform_order === current.platform_order ? <><p className="notice">该订单已登记，核对后可补充商品参考和物流信息；采购金额不会被改写。</p><TaobaoSource source={desktopOrder} data={data}/><Button disabled={busy} onClick={() => run(async () => { await api(`/purchases/${current.id}/taobao`, desktopOrder); dismissDesktopOrder(); }, '淘宝物流信息已补充')}>确认补充提取信息</Button></> : null}<TaobaoSource source={current.taobao_source} purchaseSummary={{ shop: current.shop, amount: money(current.amount_cents), count: shipmentsFor(current).length }}/><section className="purchase-order-note"><div className="purchase-association-heading"><h3>关联客户料品</h3><Button secondary disabled={busy || !!current.archived_at} onClick={() => setEditingAssociations(true)}>调整关联物料</Button></div>{data.purchase_lines.filter(line => line.purchase_id === current.id).map(line => <p key={line.id}>{orders[ol[line.order_line_id].order_id].po} · {ol[line.order_line_id].name} · {ol[line.order_line_id].spec || '—'} · 数量 {q(line.quantity)}</p>)}</section><section className="purchase-order-note" aria-label="订单备注"><h3>订单备注</h3><p>{current.note || '暂无备注'}</p></section><PurchaseAttachments items={(current.attachments || (current.source_id ? [{ attachment_id: current.source_id, name: data.attachments.find(file => file.id === current.source_id)?.name || '采购附件' }] : [])).map(file => ({ id: file.attachment_id, name: file.name }))} busy={busy} onAdd={file => run(() => api(`/purchases/${current.id}/attachments`, { attachment_ids: [file.id] }), '采购附件已添加')} onRemove={id => run(() => api(`/purchases/${current.id}/attachments/remove`, { attachment_id: id }), '采购附件已移除')}/></div>}</Modal> : null}</> : tab === 'logistics' ? <Logistics data={data} run={run} busy={busy} purchaseId={focusPurchase} onClearPurchase={() => setFocusPurchase(null)} initialPackage={pendingPackage} onClearInitialPackage={() => setPendingPackage(null)}/> : null}
    {pendingDeleteIds.length ? <Modal title={`删除 ${pendingDeleteIds.length} 条采购记录`} onClose={() => setPendingDeleteIds([])}><p>确定删除以下采购记录吗？</p><ul className="delete-order-list">{pendingDeleteIds.slice(0, 6).map(id => { const purchase = data.purchases.find(item => item.id === id); return <li key={id}>{purchase?.platform} · {purchase?.platform_order}</li>; })}{pendingDeleteIds.length > 6 ? <li>另有 {pendingDeleteIds.length - 6} 条</li> : null}</ul><p className="muted">仅适用于录错、重复录入且没有包裹、送货、收票或后续处理的记录。删除后移入回收站并释放采购占用，管理员可恢复；已有后续业务请办理采购处理或归档。</p><div className="save-bar"><Button secondary onClick={() => setPendingDeleteIds([])}>取消</Button><Button secondary danger disabled={busy} onClick={confirmDelete}>确认删除</Button></div></Modal> : null}
    {invoice ? <Modal wide title={`采购发票 · ${invoice.platform_order}`} onClose={() => setInvoicePurchase(null)}><Invoices key={invoice.id} purchase={invoice} data={data} run={run} busy={busy} onSyncPlatform={() => getInvoices([invoice.id])}/></Modal> : null}
  </>;
}

function PurchaseInvoiceCells({ purchase: p, data, onOpen }) {
  const status = invoiceStatus(p);
  const invoiceIds = new Set(data.invoice_allocations.filter(a => a.purchase_id === p.id).map(a => a.invoice_id));
  const registered = data.invoices.filter(invoice => invoiceIds.has(invoice.id));
  const byNumber = new Map(registered.map(invoice => [invoice.number, invoice]));
  const details = p.taobao_source?.invoice_details || [];
  const files = [...new Set([...details, ...registered].map(item => item.attachment_id).filter(Boolean))];
  const missingFiles = details.some(item => !item.attachment_id && !byNumber.get(item.number)?.attachment_id);
  const awaitingConfirmation = details.some(item => item.attachment_id && !byNumber.has(item.number));
  const receipt = awaitingConfirmation ? '待确认' : p.invoice_stage === '不需开票' ? '不需开票' : registered.length && p.receipt_status === '已收齐' ? '已确认' : p.receipt_status;
  return <>
    <FixedCell className="purchase-invoice-status"><Badge tone={status.tone === 'gray' && p.invoice_stage !== '不需开票' ? 'orange' : status.tone}>{status.label}</Badge></FixedCell>
    <FixedCell className="purchase-invoice-files">{files.length ? <><Badge tone={missingFiles ? 'orange' : 'green'}>{missingFiles ? '部分获取' : '已获取'}</Badge><small>{files.length === 1 ? <a href={`/api/files/${files[0]}`} target="_blank" rel="noreferrer">查看文件</a> : <button className="text-button" onClick={onOpen}>查看文件（{files.length}）</button>}</small></> : <Badge tone={p.invoice_stage === '不需开票' ? 'gray' : 'orange'}>{p.invoice_stage === '不需开票' ? '—' : status.label.startsWith('未开票') ? '待开票' : '未获取'}</Badge>}</FixedCell>
    <FixedCell className="purchase-invoice-receipt"><div className="purchase-receipt-actions"><Badge tone={receipt === '不需开票' ? 'gray' : ['已确认', '已收齐'].includes(receipt) ? 'green' : 'orange'}>{receipt}</Badge><button className="text-button" onClick={onOpen}>查看 / 确认</button></div><small className="purchase-invoice-amounts">已收 {money(p.received_cents)} / 待收 {money(p.remaining_cents)}</small></FixedCell>
  </>;
}

function PurchaseForm({ data, run, busy, onDone, onCancel, source, draftId, purchase }) {
  const orders = indexById(data.orders);
  const existingLines = purchase ? data.purchase_lines.filter(line => line.purchase_id === purchase.id) : [];
  const available = data.order_lines.map(line => ({ ...line, purchased: line.purchased - (existingLines.find(item => item.order_line_id === line.id)?.quantity || 0) })).filter(l => existingLines.some(item => item.order_line_id === l.id) || orders[l.order_id].status === 'confirmed' && !orders[l.order_id].archived_at && l.demand_quantity > l.purchased + .000001);
  const suggestedIds = source && !purchase ? suggestOrderLineIds(source.remark, available, orders) : [];
  const itemFor = line => ({ order_line_id: line.id, quantity: Number((line.demand_quantity - line.purchased).toFixed(6)), purchase_quantity: Number((line.demand_quantity - line.purchased).toFixed(6)), purchase_unit: line.unit, purchase_spec: line.spec, cost: '', link: '' });
  const [form, setForm] = useState({ platform: '淘宝', account: '', shop: '', platform_order: '', amount: '', purchased_date: data.today, promised_date: '', note: '', ...(source ? { platform: '淘宝', shop: source.shop, platform_order: source.platform_order, amount: source.amount, purchased_date: source.purchased_date, account:source.account || '', promised_date:source.promised_date || '', note: source.remark || '' } : {}), ...(purchase ? { amount: (purchase.amount_cents / 100).toFixed(2) } : {}) });
  const [attachments, setAttachments] = useState(() => (source?.attachment_ids || []).map(id=>data.attachments.find(file=>file.id===id)).filter(Boolean)), [uploading, setUploading] = useState(false);
  const [items, setItems] = useState(() => purchase ? existingLines.map(line => ({ ...line, cost: (line.cost_cents / 100).toFixed(2) })) : []), [pickerOpen, setPickerOpen] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const addMany = ids => setItems(current => {
    const selected = new Set(ids), existing = new Set(current.map(item => item.order_line_id));
    return [...current, ...available.filter(line => selected.has(line.id) && !existing.has(line.id)).map(itemFor)];
  });
  const change = (id, k, v) => setItems(xs => xs.map(x => x.order_line_id === id ? { ...x, [k]: v } : x));
  const allocatedItems = allocatePurchaseCosts(items, [], {}, form.amount, available);

  const draftButton = source && !purchase ? <Button secondary disabled={busy || uploading} onClick={() => run(async () => { const result = await api('/purchase-drafts/manual', { ...source, shop:form.shop, amount:form.amount, purchased_date:form.purchased_date, remark:form.note, account:form.account, promised_date:form.promised_date, attachment_ids:attachments.map(file=>file.id) }); if (result.skipped) throw new Error(result.purchase_id ? '该订单已登记采购，请查看现有记录' : '草稿已在回收站，请先恢复'); onDone(null, {}); }, '已保存为采购草稿，可稍后关联料品')}>保存为草稿</Button> : null;
  if (!available.length) return <><TaobaoSource source={source} data={data}/>{draftButton}<Empty title="没有可采购的料品">请先创建客户订单并确认报价，或检查需求是否已采购齐。提取结果会保留，可稍后返回核对。</Empty></>;
  return <form className="purchase-registration-form" onSubmit={e => { e.preventDefault(); if (uploading) return; run(async () => { const result = purchase ? await api(`/purchases/${purchase.id}/associations`, { lines: allocatedItems, association_mode: 'order' }) : await api('/purchases', { ...form, purchase_draft_id:draftId, attachment_ids: attachments.map(file => file.id), lines: allocatedItems, taobao_source: source ? { ...source, products: source.products?.map(product => ({ ...product, order_line_ids: [] })) } : undefined }); onDone(result.id, { carrier: form.carrier || '', tracking: form.tracking || '' }); }, purchase ? '关联客户料品已更新' : '采购已保存'); }}>
    <div className="save-bar"><Button className="purchase-link-items" disabled={busy} onClick={() => setPickerOpen(true)}>关联料品</Button>{draftButton}{purchase ? <Button secondary disabled={busy} onClick={onCancel}>取消调整</Button> : null}<Button type="submit" disabled={busy || !items.length || uploading}>{purchase ? "保存关联" : "保存采购记录"}</Button></div>
    <TaobaoSource source={source}/>{suggestedIds.length ? <p className="notice">已根据订单备注默认选择对应客户料品，请核对 PO、型号和数量。</p> : null}
    {!purchase ? <div className="form-grid purchase-info-grid"><Field label="采购平台 *"><select disabled={!!source} value={form.platform} onChange={e => set('platform', e.target.value)}>{['淘宝','京东','拼多多','闲鱼','阿里巴巴','嘉立创','对公','其他'].map(x => <option key={x}>{x}</option>)}</select></Field><InputField label="采购账号标识" value={form.account} onChange={e => set('account', e.target.value)} placeholder="如：公司采购号"/>
      <InputField label="店铺名称（公司名称）*" required value={form.shop} onChange={e => set('shop', e.target.value)}/><InputField label="平台订单号 *" readOnly={!!source} required value={form.platform_order} onChange={e => set('platform_order', e.target.value)}/>
      <InputField label="实付款（含运费、已扣优惠）*" type="number" min="0" step=".01" required value={form.amount} onChange={e => set('amount', e.target.value)}/><InputField label="采购日期 *" type="date" required value={form.purchased_date} onChange={e => set('purchased_date', e.target.value)}/>
      {!source ? <><InputField label="快递公司（可选）" value={form.carrier || ''} onChange={e => set('carrier', e.target.value)}/><InputField label="运单号（可选）" value={form.tracking || ''} onChange={e => set('tracking', e.target.value)}/></> : null}
      <InputField label="店铺承诺发货日期" type="date" value={form.promised_date} onChange={e => set('promised_date', e.target.value)}/><InputField label="备注" value={form.note} onChange={e => set('note', e.target.value)}/>
      <PurchaseAttachments items={attachments} busy={busy} onBusyChange={setUploading} onAdd={file => setAttachments(current => current.some(item => item.id === file.id) ? current : [...current, file])} onRemove={id => setAttachments(current => current.filter(file => file.id !== id))}/>
    </div> : null}<div className="field"><span>整单关联客户料品</span><button type="button" className="purchase-line-trigger" disabled={busy} onClick={() => setPickerOpen(true)}>选择客户订单中的待采购料品…{items.length ? `（已加入 ${items.length} 项）` : ''}</button></div>
    {pickerOpen ? <PurchaseLinePicker available={available} orders={orders} initialIds={[...new Set([...items.map(item => item.order_line_id), ...suggestedIds])]} addedIds={items.map(item => item.order_line_id)} onDirectAdd={addMany} remark={form.note} onClose={() => setPickerOpen(false)} onAdd={ids => { setItems(current => current.filter(item => ids.includes(item.order_line_id))); addMany(ids); setPickerOpen(false); }}/> : null}
    <Table headers={['客户料品','收货地址','对应需求数量','实际包装数量','采购单位','采购规格','自动分摊金额','']} minWidth={900}>{allocatedItems.map(x => { const l = available.find(l => l.id === x.order_line_id); return <tr key={x.order_line_id}><td><strong>{l.name}</strong><small>{orders[l.order_id].po}</small></td><td title={orders[l.order_id].address}>{orders[l.order_id].address || '—'}</td>{[['quantity','对应需求数量'],['purchase_quantity','实际包装数量']].map(([k,label]) => <td key={k}><input aria-label={`${l.name}${label}`} className="small-input" type="number" min=".000001" step=".000001" required value={x[k]} onChange={e => change(l.id, k, e.target.value)}/></td>)}<td><input aria-label={`${l.name}采购单位`} className="small-input" required value={x.purchase_unit} onChange={e => change(l.id, 'purchase_unit', e.target.value)}/></td><td><input aria-label={`${l.name}采购规格`} value={x.purchase_spec} onChange={e => change(l.id, 'purchase_spec', e.target.value)}/></td><td><span aria-label={`${l.name}自动分摊金额`}>{money(Math.round(Number(x.cost) * 100))}</span></td><td><button type="button" className="icon-button" aria-label={`移除${l.name}`} onClick={() => { setItems(xs => xs.filter(i => i.order_line_id !== l.id)); }}><Trash2 size={16}/></button></td></tr>; })}</Table>
    <p className="notice">自动分摊合计 {money(allocatedItems.reduce((a, x) => a + Math.round(Number(x.cost || 0) * 100), 0))} / 实付款 {money(Math.round(Number(form.amount || 0) * 100))}。整张采购订单关联所选料品，实付款按报价单价 × 对应需求数量分摊；报价均为零时平均分摊。</p>
  </form>;
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

export function PurchaseLinePicker({ available, orders, addedIds, onClose, onAdd, onDirectAdd, remark, initialIds = [], remainingQuantity = line => line.demand_quantity - line.purchased, groupByPo = false }) {
  const [search, setSearch] = useState(''), [selected, setSelected] = useState(initialIds);
  const [customer, setCustomer] = useState(''), [orderId, setOrderId] = useState('');
  const availableOrders = [...new Set(available.map(line => line.order_id))].map(id => orders[id]);
  const customers = [...new Set(availableOrders.map(order => order.customer))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const filteredOrders = availableOrders.filter(order => !customer || order.customer === customer);
  const searchRef = useRef(null), dialogRef = useRef(null);
  useEffect(() => { searchRef.current?.focus(); }, []);
  const added = new Set(addedIds), term = search.trim().toLowerCase();
  const matchScores = similarOrderLineScores(remark, available);
  const exactIds = new Set(suggestOrderLineIds(remark, available, orders, orderId || null));
  const visible = available.filter(line => {
    const order = orders[line.order_id];
    return (!customer || order.customer === customer) && (!orderId || order.id === Number(orderId)) && `${order.po} ${order.customer} ${line.name} ${line.spec} ${line.brand} ${line.description}`.toLowerCase().includes(term);
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
  const onKeyDown = event => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    if (event.key !== 'Tab') return;
    event.stopPropagation();
    const controls = [...dialogRef.current.querySelectorAll('button,input,select')].filter(el => !el.disabled);
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
    if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
  };
  return <div className="purchase-line-picker-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section className="purchase-line-picker" role="dialog" aria-modal="true" aria-label="选择客户订单料品" ref={dialogRef} onKeyDown={onKeyDown}>
    <div className="purchase-line-picker-head"><h2>{groupByPo ? '关联客户 PO' : '选择客户订单料品'}</h2><button type="button" className="text-button" onClick={onClose}>关闭</button></div><div className="purchase-line-picker-actions"><Button secondary onClick={onClose}>取消</Button><Button onClick={() => onAdd([...new Set([...addedIds, ...selectedVisible])])}>确认选择（{selectedVisible.length}）</Button></div>
    <div className="purchase-line-picker-filters"><select aria-label="筛选客户" value={customer} onChange={event => { setCustomer(event.target.value); setOrderId(''); }}><option value="">全部客户</option>{customers.map(name => <option key={name} value={name}>{name}</option>)}</select><select aria-label="筛选客户 PO" value={orderId} onChange={event => { const id = event.target.value; setOrderId(id); if (id) { const matches = suggestOrderLineIds(remark, available, orders, id); setSelected(ids => [...new Set([...ids, ...matches]) ]); } }}><option value="">全部客户 PO</option>{filteredOrders.map(order => <option key={order.id} value={order.id}>{order.po} · {order.customer}</option>)}</select></div>
    <div className="purchase-line-picker-search"><input ref={searchRef} aria-label="搜索客户订单料品" placeholder="搜索客户 PO、客户、料品、规格、品牌或描述" value={search} onChange={event => setSearch(event.target.value)}/><span>{visible.length} 项结果 · 已选 {selectedVisible.length} 项</span></div>
    {groupByPo ? <div className="po-picker-results"><Table minWidth={900} headers={[<input type="checkbox" aria-label="全选搜索结果" checked={allSelected} disabled={!selectable.length} onChange={toggleAll}/>, '客户 PO', '客户', '未开票料品', '含税金额', '操作']}>{visibleOrders.map(order => { const items=visible.filter(line=>line.order_id===order.id); const expanded=expandedOrders.includes(order.id); return <React.Fragment key={order.id}><tr><td><input type="checkbox" aria-label={`选择整个 PO ${order.po}`} checked={items.every(line=>added.has(line.id)||selected.includes(line.id))} disabled={items.every(line=>added.has(line.id))} onChange={()=>toggleOrder(order.id)}/></td><td>{order.po}</td><td>{order.customer}</td><td>{items.length} 项</td><td>{money(items.reduce((sum,line)=>sum+Math.round(line.quantity*line.price_cents),0))}</td><td><button type="button" className="text-button" onClick={()=>setExpandedOrders(ids=>expanded ? ids.filter(id=>id!==order.id) : [...ids,order.id])}>{expanded ? '收起' : '展开料品'}</button></td></tr>{expanded ? <tr><td colSpan={6}><Table headers={['选择','料品名称','规格型号','品牌','数量','含税金额']}>{items.map(line=><tr key={line.id}><td><input type="checkbox" aria-label={`选择料品：${order.po} · ${line.name} · ${line.id}`} checked={added.has(line.id)||selected.includes(line.id)} disabled={added.has(line.id)} onChange={()=>toggle(line.id)}/></td><td>{line.name}</td><td>{line.spec || '—'}</td><td>{line.brand || '—'}</td><td>{q(remainingQuantity(line))} {line.unit}</td><td>{money(Math.round(line.quantity*line.price_cents))}</td></tr>)}</Table></td></tr> : null}</React.Fragment>;})}</Table></div> : <>
    <Table minWidth={900} headers={[<input type="checkbox" aria-label="全选搜索结果" checked={allSelected} disabled={!selectable.length} onChange={toggleAll}/>, '客户 PO / 客户', '料品名称', '规格型号', '品牌', '描述', '剩余数量', '状态']}>{visible.map(line => <tr key={line.id}><td><input type="checkbox" aria-label={`选择料品：${orders[line.order_id].po} · ${line.name} · ${line.id}`} checked={added.has(line.id) || selected.includes(line.id)} disabled={added.has(line.id)} onChange={() => toggle(line.id)}/></td><td>{orders[line.order_id].po}<small>{orders[line.order_id].customer}</small></td><td>{line.name}</td><td>{line.spec || '—'}{exactIds.has(line.id) ? <small>备注匹配</small> : matchScores.has(line.id) ? <small>相似型号 · 请核对</small> : null}</td><td>{line.brand || '—'}</td><td title={line.description || ''}>{line.description || '—'}</td><td>{q(remainingQuantity(line))} {line.unit}</td><td>{added.has(line.id) ? '已加入' : <Button secondary onClick={() => { setSelected(ids => [...new Set([...ids, line.id])]); onDirectAdd([line.id]); }}>选择</Button>}</td></tr>)}</Table></>}

    {!visible.length ? <p className="muted purchase-line-picker-empty">没有符合条件的料品</p> : null}
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







