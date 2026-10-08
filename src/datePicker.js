// 原生日期输入框只有点击右侧小图标才会弹出日历：这里让整块区域都能唤起日期选择器，
// 并允许点击两个日期之间（如“至”“－”）的分隔文字时打开更近的那个日期框。
const DATE_INPUT = 'input[type="date"]';
const INTERACTIVE = 'input, select, textarea, button, a, label';

const usable = element => element.matches(DATE_INPUT) && !element.disabled && !element.readOnly;

function openPicker(input) {
  if (!input || input.disabled || input.readOnly) return;
  input.focus({ preventScroll: true });
  try { input.showPicker?.(); } catch { /* 浏览器不支持或不允许时只保留聚焦 */ }
}

const nearest = (inputs, clientX) => inputs.reduce((best, input) => {
  const box = input.getBoundingClientRect();
  const distance = clientX < box.left ? box.left - clientX : clientX > box.right ? clientX - box.right : 0;
  return distance < best.distance ? { input, distance } : best;
}, { input: inputs[0], distance: Infinity }).input;

export function handleDatePickerClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const inside = target.closest(DATE_INPUT);
  if (inside) { openPicker(inside); return; }
  if (target.closest(INTERACTIVE)) return;
  const range = target.closest('.date-range, .sales-invoice-date-range');
  if (range) {
    const inputs = [...range.querySelectorAll(DATE_INPUT)].filter(usable);
    if (inputs.length) openPicker(nearest(inputs, event.clientX));
    return;
  }
  const siblings = [...(target.parentElement?.children || [])];
  const index = siblings.indexOf(target);
  const before = siblings.slice(0, index).filter(usable);
  const after = siblings.slice(index + 1).filter(usable);
  if (!before.length || !after.length) return;
  openPicker(nearest([...before, ...after], event.clientX));
}
