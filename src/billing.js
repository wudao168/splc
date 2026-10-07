export async function copyBillingInfo(form, fields, title = '开票付款资料') {
  const text = [title, ...fields.map(([key, label]) => `${label}：${(form[key] || '').trim()}`)].join('\n');
  try { await navigator.clipboard.writeText(text); }
  catch {
    // The desktop shell blocks clipboard permission requests; use a user-initiated copy.
    const previous = document.activeElement;
    const input = document.createElement('textarea');
    input.value = text;
    input.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(input);
    try { input.select(); if (!document.execCommand('copy')) throw new Error('复制失败'); }
    finally { input.remove(); previous?.focus(); }
  }
}

export async function downloadBillingInfo(endpoint, form, filename) {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
  if (!response.ok) throw new Error((await response.json()).error || '导出失败');
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
