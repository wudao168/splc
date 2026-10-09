import React, { useState } from 'react';
import { api, money } from './api';
import { Button, Field, InputField, Modal, SaveBar, Table } from './components';

/** 某张订单当前还能退货的送货明细（已发货、未撤销、且还有未申请售后的数量）。 */
export function returnableDeliveries(data, orderId) {
  const deliveries = new Map((data.deliveries || []).map(item => [item.id, item]));
  const claimed = new Map();
  for (const item of data.order_cases || []) {
    if (item.kind !== 'return' || item.status === 'void') continue;
    claimed.set(item.delivery_line_id, (claimed.get(item.delivery_line_id) || 0) + item.quantity);
  }
  const lineIds = new Set((data.order_lines || []).filter(line => line.order_id === orderId).map(line => line.id));
  return (data.delivery_lines || [])
    .filter(line => lineIds.has(line.order_line_id) && deliveries.get(line.delivery_id)?.status === 'active' && deliveries.get(line.delivery_id)?.shipped_at)
    .map(line => ({ ...line, delivery: deliveries.get(line.delivery_id), returned: claimed.get(line.id) || 0 }))
    .map(line => ({ ...line, available: Math.max(0, line.quantity - line.returned) }))
    .filter(line => line.available > 1e-6);
}

/** 列表行的「退货」登记：按已发货明细填退货数量，默认退回入库存、冲减应收。 */
export default function OrderReturnForm({ order, data, run, busy, user, onClose }) {
  const rows = returnableDeliveries(data, order.id).map(item => {
    const line = (data.order_lines || []).find(x => x.id === item.order_line_id) || {};
    return { ...item, line };
  });
  const [quantities, setQuantities] = useState(() => Object.fromEntries(rows.map(item => [item.id, ''])));
  const [locations, setLocations] = useState({});
  const [form, setForm] = useState({
    reason: '', destination: 'stock', warehouse_id: String((data.warehouses || []).find(item => item.active !== 0)?.id || ''),
    location: '', received: true, financial_type: 'reduce_receivable', amount: '', note: '',
  });
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const chosen = rows.filter(item => Number(quantities[item.id] || 0) > 0);
  const suggested = chosen.reduce((sum, item) => sum + Math.round(Number(quantities[item.id]) * (item.line.price_cents || 0)), 0) / 100;
  const amount = form.financial_type === 'none' ? 0 : (form.amount === '' ? suggested : Number(form.amount) || 0);
  const totals = chosen.map(item => Math.round(Number(quantities[item.id]) * (item.line.price_cents || 0)) / 100);
  const weight = totals.reduce((sum, value) => sum + value, 0);
  const split = totals.map((value, index) => index === totals.length - 1
    ? Math.max(0, Math.round(amount * 100) - totals.slice(0, -1).reduce((sum, item, j) => sum + (weight ? Math.round(amount * 100 * totals[j] / weight) : 0), 0))
    : (weight ? Math.round(amount * 100 * value / weight) : 0));

  async function submit(event) {
    event.preventDefault();
    let saved = false;
    await run(async () => {
      if (!chosen.length) throw new Error('请填写本次退货数量');
      const stock = form.destination === 'stock';
      let purchasePending = false;
      for (const [index, item] of chosen.entries()) {
        const quantity = Number(quantities[item.id]);
        const caseResult = await api(`/orders/${order.id}/cases`, {
          order_line_id: item.order_line_id, kind: 'return', quantity, reason: form.reason, delivery_line_id: item.id,
          destination: form.destination, warehouse_id: stock ? Number(form.warehouse_id) : '',
          financial_type: form.financial_type === 'none' ? 'none' : form.financial_type,
          amount: form.financial_type === 'none' ? '' : (split[index] / 100).toFixed(2), note: form.note,
        });
        if (form.received) await api(`/order-cases/${caseResult.id}/update`, {
          received_quantity: quantity, location: locations[item.id] || form.location, note: noteText(form.note, stock),
        });
        if (form.received) {
          try { await api(`/order-cases/${caseResult.id}/complete`, {}); }
          catch { purchasePending = true; }
        }
      }
      saved = true;
      return { count: chosen.length, purchasePending };
    }, result => `已登记 ${result.count} 项退货${form.received ? (form.destination === 'stock' ? '，退回货物已入库存' : '') : '，待收货后入库'}${result.purchasePending ? '；关联采购处理请到「采购」页继续' : ''}`);
    if (saved) onClose();
  }

  return <Modal wide title={`登记退货 · ${order.po}`} onClose={onClose}>
    <form className="order-return-form" onSubmit={submit}>
      <p className="notice">客户 {order.customer} · 只列已发货且还能退货的明细；默认退回入库存（按原出库成本回冲），金额默认冲减应收。</p>
      <div className="form-grid order-return-fields">
        <InputField label="退货原因 *" required value={form.reason} onChange={e => set('reason', e.target.value)}/>
        <Field label="退回货物处理"><select value={form.destination} onChange={e => set('destination', e.target.value)}><option value="stock">退回入库存（默认）</option><option value="record">只做记录（不进库存）</option></select></Field>
        <Field label="金额处理"><select value={form.financial_type} onChange={e => set('financial_type', e.target.value)}><option value="reduce_receivable">冲减应收（默认）</option><option value="refund_received">已退款给客户</option><option value="none">不涉及金额</option></select></Field>
        {form.financial_type !== 'none' ? <InputField label="退货金额（元）" type="number" min="0" step="0.01" value={form.amount} onChange={e => set('amount', e.target.value)} placeholder={suggested.toFixed(2)} hint={`留空按订单单价自动计算：${suggested.toFixed(2)} 元`}/> : null}
        {form.destination === 'stock' ? <Field label="入库仓库 *"><select required value={form.warehouse_id} onChange={e => set('warehouse_id', e.target.value)}>{(data.warehouses || []).filter(item => item.active !== 0).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field> : null}
        {form.destination === 'stock' ? <InputField label="默认库位" value={form.location} onChange={e => set('location', e.target.value)} hint="未单独填写库位的行使用这里"/> : null}
        <InputField label="备注" value={form.note} onChange={e => set('note', e.target.value)}/>
      </div>
      <Table headers={['料品 / 规格', '发货单', '已发货', '已退', '可退', '本次退货', '退货金额', ...(form.destination === 'stock' ? ['库位'] : [])]} minWidth={900}>
        {rows.map(item => <tr key={item.id}>
          <td>{item.line.name}<small>{item.line.spec || '—'}</small></td>
          <td>{item.delivery?.number}<small>{(item.delivery?.shipped_at || '').slice(0, 10)}</small></td>
          <td>{item.quantity}</td>
          <td>{item.returned}</td>
          <td>{item.available}</td>
          <td><input aria-label={`${item.line.name}退货数量`} className="small-input" type="number" min="0" max={item.available} step="any" value={quantities[item.id] ?? ''} onChange={e => setQuantities(current => ({ ...current, [item.id]: e.target.value }))}/></td>
          <td>{money(Math.round(Number(quantities[item.id] || 0) * (item.line.price_cents || 0)))}</td>
          {form.destination === 'stock' ? <td><input aria-label={`${item.line.name}退货库位`} className="small-input" value={locations[item.id] || ''} onChange={e => setLocations(current => ({ ...current, [item.id]: e.target.value }))} placeholder={form.location || '库位/货架'}/></td> : null}
        </tr>)}
      </Table>
      <label className="check-label"><input type="checkbox" checked={form.received} onChange={e => set('received', e.target.checked)}/>退回货物已收到{form.destination === 'stock' ? '，确认后立即登记入库' : ''}（不勾选只登记退货申请）</label>
      <p className="muted footnote">已开票的订单请在「发票」页对相应发票做红冲或作废；退货金额登记后立即生效（退款会校验收款余额与发票分配，后续再增加角色复核）。</p>
      <SaveBar busy={busy} disabled={!chosen.length || !form.reason.trim()} label="登记退货" onCancel={onClose}/>
    </form>
  </Modal>;
}

const noteText = (note, stock) => note || (stock ? '客户退货已收回并入库存' : '客户退货已收回');
