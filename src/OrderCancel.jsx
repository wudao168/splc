import React, { useState } from 'react';
import { api, money, q } from './api';
import { InputField, Modal, SaveBar, Table } from './components';

/** 列表行是否可以用「取消订单」：已确认且还有未发货数量可取消。 */
export function canCancelOrder(data, order) {
  return order.status === 'confirmed' && (data.order_lines || [])
    .some(line => line.order_id === order.id && (line.cancel_available || 0) > 1e-6);
}

const round6 = value => Math.round((Number(value) || 0) * 1e6) / 1e6;

/** 取消订单登记：默认按可取消数量填满，可逐行修改；只取消未发数量，已发货部分走退货。 */
export default function OrderCancelForm({ order, data, run, busy, user, onClose }) {
  const lines = (data.order_lines || []).filter(line => line.order_id === order.id);
  const cancellable = lines.filter(line => (line.cancel_available || 0) > 1e-6);
  const [quantities, setQuantities] = useState(() => Object.fromEntries(cancellable.map(line => [line.id, round6(line.cancel_available)])));
  const [reason, setReason] = useState('');
  const amountOf = line => Math.round(Number(quantities[line.id] || 0) * (line.price_cents || 0)) / 100;
  const chosen = cancellable.filter(line => Number(quantities[line.id] || 0) > 1e-6);
  const total = chosen.reduce((sum, line) => sum + amountOf(line), 0);
  const reserved = lines.filter(line => (line.quantity - (line.cancelled_quantity || 0) - (line.cancel_available || 0) - Math.max(line.dispatched_quantity || 0, line.logistics_dispatched_quantity || 0)) > 1e-6);
  const purchasing = lines.filter(line => (line.purchased || 0) > 1e-6 && (line.cancel_available || 0) > 1e-6);

  async function submit(event) {
    event.preventDefault();
    let saved = false;
    await run(async () => {
      if (!chosen.length) throw new Error('请填写本次取消数量');
      let purchasePending = false;
      for (const line of chosen) {
        const result = await api(`/orders/${order.id}/cases`, {
          order_line_id: line.id, kind: 'cancel', quantity: Number(quantities[line.id]), reason, owner_id: user?.id,
        });
        if (user?.is_admin) {
          try { await api(`/order-cases/${result.id}/complete`, {}); }
          catch { purchasePending = true; }
        }
      }
      saved = true;
      return { count: chosen.length, purchasePending };
    }, result => `已登记取消 ${result.count} 项未发数量${result.purchasePending ? '；采购在途部分请到「采购」页继续处理' : ''}`);
    if (saved) onClose();
  }

  return <Modal wide title={`取消订单 · ${order.po}`} onClose={onClose}>
    <form className="order-cancel-form" onSubmit={submit}>
      <p className="notice">客户 {order.customer} · 默认按可取消数量填满、可修改；只取消尚未发货的数量，已发货部分请用「退货」登记。金额按订单单价冲减应收，登记后立即生效。</p>
      <div className="form-grid order-cancel-fields">
        <InputField label="取消原因 *" wide required value={reason} onChange={e => setReason(e.target.value)} placeholder="例如：客户取消、交期无法满足、客户改单"/>
      </div>
      <Table headers={['料品 / 规格', '订购', '已取消', '已发货', '可取消', '本次取消', '取消金额', '采购在途']} minWidth={900}>
        {lines.map(line => <tr key={line.id}>
          <td>{line.name}<small>{line.spec || '—'}</small></td>
          <td>{q(line.quantity)}</td>
          <td>{q(line.cancelled_quantity || 0)}</td>
          <td>{q(Math.max(line.dispatched_quantity || 0, line.logistics_dispatched_quantity || 0))}</td>
          <td>{q(line.cancel_available || 0)}</td>
          <td>{(line.cancel_available || 0) > 1e-6
            ? <input aria-label={`${line.name}本次取消数量`} className="small-input" type="number" min="0" max={round6(line.cancel_available)} step="any" value={quantities[line.id] ?? ''} onChange={e => setQuantities(current => ({ ...current, [line.id]: e.target.value }))}/>
            : '—'}</td>
          <td>{money(Math.round(Number(quantities[line.id] || 0) * (line.price_cents || 0)))}</td>
          <td>{(line.purchased || 0) > 1e-6 ? <span className="text-orange">{q(line.purchased)}<small>取消后转采购页处理</small></span> : 0}</td>
        </tr>)}
      </Table>
      {reserved.length ? <p className="notice warning">有料品被未发货送货单占用（{reserved.map(line => line.name).join('、')}），这部分数量需先到「送货单」作废对应单据后才能取消。</p> : null}
      {purchasing.length ? <p className="muted footnote">有采购在途的料品，取消确认后会在「采购」页生成待处理的采购变更，请按取消采购、退供应商或转库存处理完成后核对。</p> : null}
      <p className="muted footnote">本次取消 {chosen.length} 项、合计 {money(Math.round(total * 100))}（按订单单价冲减应收，登记后立即生效）。</p>
      <SaveBar busy={busy} disabled={!chosen.length || !reason.trim()} label="确认取消订单" onCancel={onClose}/>
    </form>
  </Modal>;
}
