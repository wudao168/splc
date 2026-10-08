import React, { useState } from 'react';
import { Plus, RefreshCw, PackagePlus, PackageMinus } from 'lucide-react';
import { api, money, q } from './api';
import { Panel, Table, FixedCell, Empty, Button, Badge, Modal, SearchBox, SaveBar, InputField, Field } from './components';
import { ItemForm, itemLabel } from './Items';
import { matchItem } from './StockLookup';

const TABS = [['overview', '库存总览'], ['items', '料品档案'], ['receipts', '入库单'], ['outbounds', '出库单'], ['entries', '库存流水']];
const defaultWarehouse = data => String((data.warehouses || [])[0]?.id || '');
const activeWarehouses = data => (data.warehouses || []).filter(x => x.active !== 0);
const openQuantity = line => Math.max(0, Number(line.quantity || 0) - Number(line.pending_quantity || 0));
const warehouseName = (data, id) => (data.warehouses || []).find(x => x.id === Number(id))?.name || '—';
export default function Inventory({ data, run, busy, refresh, user, navigate }) {
  const [tab, setTab] = useState('overview');
  const [search, setSearch] = useState('');
  const [itemModal, setItemModal] = useState(null);
  const [adjustItem, setAdjustItem] = useState(null);
  const [receiptKey, setReceiptKey] = useState(0);
  const [outboundKey, setOutboundKey] = useState(0);
  const [warehouseModal, setWarehouseModal] = useState(null);
  const term = search.trim().toLowerCase();
  const items = (data.items || []).filter(item => !term || [item.code, item.name, item.spec, item.brand, item.customer_code, item.supplier_code].filter(Boolean).join(' ').toLowerCase().includes(term));
  const totals = data.inventory_totals || {};
  const receipts = (data.stock_receipts || []).filter(x => !term || `${x.number} ${x.supplier}`.toLowerCase().includes(term));
  const outbounds = (data.stock_outbounds || []).filter(x => !term || `${x.number} ${x.customer} ${x.tracking}`.toLowerCase().includes(term));
  const entries = (data.stock_entries || []).filter(x => !term || `${x.source} ${x.kind} ${x.note}`.toLowerCase().includes(term));
  const itemOf = id => (data.items || []).find(x => x.id === id);
  const receiptQuantity = receipt => (data.stock_receipt_lines || []).filter(x => x.receipt_id === receipt.id).reduce((sum, x) => sum + x.quantity, 0);
  const receiptValue = receipt => (data.stock_receipt_lines || []).filter(x => x.receipt_id === receipt.id).reduce((sum, x) => sum + x.value_cents, 0);
  const outboundQuantity = outbound => (data.stock_outbound_lines || []).filter(x => x.outbound_id === outbound.id).reduce((sum, x) => sum + x.quantity, 0);
  const outboundValue = outbound => (data.stock_outbound_lines || []).filter(x => x.outbound_id === outbound.id).reduce((sum, x) => sum + x.value_cents, 0);
  return <div className="inventory-page">
    <div className="tabs">{TABS.map(([key, label]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => { setTab(key); setSearch(''); }}>{label}</button>)}</div>
    {tab === 'overview' ? <Panel>
      <div className="toolbar"><SearchBox value={search} onChange={setSearch} placeholder="搜索料品编号、名称、型号或品牌…"/><div className="toolbar-actions"><Button secondary disabled={busy} onClick={refresh}><RefreshCw size={16}/>刷新</Button><Button secondary onClick={() => setWarehouseModal({ name: '', location: '', note: '' })}>仓库</Button><Button onClick={() => setItemModal({})}><Plus size={16}/>新增料品</Button></div></div>
      <div className="invoice-summary inventory-summary"><div><small>料品数</small><strong>{totals.items || 0}</strong></div><div><small>现存量</small><strong>{q(totals.on_hand || 0)}</strong></div><div><small>已占用</small><strong>{q(totals.reserved || 0)}</strong></div><div><small>可用库存</small><strong>{q(totals.available || 0)}</strong></div><div><small>公共在途</small><strong>{q(totals.incoming || 0)}</strong></div><div><small>库存金额</small><strong>{money(totals.value_cents || 0)}</strong></div></div>
      <Table minWidth={1220} headers={['料品编号','料品名称','标准型号','品牌','单位','现存量','已占用','可用库存','公共在途','加权成本','库存金额','操作']}>{items.map(item => <tr key={item.id}>
        <FixedCell className="mono">{item.code}</FixedCell>
        <FixedCell title={item.name}><strong>{item.name}</strong></FixedCell>
        <FixedCell title={item.key_specs ? `${item.spec || '规格未填写'} · 关键规格：${item.key_specs}` : (item.spec || '规格未填写')}>{item.spec || '—'}</FixedCell>
        <FixedCell title={item.brand || '—'}>{item.brand || '—'}</FixedCell>
        <FixedCell>{item.unit}</FixedCell>
        <FixedCell>{q(item.on_hand)}</FixedCell>
        <FixedCell>{q(item.reserved)}</FixedCell>
        <FixedCell className={item.available > 0 ? 'purchase-complete' : undefined}>{q(item.available)}</FixedCell>
        <FixedCell>{q(item.incoming_unallocated)}</FixedCell>
        <FixedCell>{money(item.avg_cost_cents)}</FixedCell>
        <FixedCell>{money(item.value_cents)}</FixedCell>
        <FixedCell><div className="order-actions"><button className="text-button" onClick={() => setItemModal(item)}>维护</button><button className="text-button" onClick={() => setAdjustItem({ item_id: item.id, warehouse_id: defaultWarehouse(data), direction: 'gain', quantity: '', amount: '', reason: '' })}>盘点</button></div></FixedCell>
      </tr>)}</Table>
      {!items.length ? <Empty title="还没有料品档案">新增订单或采购时会按型号自动建立料品档案，也可以在这里先维护。</Empty> : null}
      <p className="muted footnote">现存量＝已入库未出库数量；可用库存＝现存量−已被订单占用数量；公共在途＝尚未分配给具体订单的入库采购数量。直发客户的采购不计入库存。</p>
    </Panel> : null}
    {tab === 'items' ? <Panel>
      <div className="toolbar"><SearchBox value={search} onChange={setSearch} placeholder="搜索料品编号、名称、标准型号、客户型号…"/><Button onClick={() => setItemModal({})}><Plus size={16}/>新增料品</Button></div>
      <Table minWidth={1160} headers={['料品编号','名称','标准型号','品牌','关键规格','单位','采购单位','换算','客户型号','供应商型号','库存','操作']}>{items.map(item => <tr key={item.id}>
        <FixedCell className="mono">{item.code}</FixedCell>
        <FixedCell title={item.name}>{item.name}</FixedCell>
        <FixedCell title={item.spec || '—'}>{item.spec || '—'}</FixedCell>
        <FixedCell>{item.brand || '—'}</FixedCell>
        <FixedCell title={item.key_specs || '—'}>{item.key_specs || '—'}</FixedCell>
        <FixedCell>{item.unit}</FixedCell>
        <FixedCell>{item.purchase_unit || '—'}</FixedCell>
        <FixedCell title={`1 ${item.purchase_unit || '采购单位'} = ${item.unit_factor} ${item.unit}`}>{item.purchase_unit ? `${item.unit_factor} ${item.unit}/${item.purchase_unit}` : '—'}</FixedCell>
        <FixedCell title={item.customer_code || '—'}>{item.customer_code || '—'}</FixedCell>
        <FixedCell title={item.supplier_code || '—'}>{item.supplier_code || '—'}</FixedCell>
        <FixedCell title="现存量 / 可用库存">{q(item.on_hand)} / {q(item.available)}</FixedCell>
        <FixedCell><button className="text-button" onClick={() => setItemModal(item)}>编辑</button></FixedCell>
      </tr>)}</Table>
      {(data.item_aliases || []).length ? <details className="inventory-aliases"><summary>已记录的客户／供应商型号对应关系 · {data.item_aliases.length} 条</summary><ul>{data.item_aliases.map(alias => <li key={alias.id}>{itemOf(alias.item_id)?.name || '—'}：{alias.source} {alias.alias}</li>)}</ul></details> : null}
      {!items.length ? <Empty title="还没有料品档案"/> : null}
    </Panel> : null}
    {tab === 'receipts' ? <div className="stock-layout"><Panel>
      <div className="toolbar"><SearchBox value={search} onChange={setSearch} placeholder="搜索入库单号或供应商…"/><div className="toolbar-actions"><Button secondary disabled={busy} onClick={refresh}><RefreshCw size={16}/>刷新</Button><Button secondary type="button" onClick={() => navigate('purchases')}>备货采购登记</Button><Button onClick={() => setReceiptKey(key => key + 1)}><PackagePlus size={16}/>登记入库</Button></div></div>
      <Table minWidth={1080} headers={['入库单号','到货日期','来源','仓库','数量','成本金额','经办时间','状态','操作']}>{receipts.map(receipt => <tr key={receipt.id}>
        <FixedCell className="mono">{receipt.number}</FixedCell>
        <FixedCell>{receipt.received_at}</FixedCell>
        <FixedCell title={receipt.supplier || '公共备货'}>{receipt.purchase_id ? `采购 #${receipt.purchase_id}` : '公共备货'}{receipt.supplier ? <small>{receipt.supplier}</small> : null}</FixedCell>
        <FixedCell>{warehouseName(data, receipt.warehouse_id)}</FixedCell>
        <FixedCell>{q(receiptQuantity(receipt))}</FixedCell>
        <FixedCell>{money(receiptValue(receipt))}</FixedCell>
        <FixedCell title={receipt.created_at}>{receipt.created_at?.slice(0, 16).replace('T', ' ')}</FixedCell>
        <FixedCell><Badge>{receipt.voided_at ? '已撤销' : '已入库'}</Badge><small>{receipt.note}</small></FixedCell>
        <FixedCell>{receipt.voided_at ? '—' : user?.is_admin ? <button className="text-button delete-action" disabled={busy} onClick={() => { const reason = window.prompt('撤销入库单原因（保留流水，货物退回待处理）'); if (reason) run(() => api(`/receipts/${receipt.id}/void`, { reason }), '入库单已撤销'); }}>撤销</button> : '仅管理员可撤销'}</FixedCell>
      </tr>)}</Table>
      {!receipts.length ? <Empty title="还没有入库单">采购明细选择“入库”收货方式后，到货时在这里登记。</Empty> : null}
    </Panel><Panel className="stock-form" title="登记入库"><ReceiptForm key={receiptKey} data={data} run={run} busy={busy} onDone={() => setReceiptKey(key => key + 1)}/></Panel></div> : null}
    {tab === 'outbounds' ? <div className="stock-layout"><Panel>
      <div className="toolbar"><SearchBox value={search} onChange={setSearch} placeholder="搜索出库单号、客户或运单号…"/><div className="toolbar-actions"><Button secondary disabled={busy} onClick={refresh}><RefreshCw size={16}/>刷新</Button><Button onClick={() => setOutboundKey(key => key + 1)}><PackageMinus size={16}/>登记出库</Button></div></div>
      <Table minWidth={1200} headers={['出库单号','客户','客户 PO','仓库','数量','出库成本','物流单号','送货单','状态','操作']}>{outbounds.map(outbound => { const order = data.orders.find(o => o.id === outbound.order_id); const delivery = data.deliveries.find(d => d.id === outbound.delivery_id); return <tr key={outbound.id}>
        <FixedCell className="mono">{outbound.number}</FixedCell>
        <FixedCell title={outbound.address}>{outbound.customer}</FixedCell>
        <FixedCell className="mono">{order?.po || '—'}</FixedCell>
        <FixedCell>{warehouseName(data, outbound.warehouse_id)}</FixedCell>
        <FixedCell>{q(outboundQuantity(outbound))}</FixedCell>
        <FixedCell>{money(outboundValue(outbound))}</FixedCell>
        <FixedCell title={[outbound.carrier, outbound.tracking].filter(Boolean).join(' ')}>{[outbound.carrier, outbound.tracking].filter(Boolean).join(' ') || '—'}</FixedCell>
        <FixedCell>{delivery ? <span className="mono">{delivery.number}{delivery.status === 'void' ? '（已作废）' : ''}</span> : '—'}</FixedCell>
        <FixedCell><Badge>{outbound.voided_at ? '已撤销' : '已出库'}</Badge><small>{outbound.created_at?.slice(0, 10)}</small></FixedCell>
        <FixedCell>{outbound.voided_at ? '—' : user?.is_admin ? <button className="text-button delete-action" disabled={busy} onClick={() => { const reason = window.prompt('撤销出库原因（需先作废送货单）'); if (reason) run(() => api(`/outbounds/${outbound.id}/void`, { reason }), '出库单已撤销'); }}>撤销</button> : '仅管理员可撤销'}</FixedCell>
      </tr>; })}</Table>
      {!outbounds.length ? <Empty title="还没有出库单">已确认订单可占用库存，在右侧登记出库后系统会同时生成送货单。</Empty> : null}
    </Panel><Panel className="stock-form" title="登记出库"><OutboundForm key={outboundKey} data={data} run={run} busy={busy} onDone={() => setOutboundKey(key => key + 1)}/></Panel></div> : null}
    {tab === 'entries' ? <Panel>
      <div className="toolbar"><SearchBox value={search} onChange={setSearch} placeholder="搜索来源单据、类型或备注…"/><Button secondary disabled={busy} onClick={refresh}><RefreshCw size={16}/>刷新</Button></div>
      <Table minWidth={1120} headers={['时间','料品','仓库','类型','方向','数量','金额','结存','来源单据','备注']}>{entries.map(entry => <tr key={entry.id}>
        <FixedCell title={entry.created_at}>{entry.created_at?.slice(0, 16).replace('T', ' ')}</FixedCell>
        <FixedCell title={itemOf(entry.item_id)?.name}>{itemOf(entry.item_id) ? itemLabel(itemOf(entry.item_id)) : `料品 #${entry.item_id}`}</FixedCell>
        <FixedCell>{warehouseName(data, entry.warehouse_id)}</FixedCell>
        <FixedCell>{entry.kind}</FixedCell>
        <FixedCell><Badge tone={entry.direction === 'in' ? 'green' : 'orange'}>{entry.direction === 'in' ? '入库' : '出库'}</Badge></FixedCell>
        <FixedCell>{q(entry.quantity)}</FixedCell>
        <FixedCell>{money(entry.value_cents)}</FixedCell>
        <FixedCell>{q(entry.balance_quantity)}</FixedCell>
        <FixedCell title={entry.source}>{entry.source || '—'}</FixedCell>
        <FixedCell title={entry.note || '—'}>{entry.note || '—'}</FixedCell>
      </tr>)}</Table>
      {!entries.length ? <Empty title="还没有库存流水">入库、出库和盘点都会留下可追溯的流水记录。</Empty> : null}
    </Panel> : null}
    {itemModal ? <ItemForm item={itemModal.id ? itemModal : null} data={data} run={run} busy={busy} onClose={() => setItemModal(null)}/> : null}
    {adjustItem ? <Modal title={`库存盘点 · ${itemOf(adjustItem.item_id)?.name || ''}`} onClose={() => setAdjustItem(null)}><AdjustForm data={data} initial={adjustItem} run={run} busy={busy} onDone={() => setAdjustItem(null)}/></Modal> : null}
    {warehouseModal ? <Modal title="仓库维护" onClose={() => setWarehouseModal(null)}><WarehouseForm data={data} initial={warehouseModal} run={run} busy={busy} onDone={() => setWarehouseModal(null)}/></Modal> : null}
  </div>;
}

