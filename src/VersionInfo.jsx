import React, { useEffect, useState } from 'react';
import { Modal } from './components';

export const BUILD_ID = typeof __CAIDAN_BUILD__ === 'undefined' ? 'V—' : __CAIDAN_BUILD__;
const BUILT_AT = typeof __CAIDAN_BUILT_AT__ === 'undefined' ? '' : __CAIDAN_BUILT_AT__;

/** 系统版本信息：当前构建、服务端、客户端与数据库，以及版本记录。 */
export default function VersionInfo({ onClose }) {
  const [health, setHealth] = useState(null);
  const [history, setHistory] = useState([]);
  useEffect(() => {
    let alive = true;
    fetch('/api/health').then(response => response.json()).then(data => { if (alive) setHealth(data); }).catch(() => {});
    fetch('/versions.json').then(response => response.json()).then(data => { if (alive) setHistory(Array.isArray(data) ? data : data.entries || []); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const latest = history[0];
  const clientBuild = typeof window !== 'undefined' && window.caidanDesktop ? BUILD_ID : null;
  return <Modal title="系统版本信息" onClose={onClose}>
    <div className="version-current"><strong>{BUILD_ID}</strong><span className="version-badge">当前版本</span></div>
    <div className="version-table">
      <div><small>发布标识</small><strong>{BUILD_ID.replace(/^V/, '')}</strong></div>
      <div><small>发布时间</small><strong>{BUILT_AT || '—'}</strong></div>
      <div><small>服务器／网页端</small><strong>{health?.build || '—'}</strong></div>
      <div><small>Windows 客户端</small><strong>{clientBuild ? `已连接（${clientBuild}）` : '未连接客户端'}</strong></div>
      <div><small>数据库</small><strong>{health ? `${health.database || 'SQLite'} · ${health.data_dir || ''}` : '读取中…'}</strong></div>
    </div>
    <section className="version-notes"><h3>版本说明</h3><p>{latest?.notes || '暂无版本说明。'}</p></section>
    <section className="version-history">
      <h3>版本记录</h3>
      {history.map(entry => <article key={`${entry.date}-${entry.title || ''}`}>
        <header><strong>{entry.title || entry.date}</strong><span>{entry.date}</span></header>
        <p>{entry.notes}</p>
      </article>)}
      {!history.length ? <p className="muted">暂无版本记录。</p> : null}
    </section>
  </Modal>;
}
