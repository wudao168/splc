import React from 'react';
import { api } from './api';
import { Button } from './components';

export default function SyncNow({ data, run, busy, children }) {
  const task = data.sync_request || {};
  const active = ['pending','running'].includes(task.status);
  const status = {pending:'等待客户端执行',running:'正在同步',done:'同步完成',failed:'同步未完成'}[task.status];
  return <div className="sync-now">{children}<span className="muted" title={task.error || ''}>{status}{task.status === 'failed' ? `：${task.error}` : ''}</span><Button secondary disabled={busy || active} onClick={() => run(() => api('/sync-now', {}), '已请求同步，请保持客户端运行并登录淘宝')}>立即同步</Button></div>;
}
