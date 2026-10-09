import React, { useEffect, useRef, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { api } from './api';

/** 每账号保存的列显示设置：取消勾选即隐藏该列，下次打开自动沿用。 */
export function useColumnSettings(user, table) {
  const [hidden, setHidden] = useState(() => new Set(user?.column_settings?.[table] || []));
  const save = next => {
    setHidden(next);
    api('/users/me/columns', { table, hidden: [...next] }).catch(() => {});
  };
  const toggle = key => {
    const next = new Set(hidden);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    save(next);
  };
  return { hidden, toggle, reset: () => save(new Set()), attr: [...hidden].join(' ') };
}

export function ColumnSettings({ columns, hidden, onToggle, onReset }) {
  const ref = useRef(null);
  useEffect(() => {
    const inside = target => ref.current && ref.current.contains(target);
    const closeOnOutside = event => { if (ref.current?.open && !inside(event.target)) ref.current.open = false; };
    const closeOnEscape = event => { if (event.key === 'Escape' && ref.current?.open) ref.current.open = false; };
    document.addEventListener('pointerdown', closeOnOutside, true);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside, true);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, []);
  return <details className="column-settings" ref={ref}>
    <summary><SlidersHorizontal size={16}/><span>列设置</span></summary>
    <div className="column-settings-menu">
      <div className="column-settings-head"><strong>显示列</strong><button type="button" className="text-button" onClick={onReset}>恢复默认</button></div>
      <div className="column-settings-list">{columns.map(([key, label]) => <label key={key} className="check-label"><input type="checkbox" checked={!hidden.has(key)} onChange={() => onToggle(key)}/>{label}</label>)}</div>
      <p className="column-settings-foot">按账号保存，下次打开自动沿用</p>
    </div>
  </details>;
}
