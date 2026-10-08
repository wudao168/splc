import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from './api';
import { copyBillingInfo, downloadBillingInfo } from './billing';
import { Button, Panel, Table, FixedCell, Empty, SearchBox, Modal, InputField, SaveBar } from './components';
import Pagination, { usePagination } from './Pagination';

export function CustomerEditor({ customer, run, busy, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({ name: customer?.name || '', note: customer?.note || '',
    contacts: customer?.contacts.map(x => ({ ...x })) || [], addresses: customer?.addresses.map(x => ({ contact: '', phone: '', ...x })) || [] }));
  const update = (group, index, key, value) => setForm(f => ({ ...f, [group]: f[group].map((x, i) => i === index ? { ...x, [key]: value } : x) }));
  async function save(e) {
    e.preventDefault();
    await run(async () => {
      const result = await api(customer ? `/customers/${customer.id}` : '/customers', form);
      onSaved?.({ ...form, id: result.id }); onClose();
    }, '客户资料已保存');
  }
  return <Modal title={customer ? '编辑客户资料' : '新增客户'} onClose={onClose}><form onSubmit={save}>
    <div className="form-grid"><InputField label="客户名称 *" wide required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}/>
      <InputField label="客户备注" wide value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))}/></div>
    <div className="customer-group-title"><h3>联系人与电话</h3><Button secondary onClick={() => setForm(f => ({ ...f, contacts: [...f.contacts, { name: '', phone: '' }] }))}><Plus size={14}/>添加联系人</Button></div>
    {form.contacts.map((x, i) => <div className="customer-contact-row" key={i}>
      <InputField label={`联系人 ${i + 1} *`} required value={x.name} onChange={e => update('contacts', i, 'name', e.target.value)}/>
      <InputField label={`联系电话 ${i + 1}`} value={x.phone} onChange={e => update('contacts', i, 'phone', e.target.value)}/>
      <button type="button" className="icon-button" aria-label={`移除联系人 ${i + 1}`} onClick={() => setForm(f => ({ ...f, contacts: f.contacts.filter((_, n) => n !== i) }))}><Trash2 size={16}/></button>
    </div>)}
    {!form.contacts.length ? <p className="muted">尚未维护联系人。只有一位联系人时，导入订单自动带出。</p> : null}
    <div className="customer-group-title"><h3>收货地址</h3><Button secondary onClick={() => setForm(f => ({ ...f, addresses: [...f.addresses, { contact: '', phone: '', address: '' }] }))}><Plus size={14}/>添加地址</Button></div>
    {form.addresses.map((x, i) => <div className="customer-address-card" key={i}><div className="customer-address-heading"><strong>收货信息 {i + 1}</strong>
      <button type="button" className="icon-button" aria-label={`移除地址 ${i + 1}`} onClick={() => setForm(f => ({ ...f, addresses: f.addresses.filter((_, n) => n !== i) }))}><Trash2 size={16}/></button></div>
      <div className="customer-address-fields"><InputField label={`收货联系人 ${i + 1}`} value={x.contact} onChange={e => update('addresses', i, 'contact', e.target.value)}/>
      <InputField label={`收货联系电话 ${i + 1}`} type="tel" value={x.phone} onChange={e => update('addresses', i, 'phone', e.target.value)}/>
      <InputField label={`收货地址 ${i + 1} *`} wide required value={x.address} onChange={e => update('addresses', i, 'address', e.target.value)}/></div></div>)}
    <p className="muted footnote">资料修改用于后续选择，不会改写已有订单的联系人和收货地址。</p>
    <SaveBar busy={busy} label="保存客户资料" onCancel={onClose}/>
  </form></Modal>;
}

const invoiceFields = [['title', '发票抬头'], ['tax_number', '纳税人识别号'], ['address', '注册地址'], ['phone', '注册电话'], ['bank_name', '开户银行'], ['bank_account', '银行账号'], ['email', '收票邮箱']];

