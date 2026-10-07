import React, { useState } from 'react';
import { Paperclip } from 'lucide-react';
import { api, money } from './api';
import { invoiceStatus } from './invoiceStatus';
import { Panel, Table, Empty, Badge, Button, SaveBar, InputField, Attachment } from './components';

export default function Invoices({ purchase: p, data, run, busy, onSyncPlatform }) {
  const [showForm, setShowForm] = useState(false);
  const status = invoiceStatus(p);
  const allocations = data.invoice_allocations.filter(a => a.purchase_id === p.id);
  const invoices = data.invoices.filter(i => allocations.some(a => a.invoice_id === i.id));
  const platformEntries = [...(p.taobao_source?.invoice_entries || [])];
  const platformDetails = p.taobao_source?.invoice_details || [];
  for (const detail of platformDetails) {
    const index = platformEntries.findIndex(entry => entry.status === '已开票' &&
      entry.amount_cents === detail.amount_cents && entry.date === detail.date);
    if (index >= 0) platformEntries.splice(index, 1);
  }
  const recordedOnly = invoices.filter(invoice => !platformDetails.some(detail => detail.number === invoice.number));
  const desktopAvailable = !!window.caidanDesktop?.syncInvoices;
  const syncButton = () => <Button secondary disabled={busy || !desktopAvailable} title={desktopAvailable ? '下载发票并关联此采购单' : '请打开采单客户端，登录淘宝后获取发票'} onClick={onSyncPlatform}>{busy ? '正在获取…' : '获取发票'}</Button>;
  const fileLink = attachmentId => <a href={`/api/files/${attachmentId}`} target="_blank" rel="noreferrer" className="text-button"><Paperclip size={15}/>查看文件</a>;
  const confirm = item => run(() => api('/invoices', {
    number: item.number, seller: p.shop, issued_date: item.date,
    amount: item.amount_cents / 100, attachment_id: item.attachment_id,
    allocations: [{ purchase_id: p.id, amount: item.amount_cents / 100 }]
  }), '已确认收票并关联采购');
  const hasRows = platformDetails.length || platformEntries.length || recordedOnly.length;
  const needsDownload = !hasRows || platformEntries.some(item => item.status === '已开票') || platformDetails.some(item => !item.attachment_id && !invoices.some(invoice => invoice.number === item.number));

  return <>
    <div className="detail-grid"><div><small>店铺 / 平台订单号</small><strong>{p.shop} · {p.platform_order}</strong></div><div><small>开票状态</small><Badge tone={status.tone}>{status.label}</Badge><small>收票：{p.receipt_status}</small></div></div>
    <div className="invoice-summary" style={{gridTemplateColumns:'repeat(3,minmax(0,1fr))'}}><div><small>应开票金额</small><strong>{money(p.invoice_expected_cents)}</strong></div><div><small>已收金额</small><strong>{money(p.received_cents)}</strong></div><div><small>待收金额</small><strong>{money(p.remaining_cents)}</strong></div></div>
    <Panel className="invoice-information"><h3>发票信息</h3>{p.platform === '淘宝' && needsDownload && !desktopAvailable ? <p className="notice">自动获取需在采单客户端中完成：打开客户端，登录“淘宝订单”，再返回采购记录获取发票。已下载的文件可在此查看、确认。</p> : null}<Table headers={['平台进度','发票号码 / 代码','金额','类型 / 日期','发票抬头 / 税号','获取发票']}>
      {platformDetails.map(item => {
        const recorded = data.invoices.find(invoice => invoice.number === item.number);
        const confirmed = recorded && allocations.some(a => a.invoice_id === recorded.id);
        return <tr key={`detail-${item.number}`}><td><Badge tone="green">已开票</Badge></td><td className="mono">{item.number}<small>代码：{item.code || '—'}</small><small>内容：{item.content || '—'}</small></td><td>{money(item.amount_cents)}</td><td>{item.invoice_type || '—'}<small>{item.date}</small></td><td>{item.title || '—'}<small className="mono">税号：{item.buyer_tax_id || '—'}</small></td><td>{item.attachment_id || confirmed ? <><Badge>已获取</Badge>{fileLink(item.attachment_id || recorded.attachment_id)}{confirmed ? <small>已确认收票</small> : recorded ? <small>票号已在其他采购登记，需核对</small> : item.amount_cents <= p.remaining_cents && p.invoice_stage !== '不需开票' ? <Button secondary disabled={busy} onClick={() => confirm(item)}>确认收票</Button> : <small>金额或收票设置需核对</small>}</> : syncButton()}</td></tr>;
      })}
      {platformEntries.map((item, index) => <tr key={`entry-${index}`}><td><Badge tone={item.status === '已开票' ? 'green' : item.status === '商家拒绝' ? 'red' : 'orange'}>{item.status === '已开票' ? '已开票' : '未开票'}</Badge>{item.status !== '已开票' ? <small>{item.status}</small> : null}</td><td>票号待获取</td><td>{money(item.amount_cents)}</td><td>{item.invoice_type || '—'}<small>{item.date || item.applied_at || '—'}</small></td><td>{item.title || '—'}{item.note ? <small>{item.note}</small> : null}</td><td>{item.status === '已开票' ? syncButton() : <small>待开票</small>}</td></tr>)}
      {recordedOnly.map(item => <tr key={`recorded-${item.id}`}><td><Badge tone="green">已开票</Badge></td><td className="mono">{item.number}</td><td>{money(item.amount_cents)}</td><td>—<small>{item.issued_date}</small></td><td>{item.seller}</td><td><Badge>已获取</Badge>{fileLink(item.attachment_id)}<small>已确认收票</small></td></tr>)}
      {!hasRows && p.platform === '淘宝' ? <tr><td colSpan={5}>暂无平台发票信息</td><td>{syncButton()}</td></tr> : null}
    </Table>{!hasRows && p.platform !== '淘宝' ? <Empty title="暂无发票信息"/> : null}
    {p.platform === '淘宝' ? <p className="muted footnote">来源：淘宝“我的发票”。文件下载后显示“已获取”，确认收票后才计入已收金额。{platformDetails.length ? <> <a href={`https://invoice-ua.taobao.com/detail/pc#/?orderId=${p.platform_order}`} target="_blank" rel="noreferrer">在淘宝查看发票</a></> : null}</p> : null}
    </Panel>
    {p.platform !== '淘宝' ? <><Button secondary onClick={() => setShowForm(value => !value)}>{showForm ? '收起登记' : '登记收票'}</Button>{showForm ? <InvoiceForm purchase={p} data={data} run={run} busy={busy} onDone={() => setShowForm(false)}/> : null}</> : null}
  </>;
}

