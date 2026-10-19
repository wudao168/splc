// 读取“我的淘宝 · 发票详情”页面（点订单页「申请开票」后打开的页面）。
// 页面是「标签：值」逐行排版，这里按标签取值，兼容同行和下一行两种排法。
function extractInvoiceSummary() {
  const text = element => (element?.innerText || '').replace(/\u00a0/g, ' ').trim();
  const lines = text(document.body).split(/\n/).map(line => line.trim()).filter(Boolean);
  const value = labels => {
    for (let index = 0; index < lines.length; index++) {
      for (const label of labels) {
        const line = lines[index];
        if (!line.startsWith(label)) continue;
        const inline = line.slice(label.length).replace(/^[：:\s]+/, '').trim();
        if (inline) return inline;
        const next = lines[index + 1] || '';
        if (next && !/^[：:]/.test(next) && !labels.some(item => next.startsWith(item))) return next;
      }
    }
    return '';
  };
  const body = text(document.body);
  const amount = (value(['发票金额']) || '').match(/[\d,]+(?:\.\d{1,2})?/);
  return {
    status: /已开票/.test(body) ? '已开票' : /申请中|开票中/.test(body) ? '申请中' : '',
    number: value(['发票号码']).slice(0, 80),
    code: value(['发票代码']).slice(0, 80),
    amount: amount ? amount[0].replaceAll(',', '') : '',
    date: value(['开票日期']).replaceAll('.', '-').slice(0, 20),
    invoice_type: value(['发票类型']).slice(0, 100),
    title: value(['发票抬头']).slice(0, 200),
    buyer_tax_id: value(['购方税号', '购买方税号', '纳税人识别号']).slice(0, 80)
  };
}

module.exports = { extractInvoiceSummary };
