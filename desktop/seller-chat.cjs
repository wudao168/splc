// 在淘宝订单详情页点「联系卖家」打开聊天窗口，并把催票话术填进输入框（发送仍由人工按回车）。
function clickSellerChat() {
  const visible = element => {
    const rect = element.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  };
  const text = element => (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
  const labels = ['联系卖家', '联系客服', '和我联系'];
  const candidates = [...document.querySelectorAll('button, a, [role="button"], span')]
    .filter(element => visible(element) && labels.includes(text(element)))
    .sort((a, b) => (a.tagName === 'SPAN' ? 1 : 0) - (b.tagName === 'SPAN' ? 1 : 0));
  if (!candidates.length) return { clicked: false, message: '订单页没有找到「联系卖家」入口' };
  candidates[0].click();
  return { clicked: true, label: text(candidates[0]) };
}

function fillSellerChat(script) {
  const message = String(script || '').slice(0, 500);
  if (!message) return { filled: false, message: '话术为空' };
  const fields = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
    .filter(element => element.getClientRects().length);
  const input = fields.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
  if (!input) return { filled: false, message: '聊天窗口没有找到输入框' };
  input.focus();
  if (input.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(input, message);
    else input.value = message;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    document.execCommand('insertText', false, message);
  }
  return { filled: true };
}

module.exports = { clickSellerChat, fillSellerChat };
