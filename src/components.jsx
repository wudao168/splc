import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X, ClipboardList, LoaderCircle, Search, Paperclip, ChevronDown } from 'lucide-react';
import { upload } from './api';
import { readTableWidths, saveTableWidths } from './tableWidths';

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

/** 表头可能是文字、按钮或复选框，这里取出可用于识别列的文字。 */
function headerLabel(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node).trim();
  if (Array.isArray(node)) return node.map(headerLabel).filter(Boolean).join(' ');
  if (typeof node === 'object' && node.props) return headerLabel(node.props.children);
  return '';
}

function shortHash(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

/** 被拖动的列可以收窄到 36px；相邻列最多被挤到 84px，再窄就由表格横向滚动承担。 */
export const MIN_COLUMN_WIDTH = 36;
export const MIN_NEIGHBOR_WIDTH = 84;

export function Table({ headers, children, empty, columnWidths, className = '', tableKey }) {
  const ref = useRef(null);
  const store = useRef({ key: null, values: null });
  const drag = useRef(null);
  const [widths, setWidths] = useState(null);
  const [resizing, setResizing] = useState(false);
  const count = headers.length;
  const signature = headers.map((header, index) => headerLabel(header) || `#${index}`).join('|');
  const route = (typeof window === 'undefined' ? '' : window.location.hash.replace(/^#/, '').split('?')[0]) || 'dashboard';
  const key = tableKey || `${route}:${String(className).trim().split(/\s+/)[0].replace(/[^A-Za-z0-9_-]/g, '') || 'table'}:${count}:${shortHash(signature)}`;

  useLayoutEffect(() => {
    if (store.current.key === key) return;
    store.current.key = key;
    const saved = readTableWidths(key);
    const values = saved && saved.length === count && saved.every(value => Number.isFinite(value)) ? saved : null;
    store.current.values = values;
    setWidths(values);
  }, [key, count]);

  useEffect(() => () => document.body.classList.remove('col-resizing'), []);

  // 供汇总行对齐：把首列实际宽度告诉 CSS（有选择框的表格让“汇总（xx）”与选择框左对齐）。
  useLayoutEffect(() => {
    const element = ref.current;
    const head = element?.querySelector('thead th');
    const width = head ? Math.round(head.getBoundingClientRect().width) : 0;
    if (width > 0) element.style.setProperty('--first-col-width', `${width}px`);
  }, [widths, children]);

  /** 当前列宽：已保存的按保存值，未保存的按屏幕上实际渲染的宽度。 */
  const renderedWidths = useCallback(() => [...(ref.current?.querySelectorAll('thead th') || [])].map(th => Math.round(th.getBoundingClientRect().width)), []);
  const baseWidths = useCallback(() => {
    const rendered = renderedWidths();
    const values = store.current.values;
    return values && values.length === rendered.length ? values : rendered;
  }, [renderedWidths]);
  const applyWidths = useCallback((index, start, delta, persist) => {
    if (index < 0 || index >= start.length) return;
    const floor = (value, limit) => (value > 0 ? Math.min(limit, value) : 0);
    const next = [...start];
    next[index] = Math.max(floor(start[index], MIN_COLUMN_WIDTH), Math.round(start[index] + delta));
    if (index + 1 < next.length) {
      const moved = next[index] - start[index];
      next[index + 1] = Math.max(floor(start[index + 1], MIN_NEIGHBOR_WIDTH), Math.round(start[index + 1] - moved));
    }
    store.current.values = next;
    setWidths(next);
    if (persist) saveTableWidths(store.current.key, next);
  }, []);

  const startResize = index => event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const start = baseWidths();
    if (start.length !== count || !start.every(value => Number.isFinite(value) && value >= 0)) return;
    event.preventDefault();
    event.stopPropagation();
    drag.current = { index, x: event.clientX, start };
    setResizing(true);
    document.body.classList.add('col-resizing');
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 忽略不支持指针捕获的环境 */ }
  };
  const moveResize = event => {
    const state = drag.current;
    if (!state) return;
    event.preventDefault();
    applyWidths(state.index, state.start, event.clientX - state.x, false);
  };
  const finishResize = event => {
    if (!drag.current) return;
    drag.current = null;
    setResizing(false);
    document.body.classList.remove('col-resizing');
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* 忽略 */ }
    if (store.current.values) saveTableWidths(store.current.key, store.current.values);
  };
  const resetWidths = event => {
    event.preventDefault();
    event.stopPropagation();
    store.current.values = null;
    setWidths(null);
    saveTableWidths(store.current.key, null);
  };
  const keyResize = index => event => {
    const step = event.key === 'ArrowLeft' ? -(event.shiftKey ? 64 : 16) : event.key === 'ArrowRight' ? (event.shiftKey ? 64 : 16) : 0;
    if (!step) return;
    const start = baseWidths();
    if (start.length !== count) return;
    event.preventDefault();
    event.stopPropagation();
    applyWidths(index, start, step, true);
  };

  const custom = widths && widths.length === count ? widths : null;
  const customTotal = custom ? custom.reduce((sum, value) => sum + value, 0) : 0;
  const colWidths = custom ? custom.map((value, index) => (Number(columnWidths?.[index]) === 0 ? 0 : value)) : columnWidths;
  const colTotal = (colWidths && !custom ? colWidths.reduce((sum, value) => sum + value, 0) : 0) || 1;
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
        // 可见高度对齐到整行，避免最后一行被截成半行（列表底部看起来“溢出”）。
        const headHeight = element.querySelector('thead')?.getBoundingClientRect().height || 0;
        const rowHeight = element.querySelector('tbody tr')?.getBoundingClientRect().height || 0;
        const firstHead = element.querySelector('thead th');
        const firstWidth = firstHead ? Math.round(firstHead.getBoundingClientRect().width) : 0;
        if (firstWidth > 0) element.style.setProperty('--first-col-width', `${firstWidth}px`);
        const snapped = rowHeight > 16
          ? headHeight + Math.max(rowHeight, Math.floor(Math.max(0, height - headHeight) / rowHeight) * rowHeight)
          : height;
        element.style.setProperty('--table-available-height', `${Math.round(Math.min(height, snapped))}px`);
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element.parentElement);
    window.addEventListener('resize', measure);
    measure();
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); cancelAnimationFrame(frame); };
  }, [children]);
  return <div className={`table-scroll ${className}${custom ? ' table-custom-cols' : ''}${resizing ? ' table-col-resizing' : ''}`} ref={ref}>
    <table style={custom ? { minWidth: `${Math.round(customTotal)}px`, maxWidth: 'none' } : undefined}>
      {colWidths ? <colgroup>{colWidths.map((width, i) => <col key={i} style={{ width: custom ? `${width}px` : `${width / colTotal * 100}%` }}/>)}</colgroup> : null}
      <thead><tr>{headers.map((h, i) => <th key={i}>{h}<span
        className="col-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label={`调整「${headerLabel(h) || `第 ${i + 1} 列`}」列宽`}
        title="拖动调整列宽，双击恢复默认"
        onPointerDown={startResize(i)}
        onPointerMove={moveResize}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onDoubleClick={resetWidths}
        onKeyDown={keyResize(i)}
        tabIndex={-1}
      /></th>)}</tr></thead>
      <tbody>{children}</tbody>
    </table>{empty}</div>;
}
export function FixedCell({ children, ...props }) {
  return <td {...props}><div className="fixed-cell"><div className="fixed-cell-content">{children}</div></div></td>;
}
export function Panel({ title, action, children, className = '', ...props }) {
  return <section className={`panel ${className}`} {...props}>{title ? <div className="panel-title"><h2>{title}</h2>{action}</div> : null}{children}</section>;
}
export function Modal({ title, children, onClose, wide }) {
  const ref = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    // 表单里已有自动聚焦的字段时不要抢走焦点，否则打开弹窗后没法直接输入。
    if (!dialog.contains(document.activeElement)) dialog.focus();
    const handle = e => {
      if (e.key === 'Escape') close.current();
      if (e.key === 'Tab') {
        const els = [...dialog.querySelectorAll('button,a,input,select,textarea,[tabindex="0"]')].filter(x => !x.disabled && x.offsetParent !== null);
        const first = els[0], last = els.at(-1);
        if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { e.preventDefault(); last?.focus(); }
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handle); document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', handle); document.body.style.overflow = ''; previous?.focus(); };
    // 只挂载一次：父级每秒刷新时钟会重建 onClose，若跟随它重跑，清理函数会把焦点从正在输入的字段抢走。
  }, []);
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