function WarehouseForm({ data, initial, run, busy, onDone }) {
  const [form, setForm] = useState({ ...initial });
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const isDefault = form.is_default === true || form.is_default === 1;
  return <><form onSubmit={e => { e.preventDefault(); run(() => api(form.id ? `/warehouses/${form.id}` : '/warehouses', form), () => { if (!form.id) setForm({ name: '', location: '', note: '', is_default: false }); return form.id ? '仓库已更新' : '仓库已新增'; }); }}>
      <div className="form-grid"><InputField label="仓库名称 *" required value={form.name} onChange={e => set('name', e.target.value)}/><InputField label="存放位置" value={form.location} onChange={e => set('location', e.target.value)}/><InputField label="备注" wide value={form.note} onChange={e => set('note', e.target.value)}/></div>
      <label className="check-label"><input type="checkbox" checked={isDefault} disabled={isDefault} onChange={e => set('is_default', e.target.checked)}/>{isDefault ? '当前默认仓库（改用下方“设为默认”可切换）' : '设为默认仓库：入库、出库、库存占用未指定时默认使用'}</label>
      <SaveBar busy={busy} label={form.id ? '保存修改' : '新增仓库'}>{form.id ? <Button secondary type="button" disabled={busy} onClick={() => setForm({ name: '', location: '', note: '', is_default: false })}>改为新增仓库</Button> : null}</SaveBar>
    </form>
    <Table headers={['仓库','位置','备注','库存料品','状态','操作']}>{(data.warehouses || []).map(warehouse => <tr key={warehouse.id}>
      <td>{warehouse.name}{warehouse.is_default === 1 ? <Badge tone="green">默认</Badge> : null}</td>
      <td>{warehouse.location || '—'}</td><td>{warehouse.note || '—'}</td>
      <td>{(data.items || []).filter(item => (item.warehouse_stock || []).some(x => x.warehouse_id === warehouse.id && x.quantity > 0)).length} 项</td>
      <td><Badge tone={warehouse.active === 0 ? 'gray' : undefined}>{warehouse.active === 0 ? '已停用' : '启用中'}</Badge></td>
      <td><div className="order-actions">
        <button className="text-button" onClick={() => setForm({ id: warehouse.id, name: warehouse.name, location: warehouse.location, note: warehouse.note, is_default: warehouse.is_default === 1, active: warehouse.active !== 0 })}>编辑</button>
        {warehouse.is_default === 1 ? null : <button className="text-button" disabled={busy || warehouse.active === 0} onClick={() => run(() => api(`/warehouses/${warehouse.id}`, { ...warehouse, is_default: true }), `${warehouse.name} 已设为默认仓库`)}>设为默认</button>}
        <button className="text-button" disabled={busy} onClick={() => run(() => api(`/warehouses/${warehouse.id}`, { ...warehouse, active: warehouse.active === 0 }), warehouse.active === 0 ? '仓库已启用' : '仓库已停用')}>{warehouse.active === 0 ? '启用' : '停用'}</button>
        <button className="text-button delete-action" disabled={busy} onClick={() => { if (window.confirm(`删除仓库「${warehouse.name}」？\n仅从未使用过的仓库可以删除；默认仓库、有库存或已有入库/出库/流水记录的仓库会被拒绝，请改用“停用”。`)) run(() => api(`/warehouses/${warehouse.id}/delete`, {}), () => { if (form.id === warehouse.id) setForm({ name: '', location: '', note: '', is_default: false }); return '仓库已删除'; }); }}>删除</button>
      </div></td>
    </tr>)}</Table></>;
}

