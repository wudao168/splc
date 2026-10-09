import React, { useEffect, useRef, useState } from 'react';
import { Panel, Table, Empty, SearchSelect } from './components';
import Pagination, { usePagination } from './Pagination';
import { api } from './api';

const reportColumnWidths = {
  orders: [3,2,1,1,1,1,1,1,1,1],
  pending: [3,2,1,2,2,1,1,1,1],
  purchases: [1,2,2,3,2,1,1,1,1,3,4],
  invoices: [1,2,2,3,2,1,1,1,1,1,1],
  delivery: [3,2,1,2,2,1,1,1,1,1],
};

export default function Reports({ selection, data }) {
  const [kind, setKind] = useState('orders'), [scope, setScope] = useState('');
  const [start, setStart] = useState(''), [end, setEnd] = useState(''), [customer, setCustomer] = useState(''), [po, setPo] = useState('');
  const [report, setReport] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const pagination = usePagination(report?.rows.length || 0);
  useEffect(() => { setKind(selection.kind); setScope(selection.scope || ''); setStart(''); setEnd(''); setCustomer(''); setPo(''); pagination.setPage(1); }, [selection]);
  const query = new URLSearchParams({kind, scope, start, end, customer, po}).toString();
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    const timer = setTimeout(() => api(`/reports?${query}`).then(result => { if (!cancelled) setReport(result); }).catch(e => { if (!cancelled) setError(e.message); }).finally(() => { if (!cancelled) setLoading(false); }), 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, data]);
  const change = setter => event => { setter(event.target.value); pagination.setPage(1); };
  const tableRef = useRef(null);
  useEffect(() => {
    // 汇总行吸顶时要贴在表头下方，表头高度随标题换行变化，这里实时量一下。
    const element = tableRef.current;
    if (!element) return;
    const measure = () => {
      const head = element.querySelector('thead th');
      if (head) element.style.setProperty('--report-head-height', `${Math.round(head.getBoundingClientRect().height)}px`);
    };
    const observer = new ResizeObserver(measure);
    const head = element.querySelector('thead');
    if (head) observer.observe(head);
    window.addEventListener('resize', measure);
    measure();
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [report, kind])
  const customerOptions = [...new Set([...(report?.customers || []), ...data.orders.map(o => o.customer)])].filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  return <Panel className="dashboard-reports">
    <div className="toolbar report-filters">
      <label><select aria-label="报表类型" value={kind} onChange={event => { setKind(event.target.value); setScope(''); pagination.setPage(1); }}>{[['orders','客户订单汇总'],['pending','待采购明细'],['purchases','采购明细'],['invoices','发票汇总'],['delivery','交付明细']].map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label><input aria-label="报表开始日期" type="date" value={start} onChange={change(setStart)}/></label>
      <label><input aria-label="报表截止日期" type="date" value={end} onChange={change(setEnd)}/></label>
      <label><SearchSelect label="报表客户" allowText value={customer} onChange={value => { setCustomer(value); pagination.setPage(1); }} options={customerOptions}/></label>
      <label><input aria-label="报表客户 PO" placeholder="搜索客户 PO" value={po} onChange={change(setPo)}/></label>
      {scope ? <button className="text-button" onClick={() => setScope('')}>{scope === 'transit' ? '仅看在途采购' : '仅看待收票'} ×</button> : null}
      <a className={`button secondary report-export ${loading || error ? 'disabled' : ''}`} aria-disabled={loading || !!error} onClick={event => { if (loading || error) event.preventDefault(); }} href={`/api/reports.xlsx?${query}`}>导出 Excel</a>
    </div>
    {loading ? <p className="muted">正在加载报表…</p> : error ? <p className="error" role="alert">{error}</p> : report ? <><div className="report-table" ref={tableRef}><Table headers={report.headers.map(header => header === '实际发货数量 / 需求数量' ? '发货 / 需求' : header === '成本差额（元）' ? '毛利（元）' : header)} columnWidths={reportColumnWidths[kind]}>{report.summary ? <tr className="report-summary">{report.summary.map((value,i) => <td key={i}><strong>{typeof value === 'number' ? value.toLocaleString('zh-CN',{maximumFractionDigits:6}) : value || '—'}</strong></td>)}</tr> : null}{report.rows.slice(pagination.start,pagination.end).map((row,index) => <tr key={index}>{row.map((value,i) => <td key={i}>{typeof value === 'number' ? value.toLocaleString('zh-CN',{maximumFractionDigits:6}) : value || '—'}</td>)}</tr>)}</Table></div>{!report.rows.length ? <Empty compact title="没有符合筛选条件的数据"/> : null}<Pagination label="统计报表" total={report.rows.length} pagination={pagination} onPageChange={pagination.setPage} onPageSizeChange={pagination.setPageSize}/></> : null}
  </Panel>;
}
