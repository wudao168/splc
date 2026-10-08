import React from 'react';
import { q } from './api';
import { Table } from './components';

const normalize = value => String(value || '').normalize('NFKC').toUpperCase().replace(/[\s\-_/／()（）]+/g, '');

/** 与后端一致的保守匹配：客户型号（含历史对应写法）或“名称 + 规格”完全一致。 */
export function candidateItems(items, line, aliases = []) {
  const code = normalize(line.customer_code), name = normalize(line.name), spec = normalize(line.spec);
  if (!code && !(name && spec)) return [];
  return (items || []).filter(item => item.active !== 0 && (
    (code && normalize(item.customer_code) === code)
    || (code && aliases.some(alias => alias.item_id === item.id && normalize(alias.alias) === code))
    || (name && normalize(item.name) === name && spec && normalize(item.spec) === spec)));
}

export function matchItem(items, line, aliases = []) {
  const matches = candidateItems(items, line, aliases);
  return matches.length === 1 ? matches[0] : null;
}

export default function StockLookup({ lines, data }) {
  const items = data.items || [];
  const aliases = data.item_aliases || [];
  const rows = lines.map((line, index) => {
    if (!(line.name || '').trim() && !(line.spec || '').trim() && !(line.customer_code || '').trim()) return null;
    const matches = candidateItems(items, line, aliases);
    return { index, line, item: matches.length === 1 ? matches[0] : null, ambiguous: matches.length > 1 };
  }).filter(Boolean);
  if (!rows.length) return null;
  return <div className="stock-lookup">
    <div className="stock-lookup-title">料品库存参考 · 按型号自动匹配料品档案</div>
    <Table headers={['料品名称','规格型号','料品编号','现存量','可用库存','预计可供量']}>{rows.map(({ index, line, item, ambiguous }) => <tr key={index}>
      <td>{line.name || '—'}</td><td>{line.spec || '—'}</td>
      <td>{item ? <span className="mono">{item.code}</span> : ambiguous ? <span className="text-orange">多个匹配，请核对</span> : <span className="muted">待匹配料品</span>}</td>
      <td>{item ? q(item.on_hand) : '—'}</td><td>{item ? q(item.available) : '—'}</td>
      <td>{item ? q(item.available + Math.max(0, item.incoming_unallocated)) : '—'}</td></tr>)}</Table>
    <p className="muted footnote">库存为实时参考，确认订单并安排供货后才占用；保存订单时会写入统一料品编号，客户型号与标准型号的对应关系同时记录。</p>
  </div>;
}
