import React, { useState } from 'react';
import { api } from './api';
import { copyBillingInfo, downloadBillingInfo } from './billing';
import { Button, InputField } from './components';

const fields = [['name', '公司名称'], ['bank_name', '开户行'], ['bank_account', '账号'], ['tax_number', '税号'], ['address', '地址'], ['phone', '电话'], ['email', '邮箱']];

export default function BillingInfo({ company, run, busy, onSaved, user }) {
  const canEdit = !!user?.is_admin;
  const [form, setForm] = useState(company);
  const [pending, setPending] = useState(false), [message, setMessage] = useState('');
  const disabled = busy || pending;
  const copy = async () => {
    try {
      await copyBillingInfo(form, fields);
      setMessage('开票信息已复制');
    } catch { setMessage('复制失败，请允许浏览器访问剪贴板后重试'); }
  };
  const download = async format => {
    setPending(true); setMessage('');
    try {
      await downloadBillingInfo(`/api/company/billing/${format}`, form, `开票付款资料.${format}`);
      setMessage('文件已生成，请在下载列表中查看');
    } catch (error) { setMessage(error.message); }
    finally { setPending(false); }
  };
  return <form onSubmit={event => { event.preventDefault(); if (!canEdit) return; run(async () => { const saved = await api('/company', form); setForm(saved); onSaved?.(saved); setMessage('开票信息已保存'); }, '开票信息已保存'); }}>
    <p className="muted">公司名称、地址和电话与设置中的公司信息共用。复制、导出使用当前填写的内容；保存后下次打开仍可使用。</p>
    <div className="form-grid billing-info-grid">{fields.map(([key, label]) => <InputField key={key} label={label + (key === 'name' ? ' *' : '')} wide={['name', 'bank_name', 'address'].includes(key)} required={key === 'name'} maxLength={key === 'name' ? 200 : 500} value={form[key] || ''} disabled={disabled} readOnly={!canEdit} onChange={event => { setForm(current => ({ ...current, [key]: event.target.value })); setMessage(''); }}/>)}</div>
    <div className="save-bar billing-info-actions"><Button secondary disabled={disabled} onClick={copy}>复制开票信息</Button><Button secondary disabled={disabled || !form.name?.trim()} onClick={() => download('pdf')}>导出 PDF</Button><Button secondary disabled={disabled || !form.name?.trim()} onClick={() => download('xlsx')}>导出 Excel</Button>{canEdit ? <Button type="submit" disabled={disabled}>保存开票信息</Button> : null}</div>
    {message ? <p role="status" className="notice">{message}</p> : null}
  </form>;
}
