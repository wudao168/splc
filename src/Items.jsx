import React, { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { api } from './api';
import { Button, Field, InputField, Modal, SaveBar, Table } from './components';

export const itemLabel = item => [item.code, item.name, item.spec ? `(${item.spec})` : ''].filter(Boolean).join(' ');

export function ItemForm({ item, data, run, busy, onClose }) {
  const [form, setForm] = useState(() => item
    ? { ...item, cost: (((item.on_hand > 0 ? item.avg_cost_cents : item.cost_cents) || 0) / 100) || '' }
    : { code: '', name: '', spec: '', brand: '', key_specs: '', unit: '个', purchase_unit: '', unit_factor: 1, customer_code: '', supplier_code: '', note: '', active: true, cost: '' });
  const [alias, setAlias] = useState({ source: '客户型号', alias: '' });
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const aliases = (data.item_aliases || []).filter(x => x.item_id === item?.id);
  return <Modal title={item ? `维护料品 · ${item.code}` : '新增料品档案'} onClose={onClose}>
    <form onSubmit={e => { e.preventDefault(); run(() => api(item ? `/items/${item.id}` : '/items', form), item ? '料品档案已更新' : '料品档案已新增'); onClose(); }}>
      <div className="form-grid"><InputField label="料品编号" value={form.code} onChange={e => set('code', e.target.value)} placeholder="留空自动生成 LP000001"/><InputField label="料品名称 *" required value={form.name} onChange={e => set('name', e.target.value)}/>
        <InputField label="标准型号 *" required value={form.spec} onChange={e => set('spec', e.target.value)} hint="各业务环节统一使用；客户写法记录在下方对应关系"/><InputField label="品牌" value={form.brand} onChange={e => set('brand', e.target.value)}/>
        <InputField label="关键规格" wide value={form.key_specs} onChange={e => set('key_specs', e.target.value)} placeholder="材质、尺寸、螺纹等型号相同但不能互换的差异"/>
        <InputField label="库存单位 *" required value={form.unit} onChange={e => set('unit', e.target.value)}/><InputField label="客户型号" value={form.customer_code} onChange={e => set('customer_code', e.target.value)}/>
        <InputField label="供应商型号" value={form.supplier_code} onChange={e => set('supplier_code', e.target.value)}/><InputField label="备注" value={form.note} onChange={e => set('note', e.target.value)}/>
        {item?.purchase_inbound
          ? <InputField label="成本" readOnly value={((item.avg_cost_cents || 0) / 100).toFixed(2)} hint="已有采购入库，成本按采购加权平均自动计算，不能手工修改"/>
          : <InputField label="成本（元/单位）" type="number" min="0" step="0.01" value={form.cost} onChange={e => set('cost', e.target.value)} hint="无采购来源（公共备货）料品可维护：保存后按此单价重算当前库存金额；没有库存时作为登记入库的默认单价"/>}</div>
      <label className="check-label"><input type="checkbox" checked={form.active !== false} onChange={e => set('active', e.target.checked)}/>启用该料品（取消勾选后不参与新的匹配，历史订单、库存和流水保留）</label>
      <SaveBar busy={busy} label="保存料品"/>
    </form>
    {item ? <section className="item-aliases">
      <h3>型号对应关系</h3>
      <p className="muted footnote">同一料品在不同客户或供应商文件里的写法。首次匹配到新写法时系统会自动记录，也可以在这里手工维护。</p>
      <Table headers={['来源','型号写法','记录时间','操作']}>{aliases.map(row => <tr key={row.id}><td>{row.source}</td><td className="mono">{row.alias}</td><td>{row.created_at?.slice(0, 10)}</td>
        <td><button type="button" className="text-button delete-action" disabled={busy} onClick={() => run(() => api(`/items/${item.id}/aliases/${row.id}/delete`, {}), '型号对应已删除')}>删除</button></td></tr>)}</Table>
      {!aliases.length ? <p className="muted footnote">暂无手工记录的对应关系。</p> : null}
      <div className="item-alias-form"><Field label="来源"><select value={alias.source} onChange={e => setAlias(current => ({ ...current, source: e.target.value }))}>{['客户型号','供应商型号','其他写法'].map(x => <option key={x}>{x}</option>)}</select></Field>
        <InputField label="型号写法" value={alias.alias} onChange={e => setAlias(current => ({ ...current, alias: e.target.value }))} placeholder="如 ABC-100"/>
        <Button secondary type="button" disabled={busy || !alias.alias.trim()} onClick={() => run(async () => { await api(`/items/${item.id}/aliases`, alias); setAlias(current => ({ ...current, alias: '' })); }, '型号对应已添加')}>添加对应</Button></div>
    </section> : <p className="muted footnote">保存后可以在产品库为料品维护客户型号与供应商型号的对应关系。</p>}
  </Modal>;
}

export function ItemRowActions({ item, run, busy, onEdit }) {
  return <div className="order-actions"><button className="text-button" onClick={() => onEdit(item)}>编辑</button>
    <button type="button" className="text-button" disabled={busy} onClick={() => run(() => api(`/items/${item.id}`, { ...item, active: item.active === 1 ? false : true }), item.active === 1 ? '料品已停用' : '料品已启用')}>{item.active === 1 ? '停用' : '启用'}</button></div>;
}
