export async function api(path, data) {
  const response = await fetch(`/api${path}`, data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '请求失败');
  return body;
}

export function filePayload(file, maxMB = 20) {
  if (file.size > maxMB * 1024 * 1024) return Promise.reject(new Error(`文件不能超过 ${maxMB} MB`));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.onload = () => resolve({ name: file.name, content: reader.result.split(',')[1] });
    reader.readAsDataURL(file);
  });
}

export const upload = async (file) => api('/attachments', await filePayload(file));
export const money = (cents = 0) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(cents / 100);
export const q = (value = 0) => Number(Number(value).toFixed(6)).toLocaleString('zh-CN', { maximumFractionDigits: 6 });
export const indexById = (list) => Object.fromEntries(list.map(x => [x.id, x]));

export function exportCsv(name, header, rows) {
  const cell = value => '"' + String(value ?? '').replace(/^[=+@-]/, s => "'" + s).replaceAll('"', '""') + '"';
  const url = URL.createObjectURL(new Blob(['\ufeff' + [header, ...rows].map(r => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}