function InvoiceForm({ purchase: p, data, run, busy, onDone }) {
  const [form, setForm] = useState({ number: '', seller: p.shop, issued_date: data.today, amount: p.remaining_cents / 100, attachment_id: '' });
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  if (p.remaining_cents <= 0 || p.invoice_stage === '不需开票') return <Empty title="本笔采购没有待收票金额"/>;
  return <form onSubmit={event => { event.preventDefault(); run(async () => { await api('/invoices', { ...form, allocations: [{ purchase_id: p.id, amount: form.amount }] }); onDone(); }, '发票已登记，本笔采购收票进度已更新'); }}><div className="form-grid">
    <InputField label="发票号码 *" required value={form.number} onChange={event => set('number', event.target.value)}/><InputField label="开票方 *" required value={form.seller} onChange={event => set('seller', event.target.value)}/><InputField label="开票日期 *" type="date" required value={form.issued_date} onChange={event => set('issued_date', event.target.value)}/><InputField label="价税合计金额 *" type="number" min=".01" max={p.remaining_cents / 100} step=".01" required value={form.amount} onChange={event => set('amount', event.target.value)}/><Attachment required value={form.attachment_id} onChange={value => set('attachment_id', value)}/>
    </div><p className="notice">本次发票关联采购 {p.platform_order}。请核对开票方、金额与附件。</p><SaveBar busy={busy} disabled={!form.attachment_id} label="保存收票"/></form>;
}
