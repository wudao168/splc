const {test} = require('node:test');
const assert = require('node:assert/strict');
const {extractInvoiceSummary} = require('../desktop/extract-invoice-summary.cjs');

const run = innerText => new Function('document', `return (${extractInvoiceSummary.toString()})()`)({body:{innerText}});

test('读取我的淘宝发票详情页的发票信息', () => {
  const result = run(['已开票 该订单已开具1张发票',
    '发票代码：\t5699524012',
    '发票号码：\t56014083',
    '发票金额：\t￥11.40',
    '发票类型：\t普通发票-纸质 - 企业',
    '开票日期：\t2026-10-15',
    '发票抬头：\t上海思品利诚智能科技有限公司',
    '购方税号：\t91310120MADL4XAW73'].join('\n'));
  assert.deepEqual(result, {
    status: '已开票', number: '56014083', code: '5699524012', amount: '11.40', date: '2026-10-15',
    invoice_type: '普通发票-纸质 - 企业', title: '上海思品利诚智能科技有限公司', buyer_tax_id: '91310120MADL4XAW73'
  });
});

test('标签与值分两行时同样能取到', () => {
  const result = run(['申请中', '发票号码', '56014083', '发票金额', '11.40', '开票日期', '2026.10.15'].join('\n'));
  assert.equal(result.number, '56014083');
  assert.equal(result.amount, '11.40');
  assert.equal(result.date, '2026-10-15');
  assert.equal(result.status, '申请中');
});

test('没有发票号码时返回空号码', () => {
  const result = run('该订单暂未开具发票');
  assert.equal(result.number, '');
  assert.equal(result.status, '');
});
