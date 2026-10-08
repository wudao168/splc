import React, { useEffect, useMemo, useRef, useState } from 'react';
import { q } from './api';

const haystack = item => [item.code, item.name, item.spec, item.brand, item.key_specs, item.customer_code, item.supplier_code]
  .filter(Boolean).join(' ').toLowerCase();

/** 料品名称 / 规格输入框：输入 2 个字后按产品库搜索，有库存的料品置顶。 */
export default function ItemSuggest({ items = [], value = '', onChange, onPick, ariaLabel, title, placeholder, minChars = 2 }) {
  const [open, setOpen] = useState(false), [active, setActive] = useState(0), [rect, setRect] = useState(null);
  const inputRef = useRef(null), rootRef = useRef(null);
  const term = String(value || '').trim().toLowerCase();
  const matches = useMemo(() => {
    if (term.length < minChars) return [];
    const rank = item => (Number(item.available) > 0 ? 0 : Number(item.on_hand) > 0 ? 1 : 2);
    return items.filter(item => item.active !== 0 && haystack(item).includes(term))
      .sort((a, b) => rank(a) - rank(b) || Number(b.available || 0) - Number(a.available || 0) || String(a.name).localeCompare(String(b.name), 'zh-CN'))
      .slice(0, 40);
  }, [items, term, minChars]);
  const visible = open && matches.length > 0;
  useEffect(() => {
    if (!visible) return;
    const close = () => setOpen(false);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    const box = inputRef.current?.getBoundingClientRect();
    if (box) setRect({ left: Math.max(12, Math.min(box.left, window.innerWidth - 552)), top: box.bottom + 2, width: box.width });
  }, [visible, matches.length]);
  const choose = item => { setOpen(false); onPick(item); };
  return <div className="item-suggest" ref={rootRef} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <input ref={inputRef} className="cell-input" role="combobox" aria-label={ariaLabel} aria-expanded={visible} aria-autocomplete="list" title={title} placeholder={placeholder} value={value}
      onFocus={() => setOpen(true)}
      onChange={event => { onChange(event.target.value); setOpen(true); setActive(0); }}
      onKeyDown={event => {
        if (event.key === 'Escape') { setOpen(false); return; }
        if (!visible) return;
        if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(index + 1, matches.length - 1)); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(index - 1, 0)); }
        else if (event.key === 'Enter') { event.preventDefault(); choose(matches[active] || matches[0]); }
      }}/>
    {visible ? <div className="item-suggest-menu" role="listbox" aria-label="料品候选列表" style={{ left: rect ? rect.left : 0, top: rect ? rect.top : 0, minWidth: Math.max(rect ? rect.width : 0, 520) }}>
      {matches.map((item, index) => <button type="button" role="option" aria-selected={index === active} className={index === active ? 'active' : undefined} key={item.id}
        onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => choose(item)}>
        <span className="item-suggest-name">{item.name}</span>
        <span className="item-suggest-field">{item.spec || '—'}</span>
        <span className="item-suggest-field">{item.brand || '—'}</span>
        <span className="item-suggest-stock">现存 {q(item.on_hand)}</span>
        <span className="item-suggest-stock">可用 {q(item.available)}</span>
      </button>)}
    </div> : null}
  </div>;
}
