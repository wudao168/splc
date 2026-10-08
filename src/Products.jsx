import React, { useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { api, money, q } from './api';
import { Panel, Table, FixedCell, Empty, Button, Badge, SearchBox } from './components';
import { ItemForm, ItemRowActions } from './Items';
import { ColumnSettings, useColumnSettings } from './columnSettings';

const PRODUCT_COLUMNS = [['code','料品编号'],['name','名称'],['spec','标准型号'],['brand','品牌'],['key_specs','关键规格'],['unit','单位'],['customer_code','客户型号'],['supplier_code','供应商型号'],['on_hand','现存量'],['reserved','已占用'],['available','可用库存'],['incoming','公共在途'],['cost','加权成本'],['value','库存金额'],['usage','引用'],['active','状态'],['actions','操作']];

export default function Products({ data, run, busy, refresh, navigate, user }) {
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(null);
  const [showInactive, setShowInactive] = useState(false);
  const { hidden, toggle, reset, attr } = useColumnSettings(user, 'products');
  const term = search.trim().toLowerCase();
  const items = (data.items || []).filter(item => item.active !== 0 || showInactive).filter(item =>
    !term || [item.code, item.name, item.spec, item.brand, item.key_specs, item.customer_code, item.supplier_code]
      .filter(Boolean).join(' ').toLowerCase().includes(term));
  const aliasesFor = item => (data.item_aliases || []).filter(x => x.item_id === item.id);
  const orderUsage = item => new Set(data.order_lines.filter(line => line.item_id === item.id).map(line => line.order_id)).size;
  const purchaseUsage = item => data.purchase_lines.filter(line => line.item_id === item.id).length;
  const totals = data.inventory_totals || {};
  return <div className="products-page">
    <Panel data-hidden-columns={attr}>
      <div className="toolbar"><SearchBox value={search} onChange={setSearch} placeholder="搜索料品编号、名称、标准型号、品牌或客户型号…"/><label className="check-label product-inactive-toggle"><input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)}/>显示已停用料品</label><div className="toolbar-actions"><ColumnSettings columns={PRODUCT_COLUMNS} hidden={hidden} onToggle={toggle} onReset={reset}/><Button secondary disabled={busy} onClick={refresh}><RefreshCw size={16}/>刷新</Button><Button secondary disabled={busy} onClick={() => { if (window.confirm('按“名称 + 标准型号 + 品牌”精确匹配，为历史订单和采购明细补建或关联料品档案。名称相同但型号不同的会各自建档；有多个候选的明细保留人工确认。确定继续？')) run(() => api('/items/backfill', {}), result => ({ text: `已补建料品：关联 ${result.linked} 条明细，新建 ${result.created} 个料品${result.skipped ? `，跳过 ${result.skipped} 条待人工确认` : ''}` })); }}>从历史单据补建料品</Button><Button onClick={() => setModal({})}><Plus size={16}/>新增料品</Button></div></div>
      <div className="invoice-summary inventory-summary"><div><small>料品数</small><strong>{items.length}</strong></div><div><small>现存量</small><strong>{q(totals.on_hand || 0)}</strong></div><div><small>可用库存</small><strong>{q(totals.available || 0)}</strong></div><div><small>公共在途</small><strong>{q(totals.incoming || 0)}</strong></div><div><small>库存金额</small><strong>{money(totals.value_cents || 0)}</strong></div><div><small>型号对应</small><strong>{(data.item_aliases || []).length}</strong></div></div>
      <Table minWidth={1420} headers={['料品编号','名称','标准型号','品牌','关键规格','单位','客户型号','供应商型号','现存量','已占用','可用库存','公共在途','加权成本','库存金额','引用','状态','操作']}>
        {items.map(item => <tr key={item.id}>
          <FixedCell className="mono">{item.code}</FixedCell>
          <FixedCell title={item.name}><strong>{item.name}</strong></FixedCell>
          <FixedCell title={item.spec || '规格未填写'}>{item.spec || '—'}</FixedCell>
          <FixedCell title={item.brand || '—'}>{item.brand || '—'}</FixedCell>
          <FixedCell title={item.key_specs || '—'}>{item.key_specs || '—'}</FixedCell>
          <FixedCell>{item.unit}</FixedCell>
          <FixedCell title={[...new Set([item.customer_code, ...aliasesFor(item).filter(x => x.source === '客户型号').map(x => x.alias)].filter(Boolean))].join('、') || '—'}>{item.customer_code || (aliasesFor(item).length ? `${aliasesFor(item).length} 个写法` : '—')}</FixedCell>
          <FixedCell title={item.supplier_code || '—'}>{item.supplier_code || '—'}</FixedCell>
          <FixedCell>{q(item.on_hand)}</FixedCell>
          <FixedCell>{q(item.reserved)}</FixedCell>
          <FixedCell className={item.available > 0 ? 'purchase-complete' : undefined}>{q(item.available)}</FixedCell>
          <FixedCell>{q(item.incoming_unallocated)}</FixedCell>
          <FixedCell>{money(item.avg_cost_cents)}</FixedCell>
          <FixedCell>{money(item.value_cents)}</FixedCell>
          <FixedCell title={`被 ${orderUsage(item)} 笔订单、${purchaseUsage(item)} 条采购明细引用`}>{orderUsage(item)} / {purchaseUsage(item)}</FixedCell>
          <FixedCell><Badge tone={item.active === 0 ? 'gray' : 'green'}>{item.active === 0 ? '已停用' : '启用中'}</Badge></FixedCell>
          <FixedCell><div className="order-actions"><ItemRowActions item={item} run={run} busy={busy} onEdit={setModal}/>
            <button className="text-button" onClick={() => navigate('inventory')}>库存</button></div></FixedCell>
        </tr>)}
      </Table>
      {!items.length ? <Empty title={search ? '没有符合条件的料品' : '产品库还没有料品'}>可以直接新增料品，也可以在订单或采购录入时按型号自动建档。</Empty> : null}
    </Panel>
    {modal ? <ItemForm item={modal.id ? modal : null} data={data} run={run} busy={busy} onClose={() => setModal(null)}/> : null}
  </div>;
}
