/** 复制文本到剪贴板：优先异步剪贴板接口，失败时退回 execCommand（HTTP 非安全上下文也能用）。 */
export async function copyText(text) {
  const value = String(text ?? '');
  if (!value) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const previous = document.activeElement;
    const area = document.createElement('textarea');
    area.value = value;
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(area);
    try {
      area.select();
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      area.remove();
      previous?.focus?.();
    }
  }
}
