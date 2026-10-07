import tempfile
import unittest

from server.db import connect
from server import domain as dm, lifecycle as lc, auth


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.con = connect(self.temp.name)
        self.worker = auth.create_user(self.con, {'username':'worker','display_name':'采购员','password':'testing456'})
        self.actor = dm.actor_id.set(self.worker)
        self.oid, self.lid = self.order('A', 10)

    def test_supplier_return_optional_reason_and_whole_number_quantity(self):
        pid, plid = self.purchase(10)
        lc.dispatch(self.con, f'/api/purchase-lines/{plid}/cases', {'quantity':2,'reason':'已有待办'})
        for value in (0, 0.5, 1.5, 9):
            with self.assertRaises(ValueError):
                lc.dispatch(self.con, f'/api/purchase-lines/{plid}/cases', {'quantity':value,'kind':'supplier_return'})
        cid = lc.dispatch(self.con, f'/api/purchase-lines/{plid}/cases', {'quantity':8,'kind':'supplier_return','reason':''})['id']
        case = dm.row(self.con, 'SELECT * FROM purchase_cases WHERE id=?', (cid,))
        self.assertEqual((case['quantity'],case['reason'],case['kind'],case['status']), (8,'','supplier_return','processing'))
        self.assertEqual(case['owner_id'], self.worker)
        self.assertEqual(len(dm.get_state(self.con)['purchase_cases']), 2)

    def test_manual_supplier_return_releases_only_purchase_quantity(self):
        pid, plid = self.purchase(10)
        cid = lc.dispatch(self.con, f'/api/purchase-lines/{plid}/cases', {'quantity':3,'kind':'supplier_return'})['id']
        self.con.execute('UPDATE purchase_cases SET amount_cents=100 WHERE id=?', (cid,))
        lc.complete_purchase_case(self.con, cid)
        self.assertEqual(lc.purchased_qty(self.con, self.lid), 7)
        self.assertEqual(lc.demand_qty(self.con, self.lid), 10)
        self.assertEqual(dm.row(self.con, 'SELECT status FROM purchase_cases WHERE id=?', (cid,))['status'], 'completed')
        with self.assertRaises(ValueError):
            lc.complete_purchase_case(self.con, cid)

    def test_manual_return_restore_blocks_duplicate_purchase(self):
        pid, plid = self.purchase(10)
        cid = lc.dispatch(self.con, f'/api/purchase-lines/{plid}/cases', {'quantity':3,'kind':'supplier_return'})['id']
        lc.complete_purchase_case(self.con, cid)
        lc.void_case(self.con, 'purchase_cases', cid, {'reason':'录错恢复'})
        self.assertEqual(lc.purchased_qty(self.con, self.lid), 10)
        cid2 = lc.dispatch(self.con, f'/api/purchase-lines/{plid}/cases', {'quantity':3,'kind':'supplier_return'})['id']
        lc.complete_purchase_case(self.con, cid2)
        self.purchase(3, code='P-REBUY')
        with self.assertRaisesRegex(ValueError, '重新采购'):
            lc.void_case(self.con, 'purchase_cases', cid2, {'reason':'恢复'})

    def test_quick_return_and_restore(self):
        pid, plid = self.purchase(10)
        lc.dispatch(self.con, f'/api/purchase-lines/{plid}/cases', {'quantity':2,'kind':'supplier_return','immediate':True})
        self.assertEqual(lc.purchased_qty(self.con, self.lid), 8)
        lc.dispatch(self.con, f'/api/purchases/{pid}/return', {})
        self.assertEqual(lc.purchased_qty(self.con, self.lid), 0)
        lc.dispatch(self.con, f'/api/purchases/{pid}/restore-return', {})
        self.assertEqual(lc.purchased_qty(self.con, self.lid), 10)
        self.assertEqual(lc.demand_qty(self.con, self.lid), 10)

    def tearDown(self):
        dm.actor_id.reset(self.actor)
        self.con.close()
        self.temp.cleanup()

    def order(self, po, quantity):
        oid = dm.create_order(self.con, {'customer':'测试客户','address':'测试地址','po':po,
            'lines':[{'name':'螺栓','quantity':quantity,'price':10}]})['id']
        dm.confirm_quote(self.con, oid)
        return oid, dm.row(self.con, 'SELECT id FROM order_lines WHERE order_id=?', (oid,))['id']

    def purchase(self, quantity=10, code='P1', lid=None):
        pid = dm.create_purchase(self.con, {'platform':'京东','shop':'测试店铺','platform_order':code,'amount':quantity*6,
            'lines':[{'order_line_id':lid or self.lid,'quantity':quantity,'cost':quantity*6}]})['id']
        return pid, dm.row(self.con, 'SELECT id FROM purchase_lines WHERE purchase_id=?', (pid,))['id']

    def delivery(self, quantity, ship=True, replacement=None):
        did = dm.create_deliveries(self.con, {'company':'测试公司','replacement_case_id':replacement,
            'lines':[{'order_line_id':self.lid,'quantity':quantity}]})['ids'][0]
        self.assertTrue(dm.row(self.con, 'SELECT shipped_at FROM deliveries WHERE id=?', (did,))['shipped_at'])
        if not ship:
            self.con.execute("UPDATE deliveries SET shipped_at='' WHERE id=?", (did,))
        return did, dm.row(self.con, 'SELECT id FROM delivery_lines WHERE delivery_id=?', (did,))['id']

    def case(self, kind, quantity, **extra):
        return lc.create_order_case(self.con, self.oid, {'kind':kind,'quantity':quantity,'order_line_id':self.lid,
            'reason':'客户调整','financial_type':'none', **extra})['id']

    def as_admin(self, fn, *args):
        token = dm.actor_id.set(1)
        try:
            return fn(self.con, *args)
        finally:
            dm.actor_id.reset(token)

    def test_partial_cancel_return_and_shared_procurement(self):
        oid2, lid2 = self.order('B', 3)
        pid = dm.create_purchase(self.con, {'platform':'京东','shop':'测试店铺','platform_order':'SHARED','amount':78,
            'lines':[{'order_line_id':self.lid,'quantity':10,'cost':60},{'order_line_id':lid2,'quantity':3,'cost':18}]})['id']
        plid = dm.row(self.con, 'SELECT id FROM purchase_lines WHERE order_line_id=?', (self.lid,))['id']
        did, dlid = self.delivery(6)
        cancellation = self.case('cancel', 4)
        pc = dm.get_state(self.con)['purchase_cases'][0]
        self.assertEqual(pc['quantity'], 4)
        with self.assertRaisesRegex(ValueError, '未完成'):
            lc.complete_order_case(self.con, cancellation)
        lc.update_purchase_case(self.con, pc['id'], {'kind':'cancel','amount':24,'note':'卖家取消，退款到账'})
        with self.assertRaisesRegex(ValueError, '管理员'):
            lc.confirm_case_finance(self.con, 'purchase_cases', pc['id'])
        with self.assertRaisesRegex(ValueError, '到账'):
            lc.complete_purchase_case(self.con, pc['id'])
        self.as_admin(lc.confirm_case_finance, 'purchase_cases', pc['id'])
        lc.complete_purchase_case(self.con, pc['id'])
        lc.complete_order_case(self.con, cancellation)
        returned = self.case('return', 2, delivery_line_id=dlid, purchase_line_id=plid)
        lc.update_order_case(self.con, returned, {'received_quantity':2,'note':'退回完好'})
        pc2 = dm.get_state(self.con)['purchase_cases'][0]
        lc.update_purchase_case(self.con, pc2['id'], {'kind':'stock','location':'A 架','note':'退回转存'})
        lc.complete_purchase_case(self.con, pc2['id'])
        lc.complete_order_case(self.con, returned)
        state = dm.get_state(self.con)
        line = next(l for l in state['order_lines'] if l['id'] == self.lid)
        self.assertEqual((line['cancelled_quantity'],line['dispatched_quantity'],line['returned_quantity'],line['purchased']), (4,6,2,4))
        self.assertEqual(line['cost_cents'], 2400)
        self.assertEqual(next(l for l in state['order_lines'] if l['id'] == lid2)['purchased'], 3)
        self.assertEqual(next(o for o in state['orders'] if o['id'] == oid2)['status'], 'confirmed')
        self.assertEqual(lc.delivery_limit(self.con, self.lid), 0)
        self.assertEqual(len(state['quotes']), 2)

    def test_unshipped_delivery_reserves_and_return_requires_actual_dispatch(self):
        did, dlid = self.delivery(6, False)
        with self.assertRaisesRegex(ValueError, '送货单'):
            self.case('cancel', 5)
        with self.assertRaisesRegex(ValueError, '实际发货'):
            self.case('return', 1, delivery_line_id=dlid)
        dm.void_delivery(self.con, did)
        self.case('cancel', 4)
        did, dlid = self.delivery(6)
        with self.assertRaisesRegex(ValueError, '已实际发货'):
            dm.void_delivery(self.con, did)
        with self.assertRaisesRegex(ValueError, '尚未实际发出'):
            self.case('cancel', 1)
        self.case('return', 4, delivery_line_id=dlid)
        with self.assertRaisesRegex(ValueError, '尚未申请售后'):
            self.case('return', 3, delivery_line_id=dlid)
        with self.assertRaisesRegex(ValueError, '售后'):
            self.as_admin(lc.dispatch, f'/api/deliveries/{did}/unship', {'reason':'录错'})

    def test_exchange_has_separate_capacity(self):
        did, dlid = self.delivery(10)
        cid = self.case('exchange', 2, delivery_line_id=dlid)
        with self.assertRaisesRegex(ValueError, '剩余数量'):
            self.delivery(1, replacement=cid)
        lc.update_order_case(self.con, cid, {'received_quantity':2,'location':'待换区','note':'已收回'})
        with self.assertRaisesRegex(ValueError, '补发'):
            lc.complete_order_case(self.con, cid)
        self.delivery(2, replacement=cid)
        lc.complete_order_case(self.con, cid)
        self.assertEqual(lc.delivery_limit(self.con, self.lid), 0)
        with self.assertRaisesRegex(ValueError, '剩余数量'):
            self.delivery(1, replacement=cid)
        line = dm.get_state(self.con)['order_lines'][0]
        self.assertEqual(line['dispatched_quantity']-line['returned_quantity'], 10)

    def test_refund_cannot_exceed_receipts_and_cannot_complete_unconfirmed(self):
        _, dlid = self.delivery(5)
        cid = self.case('refund_only', 1, delivery_line_id=dlid, financial_type='refund_received', amount=15)
        with self.assertRaisesRegex(ValueError, '收款余额'):
            self.as_admin(lc.confirm_case_finance, 'order_cases', cid)
        with self.assertRaisesRegex(ValueError, '管理员'):
            lc.receipt(self.con, self.oid, {'amount':20,'note':'已收'})
        rid = self.as_admin(lc.receipt, self.oid, {'amount':20,'note':'银行实收'})['id']
        self.as_admin(lc.confirm_case_finance, 'order_cases', cid)
        with self.assertRaisesRegex(ValueError, '用于退款'):
            self.as_admin(lc.dispatch, f'/api/order-receipts/{rid}/void', {'reason':'录错'})
        lc.update_order_case(self.con, cid, {'note':'客户确认仅退款','amount':15})
        lc.complete_order_case(self.con, cid)
        with self.assertRaisesRegex(ValueError, '已完成'):
            lc.update_order_case(self.con, cid, {'note':'修改'})
        self.as_admin(lc.void_case, 'order_cases', cid, {'reason':'退款登记录错'})
        self.as_admin(lc.dispatch, f'/api/order-receipts/{rid}/void', {'reason':'收款录错'})
        self.assertEqual(dm.get_state(self.con)['orders'][0]['refunded_cents'], 0)

    def test_split_transfer_stock_and_reversal_conserve_quantity_and_cost(self):
        _, plid = self.purchase()
        cid = self.case('cancel', 4)
        original = dm.get_state(self.con)['purchase_cases'][0]['id']
        second = lc.dispatch(self.con, f'/api/purchase-cases/{original}/split', {'quantity':1})['id']
        _, target = self.order('B', 4)
        lc.update_purchase_case(self.con, original, {'kind':'transfer','target_order_line_id':target,'note':'转入 B'})
        lc.complete_purchase_case(self.con, original)
        lc.update_purchase_case(self.con, second, {'kind':'stock','location':'A','note':'待分配'})
        lc.complete_purchase_case(self.con, second)
        lc.complete_order_case(self.con, cid)
        self.assertEqual(lc.purchased_qty(self.con, target), 3)
        lc.move_stock(self.con, second, {'quantity':1,'target_order_line_id':target})
        self.assertEqual(lc.purchased_qty(self.con, target), 4)
        self.assertEqual(sum(l['cost_cents'] for l in dm.get_state(self.con)['purchase_lines']), 6000)
        with self.assertRaisesRegex(ValueError, '转出'):
            self.as_admin(lc.void_case, 'purchase_cases', second, {'reason':'改为退回'})
        mid = dm.get_state(self.con)['stock_moves'][0]['id']
        self.as_admin(lc.dispatch, f'/api/stock-moves/{mid}/void', {'reason':'录错目标'})
        self.assertEqual(lc.purchased_qty(self.con, target), 3)
        self.as_admin(lc.void_case, 'purchase_cases', second, {'reason':'重新办理'})
        state = dm.get_state(self.con)
        self.assertEqual(next(c for c in state['order_cases'] if c['id'] == cid)['status'], 'processing')
        self.assertTrue(any(c['order_case_id'] == cid and c['status'] == 'pending' for c in state['purchase_cases']))
        with self.assertRaisesRegex(ValueError, '未完成'):
            lc.complete_order_case(self.con, cid)

    def test_archive_retains_pending_work_and_statistics(self):
        self.purchase()
        self.case('cancel', 2)
        lc.manage_record(self.con, 'orders', self.oid, 'archive')
        state = dm.get_state(self.con)
        self.assertEqual(state['orders'][0]['open_cases'], 1)
        self.assertEqual(state['purchases'][0]['open_cases'], 1)
        self.assertEqual(state['order_lines'][0]['purchased'], 10)
        with self.assertRaisesRegex(ValueError, '归档'):
            self.delivery(1)

    def test_soft_delete_restore_and_overallocation_guard(self):
        pid, plid = self.purchase(4)
        lc.manage_record(self.con, 'purchases', pid, 'delete')
        self.assertEqual(lc.purchased_qty(self.con, self.lid), 0)
        self.assertEqual(self.con.execute('SELECT COUNT(*) FROM purchase_lines').fetchone()[0], 1)
        self.purchase(10, 'P2')
        with self.assertRaisesRegex(ValueError, '超过客户需求'):
            self.as_admin(lc.manage_record, 'purchases', pid, 'restore')
        lc.manage_record(self.con, 'purchases', 2, 'delete')
        self.as_admin(lc.manage_record, 'purchases', pid, 'restore')
        self.assertEqual(lc.purchased_qty(self.con, self.lid), 4)
        with self.assertRaisesRegex(ValueError, '管理员'):
            lc.manage_record(self.con, 'purchases', 2, 'restore')

    def test_correction_and_post_business_deletion_guards(self):
        pid, plid = self.purchase(4)
        with self.assertRaisesRegex(ValueError, '管理员'):
            lc.dispatch(self.con, f'/api/purchase-lines/{plid}/correct', {'quantity':3,'cost':18,'reason':'录错'})
        self.as_admin(lc.dispatch, f'/api/purchase-lines/{plid}/correct', {'quantity':3,'cost':18,'reason':'录错'})
        self.assertEqual(lc.purchase_balance(self.con, plid), (3,1800))
        pkg = dm.create_package(self.con, {'carrier':'测试','tracking':'X1','lines':[{'purchase_line_id':plid,'quantity':1}]})['id']
        with self.assertRaisesRegex(ValueError, '包裹'):
            lc.manage_record(self.con, 'purchases', pid, 'delete')
        with self.assertRaisesRegex(ValueError, '包裹'):
            self.as_admin(lc.dispatch, f'/api/purchase-lines/{plid}/correct', {'quantity':2,'cost':12,'reason':'录错'})
        dm.update_tracking(self.con, pkg, {'status':'运输中'})
        dm.update_tracking(self.con, pkg, {'status':'退回'})
        with self.assertRaisesRegex(ValueError, '尚未实际发出'):
            self.case('cancel', 10)

    def test_atomic_mixed_delete_rolls_back(self):
        other, lid = self.order('B', 1)
        self.purchase(1, lid=lid)
        self.con.commit()
        with self.assertRaises(ValueError), self.con:
            dm.delete_order_items(self.con, [{'type':'order','id':self.oid},{'type':'order','id':other}])
        self.assertEqual(len(dm.get_state(self.con)['orders']), 2)

    def test_invoice_history_requires_adjustment_note(self):
        pid, plid = self.purchase(2)
        self.con.execute('INSERT INTO attachments VALUES(?,?,?,?)', ('a'*64, 'invoice.pdf','application/pdf',dm.now()))
        dm.create_invoice(self.con, {'number':'INV1','seller':'测试店铺','issued_date':dm.today(),'amount':12,'attachment_id':'a'*64,
            'allocations':[{'purchase_id':pid,'amount':12}]})
        pcid = lc.make_purchase_case(self.con, plid, 1, '退供应商')
        lc.update_purchase_case(self.con, pcid, {'kind':'cancel','amount':6,'note':'供应商已退回款项'})
        self.as_admin(lc.confirm_case_finance, 'purchase_cases', pcid)
        with self.assertRaisesRegex(ValueError, '发票'):
            lc.complete_purchase_case(self.con, pcid)
        lc.update_purchase_case(self.con, pcid, {'kind':'cancel','amount':6,'note':'退货退款完成','invoice_note':'已核对调整凭证'})
        lc.complete_purchase_case(self.con, pcid)
        self.assertEqual(len(dm.get_state(self.con)['invoices']), 1)
        self.assertEqual(len(dm.get_state(self.con)['invoice_allocations']), 1)


if __name__ == '__main__':
    unittest.main()
