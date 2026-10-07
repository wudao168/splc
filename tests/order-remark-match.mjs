import {test} from 'node:test';
import assert from 'node:assert/strict';
import {suggestOrderLineIds} from '../src/orderRemarkMatch.js';

const orders = {1:{po:'PO99999990055'},2:{po:'PO99999990056'}};
const lines = [
  {id:10,order_id:1,name:'欧形端子',spec:'VE16-12（500只）',description:''},
  {id:11,order_id:1,name:'端子',spec:'VE16-10',description:''},
  {id:12,order_id:2,name:'笔',spec:'P70208 4-4',description:''}
];

test('PO and model select the matching line within the customer order', () => {
  assert.deepEqual(suggestOrderLineIds('普票，PO99999990055，欧形端子，VE16-12（500只），数量1',lines,orders),[10]);
});
test('a unique PO or model can select a line, but ambiguous matches stay manual', () => {
  assert.deepEqual(suggestOrderLineIds('PO99999990056，P70208 4-4',lines,orders),[12]);
  assert.deepEqual(suggestOrderLineIds('VE16-10',lines,orders),[11]);
  assert.deepEqual(suggestOrderLineIds('PO99999990055',lines,orders),[]);
  assert.deepEqual(suggestOrderLineIds('VE16',lines,orders),[]);
  assert.deepEqual(suggestOrderLineIds('PO9999999005',lines,orders),[]);
  assert.deepEqual(suggestOrderLineIds('PO99999990055，P70208 4-4',lines,orders),[]);
});

test('manual PO narrows identical models and multiple unique specs can match', () => {
 const os={1:{po:'C3260928500018'},2:{po:'C3260928500019'}};
 const ls=[{id:1,order_id:1,spec:'CBJT-M28-1/2-SUS304'},{id:2,order_id:1,spec:'CBJT-M20-1/4-SUS304'},{id:3,order_id:2,spec:'CBJT-M20-1/4-SUS304'}];
 assert.deepEqual(suggestOrderLineIds('CBJT-M20-1/4-SUS304',ls,os),[]);
 assert.deepEqual(suggestOrderLineIds('CBJT-M20-1/4-SUS304',ls,os,1),[2]);
 assert.deepEqual(suggestOrderLineIds('C3260928500018，CBJT-M28-1/2-SUS304，CBJT-M20-1/4-SUS304',ls,os),[1,2]);
 assert.deepEqual(suggestOrderLineIds('CBJT-M20-1/4-SUS304',[...ls,{id:4,order_id:1,spec:ls[1].spec}],os,1),[]);
});

test('quantity after a specification is not treated as a model suffix', () => {
 const os={1:{po:'C3260928500018'}};
 const ls=[{id:17,order_id:1,spec:'CBJT-M20-1/4-SUS304'},{id:18,order_id:1,spec:'CBJT-M28-1/2-SUS304'}];
 const remark='专票，304 RC1/4内-M20x1.5外，和 304 RC1/2内-M28x1.5外； GZ,送货单备注：C3260928500018 ，P301581 ，穿板式接头：CBJT-M20-1/4-SUS304，数量6；和 CBJT-M28-1/2-SUS304，数量3';
 assert.deepEqual(suggestOrderLineIds(remark,ls,os),[17,18]);
 assert.deepEqual(suggestOrderLineIds(remark,ls,os,1),[17,18]);
});

 test('high similarity provides references without automatic selection', async () => {
 const {similarOrderLineScores}=await import('../src/orderRemarkMatch.js');
 const ls=[{id:1,order_id:1,spec:'CBJT-M20-1/4-SUS304'},{id:2,order_id:1,spec:'CBJT-M28-1/2-SUS304'},{id:3,order_id:1,spec:'HFK21-60B'}];
 const scores=similarOrderLineScores('CBJT-M21-1/4-SUS304',ls);
 assert.ok(scores.has(1));
 assert.equal(scores.has(3),false);
 assert.deepEqual(suggestOrderLineIds('CBJT-M21-1/4-SUS304',ls,{1:{po:'C123456789'}}),[]);
 });

