import tempfile
import unittest
from server.db import connect
from server import domain as dm, sales_invoices as si, lifecycle as lc


class SalesInvoiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.con = connect(self.temp.name)
        self.token = dm.actor_id.set(1)
        self.a = self.order('客户甲', 'PO-A', 100)
        self.b = self.order('客户甲', 'PO-B', 200)
        self.c = self.order('客户乙', 'PO-C', 100)

    def tearDown(self):
        dm.actor_id.reset(self.token)
        self.con.close()
        self.temp.cleanup()

    def order(self, customer, po, amount):
        oid = dm.create_order(self.con, {'customer':customer, 'po':po, 'address':'测试路', 'lines':[{'name':'测试料品','quantity':1,'price':amount}]})['id']
        dm.confirm_quote(self.con, oid)
        return oid

    def invoice(self, number, parts, **extra):
        return si.create(self.con, {'customer':'客户甲','number':number,'kind':'普通发票','issued_date':'2026-01-01','due_date':'2026-01-02','amount':sum(parts.values()),'orders':[{'order_id':o,'amount':v} for o,v in parts.items()], **extra})['id']

    def receipt(self, oid, amount, iid=None):
        return si.receipt(self.con, {'order_id':oid,'amount':amount,'received_date':dm.today(),'method':'银行转账','invoices':[{'invoice_id':iid,'amount':amount}] if iid else []})['id']

    def state(self):
        return dm.get_state(self.con)

    def test_split_invoices_combined_orders_and_partial_payment(self):
        iid = self.invoice('INV-1', {self.a:60,self.b:100})
        self.invoice('INV-2', {self.a:40})
        self.receipt(self.a, 20, iid)
        self.receipt(self.a, 40, iid)
        self.receipt(self.b, 100, iid)
        data = self.state()
        invoice = next(i for i in data['sales_invoices'] if i['id']==iid)
        self.assertEqual((invoice['paid_cents'], invoice['remaining_cents'], invoice['payment_status']), (16000,0,'已结清'))
        orders = {o['id']:o for o in data['orders']}
        self.assertEqual(orders[self.a]['invoice_status'], '已开齐')
        self.assertEqual(orders[self.b]['invoice_status'], '部分开票')
        self.assertEqual(orders[self.c]['invoice_status'], '未开票')

    def test_prepayment_reallocation_void_and_red_preserve_receipt(self):
        rid = self.receipt(self.a, 100)
        iid = self.invoice('INV-1', {self.a:100})
        si.allocate(self.con, rid, {'invoices':[{'invoice_id':iid,'amount':60}]})
        i = self.state()['sales_invoices'][0]
        self.assertEqual((i['payment_status'],i['overdue']), ('部分回款',True))
        si.dispatch(self.con, f'/api/sales-invoices/{iid}/void', {'reason':'录入错误'})
        data = self.state()
        self.assertEqual(data['order_receipts'][0]['allocated_cents'], 0)
        self.assertEqual(data['order_receipts'][0]['amount_cents'], 10000)
        new = self.invoice('INV-2', {self.a:100})
        si.allocate(self.con, rid, {'invoices':[{'invoice_id':new,'amount':100}]})
        si.dispatch(self.con, f'/api/sales-invoices/{new}/red', {'reason':'退货','red_number':'RED-1'})
        self.assertEqual(self.state()['sales_invoices'][0]['status'], 'red')
        self.assertEqual(self.state()['order_receipts'][0]['allocated_cents'], 0)

    def test_receipt_before_invoice_is_auto_allocated(self):
        rid = self.receipt(self.a, 60)                     # 未开票先登记预付款
        self.assertEqual(self.state()['order_receipts'][0]['allocated_cents'], 0)
        iid = self.invoice('INV-1', {self.a:100})          # 之后登记发票，应自动关联
        data = self.state()
        self.assertEqual([(a['invoice_id'], a['amount_cents']) for a in data['sales_receipt_allocations'] if a['receipt_id'] == rid], [(iid, 6000)])
        invoice = next(i for i in data['sales_invoices'] if i['id'] == iid)
        self.assertEqual((invoice['paid_cents'], invoice['remaining_cents'], invoice['payment_status']), (6000, 4000, '部分回款'))
        # 预付款大于该订单开票金额时，只关联不超过开票金额的部分
        rid2 = self.receipt(self.b, 300)
        iid2 = self.invoice('INV-2', {self.b:200})
        data = self.state()
        self.assertEqual(sum(a['amount_cents'] for a in data['sales_receipt_allocations'] if a['receipt_id'] == rid2), 20000)
        invoice2 = next(i for i in data['sales_invoices'] if i['id'] == iid2)
        self.assertEqual((invoice2['paid_cents'], invoice2['remaining_cents']), (20000, 0))

    def test_invalid_customer_duplicate_number_and_overinvoice(self):
        for parts, extra in [({self.c:1},{}),({self.a:101},{}),({self.a:10},{'amount':11}),({self.a:10},{'due_date':'2025-01-01'})]:
            with self.assertRaises(ValueError):
                self.invoice('BAD',parts,**extra)
        self.invoice('INV-1',{self.a:100})
        with self.assertRaisesRegex(ValueError,'号码已登记'):
            self.invoice('INV-1',{self.b:10})
        with self.assertRaisesRegex(ValueError,'待开票'):
            self.invoice('INV-2',{self.a:1})

    def test_allocations_cannot_exceed_invoice_order_or_receipt(self):
        iid = self.invoice('INV-1',{self.a:30,self.b:70})
        rid = self.receipt(self.a,100)
        with self.assertRaisesRegex(ValueError,'未回款'):
            si.allocate(self.con,rid,{'invoices':[{'invoice_id':iid,'amount':31}]})
        si.allocate(self.con,rid,{'invoices':[{'invoice_id':iid,'amount':30}]})
        rid2 = self.receipt(self.a,5)
        with self.assertRaises(ValueError):
            si.allocate(self.con,rid2,{'invoices':[{'invoice_id':iid,'amount':1}]})
        other = self.invoice('INV-2',{self.a:20})
        # 开票后新登记的小额回款：分配额不能超过该笔到账金额（未开票期间的回款会在开票时自动关联）
        late = self.receipt(self.b,5)
        with self.assertRaisesRegex(ValueError,'到账金额'):
            si.allocate(self.con,late,{'invoices':[{'invoice_id':iid,'amount':6}]})
        wrong = self.receipt(self.c,10)
        with self.assertRaises(ValueError):
            si.allocate(self.con,wrong,{'invoices':[{'invoice_id':iid,'amount':1}]})

    def test_void_receipt_reopens_invoice_and_order_delete_is_blocked(self):
        iid=self.invoice('INV-1',{self.a:100})
        rid=self.receipt(self.a,100,iid)
        lc.dispatch(self.con,f'/api/order-receipts/{rid}/void',{'reason':'重复登记'})
        self.assertEqual(self.state()['sales_invoices'][0]['remaining_cents'],10000)
        with self.assertRaises(ValueError):
            lc.manage_record(self.con,'orders',self.a,'delete')

    def test_receipt_directly_linked_to_multi_po_invoice(self):
        iid = self.invoice('DIRECT', {self.a:60, self.b:100})
        payload = {'invoice_id':iid,'amount':80,'received_date':dm.today(),'method':'银行转账'}
        result = si.receipt(self.con, payload)
        self.assertEqual(len(result['ids']), 2)
        invoice = next(i for i in self.state()['sales_invoices'] if i['id']==iid)
        self.assertEqual((invoice['paid_cents'], invoice['remaining_cents']), (8000,8000))
        with self.assertRaisesRegex(ValueError, '未回款'):
            si.receipt(self.con, {**payload,'amount':81})
        si.receipt(self.con, payload)
        self.assertEqual(self.state()['sales_invoices'][0]['payment_status'], '已结清')
        with self.assertRaises(ValueError):
            si.receipt(self.con, payload)

    def test_migration_is_idempotent(self):
        si.migrate(self.con)
        si.migrate(self.con)
        self.invoice('INV-1',{self.a:1})
        self.assertEqual(len(self.state()['sales_invoices']),1)

    def test_invoice_history_blocks_deletion_even_after_void(self):
        iid = self.invoice('INV-1', {self.a:10})
        si.dispatch(self.con, f'/api/sales-invoices/{iid}/void', {'reason':'错误号码'})
        with self.assertRaisesRegex(ValueError, '销售发票历史'):
            lc.manage_record(self.con, 'orders', self.a, 'delete')

    def test_failed_receipt_allocation_rolls_back_new_receipt(self):
        iid = self.invoice('INV-1', {self.a:10})
        self.con.commit()
        with self.assertRaises(ValueError):
            with self.con:
                self.receipt(self.a, 20, iid)
        self.assertEqual(self.con.execute('SELECT COUNT(*) FROM order_receipts').fetchone()[0], 0)

    def test_confirmed_order_reduction_updates_invoice_capacity(self):
        iid = self.invoice('INV-1', {self.a:100})
        lid = self.con.execute('SELECT id FROM order_lines WHERE order_id=?', (self.a,)).fetchone()[0]
        case = lc.create_order_case(self.con, self.a, {'order_line_id':lid,'kind':'cancel','quantity':.2,'reason':'部分取消','financial_type':'reduce_receivable','amount':20})['id']
        # 冲减应收是登记的必然结果，创建时即自动确认，无需管理员再确认。
        self.assertTrue(self.con.execute('SELECT finance_confirmed_at FROM order_cases WHERE id=?', (case,)).fetchone()[0])
        order = next(o for o in self.state()['orders'] if o['id']==self.a)
        self.assertEqual(order['receivable_cents'],8000)
        self.assertEqual(order['invoice_excess_cents'],2000)

    def test_refund_and_receipt_void_cannot_overallocate_cash(self):
        iid = self.invoice('INV-1', {self.a:50})
        self.receipt(self.a,50,iid)
        spare = self.receipt(self.a,50)
        lid = self.con.execute('SELECT id FROM order_lines WHERE order_id=?', (self.a,)).fetchone()[0]
        case = lc.create_order_case(self.con,self.a,{'order_line_id':lid,'kind':'cancel','quantity':.5,'reason':'取消退款','financial_type':'refund_received','amount':50})['id']
        self.assertTrue(self.con.execute('SELECT finance_confirmed_at FROM order_cases WHERE id=?', (case,)).fetchone()[0])
        with self.assertRaisesRegex(ValueError,'已分配'):
            lc.dispatch(self.con,f'/api/order-receipts/{spare}/void',{'reason':'错误撤销'})


if __name__ == '__main__':
    unittest.main()
