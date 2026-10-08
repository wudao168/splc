import React, { useEffect, useRef, useState } from 'react';
import { q } from './api';
import { Button, Table } from './components';

/** 从产品库挑料品：与“关联料品”一致的左侧抽屉，仅料品行按入库方式进入采购明细。 */
export default function ProductPicker({ data, addedIds = [], onAdd, onClose }) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState([]);
  const searchRef = useRef(null);
  useEffect(() => { searchRef.current?.focus(); }, []);
  const term = search.trim().toLowerCase();
  const added = new Set(addedIds);
  const items = (data.items || []).filter(item => item.active !== 0).filter(item => !term ||
    [item.code, item.name, item.spec, item.brand, item.key_specs, item.customer_code, item.supplier_code]
      .filter(Boolean).join(' ').toLowerCase().includes(term));
  const selectable = items.filter(item => !added.has(item.id));
  const allSelected = selectable.length > 0 && selectable.every(item => selected.includes(item.id));
  const toggle = id => setSelected(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);
  return <div className="purchase-line-picker-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="purchase-line-picker product-picker" role="dialog" aria-modal="true" aria-label="从产品库选择料品">
      <div className="purchase-line-picker-head"><h2>从产品库选择料品</h2><button type="button" className="text-button" onClick={onClose}>关闭</button></div>
      <div className="purchase-line-picker-actions"><Button secondary type="button" onClick={onClose}>取消</Button><Button type="button" disabled={!selected.length} onClick={() => onAdd(selected)}>确认选择（{selected.length}）</Button></div>
      <div className="purchase-line-picker-search"><input ref={searchRef} aria-label="搜索产品库料品" placeholder="搜索料品编号、名称、标准型号、品牌或客户型号" value={search} onChange={event => setSearch(event.target.value)}/><span>{items.length} 项结果 · 已选 {selected.length} 项</span></div>
      <Table className="product-picker-table" minWidth={960} headers={[<input type="checkbox" aria-label="全选料品" checked={allSelected} disabled={!selectable.length} onChange={e => setSelected(e.target.checked ? selectable.map(item => item.id) : [])}/>,'料品编号','料品名称','标准型号','品牌','单位','现存量','可用库存','公共在途','操作']}>
        {items.map(item => <tr key={item.id}>
          <td><input type="checkbox" aria-label={`选择料品 ${item.code}`} checked={added.has(item.id) || selected.includes(item.id)} disabled={added.has(item.id)} onChange={() => toggle(item.id)}/></td>
          <td className="mono">{item.code}</td><td>{item.name}</td><td>{item.spec || '—'}</td><td>{item.brand || '—'}</td><td>{item.unit}</td>
          <td>{q(item.on_hand)}</td><td>{q(item.available)}</td><td>{q(item.incoming_unallocated)}</td>
          <td>{added.has(item.id) ? '已加入' : <Button secondary type="button" onClick={() => onAdd([item.id])}>加入</Button>}</td>
        </tr>)}
      </Table>
      {!items.length ? <p className="muted purchase-line-picker-empty">{search ? '没有符合条件的料品' : '产品库还没有料品，请先到“产品库”新增。'}</p> : null}
      <p className="muted footnote product-picker-note">仅关联料品的采购不绑定客户订单，收货方式固定为“入库”；到货后从“库存 → 登记入库”办理，入库后进入可用库存，可再分配给需要的订单。</p>
    </section>
  </div>;
}
