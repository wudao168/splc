// 在“我的淘宝 · 申请开票”表单里自动填写并保存。
// 规则：默认选「专用发票-电子」，没有该选项时退回「普通发票-电子」；抬头一律用企业。
function submitInvoiceForm(company) {
  const visible = element => {
    const rect = element.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  };
  const text = element => (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
  const inputsOf = element => [...(element?.querySelectorAll?.('input') || [])];
  // 按文字点选单选/复选：找到文字所在节点，再点它附近的 input。
  const pick = label => {
    const nodes = [...document.querySelectorAll('label, span, div, li, td')]
      .filter(element => visible(element) && text(element) === label)
      .sort((a, b) => text(a).length - text(b).length);
    for (const node of nodes) {
      const scope = node.closest('label') || node.parentElement || node;
      const input = inputsOf(scope).find(item => ['radio', 'checkbox'].includes(item.type));
      if (input) {
        if (!input.checked) input.click();
        return input.checked;
      }
    }
    return false;
  };
  const fill = (label, value) => {
    if (!value) return false;
    const labelNode = [...document.querySelectorAll('label, span, div, td')]
      .filter(element => visible(element) && text(element).replace(/^\*\s*/, '').replace(/[：:]$/, '') === label)
      .sort((a, b) => text(a).length - text(b).length)[0];
    if (!labelNode) return false;
    const scope = labelNode.closest('label, tr, li, div') || labelNode.parentElement;
    const input = inputsOf(scope).find(item => !['radio', 'checkbox', 'hidden', 'button', 'submit'].includes(item.type));
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, value); else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  const chosenType = pick('专用发票-电子') ? '专用发票-电子' : pick('普通发票-电子') ? '普通发票-电子' : '';
  pick('企业');
  fill('发票抬头', company.name || '');
  fill('纳税人识别号', company.tax_number || '');
  pick('商品明细');
  // 同意条款（复选框紧跟“我已阅读并同意”文字）
  const agree = [...document.querySelectorAll('input[type=checkbox]')].find(input => {
    const scope = input.closest('label') || input.parentElement;
    return visible(input) && /我已阅读并同意/.test(text(scope) || '');
  });
  if (agree && !agree.checked) agree.click();
  const save = [...document.querySelectorAll('button, a, [role="button"], div, span')]
    .filter(element => visible(element) && text(element) === '保存')
    .map(element => element.closest('button, a, [role="button"]') || element)[0];
  if (save) save.click();
  return {chosenType, agreed: !!agree?.checked, saved: !!save, name: company.name || '', tax: company.tax_number || ''};
}

module.exports = { submitInvoiceForm };
