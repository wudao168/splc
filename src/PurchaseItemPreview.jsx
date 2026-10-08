import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { q } from './api';

/** 采购列表“料品 / 规格”单元格：点击打开预览窗，鼠标悬停显示浮层预览。 */
export default function PurchaseItemCell({ items, onOpen }) {
  const [tip, setTip] = useState(null);
  const timer = useRef(null);
  const open = event => {
    const rect = event.currentTarget.getBoundingClientRect();
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const width = 320;
      setTip({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: rect.bottom + 6, width });
    }, 220);
  };
  const close = () => { clearTimeout(timer.current); setTip(null); };
  const first = items[0];
  return <>
    <button type="button" className="text-button purchase-item-single" onMouseEnter={open} onMouseLeave={close} onFocus={open} onBlur={close}
      title={items.length > 1 ? `点击预览全部 ${items.length} 项料品` : '点击预览料品信息'} onClick={onOpen}>
      <strong>{first.name}</strong><small>{first.spec || '规格未填写'}</small>
    </button>
    {tip ? createPortal(<div className="purchase-item-hover" role="tooltip" style={{ left: tip.left, top: tip.top, width: tip.width }}>
      <div className="purchase-item-hover-title">{items.length > 1 ? `本单 ${items.length} 项料品` : '料品信息'}</div>
      <ul>{items.map(item => <li key={item.id}><span>{item.name}</span><small>{item.spec || '规格未填写'} · {q(item.quantity)} {item.unit}</small></li>)}</ul>
      <div className="purchase-item-hover-foot">点击可打开预览窗</div>
    </div>, document.body) : null}
  </>;
}