function CustomerInvoiceEditor({ customer, run, busy, onClose }) {
  const [form, setForm] = useState(() => Object.fromEntries(invoiceFields.map(([key]) => [key, customer.invoice_info?.[key] || ''])));
  const [pending, setPending] = useState(false), [message, setMessage] = useState('');
  const disabled = busy || pending;
  const update = key => event => { setForm(previous => ({ ...previous, [key]: event.target.value })); setMessage(''); };
  async function copy() {
    try { await copyBillingInfo(form, invoiceFields, '客户开票信息'); setMessage('开票信息已复制'); }
    catch { setMessage('复制失败，请允许浏览器访问剪贴板后重试'); }
  }
  async function download(format) {
    setPending(true); setMessage('');
    try {
      const name = form.title.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80);
      await downloadBillingInfo(`/api/customers/${customer.id}/invoice-info/${format}`, form, `${name}-开票信息.${format}`);
      setMessage('文件已生成，请在下载列表中查看');
    } catch (error) { setMessage(error.message); }
    finally { setPending(false); }
  }
  async function save(event) {
    event.preventDefault();
    await run(async () => {
      await api(`/customers/${customer.id}/invoice-info`, form);
      onClose();
    }, '客户开票信息已保存');
  }
  return <Modal title="客户开票信息" onClose={onClose}><form onSubmit={save}>
    <p className="notice">{customer.name}</p>
    <div className="form-grid">
      <InputField label="发票抬头" wide value={form.title} required={Object.values(form).some(value => value.trim())} onChange={update('title')} placeholder="填写发票上的购买方名称"/>
      <InputField label="纳税人识别号" wide value={form.tax_number} onChange={update('tax_number')}/>
      <InputField label="注册地址" wide value={form.address} onChange={update('address')}/>
      <InputField label="注册电话" type="tel" value={form.phone} onChange={update('phone')}/>
      <InputField label="收票邮箱" type="email" value={form.email} onChange={update('email')}/>
      <InputField label="开户银行" value={form.bank_name} onChange={update('bank_name')}/>
      <InputField label="银行账号" value={form.bank_account} onChange={update('bank_account')}/>
    </div>
    <p className="muted footnote">复制、导出使用当前填写的内容。填写抬头后按需补充其他资料；全部清空后保存可移除开票信息。</p>
    <SaveBar busy={busy} disabled={pending} label="保存开票信息" onCancel={onClose}>
      <Button secondary disabled={disabled || !form.title.trim()} onClick={copy}>复制开票信息</Button>
      <Button secondary disabled={disabled || !form.title.trim()} onClick={() => download('pdf')}>导出 PDF</Button>
      <Button secondary disabled={disabled || !form.title.trim()} onClick={() => download('xlsx')}>导出 Excel</Button>
    </SaveBar>
    {message ? <p role="status" className="notice">{message}</p> : null}
  </form></Modal>;
}

export default function Customers({ data, run, busy, user }) {
  const [search, setSearch] = useState(''), [editing, setEditing] = useState(null), [invoiceCustomer, setInvoiceCustomer] = useState(null);
  const customers = (data.customers || []).filter(c => [c.name, c.note, ...c.contacts.flatMap(x => [x.name, x.phone]), ...c.addresses.flatMap(x => [x.contact, x.phone, x.address])].join(' ').toLowerCase().includes(search.toLowerCase()));
  const pagination = usePagination(customers.length);
  const pageCustomers = customers.slice(pagination.start, pagination.end);
  return <><Panel className="customer-list"><div className="toolbar"><SearchBox value={search} onChange={value => { setSearch(value); pagination.setPage(1); }} placeholder="搜索客户、联系人、电话或地址…"/><Button onClick={() => setEditing({})}><Plus size={16}/>新增客户</Button></div>
    <Table headers={['客户名称', '联系人', '电话', '收货地址', '开票信息', '备注', '操作']} empty={!customers.length ? <Empty title="暂无匹配客户">先建立客户资料，再在询价导入中选择。</Empty> : null}>
      {pageCustomers.map(c => <tr key={c.id}><FixedCell title={c.name}><strong>{c.name}</strong></FixedCell><FixedCell title={c.contacts.map(x => x.name || '—').join('\n')}>{c.contacts.length ? c.contacts.map((x, i) => <div className="customer-contact-value" key={i}>{x.name || '—'}</div>) : '—'}</FixedCell><FixedCell title={c.contacts.map(x => x.phone || '—').join('\n')}>{c.contacts.length ? c.contacts.map((x, i) => <div className="customer-contact-value" key={i}>{x.phone || '—'}</div>) : '—'}</FixedCell><FixedCell title={c.addresses.map(x => [x.address, x.contact, x.phone].filter(Boolean).join(' · ')).join('\n')}>{c.addresses.map((x, i) => <div className="customer-address-summary" key={i}>{x.address}{x.contact || x.phone ? <small>{x.contact} {x.phone}</small> : null}</div>)}</FixedCell><FixedCell><button type="button" className="text-button customer-invoice-link" onClick={() => setInvoiceCustomer(c)}>{c.invoice_info?.title ? <><span className="badge green">已维护</span><small>查看 / 编辑</small></> : '填写开票信息'}</button></FixedCell><FixedCell title={c.note}>{c.note || '—'}</FixedCell><FixedCell><div className="order-actions"><Button secondary onClick={() => setEditing(c)}>编辑</Button>{user?.is_admin ? <Button secondary danger disabled={busy} onClick={() => { const linked = data.orders.filter(o => o.customer_id === c.id || o.customer === c.name).length; if (window.confirm(`删除客户「${c.name}」？\n联系人、收货地址和开票信息会一并删除。\n该客户有 ${linked} 笔订单：订单继续保留客户名称，但不再关联客户资料。`)) run(() => api(`/customers/${c.id}/delete`, {}), '客户已删除'); }}>删除</Button> : null}</div></FixedCell></tr>)}
    </Table><Pagination label="客户列表" total={customers.length} pagination={pagination} onPageChange={pagination.setPage} onPageSizeChange={pagination.setPageSize}/></Panel>{editing ? <CustomerEditor customer={editing.id ? editing : null} run={run} busy={busy} onClose={() => setEditing(null)}/> : null}{invoiceCustomer ? <CustomerInvoiceEditor customer={invoiceCustomer} run={run} busy={busy} onClose={() => setInvoiceCustomer(null)}/> : null}</>;
}
