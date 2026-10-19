import { api } from './api';

/** 明细栏列宽按账号保存在服务端；这里做一层内存缓存，切页或重新挂载时立即沿用，避免等待网络。 */
const cache = { userId: null, values: {} };

export function primeTableWidths(user) {
  if (!user || cache.userId === user.id) return;
  const saved = user.column_settings?.widths;
  cache.userId = user.id;
  cache.values = saved && typeof saved === 'object' && !Array.isArray(saved) ? { ...saved } : {};
}

export function readTableWidths(key) {
  const value = cache.values[key];
  return Array.isArray(value) && value.length ? value.map(Number) : null;
}

export function saveTableWidths(key, widths) {
  if (!key) return;
  if (Array.isArray(widths) && widths.length) cache.values[key] = widths;
  else delete cache.values[key];
  api('/users/me/table-widths', { key, widths: Array.isArray(widths) ? widths : [] }).catch(() => {});
}
