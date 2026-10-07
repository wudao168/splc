import React, { useState } from 'react';
import { api, money, q } from './api';
import { Attachment, Badge, Button, Empty, Field, InputField, Panel, SaveBar, Table } from './components';

const kinds = { cancel: '取消未发数量', return: '退货退款', exchange: '退货换货', refund_only: '仅调整金额／退款' };
const stages = { pending: '待处理', processing: '处理中', completed: '已完成', void: '已撤销' };
const actions = { cancel: '取消采购', supplier_return: '退供应商', stock: '转库存', transfer: '转其他订单' };
const finances = { none: '不涉及金额', reduce_receivable: '减少应收', refund_received: '退回已收款' };

function Owner({ data, value, onChange }) {
  return <Field label="经办人"><select value={value} onChange={e => onChange(Number(e.target.value))}>{data.users.filter(u => u.active).map(u => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select></Field>;
}
export function Revoke({ path, run, busy, label = '撤销／更正' }) {
  const [editing, setEditing] = useState(false), [reason, setReason] = useState('');
  return <div className={`revoke-action ${editing ? 'expanded' : ''}`}><Button secondary danger disabled={busy} onClick={() => setEditing(x => !x)}>{editing ? '取消更正' : label}</Button>{editing ? <><InputField label="更正原因 *" value={reason} onChange={e => setReason(e.target.value)} placeholder="先核实实际货物和款项，填写录入错误原因"/><Button secondary danger disabled={busy || !reason.trim()} onClick={() => run(async () => { await api(path, { reason }); setEditing(false); }, '更正已记录')}>确认更正记录</Button></> : null}</div>;
}
export function RecordArchive({ table, record, run, busy }) {
  return <Button secondary disabled={busy} onClick={() => run(() => api(`/${table}/${record.id}/${record.archived_at ? 'unarchive' : 'archive'}`, {}), record.archived_at ? '已取消归档' : '已归档，未结事项继续提醒')}>{record.archived_at ? '取消归档' : '归档'}</Button>;
}
export function Trash({ data, table, run, busy, user }) {
  const items = (data.trash || []).filter(x => x.type === table || (table === 'orders' && x.type === 'intake-drafts'));
  return <Panel title="回收站"><Table headers={['记录','删除时间','操作']}>{items.map(item => <tr key={`${item.type}-${item.id}`}><td>{item.label}</td><td>{item.deleted_at?.slice(0, 19).replace('T', ' ')}</td><td>{user?.is_admin ? <Button secondary disabled={busy} onClick={() => run(() => api(`/${item.type}/${item.id}/restore`, {}), '记录已恢复')}>恢复</Button> : '仅管理员可恢复'}</td></tr>)}</Table>{!items.length ? <Empty compact title="回收站为空"/> : null}</Panel>;
}

export function OrderLifecycle({ order, data, run, busy, user }) {
  const lines = data.order_lines.filter(l => l.order_id === order.id);
  const lineIds = new Set(lines.map(l => l.id));
  const cases = (data.order_cases || []).filter(c => lineIds.has(c.order_line_id));
  const [create, setCreate] = useState(false), [tab, setTab] = useState('lines');
  return <div className="lifecycle order-lifecycle">
    <div className="save-bar"><span className="muted">{order.po} · {order.customer}</span><RecordArchive table="orders" record={order} run={run} busy={busy}/><Button onClick={() => { setTab('cases'); setCreate(x => !x); }}>{create ? '收起登记' : '登记变更／售后'}</Button></div>
    <p className="notice">取消仅减少未发数量；已开送货单需先核实或作废。实际发货请在送货单中确认。退货不会自动增加可发数量，换货通过关联售后单补发。</p>

    <div className="tabs" role="tablist" aria-label="订单变更与售后"><button type="button" role="tab" aria-selected={tab === 'lines'} className={tab === 'lines' ? 'active' : ''} onClick={() => setTab('lines')}>料品列表</button><button type="button" role="tab" aria-selected={tab === 'cases'} className={tab === 'cases' ? 'active' : ''} onClick={() => setTab('cases')}>变更与售后 · {cases.length}</button></div>
    <div role="tabpanel" hidden={tab !== 'cases'}>
    {create ? <OrderCaseForm order={order} lines={lines} data={data} run={run} busy={busy} user={user} onDone={() => setCreate(false)}/> : null}
    <Panel title={`变更与售后 · ${cases.length}`}>{cases.map(c => <OrderCase key={`${c.id}-${c.status}-${c.received_quantity}-${c.finance_confirmed_at}`} item={c} data={data} run={run} busy={busy} user={user}/>)}{!cases.length ? <Empty compact title="暂无变更与售后记录"/> : null}</Panel>
    </div>
    <div role="tabpanel" hidden={tab !== 'lines'} className="order-lifecycle-lines"><Table headers={['料品名称','规格型号','原订购','已取消','实际已发','退货中','已退回','客户净留存','当前采购']} minWidth={840}>{lines.map(l => <tr key={l.id}><td title={l.name}>{l.name}</td><td title={l.spec}>{l.spec}</td><td>{q(l.quantity)}</td><td>{q(l.cancelled_quantity || 0)}</td><td>{q(l.dispatched_quantity || 0)}</td><td>{q(l.returning_quantity || 0)}</td><td>{q(l.returned_quantity || 0)}</td><td>{q(Math.max(0, (l.dispatched_quantity || 0) - (l.returned_quantity || 0)))}</td><td>{q(l.purchased)}</td></tr>)}</Table></div>
  </div>;
}

function OrderCaseForm({ order, lines, data, run, busy, user, onDone }) {
  const [f, setF] = useState({ kind: 'cancel', order_line_id: lines[0]?.id || '', delivery_line_id: '', purchase_line_id: '', quantity: '', reason: '', financial_type: 'reduce_receivable', amount: '', owner_id: user.id });
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));
  const line = lines.find(l => l.id === Number(f.order_line_id));
  const deliveries = data.delivery_lines.filter(l => l.order_line_id === Number(f.order_line_id) && data.deliveries.some(d => d.id === l.delivery_id && d.status === 'active' && d.shipped_at));
  const sources = data.purchase_lines.filter(l => l.order_line_id === Number(f.order_line_id) && l.quantity > 0);
  const selectedDelivery = deliveries.find(d => d.id === Number(f.delivery_line_id));
  const max = f.kind === 'cancel' ? line?.cancel_available || 0 : selectedDelivery ? selectedDelivery.quantity - (data.order_cases || []).filter(c => c.delivery_line_id === selectedDelivery.id && c.status !== 'void').reduce((n, c) => n + c.quantity, 0) : 0;
  return <form className="lifecycle-card" onSubmit={e => { e.preventDefault(); run(async () => { await api(`/orders/${order.id}/cases`, { ...f, order_line_id: Number(f.order_line_id), delivery_line_id: Number(f.delivery_line_id) || null, purchase_line_id: Number(f.purchase_line_id) || null, amount: f.amount === '' ? Number(f.quantity || 0) * (line?.price_cents || 0) / 100 : f.amount }); onDone(); }, '业务处理已登记'); }}>
    <div className="form-grid">
      <Field label="处理类型"><select value={f.kind} onChange={e => { setF(x => ({ ...x, kind: e.target.value, quantity: '', delivery_line_id: '', purchase_line_id: '', financial_type: e.target.value === 'exchange' ? 'none' : 'reduce_receivable' })); }}>{Object.entries(kinds).map(([k,v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      <Field label="订单料品"><select value={f.order_line_id} onChange={e => setF(x => ({ ...x, order_line_id: Number(e.target.value), delivery_line_id: '', purchase_line_id: '', quantity: '' }))}>{lines.map(l => <option key={l.id} value={l.id}>{l.name} · {l.spec}</option>)}</select></Field>
      {f.kind !== 'cancel' ? <Field label="原实际发货明细 *"><select required value={f.delivery_line_id} onChange={e => set('delivery_line_id', Number(e.target.value))}><option value="">请选择已确认发货的送货单</option>{deliveries.map(l => <option key={l.id} value={l.id}>{data.deliveries.find(d => d.id === l.delivery_id)?.number} · {q(l.quantity)} {line?.unit}</option>)}</select></Field> : null}
      {['return','exchange'].includes(f.kind) ? <Field label="退回货物的采购来源"><select value={f.purchase_line_id} onChange={e => set('purchase_line_id', Number(e.target.value))}><option value="">未关联采购，收回时登记存放位置</option>{sources.map(l => <option key={l.id} value={l.id}>{data.purchases.find(p => p.id === l.purchase_id)?.platform_order} · 可核对 {q(l.quantity)}</option>)}</select></Field> : null}
    </div>
    <div className="order-case-fields">
      <InputField label={`本次数量 *（可办理 ${q(max)}）`} type="number" min="0.000001" step="0.000001" max={max} required value={f.quantity} onChange={e => set('quantity', e.target.value)}/>
      <Owner data={data} value={f.owner_id} onChange={v => set('owner_id', v)}/>
      <Field label="客户金额处理"><select value={f.financial_type} onChange={e => set('financial_type', e.target.value)}>{Object.entries(finances).map(([k,v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      {f.financial_type !== 'none' ? <InputField label="申请调整金额（留空按报价计算）" type="number" min="0" step=".01" value={f.amount} onChange={e => set('amount', e.target.value)}/> : null}
    </div>
    <div className="order-case-reason"><InputField label="原因 *" required value={f.reason} onChange={e => set('reason', e.target.value)}/><SaveBar busy={busy} disabled={max <= 0} label="登记处理"/></div>
  </form>;
}

function OrderCase({ item: c, data, run, busy, user }) {
  const [f, setF] = useState({ ...c, amount: c.amount_cents / 100 });
  const set = (k,v) => setF(x => ({ ...x, [k]:v }));
  const line = data.order_lines.find(l => l.id === c.order_line_id);
  const open = ['pending','processing'].includes(c.status);
  return <details className="lifecycle-card"><summary>#{c.id} · {kinds[c.kind]} · {line?.name} × {q(c.quantity)}　<Badge>{stages[c.status]}</Badge></summary>
    <p>{c.reason}</p><p className="muted">经办人：{data.users.find(u => u.id === c.owner_id)?.display_name} · {finances[c.financial_type]} {money(c.amount_cents)} · {c.finance_confirmed_at ? '金额已确认' : c.amount_cents ? '金额待管理员确认' : '无待确认金额'}</p>
    {(data.purchase_cases || []).some(p => p.order_case_id === c.id && p.status !== 'void') ? <p className="notice warning">关联采购处理：{data.purchase_cases.filter(p => p.order_case_id === c.id && p.status !== 'void').map(p => `#${p.id} ${stages[p.status]}`).join('、')}，请到采购明细办理。</p> : null}
    {open ? <form onSubmit={e => { e.preventDefault(); run(() => api(`/order-cases/${c.id}/update`, f), '进度已保存'); }}><div className="form-grid">
      {['return','exchange'].includes(c.kind) ? <><InputField label="累计实际收回数量" type="number" min={c.received_quantity} max={c.quantity} step=".000001" required value={f.received_quantity} onChange={e => set('received_quantity', e.target.value)}/><InputField label="退回物流／运单" value={f.tracking} onChange={e => set('tracking', e.target.value)}/>{!c.purchase_line_id ? <InputField label="退回货物存放位置" value={f.location} onChange={e => set('location', e.target.value)}/> : null}</> : null}
      <Owner data={data} value={f.owner_id} onChange={v => set('owner_id', v)}/><Field label="金额处理"><select disabled={!!c.finance_confirmed_at} value={f.financial_type} onChange={e => set('financial_type', e.target.value)}>{Object.entries(finances).map(([k,v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      <InputField label="申请调整金额" type="number" min="0" step=".01" disabled={!!c.finance_confirmed_at || f.financial_type === 'none'} value={f.amount} onChange={e => set('amount', e.target.value)}/>
      <InputField label="处理结果／进度说明" wide value={f.note} onChange={e => set('note', e.target.value)}/><Attachment value={f.evidence_id} onChange={v => set('evidence_id', v)}/>
    </div><SaveBar busy={busy} label="保存进度"/></form> : <p>实际收回 {q(c.received_quantity)} · {c.note || '—'} {c.evidence_id ? <a href={`/api/files/${c.evidence_id}`} target="_blank" rel="noreferrer">查看凭证</a> : null}</p>}
    <div className="save-bar">{open && user.is_admin && c.amount_cents > 0 && !c.finance_confirmed_at ? <Button secondary disabled={busy} onClick={() => run(() => api(`/order-cases/${c.id}/finance`, {}), '金额已由管理员确认')}>{c.financial_type === 'refund_received' ? '确认已退款' : '确认应收调整'}</Button> : null}{open ? <Button disabled={busy} onClick={() => run(() => api(`/order-cases/${c.id}/complete`, {}), '此项业务已完成')}>确认完成</Button> : null}{c.status !== 'void' && user.is_admin ? <Revoke path={`/order-cases/${c.id}/void`} run={run} busy={busy}/> : null}</div>
  </details>;
}

export function PurchaseLifecycle({ purchase, data, run, busy, user }) {
  const lines = data.purchase_lines.filter(l => l.purchase_id === purchase.id), ids = new Set(lines.map(l => l.id));
  const cases = (data.purchase_cases || []).filter(c => ids.has(c.purchase_line_id));
  const [lineId, setLineId] = useState(lines[0]?.id || ''), [quantity, setQuantity] = useState(''), [reason, setReason] = useState('');
  const selected = lines.find(l => l.id === Number(lineId));
  return <div className="lifecycle"><Panel title={`采购处理 · ${cases.length}`} action={<RecordArchive table="purchases" record={purchase} run={run} busy={busy}/>}>
    <p className="notice">按对应料品和数量处理取消、退供应商、转库存或转单。实付款 {money(purchase.amount_cents)}，已确认到账退款 {money(purchase.refund_cents || 0)}。平台操作需由经办人核实办理。</p>
    {cases.map(c => <PurchaseCase key={`${c.id}-${c.quantity}-${c.status}-${c.finance_confirmed_at}`} item={c} data={data} run={run} busy={busy} user={user}/>)}
    <details className="lifecycle-card"><summary>登记新的采购处理事项</summary><form onSubmit={e => { e.preventDefault(); run(async () => { await api(`/purchase-lines/${lineId}/cases`, { quantity, reason }); setQuantity(''); setReason(''); }, '采购处理事项已登记'); }}><div className="form-grid"><Field label="采购明细"><select value={lineId} onChange={e => setLineId(Number(e.target.value))}>{lines.map(l => <option key={l.id} value={l.id}>{data.order_lines.find(o => o.id === l.order_line_id)?.name} · 剩余 {q(l.quantity)}（待处理 {q(l.pending_quantity || 0)}）</option>)}</select></Field><InputField label="本次处理数量 *" required type="number" min=".000001" max={Math.max(0, (selected?.quantity || 0) - (selected?.pending_quantity || 0))} step=".000001" value={quantity} onChange={e => setQuantity(e.target.value)}/><InputField label="原因 *" wide required value={reason} onChange={e => setReason(e.target.value)}/></div><SaveBar busy={busy} label="登记采购处理"/></form></details>
    {user.is_admin ? <details className="lifecycle-card"><summary>更正录错的采购明细</summary><PurchaseCorrection lines={lines} data={data} run={run} busy={busy}/></details> : null}
  </Panel></div>;
}

function PurchaseCase({ item: c, data, run, busy, user }) {
  const [splitting, setSplitting] = useState(false), [splitQuantity, setSplitQuantity] = useState('');
  const [f, setF] = useState({ ...c, kind: c.kind || 'cancel', amount: c.amount_cents / 100, target_order_line_id: c.target_order_line_id || '' });
  const set = (k,v) => setF(x => ({ ...x, [k]: v }));
  const source = data.purchase_lines.find(l => l.id === c.purchase_line_id), original = data.order_lines.find(l => l.id === source?.order_line_id);
  const targets = data.order_lines.filter(l => data.orders.some(o => o.id === l.order_id && o.status === 'confirmed' && !o.archived_at) && l.id !== original?.id && l.demand_quantity > l.purchased + .000001);
  const open = ['pending','processing'].includes(c.status);
  if (c.kind === 'supplier_return') return <details className="lifecycle-card" open><summary>#{c.id} · {original?.name} × {q(c.quantity)} · 采购退货　<Badge>{stages[c.status]}</Badge></summary><p>来源客户 PO：{data.orders.find(o => o.id === original?.order_id)?.po} · 退货原因：{c.reason || '—'}</p><p className="notice">人工确认退货后，释放对应采购数量，客户订单料品恢复待采购。淘宝退货、退款和物流流程在平台自行办理，不影响此处确认。</p><div className="save-bar">{open ? <Button disabled={busy} onClick={() => { if (window.confirm(`确认退货 ${original?.name} × ${q(c.quantity)}？对应数量将恢复待采购。`)) run(() => api(`/purchase-cases/${c.id}/complete`, {}), '退货已确认，关联料品数量已释放'); }}>确认退货</Button> : null}{c.status !== 'void' ? <Revoke label={c.status === 'completed' ? '恢复采购' : '撤销退货'} path={`/purchase-cases/${c.id}/void`} run={run} busy={busy}/> : null}</div></details>;
  return <details className="lifecycle-card"><summary>#{c.id} · {original?.name} × {q(c.quantity)} · {actions[c.kind] || '待选择处理方式'}　<Badge>{stages[c.status]}</Badge></summary>
    <p>{c.reason} · 来源客户 PO：{data.orders.find(o => o.id === original?.order_id)?.po} · 对应采购成本 {money(c.cost_cents)}</p>
    <p className="muted">经办人：{data.users.find(u => u.id === c.owner_id)?.display_name} · 退款 {money(c.amount_cents)} · {c.finance_confirmed_at ? '已确认到账' : c.amount_cents ? '待管理员确认到账' : '无待确认金额'}</p>
    {open ? <form onSubmit={e => { e.preventDefault(); run(() => api(`/purchase-cases/${c.id}/update`, { ...f, target_order_line_id: Number(f.target_order_line_id) || null }), '采购进度已保存'); }}><div className="form-grid">
      <Field label="处理方式"><select value={f.kind} disabled={!!c.finance_confirmed_at} onChange={e => setF(x => ({ ...x, kind: e.target.value, amount: ['stock','transfer'].includes(e.target.value) ? 0 : x.amount }))}>{Object.entries(actions).map(([k,v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      <Owner data={data} value={f.owner_id} onChange={v => set('owner_id', v)}/>
      {f.kind === 'transfer' ? <Field label="转入订单料品 *"><select required value={f.target_order_line_id} onChange={e => set('target_order_line_id', e.target.value)}><option value="">请选择</option>{targets.map(l => <option key={l.id} value={l.id}>{data.orders.find(o => o.id === l.order_id)?.po} · {l.name} · 待采购 {q(l.demand_quantity - l.purchased)}</option>)}</select></Field> : null}
      {f.kind === 'stock' ? <InputField label="库存存放位置 *" required value={f.location} onChange={e => set('location', e.target.value)}/> : null}
      {['cancel','supplier_return'].includes(f.kind) ? <InputField label="申请供应商退款金额" disabled={!!c.finance_confirmed_at} min="0" step=".01" type="number" value={f.amount} onChange={e => set('amount', e.target.value)}/> : null}
      <InputField label="退回物流／处理单号" value={f.tracking} onChange={e => set('tracking', e.target.value)}/><InputField label="处理结果／进度说明 *" wide required value={f.note} onChange={e => set('note', e.target.value)}/><InputField label="发票调整核对结果（已收票且退款时必填）" wide value={f.invoice_note} onChange={e => set('invoice_note', e.target.value)}/><Attachment value={f.evidence_id} onChange={v => set('evidence_id', v)}/>
    </div><SaveBar busy={busy} label="保存处理进度"/></form> : <p>{c.note} {c.location ? ` · 存放：${c.location}` : ''}{c.evidence_id ? <a href={`/api/files/${c.evidence_id}`} target="_blank" rel="noreferrer">查看凭证</a> : null}</p>}
    <div className="save-bar">{open && !c.finance_confirmed_at ? <Button secondary disabled={busy} onClick={() => setSplitting(x => !x)}>{splitting ? '取消拆分' : '拆分处理数量'}</Button> : null}{open && user.is_admin && c.amount_cents > 0 && !c.finance_confirmed_at ? <Button secondary disabled={busy} onClick={() => run(() => api(`/purchase-cases/${c.id}/finance`, {}), '供应商退款到账已确认')}>确认退款已到账</Button> : null}{open ? <Button disabled={busy} onClick={() => run(() => api(`/purchase-cases/${c.id}/complete`, {}), '采购处理已完成，数量和成本已更新')}>确认完成处理</Button> : null}{c.status !== 'void' && user.is_admin ? <Revoke path={`/purchase-cases/${c.id}/void`} run={run} busy={busy}/> : null}</div>
    {splitting && open && !c.finance_confirmed_at ? <form onSubmit={e => { e.preventDefault(); run(async () => { await api(`/purchase-cases/${c.id}/split`, { quantity: splitQuantity }); setSplitting(false); }, '已拆分处理数量，请分别核对金额'); }}><p className="muted">拆出部分数量单独处理，拆分后请分别核对两笔退款金额。</p><InputField label="拆出数量 *" type="number" min=".000001" max={c.quantity - .000001} step=".000001" required value={splitQuantity} onChange={e => setSplitQuantity(e.target.value)}/><SaveBar busy={busy} label="确认拆分数量"/></form> : null}
    {c.status === 'completed' && c.kind === 'stock' ? <StockTransfer item={c} data={data} run={run} busy={busy} user={user}/> : null}
  </details>;
}

function StockTransfer({ item, data, run, busy, user }) {
  const [target, setTarget] = useState(''), [quantity, setQuantity] = useState('');
  const moves = (data.stock_moves || []).filter(m => m.purchase_case_id === item.id);
  const remaining = item.quantity - moves.filter(m => !m.voided_at).reduce((n,m) => n + m.quantity, 0);
  const targets = data.order_lines.filter(l => data.orders.some(o => o.id === l.order_id && o.status === 'confirmed' && !o.archived_at) && l.demand_quantity > l.purchased + .000001);
  return <><p>库存剩余 {q(remaining)} · {item.location}</p>{moves.map(m => <p key={m.id}>已转出 {q(m.quantity)}，成本 {money(m.cost_cents)} {m.voided_at ? <Badge>已撤销</Badge> : user.is_admin ? <Revoke path={`/stock-moves/${m.id}/void`} run={run} busy={busy} label="撤销转单"/> : null}</p>)}{remaining > .000001 ? <form onSubmit={e => { e.preventDefault(); run(() => api(`/purchase-cases/${item.id}/stock-transfer`, { target_order_line_id: Number(target), quantity }), '库存已转入订单'); }}><div className="form-grid"><Field label="库存转入料品"><select required value={target} onChange={e => setTarget(e.target.value)}><option value="">请选择订单料品</option>{targets.map(l => <option key={l.id} value={l.id}>{data.orders.find(o => o.id === l.order_id)?.po} · {l.name}</option>)}</select></Field><InputField label="库存转出数量" type="number" required min=".000001" max={remaining} step=".000001" value={quantity} onChange={e => setQuantity(e.target.value)}/></div><SaveBar busy={busy} label="确认库存转单"/></form> : null}</>;
}

function PurchaseCorrection({ lines, data, run, busy }) {
  const [lineId, setLineId] = useState(''), [quantity, setQuantity] = useState(''), [cost, setCost] = useState(''), [reason, setReason] = useState('');
  return <form onSubmit={e => { e.preventDefault(); run(() => api(`/purchase-lines/${lineId}/correct`, { quantity, cost, reason }), '采购明细已更正'); }}><p className="muted">仅用于尚无包裹、送货或处理记录的录入错误。有后续业务时请先核实下游记录，业务变更请登记采购处理。</p><div className="form-grid"><Field label="需要更正的明细"><select required value={lineId} onChange={e => { const l = lines.find(x => x.id === Number(e.target.value)); setLineId(e.target.value); setQuantity(l?.quantity || ''); setCost(l ? l.cost_cents / 100 : ''); }}><option value="">请选择</option>{lines.map(l => <option key={l.id} value={l.id}>{data.order_lines.find(o => o.id === l.order_line_id)?.name}</option>)}</select></Field><InputField label="更正后的需求数量" required type="number" min=".000001" step=".000001" value={quantity} onChange={e => setQuantity(e.target.value)}/><InputField label="更正后的分摊成本" required type="number" min="0" step=".01" value={cost} onChange={e => setCost(e.target.value)}/><InputField label="更正原因 *" required value={reason} onChange={e => setReason(e.target.value)}/></div><SaveBar busy={busy} label="确认更正"/></form>;
}
