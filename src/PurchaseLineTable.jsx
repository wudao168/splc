import React from 'react';
import { Trash2 } from 'lucide-react';
import { money } from './api';
import { Badge, Table } from './components';

/** 采购明细行：客户料品行（可直发或入库）与仅料品的备货行（固定入库）混排。 */
export default function PurchaseLineTable({ rows, data, available, orders, change, remove }) {
  const warehouses = (data.warehouses || []).filter(warehouse => warehouse.active !== 0);
  return <Table headers={['客户料品 / 备货料品','收货地址','对应需求数量','实际包装数量','采购单位','采购规格','收货方式','入库仓库','自动分摊金额','']} minWidth={1120}>
    {rows.map(row => {
      const linked = !!row.order_line_id;
      const line = linked ? available.find(item => item.id === row.order_line_id) : null;
      const item = linked ? null : (data.items || []).find(x => x.id === row.item_id);
      const name = linked ? line?.name : item?.name;
      const key = row.key ?? (linked ? `L${row.order_line_id}` : `P${row.item_id}`);
      const mode = row.receive_mode || (linked ? 'direct' : 'stock');
      return <tr key={key}>
        <td>{linked
          ? <><strong>{name}</strong><small>{orders[line.order_id]?.po}</small></>
          : <><strong>{name || '—'}</strong><small className="mono">{item?.code} · 公共备货</small></>}</td>
        <td title={linked ? orders[line.order_id]?.address : '不关联订单，入库后进入可用库存'}>{linked ? (orders[line.order_id]?.address || '—') : '公共备货（不关联订单）'}</td>
        <td><input aria-label={`${name}对应需求数量`} className="small-input" type="number" min=".000001" step=".000001" required value={row.quantity} onChange={e => change(key, 'quantity', e.target.value)}/></td>
        <td><input aria-label={`${name}实际包装数量`} className="small-input" type="number" min=".000001" step=".000001" required value={row.purchase_quantity} onChange={e => change(key, 'purchase_quantity', e.target.value)}/></td>
        <td><input aria-label={`${name}采购单位`} className="small-input" required value={row.purchase_unit} onChange={e => change(key, 'purchase_unit', e.target.value)}/></td>
        <td><input aria-label={`${name}采购规格`} value={row.purchase_spec} onChange={e => change(key, 'purchase_spec', e.target.value)}/></td>
        <td>{linked
          ? <select aria-label={`${name}收货方式`} value={mode} onChange={e => change(key, 'receive_mode', e.target.value)}><option value="direct">直发客户</option><option value="stock">入库</option></select>
          : <Badge tone="green">入库</Badge>}</td>
        <td>{mode === 'stock'
          ? <select aria-label={`${name}入库仓库`} value={row.warehouse_id || ''} onChange={e => change(key, 'warehouse_id', e.target.value)}><option value="">默认仓库</option>{warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
          : '—'}</td>
        <td>{linked
          ? <span aria-label={`${name}自动分摊金额`}>{money(Math.round(Number(row.cost || 0) * 100))}</span>
          : <input aria-label={`${name}备货成本`} className="small-input" type="number" min="0" step=".01" value={row.cost} onChange={e => change(key, 'cost', e.target.value)}/>}</td>
        <td><button type="button" className="icon-button" aria-label={`移除${name}`} onClick={() => remove(key)}><Trash2 size={16}/></button></td>
      </tr>;
    })}
  </Table>;
}
