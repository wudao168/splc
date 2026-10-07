// Read only the invoice rows currently rendered by Taobao's "全部发票" page.
function extractInvoicePage(expectedMode) {
  if (location.hostname !== 'i.taobao.com' || location.pathname !== '/my_itaobao/invoice') throw new Error('当前不是淘宝发票列表');
  const mode = new URL(location.href).searchParams.get('active') || 'already';
  if (mode !== expectedMode) throw new Error('发票分类尚未加载');
  const current = document.querySelector('button.next-pagination-item.next-current');
  const page = Number(current?.textContent?.trim());
  if (!Number.isInteger(page) || page < 1) throw new Error('发票列表尚未加载');
  const entries = [];
  for (const row of document.querySelectorAll('table[role="row"]')) {
    const platform_order = row.querySelector('[class*="group-header-title-number"]')?.textContent?.trim() || '';
    if (!/^\d{8,30}$/.test(platform_order)) continue;
    const cell = number => row.querySelector(`[data-next-table-col="${number}"]`)?.innerText?.trim() || '';
    const amount = cell(1).match(/[\d,]+(?:\.\d{1,2})?/)?.[0]?.replaceAll(',', '') || '';
    const titleAndType = cell(2).split(/\n+/).map(s => s.trim()).filter(Boolean);
    const statusCell = row.querySelector(`[data-next-table-col="${mode === 'already' ? 5 : 3}"]`);
    const status = statusCell?.querySelector(mode === 'already' ? '[class*="status-card"]' : '[class*="progress"]')?.textContent?.trim() || '';
    if (!amount || !status) continue;
    entries.push({
      platform_order,
      shop: row.querySelector('[class*="group-header-logo"] div')?.textContent?.trim() || '',
      amount,
      title: titleAndType[0] || '',
      invoice_type: mode === 'already' ? cell(3) : titleAndType[1] || '',
      status,
      date: mode === 'already' ? cell(4).replaceAll('.', '-') : '',
      applied_at: mode === 'application' ? row.querySelector('[class*="group-header-time"]')?.innerText?.replace(/申请时间：\s*/, '').trim() || '' : '',
      note: mode === 'application' ? cell(4) : ''
    });
  }
  const next = document.querySelector('button.next-pagination-item.next-next');
  return {page, entries, has_next: !!next && !next.disabled};
}

module.exports = { extractInvoicePage };
