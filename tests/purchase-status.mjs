import assert from 'node:assert/strict';
import {purchaseStatusKeys} from '../src/purchaseStatus.js';
assert.deepEqual(purchaseStatusKeys([]),['normal']);
assert.deepEqual(purchaseStatusKeys([{kind:'supplier_return',status:'pending'}]),['returning']);
assert.deepEqual(purchaseStatusKeys([{kind:'supplier_return',status:'completed'}]),['returned']);
assert.deepEqual(purchaseStatusKeys([{kind:'supplier_return',status:'void'}]),['normal']);
assert.deepEqual(purchaseStatusKeys([{kind:'supplier_return',status:'completed'},{kind:'cancel',status:'processing'}]),['returned','cancelling']);
console.log('PASS status rules');
