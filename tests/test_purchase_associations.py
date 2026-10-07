import json
import tempfile
import unittest
from server.db import connect
from server import domain as dm


class PurchaseAssociationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.con = connect(self.temp.name)
        oid = dm.create_order(self.con, dict(customer='客户', po='PO-EDIT', address='地址', lines=[dict(name='旧料品', quantity=2), dict(name='新料品', quantity=3)]))['id']
        dm.confirm_quote(self.con, oid)
        self.old, self.new = [row[0] for row in self.con.execute('SELECT id FROM order_lines ORDER BY id')]
        self.pid = dm.create_purchase(self.con, dict(platform='淘宝', platform_order='12345678901', shop='店铺', amount='20', lines=[dict(order_line_id=self.old, quantity=2, cost='20')], taobao_source=dict(transaction_status='卖家已发货', platform_order='12345678901', products=[dict(name='商品', order_line_ids=[self.old])], packages=[])))['id']

    def tearDown(self):
        self.con.close()
        self.temp.cleanup()

    def body(self, lid, quantity):
        return dict(lines=[dict(order_line_id=lid, quantity=quantity, cost='20')], product_order_line_ids=[[lid]])

    def test_replace_releases_old_and_preserves_source(self):
        dm.update_purchase_associations(self.con, self.pid, self.body(self.new, 3))
        self.assertEqual(dm.lc.purchased_qty(self.con, self.old), 0)
        self.assertEqual(dm.lc.purchased_qty(self.con, self.new), 3)
        payload = json.loads(self.con.execute('SELECT payload FROM purchase_sources').fetchone()[0])
        self.assertEqual(payload['products'][0]['order_line_ids'], [self.new])
        self.assertEqual(payload['products'][0]['name'], '商品')
        self.assertEqual(self.con.execute('SELECT amount_cents FROM purchases').fetchone()[0], 2000)

    def test_over_quantity_and_invalid_mapping_leave_old(self):
        with self.assertRaises(ValueError):
            dm.update_purchase_associations(self.con, self.pid, self.body(self.new, 4))
        body = self.body(self.new, 3)
        body['product_order_line_ids'] = [[self.old]]
        with self.assertRaises(ValueError):
            dm.update_purchase_associations(self.con, self.pid, body)
        self.assertEqual(dm.lc.purchased_qty(self.con, self.old), 2)

    def test_unchanged_line_keeps_id_and_existing_occupancy_is_allowed(self):
        before = self.con.execute('SELECT id FROM purchase_lines').fetchone()[0]
        dm.update_purchase_associations(self.con, self.pid, self.body(self.old, 2))
        self.assertEqual(self.con.execute('SELECT id FROM purchase_lines').fetchone()[0], before)

    def test_return_history_prevents_rewriting(self):
        lid = self.con.execute('SELECT id FROM purchase_lines').fetchone()[0]
        self.con.execute("INSERT INTO purchase_cases(purchase_line_id,quantity,reason,cost_cents,created_at) VALUES(?,1,'退货',1000,?)", (lid, dm.now()))
        with self.assertRaisesRegex(ValueError, '已有退货'):
            dm.update_purchase_associations(self.con, self.pid, self.body(self.new, 3))
        self.assertEqual(dm.lc.purchased_qty(self.con, self.old), 2)

    def test_delivery_reads_synced_tracking_without_package_allocation(self):
        dm.save_taobao_source(self.con, self.pid, dict(platform_order='12345678901', packages=[dict(carrier='测试快递', tracking='TRACK123456', status='已签收')]))
        dm.create_deliveries(self.con, dict(company='公司', lines=[dict(order_line_id=self.old, quantity=1)]))
        snapshot = json.loads(self.con.execute('SELECT snapshot FROM delivery_lines').fetchone()[0])
        self.assertEqual(snapshot['tracking'], 'TRACK123456')
        self.assertEqual(snapshot['carrier'], '测试快递')

    def test_order_level_batch_needs_no_product_mapping(self):
        dm.update_purchase_associations(self.con, self.pid, dict(association_mode='order', lines=[dict(order_line_id=self.old, quantity=2, cost='8'), dict(order_line_id=self.new, quantity=3, cost='12')]))
        self.assertEqual(dm.lc.purchased_qty(self.con, self.old), 2)
        self.assertEqual(dm.lc.purchased_qty(self.con, self.new), 3)
        payload = json.loads(self.con.execute('SELECT payload FROM purchase_sources').fetchone()[0])
        self.assertNotIn('order_line_ids', payload['products'][0])
        self.assertEqual(sum(row[0] for row in self.con.execute('SELECT cost_cents FROM purchase_lines')), 2000)
