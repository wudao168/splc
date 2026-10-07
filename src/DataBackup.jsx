import React, { useState } from 'react';
import { api, filePayload } from './api';
import { Panel, Button, InputField } from './components';

export default function DataBackup() {
  const [file, setFile] = useState(null), [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState(null);
  async function download() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/backup');
      if (!response.ok) throw new Error((await response.json()).error);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url; link.download = `采单完整备份-${new Date().toISOString().slice(0, 10)}.zip`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function restore(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const payload = await filePayload(file, 100);
      setResult(await api('/restore', { ...payload, confirmation }));
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <Panel title="数据备份与恢复"><p>完整备份包含账号、公司资料、订单、采购、送货单、操作记录和附件。下载后请另存一份到其他设备，以便系统损坏或更换服务器时恢复。</p>
    {error ? <p className="notice error" role="alert">{error}</p> : null}
    {result ? <><p className="notice" role="status">恢复完成。恢复前的数据已自动保存到服务器 backups/{result.safety_backup}。请使用备份中的账号和密码重新登录。</p><Button onClick={() => location.reload()}>重新登录</Button></> : <>
      <Button disabled={busy} onClick={download}>下载完整备份 ZIP</Button>
      <h3>从备份恢复</h3><p className="notice warning">恢复将替换当前全部业务数据，并清除所有登录会话。系统会先校验备份，再自动保存当前数据的安全备份。更换服务器时，请在新服务器部署兼容版本后导入本文件。</p>
      <form onSubmit={restore}><InputField label="完整备份 ZIP（最大 100 MB）" type="file" accept=".zip,application/zip" required disabled={busy} onChange={e => { setFile(e.target.files?.[0] || null); setConfirmation(''); }}/><InputField label="输入“恢复全部数据”确认覆盖" value={confirmation} disabled={busy} onChange={e => setConfirmation(e.target.value)} autoComplete="off"/>
        <Button danger type="submit" disabled={busy || !file || confirmation !== '恢复全部数据'}>{busy ? '正在处理，请勿重复操作…' : '校验并恢复数据'}</Button></form>
      <p className="muted">仅支持与当前数据库结构兼容的采单备份。超过网页大小限制的备份可停服后恢复数据库和附件目录。系统版本更新仍通过飞牛 Docker 操作。</p>
    </>}
  </Panel>;
}
