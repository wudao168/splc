import React, { useState } from 'react';
import { api, upload } from './api';
import { Button, Field } from './components';

export default function CompanyStamp({ kind, title, attachmentId, attachments, busy, run, onDone }) {
  const [selected, setSelected] = useState(attachmentId || '');
  const [name, setName] = useState(attachments.find(file => file.id === attachmentId)?.name || '');
  const [uploading, setUploading] = useState(false), [error, setError] = useState('');
  const choose = async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true); setError('');
    try {
      if (!/\.(png|jpe?g|webp)$/i.test(file.name)) throw new Error('请上传 PNG、JPG 或 WebP 图片');
      const result = await upload(file);
      setSelected(result.id); setName(result.name);
    } catch (ex) { setError(ex.message); }
    finally { setUploading(false); event.target.value = ''; }
  };
  const save = id => run(async () => { await api('/company/stamps', { kind, attachment_id: id }); onDone(); }, id ? `${title}已保存` : `${title}已移除`);
  return <form onSubmit={event => { event.preventDefault(); save(selected); }}>
    <p className="muted">上传现有印章图片，支持 PNG、JPG、WebP，建议使用透明背景。</p>
    <Field label={`${title}图片`}><input className="stamp-file-input" type="file" accept=".png,.jpg,.jpeg,.webp" onChange={choose} disabled={busy || uploading}/></Field>
    <div className="company-stamp-preview">{selected ? <img src={`/api/files/${selected}`} alt={`${title}预览`}/> : <span className="muted">尚未设置{title}</span>}</div>
    {name ? <p className="muted stamp-filename">{name}</p> : null}
    {uploading ? <p role="status">正在上传…</p> : null}{error ? <p role="alert" className="error">{error}</p> : null}
    <div className="save-bar">{attachmentId ? <Button secondary danger disabled={busy || uploading} onClick={() => save('')}>移除印章</Button> : null}<Button type="submit" disabled={busy || uploading || !selected}>保存印章</Button></div>
  </form>;
}