function AdjustForm({ data, initial, run, busy, onDone }) {
  const [form, setForm] = useState({ ...initial });
  const item = (data.items || []).find(x => x.id === form.item_id);
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  return <form onSubmit={e => { e.preventDefault(); run(() => api('/stock-adjust', form), '盘点已登记'); onDone(); }}>
    <p className="notice">{item ? `${itemLabel(item)} · 现有 ${q(item.on_hand)} ${item.unit}` : ''}。盘盈会增加库存，盘亏会按当前加权成本减少库存，均保留流水。</p>
    <div className="form-grid"><Field label="盘点方向"><select value={form.direction} onChange={e => set('direction', e.target.value)}><option value="gain">盘盈（实际多于账面）</option><option value="loss">盘亏（实际少于账面）</option></select></Field>
      <Field label="仓库 *"><select required value={form.warehouse_id} onChange={e => set('warehouse_id', e.target.value)}>{activeWarehouses(data).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
      <InputField label="数量 *" required type="number" min="0" step="any" value={form.quantity} onChange={e => set('quantity', e.target.value)}/>
      {form.direction === 'gain' ? <InputField label="盘盈入库成本" type="number" min="0" step=".01" value={form.amount} onChange={e => set('amount', e.target.value)} hint="留空按零成本入库"/> : null}
      <InputField label="原因 *" wide required value={form.reason} onChange={e => set('reason', e.target.value)}/></div>
    <SaveBar busy={busy} label="登记盘点"/></form>;
}

export function ReceiptForm({ data, run, busy, onDone }) {
  const purchaseLines = (data.purchase_lines || []).filter(line => line.receive_mode === 'stock' && openQuantity(line) > 1e-6);
  const [mode, setMode] = useState('purchase');
  const [warehouse, setWarehouse] = useState(defaultWarehouse(data));
  const [receivedAt, setReceivedAt] = useState(data.today);
  const [supplier, setSupplier] = useState('');
  const [note, setNote] = useState('');
  const [selected, setSelected] = useState([]);
  const [quantities, setQuantities] = useState({});
  const [locations, setLocations] = useState({});
  const [direct, setDirect] = useState({ item_id: '', quantity: '', unit: '', cost: '', location: '' });
  const toggle = line => setSelected(ids => ids.includes(line.id) ? ids.filter(id => id !== line.id) : [...ids, line.id]);
  const chosen = purchaseLines.filter(line => selected.includes(line.id));
  return <form onSubmit={e => { e.preventDefault(); run(async () => {
    const lines = mode === 'purchase'
      ? chosen.map(line => ({ purchase_line_id: line.id, quantity: quantities[line.id] ?? openQuantity(line), location: locations[line.id] || '' }))
      : [{ item_id: Number(direct.item_id), quantity: direct.quantity, unit: direct.unit || (data.items.find(x => x.id === Number(direct.item_id))?.unit || '个'), cost: direct.cost, location: direct.location }];
    await api('/receipts', { warehouse_id: Number(warehouse), received_at: receivedAt, supplier, note, lines });
  }, '入库已登记，库存与订单占用已更新'); onDone(); }}>
    <div className="form-grid purchase-info-grid"><Field label="入库来源"><select value={mode} onChange={e => setMode(e.target.value)}><option value="purchase">采购明细到货</option><option value="direct">无采购来源（公共备货）</option></select></Field>
      <Field label="入库仓库 *"><select required value={warehouse} onChange={e => setWarehouse(e.target.value)}>{activeWarehouses(data).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
      <InputField label="到货日期 *" type="date" required value={receivedAt} onChange={e => setReceivedAt(e.target.value)}/><InputField label="供应商" value={supplier} onChange={e => setSupplier(e.target.value)} placeholder="平台采购可留空，由采购记录带出"/>
      <InputField label="入库备注" wide value={note} onChange={e => setNote(e.target.value)}/></div>
    {mode === 'purchase' ? (purchaseLines.length ? <Table minWidth={980} headers={[<input type="checkbox" aria-label="全选待入库明细" checked={chosen.length === purchaseLines.length} onChange={e => setSelected(e.target.checked ? purchaseLines.map(x => x.id) : [])}/>,'采购记录','客户料品','料品编号','待入库数量','本次入库','单位','库位','备注']}>
      {purchaseLines.map(line => { const purchase = data.purchases.find(p => p.id === line.purchase_id); const orderLine = data.order_lines.find(x => x.id === line.order_line_id); const item = (data.items || []).find(x => x.id === line.item_id); return <tr key={line.id}>
        <td><input type="checkbox" aria-label={`选择入库明细 ${line.id}`} checked={selected.includes(line.id)} onChange={() => toggle(line)}/></td>
        <td>{purchase ? <span>{purchase.platform} · {purchase.shop}<small>{purchase.platform_order}</small></span> : '—'}</td>
        <td>{orderLine ? <span>{orderLine.name}<small>{orderLine.spec || '—'}{orderLine.item_id ? '' : ' · 待匹配料品'}</small></span> : '公共备货'}</td>
        <td className="mono">{item?.code || (line.item_id ? `#${line.item_id}` : '待匹配')}</td>
        <td>{q(openQuantity(line))}</td>
        <td><input type="number" className="small-input" aria-label={`入库数量 ${line.id}`} min="0" max={openQuantity(line)} step="any" disabled={!selected.includes(line.id)} required={selected.includes(line.id)} value={quantities[line.id] ?? openQuantity(line)} onChange={e => setQuantities(current => ({ ...current, [line.id]: e.target.value }))}/></td>
        <td>{line.purchase_unit || '—'}</td>
        <td><input aria-label={`库位 ${line.id}`} disabled={!selected.includes(line.id)} value={locations[line.id] || ''} onChange={e => setLocations(current => ({ ...current, [line.id]: e.target.value }))} placeholder="库位/货架"/></td>
        <td>{line.purchase_spec || '—'}</td>
      </tr>; })}</Table> : <Empty title="没有待入库的采购明细">请在采购记录中把需要入库的明细收货方式改为“入库”。</Empty>) : <div className="form-grid"><Field label="入库料品 *"><select required value={direct.item_id} onChange={e => setDirect(current => ({ ...current, item_id: e.target.value, unit: data.items.find(x => x.id === Number(e.target.value))?.unit || current.unit }))}><option value="">请选择料品</option>{(data.items || []).map(item => <option key={item.id} value={item.id}>{itemLabel(item)}</option>)}</select></Field>
      <InputField label="入库数量 *" required type="number" min="0" step="any" value={direct.quantity} onChange={e => setDirect(current => ({ ...current, quantity: e.target.value }))}/>
      <InputField label="入库单位" value={direct.unit} onChange={e => setDirect(current => ({ ...current, unit: e.target.value }))}/><InputField label="入库成本" type="number" min="0" step=".01" value={direct.cost} onChange={e => setDirect(current => ({ ...current, cost: e.target.value }))} hint="备货成本，出库时按加权平均计入客户订单"/>
      <InputField label="库位" wide value={direct.location} onChange={e => setDirect(current => ({ ...current, location: e.target.value }))}/></div>}
    <p className="muted footnote">采购物流显示已签收不等于已经入库；请核对实际数量、型号、单位和库位后再登记。</p>
    <SaveBar busy={busy} disabled={mode === 'purchase' ? !chosen.length : !direct.item_id || !direct.quantity} label="确认入库"/>
  </form>;
}

export function ReserveForm({ data, run, busy, orderId, onDone, onCancel }) {
  const [warehouse, setWarehouse] = useState(defaultWarehouse(data));
  const [quantities, setQuantities] = useState({});
  const order = data.orders.find(o => o.id === Number(orderId));
  const lines = data.order_lines.filter(line => line.order_id === Number(orderId));
  const candidates = lines.filter(line => Number(line.stock_available || 0) > 1e-6 && Number(line.gap_quantity ?? 0) > 1e-6);
  return <form onSubmit={e => { e.preventDefault(); run(async () => {
    for (const line of candidates) {
      const amount = Number(quantities[line.id] || 0);
      if (amount > 0) await api('/reservations', { order_line_id: line.id, quantity: amount, warehouse_id: Number(warehouse) || null, note: `订单 ${order?.po || ''} 安排库存` });
    }
  }, '库存占用已登记，出库时自动扣减'); onDone(); }}>
    <p className="notice">占用只是把可用库存留给本订单，不扣减现存量；确认出库时才真正扣减并计入订单成本。库存数量实时变化，提交时会再次校验。</p>
    <div className="form-grid"><Field label="占用仓库 *"><select value={warehouse} onChange={e => setWarehouse(e.target.value)}>{activeWarehouses(data).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
      <Field label="订单"><strong>{order ? `${order.po} · ${order.customer}` : '—'}</strong></Field></div>
    <Table minWidth={860} headers={['料品名称','标准型号','料品编号','需求','已占用','可用库存','本单缺口','本次占用','单位']}>{candidates.map(line => { const item = (data.items || []).find(x => x.id === line.item_id); return <tr key={line.id}>
      <td>{line.name}</td><td>{line.spec || '—'}</td><td className="mono">{item?.code || '待匹配'}</td>
      <td>{q(line.demand_quantity ?? line.quantity)}</td><td>{q(line.stock_reserved || 0)}</td><td>{q(line.stock_available || 0)}</td><td>{q(line.gap_quantity || 0)}</td>
      <td><input type="number" className="small-input" aria-label={`${line.name}占用数量`} min="0" max={Math.min(line.stock_available, line.gap_quantity)} step="any" value={quantities[line.id] ?? ''} placeholder={String(Math.min(line.stock_available, line.gap_quantity))} onChange={e => setQuantities(current => ({ ...current, [line.id]: e.target.value }))}/></td>
      <td>{line.unit}</td></tr>; })}</Table>
    {!candidates.length ? <Empty compact title="当前可用库存不足或订单已落实">请先登记入库或核对其他订单占用。</Empty> : null}
    <SaveBar busy={busy} disabled={!candidates.length} label="确认占用">{onCancel ? <Button secondary disabled={busy} onClick={onCancel}>返回</Button> : null}</SaveBar>
  </form>;
}

export function OutboundForm({ data, run, busy, orderId, onDone, onCancel }) {
  const companyInfo = data.company?.name ? data.company : {
    name: localStorage.getItem('caidan.company') || '上海思品利诚智能科技有限公司',
    name_en: localStorage.getItem('caidan.company_en') || 'Shanghai SPLC Intelligent Technology Co., Ltd',
    address: localStorage.getItem('caidan.company_address') || '上海市奉贤区名城路1088弄7号',
    phone: localStorage.getItem('caidan.company_phone') || '18551211185',
  };
  const [oid, setOid] = useState(orderId ? String(orderId) : '');
  const [warehouse, setWarehouse] = useState(defaultWarehouse(data));
  const [quantities, setQuantities] = useState({});
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  const [company, setCompany] = useState(companyInfo.name || '');
  const [note, setNote] = useState('');
  const order = data.orders.find(o => o.id === Number(oid));
  const orderOptions = data.orders.filter(o => o.status === 'confirmed' && !o.archived_at);
  const itemOf = line => (data.items || []).find(x => x.id === line.item_id) || matchItem(data.items || [], line, data.item_aliases || []);
  const lines = data.order_lines.filter(line => line.order_id === Number(oid));
  const rows = lines.map(line => { const item = itemOf(line); return { line, item, onHand: Number(item?.on_hand || 0), reserved: Number(item?.reserved || 0), available: Number(item?.available || 0) }; });
  const total = rows.reduce((sum, row) => sum + Number(quantities[row.line.id] || 0), 0);
  return <form onSubmit={e => { e.preventDefault(); run(async () => {
    const payload = rows.filter(row => Number(quantities[row.line.id] || 0) > 0).map(row => ({ order_line_id: row.line.id, quantity: quantities[row.line.id] }));
    const payloadOrder = oid || String(lines[0]?.order_id || '');
    await api('/outbounds', { order_id: Number(payloadOrder), warehouse_id: Number(warehouse), carrier, tracking, company, note,
      company_en: companyInfo.name_en, company_address: companyInfo.address, company_phone: companyInfo.phone, lines: payload });
  }, '出库已办理：库存扣减并生成送货单'); onDone(); }}>
    <div className="form-grid outbound-fields"><Field label="客户订单 *">{orderId ? <strong>{order ? `${order.po} · ${order.customer}` : '—'}</strong> : <select required value={oid} onChange={e => { setOid(e.target.value); setQuantities({}); }}><option value="">请选择订单</option>{orderOptions.map(o => <option key={o.id} value={o.id}>{o.po} · {o.customer}</option>)}</select>}</Field>
      <Field label="出库仓库 *"><select required value={warehouse} onChange={e => setWarehouse(e.target.value)}>{activeWarehouses(data).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
      <InputField label="快递公司" value={carrier} onChange={e => setCarrier(e.target.value)}/><InputField label="运单号" value={tracking} onChange={e => setTracking(e.target.value)} placeholder="可稍后在送货单补充"/>
      <InputField label="送货单公司抬头 *" required value={company} onChange={e => setCompany(e.target.value)}/><InputField label="出库备注" value={note} onChange={e => setNote(e.target.value)}/></div>
    <Table minWidth={1040} headers={['料品名称','标准型号','料品编号','需求','已发货','已占用','现存量','可用库存','可出数量','本次出库','单位']}>{rows.map(row => { const { line, item } = row; const shippable = row.onHand; return <tr key={line.id}>
      <td>{line.name}</td><td>{line.spec || '—'}</td><td>{item ? <span className="mono">{item.code}</span> : <ItemBinder line={line} data={data} run={run} busy={busy}/>}</td>
      <td>{q(line.demand_quantity ?? line.quantity)}</td><td>{q(line.logistics_dispatched_quantity || 0)}</td><td>{q(row.reserved)}</td>
      <td>{q(row.onHand)}</td><td>{q(row.available)}</td><td>{q(shippable)}</td>
      <td><input type="number" className="small-input" aria-label={`${line.name}出库数量`} min="0" max={shippable} step="any" disabled={shippable <= 0} value={quantities[line.id] ?? ''} placeholder="0" onChange={e => setQuantities(current => ({ ...current, [line.id]: e.target.value }))}/></td>
      <td>{line.unit}</td></tr>; })}</Table>
    {!lines.length ? <Empty compact title="该订单没有料品明细"/> : !rows.some(row => row.onHand > 0) ? <p className="notice warning">该订单当前没有可出库的库存：未关联料品的行请先在产品库中关联料品编号；已关联的请先在「入库单」登记入库或做盘点。</p> : null}
    <SaveBar busy={busy} disabled={!total} label="确认出库并生成送货单">{onCancel ? <Button secondary disabled={busy} onClick={onCancel}>返回</Button> : null}</SaveBar>
  </form>;
}

export function ItemBinder({ line, data, run, busy }) {
  const [value, setValue] = useState('');
  const matches = (data.items || []).filter(item => item.name === line.name || (line.customer_code && item.customer_code === line.customer_code));
  return <div className="order-actions">
    <select aria-label={`${line.name}关联料品`} value={value} onChange={e => setValue(e.target.value)}><option value="">待匹配料品…</option>{(matches.length ? matches : data.items || []).map(item => <option key={item.id} value={item.id}>{itemLabel(item)}</option>)}</select>
    <button type="button" className="text-button" disabled={busy || !value} onClick={() => run(() => api(`/order-lines/${line.id}/item`, { item_id: Number(value) }), '料品已关联，库存列已更新')}>关联</button>
  </div>;
}

