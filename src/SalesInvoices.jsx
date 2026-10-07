import React, { useState } from 'react';
import { api, money } from './api';
import { Panel, Table, FixedCell, Button, Badge, Modal, SearchBox, SaveBar, InputField, Field, Attachment, Empty } from './components';
import { PurchaseLinePicker } from './Purchases';
import Pagination, { usePagination } from './Pagination';

const statusLabel = i => i.status === 'void' ? '已作废' : i.status === 'red' ? '已全额红冲' : i.payment_status;
const invoiceOrders = (data, iid) => data.sales_invoice_orders.filter(a => a.invoice_id === iid);
const orderLabel = (data, oid) => data.orders.find(o => o.id === oid)?.po || String(oid);
const attachmentLink = id => id ? <a href={`/api/files/${id}`} target="_blank" rel="noreferrer">查看附件</a> : '—';

export default function SalesInvoices({ data, run, busy, user }) {
  const [tab, setTab] = useState('invoices'), [customer, setCustomer] = useState(''), [search, setSearch] = useState('');
  const [status, setStatus] = useState(''), [overdue, setOverdue] = useState(false), [from, setFrom] = useState(''), [to, setTo] = useState('');
  const [modal, setModal] = useState(null);
  const customers = [...new Set(data.orders.map(o => o.customer))].sort((a,b) => a.localeCompare(b,'zh-CN'));
  const rows = data.sales_invoices.filter(i => (!customer || i.customer === customer) && (!status || statusLabel(i) === status) && (!overdue || i.overdue) && (!from || i.issued_date >= from) && (!to || i.issued_date <= to) && `${i.customer} ${i.number} ${invoiceOrders(data,i.id).map(a=>orderLabel(data,a.order_id)).join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  const receipts = data.order_receipts.filter(r => {
    const o = data.orders.find(o=>o.id===r.order_id);
    return (!customer || o?.customer === customer) && `${o?.customer} ${o?.po} ${r.reference} ${r.note}`.toLowerCase().includes(search.toLowerCase()) && (!from || (r.received_date || r.created_at.slice(0,10)) >= from) && (!to || (r.received_date || r.created_at.slice(0,10)) <= to);
  });
  const pagination = usePagination(tab === 'invoices' ? rows.length : receipts.length);
  const current = modal?.id && data.sales_invoices.find(i => i.id === modal.id);
  const close = () => setModal(null);
  const total = key => rows.filter(i=>i.status==='active').reduce((sum,i)=>sum+i[key],0);
  return <>
    <div className="tabs"><button className={tab==='invoices'?'active':''} onClick={()=>{setTab('invoices');pagination.setPage(1);}}>销售发票</button><button className={tab==='receipts'?'active':''} onClick={()=>{setTab('receipts');pagination.setPage(1);}}>回款</button></div>
    <Panel className="sales-invoices"><div className="toolbar">
      <SearchBox value={search} onChange={v=>{setSearch(v);pagination.setPage(1);}} placeholder="搜索客户、发票号码或客户 PO…"/>
      <select aria-label="发票客户筛选" value={customer} onChange={e=>{setCustomer(e.target.value);pagination.setPage(1);}}><option value="">全部客户</option>{customers.map(c=><option key={c}>{c}</option>)}</select>
      {tab==='invoices' ? <><select aria-label="回款状态筛选" value={status} onChange={e=>{setStatus(e.target.value);pagination.setPage(1);}}><option value="">全部状态</option>{['未回款','部分回款','已结清','已作废','已全额红冲'].map(s=><option key={s}>{s}</option>)}</select><label className="check-label"><input type="checkbox" checked={overdue} onChange={e=>{setOverdue(e.target.checked);pagination.setPage(1);}}/>仅逾期</label></> : null}
      <div className="sales-invoice-date-range"><input aria-label={tab==='invoices'?'开票开始日期':'到账开始日期'} type="date" value={from} onChange={e=>{setFrom(e.target.value);pagination.setPage(1);}}/><span>-</span><input aria-label="结束日期" type="date" value={to} onChange={e=>{setTo(e.target.value);pagination.setPage(1);}}/></div>
      <div className="purchase-toolbar-actions"><Button onClick={()=>setModal({type:'new'})}>录入发票</Button></div>
    </div>
    {tab==='invoices' ? <><p className="notice">当前筛选有效发票：{money(total('amount_cents'))}　已回款：{money(total('paid_cents'))}　未回款：{money(total('remaining_cents'))}　逾期未回款：{money(rows.filter(i=>i.overdue).reduce((s,i)=>s+i.remaining_cents,0))}</p><Table headers={['客户','发票号码','客户 PO','开票日期','发票金额','已回款','未回款','回款到期日','状态','操作']}>
      {rows.slice(pagination.start,pagination.end).map(i=><tr key={i.id}><FixedCell>{i.customer}</FixedCell><FixedCell>{i.number}</FixedCell><FixedCell>{invoiceOrders(data,i.id).map(a=>orderLabel(data,a.order_id)).join('、')}</FixedCell><FixedCell>{i.issued_date}</FixedCell><FixedCell>{money(i.amount_cents)}</FixedCell><FixedCell>{money(i.paid_cents)}</FixedCell><FixedCell>{money(i.remaining_cents)}</FixedCell><FixedCell>{i.due_date || '未指定'}</FixedCell><FixedCell><Badge>{statusLabel(i)}</Badge>{i.overdue?<small className="text-orange">已逾期</small>:null}</FixedCell><FixedCell><button className="text-button" onClick={()=>setModal({type:'detail',id:i.id})}>查看</button>{i.status==='active'&&i.remaining_cents>0?<button className="text-button" onClick={()=>setModal({type:'receipt',id:i.id})}>回款</button>:null}</FixedCell></tr>)}
    </Table></> : <><p className="notice">回款通过销售发票操作栏登记。作废或红冲发票后，原到账金额保留，可通过“分配发票”重新关联。</p><Table headers={['客户 / PO','到账日期','金额','已分配发票','未分配','方式 / 流水号','备注','状态','操作']}>
      {receipts.slice(pagination.start,pagination.end).map(r=><tr key={r.id}><FixedCell>{data.orders.find(o=>o.id===r.order_id)?.customer}<small>{orderLabel(data,r.order_id)}</small></FixedCell><FixedCell>{r.received_date || r.created_at.slice(0,10)}</FixedCell><FixedCell>{money(r.amount_cents)}</FixedCell><FixedCell>{money(r.allocated_cents)}</FixedCell><FixedCell>{r.voided_at?'—':money(r.amount_cents-r.allocated_cents)}</FixedCell><FixedCell>{r.method || '—'}<small>{r.reference}</small></FixedCell><FixedCell>{r.note}{attachmentLink(r.evidence_id)}</FixedCell><FixedCell>{r.voided_at?'已撤销':'有效'}</FixedCell><FixedCell>{!r.voided_at?<><button className="text-button" onClick={()=>setModal({type:'allocate',receipt:r})}>分配发票</button>{user?.is_admin?<button className="text-button" onClick={()=>setModal({type:'void-receipt',receipt:r})}>撤销</button>:null}</>:null}</FixedCell></tr>)}
    </Table></>}
    {!(tab==='invoices'?rows:receipts).length?<Empty title="暂无符合条件的记录"/>:null}
    <Pagination label="发票及回款" total={tab==='invoices'?rows.length:receipts.length} pagination={pagination} onPageChange={pagination.setPage} onPageSizeChange={pagination.setPageSize}/></Panel>
    {modal?.type==='new'?<Modal wide title="录入销售发票" onClose={close}><InvoiceForm data={data} run={run} busy={busy} onDone={close}/></Modal>:null}
    {modal?.type==='receipt'||modal?.type==='allocate'?<Modal wide title={modal.type==='allocate'?'分配已有回款':current?'登记发票回款':'登记回款'} onClose={close}><ReceiptForm key={modal.receipt?.id || current?.id || 'new'} data={data} run={run} busy={busy} onDone={close} receipt={modal.receipt} invoice={current}/></Modal>:null}
    {modal?.type==='detail'&&current?<Modal wide title={`销售发票 · ${current.number}`} onClose={close}><InvoiceDetail invoice={current} data={data}/>{current.status==='active'?<div className="save-bar">{current.remaining_cents>0?<Button onClick={()=>setModal({type:'receipt',id:current.id})}>回款</Button>:null}<Button secondary onClick={()=>setModal({type:'void',id:current.id})}>作废</Button><Button secondary onClick={()=>setModal({type:'red',id:current.id})}>全额红冲</Button></div>:null}</Modal>:null}
    {['void','red','void-receipt'].includes(modal?.type)?<Modal title={modal.type==='red'?'全额红冲发票':modal.type==='void'?'作废发票':'撤销错误回款'} onClose={close}><Correction type={modal.type} run={run} busy={busy} onDone={close} id={modal.id || modal.receipt.id}/></Modal>:null}
  </>;
}

function InvoiceForm({data,run,busy,onDone}) {
  const [form,setForm]=useState({customer:'',number:'',kind:'增值税专用发票',issued_date:data.today,due_date:'',amount:'',note:'',attachment_id:'',billing_info:{}});
  const [selected,setSelected]=useState([]), [picker,setPicker]=useState(false);
  const set=(key,value)=>setForm(f=>({...f,[key]:value}));
  const orders=data.orders.filter(o=>o.customer===form.customer&&o.status==='confirmed'&&!o.archived_at&&o.receivable_cents>o.invoiced_cents);
  const used=new Set((data.sales_invoice_lines || []).filter(a=>data.sales_invoices.some(i=>i.id===a.invoice_id&&i.status==='active')).map(a=>a.order_line_id));
  const available=data.order_lines.filter(l=>orders.some(o=>o.id===l.order_id)&&!used.has(l.id)&&l.quote_cents>0);
  const chosen=available.filter(l=>selected.includes(l.id));
  const total=chosen.reduce((s,l)=>s+Math.round(l.quantity*l.price_cents),0);
  const selectLines=ids=>{
    setSelected(ids);
    const cents=available.filter(l=>ids.includes(l.id)).reduce((sum,l)=>sum+Math.round(l.quantity*l.price_cents),0);
    set('amount',(cents/100).toFixed(2));
  };
  const toggle=ids=>selectLines(selected.filter(id=>!ids.includes(id)));
  return <form className="sales-invoice-form" onSubmit={e=>{e.preventDefault();run(async()=>{await api('/sales-invoices',{...form,order_line_ids:chosen.map(l=>l.id)});onDone();},'销售发票已登记');}}>
    <div className="sales-invoice-association-toolbar"><Button disabled={!form.customer} onClick={()=>setPicker(true)}>关联 PO</Button></div>
    <div className="form-grid"><Field label="客户 *"><select aria-label="客户 *" required value={form.customer} onChange={e=>{const customer=e.target.value;setForm(f=>({...f,customer,amount:'',billing_info:{...data.customers.find(c=>c.name===customer)?.invoice_info}}));setSelected([]);}}><option value="">请选择客户</option>{[...new Set(data.orders.filter(o=>o.status==='confirmed').map(o=>o.customer))].map(c=><option key={c}>{c}</option>)}</select></Field>
      <InputField label="发票号码 *" required value={form.number} onChange={e=>set('number',e.target.value)}/><Field label="发票类型"><select value={form.kind} onChange={e=>set('kind',e.target.value)}>{['增值税专用发票','普通发票','其他'].map(k=><option key={k}>{k}</option>)}</select></Field>
      <InputField label="含税金额 *" required type="number" min="0.01" step="0.01" value={form.amount} onChange={e=>set('amount',e.target.value)}/><InputField label="开票日期 *" required type="date" value={form.issued_date} onChange={e=>set('issued_date',e.target.value)}/><InputField label="回款到期日" type="date" min={form.issued_date} value={form.due_date} onChange={e=>set('due_date',e.target.value)}/>
      {[['title','发票抬头'],['tax_number','纳税人识别号'],['address','注册地址'],['phone','注册电话'],['bank_name','开户银行'],['bank_account','银行账号']].map(([key,label])=><InputField key={key} label={label} value={form.billing_info[key] || ''} onChange={e=>set('billing_info',{...form.billing_info,[key]:e.target.value})}/>)}
      <InputField label="备注" wide value={form.note} onChange={e=>set('note',e.target.value)}/><Attachment value={form.attachment_id} onChange={id=>set('attachment_id',id)}/></div>
    <h3>关联客户 PO</h3>
    <p>已选 {chosen.length} 项 · 含税合计 {money(total)} / 发票金额 {money(Math.round(Number(form.amount||0)*100))}</p>
    <Table headers={['客户 PO','料品 / 规格','数量','含税金额','操作']}>{chosen.map(l=><tr key={l.id}><td>{orderLabel(data,l.order_id)}</td><td>{l.name}<small>{l.spec}</small></td><td>{l.quantity}</td><td>{money(Math.round(l.quantity*l.price_cents))}</td><td><button type="button" className="text-button" onClick={()=>toggle([l.id])}>移除</button></td></tr>)}</Table>
    {picker ? <PurchaseLinePicker groupByPo available={available} orders={Object.fromEntries(orders.map(o=>[o.id,o]))} addedIds={selected} initialIds={selected} remark="" remainingQuantity={line=>line.quantity} onClose={()=>setPicker(false)} onDirectAdd={ids=>selectLines([...new Set([...selected,...ids])])} onAdd={ids=>{selectLines(ids);setPicker(false);}}/> : null}

    <SaveBar busy={busy} disabled={!total||total!==Math.round(Number(form.amount||0)*100)} onCancel={onDone}/>

  </form>;
}

function ReceiptForm({data,run,busy,onDone,receipt,invoice}) {
  const [form,setForm]=useState({order_id:receipt?.order_id || '',amount:receipt?receipt.amount_cents/100:invoice?invoice.remaining_cents/100:'',received_date:data.today,method:'银行转账',reference:'',note:'',evidence_id:''});
  const [parts,setParts]=useState(()=>Object.fromEntries(data.sales_receipt_allocations.filter(a=>a.receipt_id===receipt?.id&&data.sales_invoices.some(i=>i.id===a.invoice_id&&i.status==='active')).map(a=>[a.invoice_id,a.amount_cents/100])));
  const set=(key,value)=>setForm(f=>({...f,[key]:value}));
  const invoices=data.sales_invoice_orders.filter(a=>a.order_id===Number(form.order_id)&&data.sales_invoices.some(i=>i.id===a.invoice_id&&i.status==='active'));
  const total=Object.values(parts).reduce((s,v)=>s+Math.round(Number(v||0)*100),0);
  return <form onSubmit={e=>{e.preventDefault();run(async()=>{const payload=invoice?{...form,invoice_id:invoice.id}:{...form,invoices:Object.entries(parts).filter(([,v])=>Number(v)>0).map(([id,amount])=>({invoice_id:Number(id),amount}))};await api(receipt?`/sales-receipts/${receipt.id}/allocate`:'/sales-receipts',payload);onDone();},receipt?'回款分配已保存':'回款已登记');}}>
    <div className="form-grid">{invoice?<Field label="关联发票"><strong>{invoice.customer} · {invoice.number}</strong><small>未回款 {money(invoice.remaining_cents)}</small></Field>:<Field label="客户订单 *"><select aria-label="客户订单 *" required disabled={!!receipt} value={form.order_id} onChange={e=>{set('order_id',e.target.value);setParts({});}}><option value="">请选择客户订单</option>{data.orders.filter(o=>o.status==='confirmed'||o.id===receipt?.order_id).map(o=><option key={o.id} value={o.id}>{o.customer} · {o.po}</option>)}</select></Field>}<InputField label="到账金额 *" required disabled={!!receipt} type="number" min=".01" max={invoice?invoice.remaining_cents/100:undefined} step=".01" value={form.amount} onChange={e=>set('amount',e.target.value)}/>
    {!receipt?<><InputField label="到账日期 *" required type="date" max={data.today} value={form.received_date} onChange={e=>set('received_date',e.target.value)}/><InputField label="收款方式 *" required value={form.method} onChange={e=>set('method',e.target.value)}/><InputField label="流水号" value={form.reference} onChange={e=>set('reference',e.target.value)}/><InputField label="备注" value={form.note} onChange={e=>set('note',e.target.value)}/><Attachment value={form.evidence_id} onChange={id=>set('evidence_id',id)}/></>:null}</div>
    {!invoice?<><p className="notice">已分配 {money(total)}；其余金额保留为订单未分配回款。尚未开票可直接保存。</p>
    <Table headers={['发票号码','该订单开票金额','其他回款已分配','本笔分配金额']}>{invoices.map(a=>{const i=data.sales_invoices.find(i=>i.id===a.invoice_id);const other=data.sales_receipt_allocations.filter(x=>x.invoice_id===i.id&&x.receipt_id!==receipt?.id&&data.order_receipts.some(r=>r.id===x.receipt_id&&r.order_id===Number(form.order_id)&&!r.voided_at)).reduce((s,x)=>s+x.amount_cents,0);return <tr key={i.id}><td>{i.number}</td><td>{money(a.amount_cents)}</td><td>{money(other)}</td><td><input aria-label={`${i.number}回款分配`} type="number" min="0" step=".01" max={(a.amount_cents-other)/100} value={parts[i.id] || ''} onChange={e=>setParts(p=>({...p,[i.id]:e.target.value}))}/></td></tr>;})}</Table></>:null}<SaveBar busy={busy} disabled={invoice?!(Number(form.amount)>0)||Math.round(Number(form.amount)*100)>invoice.remaining_cents:total>Math.round(Number(form.amount||0)*100)} onCancel={onDone}/>
  </form>;
}

function Correction({type,id,run,busy,onDone}) {
  const [reason,setReason]=useState(''),[redNumber,setRedNumber]=useState('');
  return <form onSubmit={e=>{e.preventDefault();run(async()=>{await api(type==='void-receipt'?`/order-receipts/${id}/void`:`/sales-invoices/${id}/${type}`,{reason,red_number:redNumber});onDone();},'已保存更正记录');}}><p className="notice">历史记录保留。发票作废或全额红冲后释放开票额度及回款分配，实际到账记录仍保留；“全额红冲”仅用于已办理全额红冲的发票，请填写真实红字发票号码。</p>{type==='red'?<InputField label="红字发票号码 *" required value={redNumber} onChange={e=>setRedNumber(e.target.value)}/>:null}<InputField label="原因 *" required value={reason} onChange={e=>setReason(e.target.value)}/><SaveBar busy={busy} onCancel={onDone}/></form>;
}

function InvoiceDetail({invoice:i,data}) {
  const parts=invoiceOrders(data,i.id);
  return <><div className="detail-grid"><div><small>客户</small><strong>{i.customer}</strong></div><div><small>状态</small><strong>{statusLabel(i)}{i.overdue?' · 逾期':''}</strong></div><div>开票日期：{i.issued_date}</div><div>回款到期：{i.due_date || '未指定'}</div><div>发票金额：{money(i.amount_cents)}</div><div>未回款：{money(i.remaining_cents)}</div></div><p>{i.kind}　{attachmentLink(i.attachment_id)}</p><p>{Object.values(i.billing_info).filter(Boolean).join(' · ')}</p><p>{i.note}</p>{i.reason?<p className="notice">{i.reason} {i.red_number?`红字发票：${i.red_number}`:''}</p>:null}<Table className="sales-invoice-detail-table" headers={['客户 PO','分摊金额']}>{parts.map(a=><tr key={a.order_id}><td><a href={`#orders?order=${a.order_id}`}>{orderLabel(data,a.order_id)}</a></td><td>{money(a.amount_cents)}</td></tr>)}</Table><h3>回款记录</h3><Table className="sales-invoice-detail-table" headers={['到账日期','客户 PO','本票分配金额','收款方式','流水号','凭证','状态']}>{data.sales_receipt_allocations.filter(a=>a.invoice_id===i.id).map(a=>{const r=data.order_receipts.find(r=>r.id===a.receipt_id);return <tr key={r.id}><td>{r.received_date || r.created_at.slice(0,10)}</td><td>{orderLabel(data,r.order_id)}</td><td>{money(a.amount_cents)}</td><td>{r.method}</td><td>{r.reference}</td><td>{attachmentLink(r.evidence_id)}</td><td>{r.voided_at?'回款已撤销':i.status!=='active'?'已释放':'有效'}</td></tr>;})}</Table></>;
}

export function OrderSalesSummary({data,order}) {
  const parts=(data.sales_invoice_orders || []).filter(a=>a.order_id===order.id);
  const receipts=(data.order_receipts || []).filter(r=>r.order_id===order.id);
  return <details className="order-sales-summary"><summary>发票 / 回款 · {order.invoice_status || '未开票'} · 已开 {money(order.invoiced_cents)} · 净回款 {money((order.paid_cents||0)-(order.refunded_cents||0))}</summary>{order.invoice_excess_cents>0?<p className="notice warning">订单金额已调减，发票超开 {money(order.invoice_excess_cents)}，请办理红冲。</p>:null}<p><a href="#sales-invoices">进入发票详情维护</a></p><Table headers={['发票号码','开票日期','本订单金额','状态']}>{parts.map(a=>{const i=data.sales_invoices.find(i=>i.id===a.invoice_id);return <tr key={i.id}><td>{i.number}</td><td>{i.issued_date}</td><td>{money(a.amount_cents)}</td><td>{statusLabel(i)}</td></tr>;})}</Table><Table headers={['到账日期','回款金额','流水号','状态']}>{receipts.map(r=><tr key={r.id}><td>{r.received_date || r.created_at.slice(0,10)}</td><td>{money(r.amount_cents)}</td><td>{r.reference || '—'}</td><td>{r.voided_at?'已撤销':'有效'}</td></tr>)}</Table></details>;
}


