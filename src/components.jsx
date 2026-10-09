import React, { useEffect, useRef, useState } from 'react';
import { X, ClipboardList, LoaderCircle, Search, Paperclip, ChevronDown } from 'lucide-react';
import { upload } from './api';

export function Button({ children, secondary, danger, className = '', ...props }) {
  return <button type="button" className={`button ${secondary ? 'secondary' : ''} ${danger ? 'danger' : ''} ${className}`} {...props}>{children}</button>;
}
export function Empty({ title = '暂无记录', children, action, compact }) {
  return <div className={`empty ${compact ? 'compact' : ''}`}><ClipboardList size={38} strokeWidth={1.5}/><strong>{title}</strong>{children ? <p>{children}</p> : null}{action}</div>;
}
export function Badge({ children, tone }) {
  const text = typeof children === 'string' || typeof children === 'number' ? String(children) : '';
  const color = tone || (/已收齐|已签收|已确认|已开齐|已回款|已收票|已入库|运输中|有效/.test(text) ? 'green'
    : /逾期|异常|退回|作废/.test(text) ? 'red'
      : /待|草稿|部分|未开票|未回款|未收票|未登记|未获取|未入库|未完成/.test(text) ? 'orange' : 'gray');
  return <span className={`badge ${color}`}>{children}</span>;
}
export function Field({ label, children, wide, hint }) {
  return <label className={`field ${wide ? 'wide' : ''}`}><span>{label}</span>{children}{hint ? <small>{hint}</small> : null}</label>;
}
export function InputField({ label, wide, hint, ...props }) {
  return <Field label={label} wide={wide} hint={hint}><input {...props}/></Field>;
}
export function SearchBox({ value, onChange, placeholder = '搜索订单、客户或料品…' }) {
  return <div className="search"><Search size={17}/><input aria-label="搜索" placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)}/></div>;
}
export function Table({ headers, children, empty, columnWidths, className = '' }) {
  const ref = useRef(null);
  useEffect(() => {
    const element = ref.current;
    let frame;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!element.isConnected || element.closest('.purchase-line-picker')) return;
        let footerHeight = 0;
        for (let sibling = element.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
          footerHeight += sibling.getBoundingClientRect().height;
        }
        const bottomGap = element.closest('.modal') ? 32 : 24;
        const height = Math.max(96, window.innerHeight - element.getBoundingClientRect().top - footerHeight - bottomGap);
        element.style.setProperty('--table-available-height', `${height}px`);
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element.parentElement);
    window.addEventListener('resize', measure);
    measure();
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); cancelAnimationFrame(frame); };
  }, [children]);
  return <div className={`table-scroll ${className}`} ref={ref}><table>{columnWidths ? <colgroup>{columnWidths.map((width, i) => <col key={i} style={{ width: `${width / columnWidths.reduce((sum, value) => sum + value, 0) * 100}%` }}/>)}</colgroup> : null}<thead><tr>{headers.map((h, i) => <th key={i}>{h}</th>)}</tr></thead><tbody>{children}</tbody></table>{empty}</div>;
}
export function FixedCell({ children, ...props }) {
  return <td {...props}><div className="fixed-cell"><div className="fixed-cell-content">{children}</div></div></td>;
}
export function Panel({ title, action, children, className = '', ...props }) {
  return <section className={`panel ${className}`} {...props}>{title ? <div className="panel-title"><h2>{title}</h2>{action}</div> : null}{children}</section>;
}
export function Modal({ title, children, onClose, wide }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    dialog.focus();
    const handle = e => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        const els = [...dialog.querySelectorAll('button,a,input,select,textarea,[tabindex="0"]')].filter(x => !x.disabled && x.offsetParent !== null);
        const first = els[0], last = els.at(-1);
        if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { e.preventDefault(); last?.focus(); }
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handle); document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', handle); document.body.style.overflow = ''; previous?.focus(); };
  }, [onClose]);
  return <div className="modal-backdrop"><section className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}><div className="modal-title"><h2>{title}</h2><button className="icon-button" aria-label="关闭" onClick={onClose}><X size={22}/></button></div><div className="modal-body">{children}</div></section></div>;
}
export function Attachment({ value, onChange, required = false }) {
  const fileInput = useRef(null);
  const [filename, setFilename] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function change(e) {
    const file = e.target.files?.[0]; if (!file) return;
    setFilename(file.name);
    setBusy(true); setError('');
    try { const r = await upload(file); onChange(r.id); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <div className="field wide"><span>{`附件${required ? ' *' : ''}`}</span><div className="upload-inline"><Paperclip size={18}/><input ref={fileInput} hidden type="file" aria-label="附件文件" accept=".pdf,.png,.jpg,.jpeg,.webp,.xlsx,.ofd" onChange={change} disabled={busy}/><Button disabled={busy} onClick={() => fileInput.current?.click()}>选择文件</Button><span>{filename || '未选择任何文件'}</span>{busy ? <LoaderCircle className="spin" size={18}/> : null}{value ? <a href={`/api/files/${value}`} target="_blank" rel="noreferrer">查看已上传附件</a> : null}</div>{error ? <span className="error">{error}</span> : null}</div>;
}
export const matchCustomer = (value, name) => { const term = String(value == null ? '' : value).trim().toLowerCase(); return !term || String(name == null ? '' : name).toLowerCase().includes(term); };
export function SearchSelect({ value = '', options = [], onChange, label = '客户', placeholder = '全部客户', allowText = false, required = false }) {
  const [open, setOpen] = useState(false), [text, setText] = useState(null);
  const items = options.map(option => typeof option === 'string' ? { value: option, label: option } : option);
  const current = items.find(item => item.value === value);
  const display = text === null ? (current ? current.label : allowText ? String(value || '') : '') : text;
  const term = display.trim().toLowerCase();
  const matches = text !== null && term ? items.filter(item => item.label.toLowerCase().includes(term)) : items;
  const close = () => { setOpen(false); setText(null); };
  const pick = item => { setText(null); onChange(item.value); setOpen(false); };
  return <div className="customer-combobox" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }}>
    <input role="combobox" aria-label={label} aria-expanded={open} aria-autocomplete="list" required={required} placeholder={placeholder} title={display || undefined} value={display} onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onChange={event => { const next = event.target.value; setText(next); if (allowText) onChange(next); else setOpen(true); }} onKeyDown={event => { if (event.key === 'Escape') close(); }}/>
    <button type="button" className="customer-toggle" aria-label="展开候选列表" aria-expanded={open} onClick={() => { if (open) close(); else setOpen(true); }}><ChevronDown size={16}/></button>
    {open && matches.length ? <div className="customer-options" role="listbox" aria-label="候选列表">{matches.slice(0, 80).map(item => <button type="button" role="option" aria-selected={item.value === value} key={item.value} onClick={() => pick(item)}>{item.label}</button>)}</div> : null}
  </div>;
}
export function SaveBar({ busy, disabled, children, label = '保存', onCancel }) {
  return <div className="save-bar">{children}{onCancel ? <Button secondary onClick={onCancel}>取消</Button> : null}<Button type="submit" disabled={busy || disabled}>{busy ? <LoaderCircle size={16} className="spin"/> : null}{busy ? '正在保存…' : label}</Button></div>;
}
