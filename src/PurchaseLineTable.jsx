import React from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { money } from './api';
import { Table } from './components';

const rowKeyOf = row => row.key ?? (row.order_line_id ? `L${row.order_line_id}` : `P${row.item_id}`);
/** 金额输入：只保留数字与一个小数点，避免被格式化后无法继续输入（同时不使用数字微调控件）。 */
const typedNumber = value => { const cleaned = String(value ?? '').replace(/[^\d.]/g, ''); const [head, ...rest] = cleaned.split('.'); return rest.length ? `${head}.${rest.join('')}` : head; };
/** 采购明细行：平台采购（客户料品，金额按实付款分摊，可手改锁定）与常规采购（产品库备货，手填单价自动算金额）。 */
export default function PurchaseLineTable({ mode = 'platform', rows, rawRows = [], data, available, orders, change, remove, editCost, resetManual }) {
  const warehouses = (data.warehouses || []).filter(warehouse => warehouse.active !== 0);
  const itemList = data.items || [];
  const rawOf = key => rawRows.find(row => rowKeyOf(row) === key) || {};
  if (mode === 'regular') return <Table headers={['备货料品','单位','规格','数量','单价（元）','金额（元）','入库仓库','']} minWidth={1020}>
    {rows.map(row => {
      const item = itemList.find(x => x.id === row.item_id);
      const name = item?.name || '—';
      const key = rowKeyOf(row);
      const amountCents = Math.round((Number(row.unit_price) || 0) * (Number(row.quantity) || 0) * 100);
      return <tr key={key}>
        <td title={name}><strong>{name}</strong><small className="mono">{item?.code} · 备货入库</small></td>
        <td><input aria-label={`${name}采购单位`} className="small-input" required value={row.purchase_unit} onChange={e => change(key, 'purchase_unit', e.target.value)}/></td>
        <td><input aria-label={`${name}采购规格`} value={row.purchase_spec} onChange={e => change(key, 'purchase_spec', e.target.value)}/></td>
        <td><input aria-label={`${name}数量`} className="small-input" type="number" min="0" step="any" required value={row.quantity} onChange={e => change(key, 'quantity', e.target.value)}/></td>
        <td><input aria-label={`${name}单价`} className="small-input cost-input" type="text" inputMode="decimal" autoComplete="off" placeholder="0.00" value={row.unit_price ?? ''} onChange={e => change(key, 'unit_price', typedNumber(e.target.value))}/></td>
        <td aria-label={`${name}金额`}>{money(amountCents)}</td>
        <td><select aria-label={`${name}入库仓库`} value={row.warehouse_id || ''} onChange={e => change(key, 'warehouse_id', e.target.value)}><option value="">默认仓库</option>{warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></td>
        <td><button type="button" className="icon-button" aria-label={`移除${name}`} onClick={() => remove(key)}><Trash2 size={16}/></button></td>
      </tr>;
    })}
  </Table>;
  return <Table headers={['客户料品','客户 PO','需求数量','单位','规格','收货方式','入库仓库','报价单价','分摊金额','']} minWidth={1240}>
    {rows.map(row => {
      const line = available.find(item => item.id === row.order_line_id);
      const order = line ? orders[line.order_id] : null;
      const name = line?.name || '—';
      const key = rowKeyOf(row);
      const raw = rawOf(key);
      const manual = !!raw.manual;
      const modeValue = row.receive_mode || 'direct';
      return <tr key={key}>
        <td title={name}><strong>{name}</strong></td>
        <td title={order ? `${order.po} · ${order.customer}` : ''}><strong>{order?.po || '—'}</strong>{order?.customer ? <small>{order.customer}</small> : null}</td>
        <td><input aria-label={`${name}对应需求数量`} className="small-input" type="number" min="0" step="any" required value={row.quantity} onChange={e => change(key, 'quantity', e.target.value)}/></td>
        <td><input aria-label={`${name}采购单位`} className="small-input" required value={row.purchase_unit} onChange={e => change(key, 'purchase_unit', e.target.value)}/></td>
        <td><input aria-label={`${name}采购规格`} value={row.purchase_spec} onChange={e => change(key, 'purchase_spec', e.target.value)}/></td>
        <td><select aria-label={`${name}收货方式`} value={modeValue} onChange={e => change(key, 'receive_mode', e.target.value)}><option value="direct">直发客户</option><option value="stock">入库</option></select></td>
        <td>{modeValue === 'stock'
          ? <select aria-label={`${name}入库仓库`} value={row.warehouse_id || ''} onChange={e => change(key, 'warehouse_id', e.target.value)}><option value="">默认仓库</option>{warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
          : '—'}</td>
        <td className="purchase-quote-price" title="客户订单报价单价（含税）">{line ? money(line.price_cents) : '—'}</td>
        <td><div className="purchase-cost-cell">
          <input aria-label={`${name}分摊金额`} className="small-input cost-input" type="text" inputMode="decimal" autoComplete="off" value={manual ? String(raw.cost ?? '') : row.cost} onChange={e => editCost(key, typedNumber(e.target.value))}/>
          {manual ? <span className="purchase-manual-tag" title="已手动修改，自动分摊会跳过本行">手动</span> : null}
        </div></td>
        <td className="purchase-line-actions">
          {manual ? <button type="button" className="icon-button" aria-label={`恢复${name}自动分摊`} title="恢复自动分摊" onClick={() => resetManual(key)}><RotateCcw size={15}/></button> : null}
          <button type="button" className="icon-button" aria-label={`移除${name}`} onClick={() => remove(key)}><Trash2 size={16}/></button>
        </td>
      </tr>;
    })}
  </Table>;
}
