import tempfile
import unittest

from server.db import connect
from server import domain as dm, inventory as iv


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.con = connect(self.temp.name)
        self.actor = dm.actor_id.set(1)
        self.oid, self.lid = self.order('PO-100', '化学螺栓', 'M20×260', 10)
        self.warehouse = dm.row(self.con, 'SELECT id FROM warehouses ORDER BY id LIMIT 1')['id']

    def tearDown(self):
        dm.actor_id.reset(self.actor)
        self.con.close()
        self.temp.cleanup()

    def order(self, po, name, spec, quantity, brand='东明', customer_code='', price='5'):
        oid = dm.create_order(self.con, {'customer':'测试客户', 'po':po, 'address':'广州测试路1号',
            'lines':[{'name':name, 'spec':spec, 'brand':brand, 'customer_code':customer_code,
                      'quantity':quantity, 'unit':'个', 'price':price}]})['id']
        lid = dm.row(self.con, 'SELECT id FROM order_lines WHERE order_id=?', (oid,))['id']
        dm.confirm_quote(self.con, oid)
        return oid, lid

    def purchase(self, quantity, mode='direct', cost='50', code='JD-1', order_line_id=None, item_id=None):
        line = {'quantity':quantity, 'cost':cost, 'receive_mode':mode}
        if order_line_id:
            line['order_line_id'] = order_line_id
        else:
            line['item_id'] = item_id
        return dm.create_purchase(self.con, {'platform':'京东', 'shop':'测试店铺', 'platform_order':code,
                                             'amount':cost, 'lines':[line]})['id']

    def line_state(self, lid=None):
        return next(x for x in dm.get_state(self.con)['order_lines'] if x['id'] == (lid or self.lid))

    def item_state(self, item_id=None):
        state = dm.get_state(self.con)
        item_id = item_id or next(x for x in state['order_lines'] if x['id'] == self.lid)['item_id']
        return next(x for x in state['items'] if x['id'] == item_id)

    def test_orders_with_same_model_share_one_item_archive(self):
        second, _ = self.order('PO-101', '化学螺栓', 'M20×260', 4)
        third, _ = self.order('PO-102', '化学螺栓', 'M20×300', 4)
        state = dm.get_state(self.con)
        item_ids = {x['id']: x['item_id'] for x in state['order_lines']}
        self.assertEqual(item_ids[self.lid], item_ids[next(x['id'] for x in state['order_lines'] if x['order_id'] == second)])
        self.assertNotEqual(item_ids[self.lid], item_ids[next(x['id'] for x in state['order_lines'] if x['order_id'] == third)])
        self.assertEqual(len(state['items']), 2)
        self.assertEqual(state['items'][0]['code'], 'LP000001')
        self.assertEqual(state['items'][0]['spec'], 'M20×260')

    def test_customer_code_matches_item_and_ambiguous_input_stays_unmatched(self):
        oid, _ = self.order('PO-103', '化学螺栓', 'M20×260', 1, customer_code='ABC-100')
        dm.create_order(self.con, {'customer':'测试客户', 'po':'PO-104', 'address':'广州测试路1号',
            'lines':[{'name':'客户自有叫法', 'spec':'', 'customer_code':'ABC100', 'quantity':1, 'unit':'个', 'price':'5'}]})
        state = dm.get_state(self.con)
        original = next(x for x in state['items'] if x['spec'] == 'M20×260')
        unmatched = [x for x in state['order_lines'] if x['customer_code'] == 'ABC100'][0]
        self.assertEqual(unmatched['item_id'], original['id'])
        self.assertIn('化学螺栓', [x['name'] for x in state['items']])

    def test_receipt_into_stock_reserves_for_linked_order(self):
        self.purchase(10, mode='stock', cost='500', order_line_id=self.lid)
        plid = dm.row(self.con, 'SELECT id FROM purchase_lines WHERE order_line_id=?', (self.lid,))['id']
        iv.post_receipt(self.con, {'warehouse_id':self.warehouse, 'lines':[{'purchase_line_id':plid}]})
        line = self.line_state()
        self.assertEqual(line['purchased'], 0)
        self.assertEqual(line['stock_reserved'], 10)
        self.assertEqual(line['secured_quantity'], 10)
        self.assertEqual(line['gap_quantity'], 0)
        item = self.item_state()
        self.assertEqual((item['on_hand'], item['reserved'], item['available']), (10, 10, 0))
        self.assertEqual(item['avg_cost_cents'], 5000)

    def test_stock_columns_and_public_stock_pool(self):
        self.purchase(4, mode='direct', cost='200', code='JD-D', order_line_id=self.lid)
        self.purchase(6, mode='stock', cost='300', code='JD-S', order_line_id=self.lid)
        line = self.line_state()
        self.assertEqual((line['stock_incoming_direct'], line['stock_incoming_stock']), (4, 6))
        self.assertEqual(line['purchased'], 10)
        self.assertEqual(line['gap_quantity'], 0)
        item_id = line['item_id']
        self.purchase(5, mode='stock', cost='250', code='JD-P', item_id=item_id)
        self.assertEqual(self.line_state()['stock_pool'], 5)
        self.assertEqual(self.line_state()['stock_expected'], 5)
        item = self.item_state()
        self.assertEqual((item['on_hand'], item['available'], item['incoming_unallocated']), (0, 0, 5))

    def test_outbound_uses_item_of_order_line_and_books_cost(self):
        self.purchase(10, mode='stock', cost='500', order_line_id=self.lid)
        plid = dm.row(self.con, 'SELECT id FROM purchase_lines WHERE order_line_id=?', (self.lid,))['id']
        iv.post_receipt(self.con, {'warehouse_id':self.warehouse, 'lines':[{'purchase_line_id':plid}]})
        result = iv.post_outbound(self.con, {'warehouse_id':self.warehouse, 'order_id':self.oid, 'company':'测试公司',
                                             'lines':[{'order_line_id':self.lid, 'quantity':6}]})
        self.assertTrue(result['number'].startswith('CKD-'))
        state = dm.get_state(self.con)
        line = self.line_state()
        self.assertEqual(line['stock_cost_cents'], 30000)
        self.assertEqual(line['cost_cents'], 30000)
        self.assertEqual(line['stock_on_hand'], 4)
        self.assertEqual(line['stock_reserved'], 4)
        delivery = next(x for x in state['deliveries'] if x['id'] == result['delivery_id'])
        self.assertEqual(delivery['number'].startswith('SHD-PO-100'), True)
        self.assertEqual(len([x for x in state['delivery_lines'] if x['delivery_id'] == delivery['id']]), 1)
        item = self.item_state()
        self.assertEqual((item['on_hand'], item['reserved']), (4, 4))

    def test_void_delivery_then_outbound_restores_stock(self):
        self.purchase(10, mode='stock', cost='500', order_line_id=self.lid)
        plid = dm.row(self.con, 'SELECT id FROM purchase_lines WHERE order_line_id=?', (self.lid,))['id']
        iv.post_receipt(self.con, {'warehouse_id':self.warehouse, 'lines':[{'purchase_line_id':plid}]})
        result = iv.post_outbound(self.con, {'warehouse_id':self.warehouse, 'order_id':self.oid, 'company':'测试公司',
                                             'lines':[{'order_line_id':self.lid, 'quantity':6}]})
        from server import lifecycle as lc
        lc.dispatch(self.con, f"/api/deliveries/{result['delivery_id']}/unship", {'reason':'录错出库'})
        with self.assertRaisesRegex(ValueError, '送货单'):
            iv.void_outbound(self.con, result['id'], {'reason':'录错'})
        dm.void_delivery(self.con, result['delivery_id'])
        iv.void_outbound(self.con, result['id'], {'reason':'录错'})
        item = self.item_state()
        self.assertEqual((item['on_hand'], item['reserved']), (10, 10))
        self.assertEqual(self.line_state()['stock_cost_cents'], 0)

    def test_reservation_prevents_double_allocation(self):
        self.purchase(10, mode='stock', cost='500', order_line_id=self.lid)
        plid = dm.row(self.con, 'SELECT id FROM purchase_lines WHERE order_line_id=?', (self.lid,))['id']
        iv.post_receipt(self.con, {'warehouse_id':self.warehouse, 'lines':[{'purchase_line_id':plid}]})
        iv.release_order_reservations(self.con, self.lid, '测试：改为手工安排')
        other_oid, other_lid = self.order('PO-105', '化学螺栓', 'M20×260', 8)
        iv.reservation(self.con, {'order_line_id':other_lid, 'quantity':6})
        with self.assertRaisesRegex(ValueError, '可用库存不足'):
            iv.reservation(self.con, {'order_line_id':other_lid, 'quantity':5})
        iv.release_reservation(self.con, dm.row(self.con, "SELECT id FROM stock_reservations WHERE order_line_id=? AND status='active'", (other_lid,))['id'], {'reason':'客户改需求'})
        iv.reservation(self.con, {'order_line_id':other_lid, 'quantity':10})
        self.assertEqual(self.item_state()['available'], 0)

    def test_direct_purchase_cannot_be_received_and_public_stock_must_be_stock_mode(self):
        self.purchase(10, mode='direct', order_line_id=self.lid)
        plid = dm.row(self.con, 'SELECT id FROM purchase_lines WHERE order_line_id=?', (self.lid,))['id']
        with self.assertRaisesRegex(ValueError, '直发客户'):
            iv.post_receipt(self.con, {'warehouse_id':self.warehouse, 'lines':[{'purchase_line_id':plid}]})
        item_id = self.line_state()['item_id']
        with self.assertRaisesRegex(ValueError, '入库'):
            self.purchase(2, mode='direct', code='JD-X', item_id=item_id)
        order_id = self.purchase(2, mode='stock', code='JD-Y', item_id=item_id)
        plid = dm.row(self.con, 'SELECT id FROM purchase_lines WHERE purchase_id=?', (order_id,))['id']
        iv.post_receipt(self.con, {'warehouse_id':self.warehouse, 'lines':[{'purchase_line_id':plid}]})
        self.assertEqual(self.item_state()['on_hand'], 2)

    def test_cancel_order_releases_reservation_and_stock_adjust(self):
        self.purchase(10, mode='stock', cost='500', order_line_id=self.lid)
        plid = dm.row(self.con, 'SELECT id FROM purchase_lines WHERE order_line_id=?', (self.lid,))['id']
        iv.post_receipt(self.con, {'warehouse_id':self.warehouse, 'lines':[{'purchase_line_id':plid}]})
        dm.cancel_order(self.con, self.oid, {'reason':'客户撤单'})
        self.assertEqual(self.item_state()['available'], 10)
        item_id = self.item_state()['id']
        iv.adjust_stock(self.con, {'item_id':item_id, 'warehouse_id':self.warehouse, 'direction':'gain',
                                   'quantity':1, 'amount':'49', 'reason':'盘点多出'})
        self.assertEqual(self.item_state()['on_hand'], 11)
        with self.assertRaisesRegex(ValueError, '盘亏数量超过现存量'):
            iv.adjust_stock(self.con, {'item_id':item_id, 'warehouse_id':self.warehouse, 'direction':'loss',
                                       'quantity':12, 'reason':'录错'})

    def test_receive_mode_switch_and_item_binding(self):
        self.purchase(5, mode='direct', code='JD-M', order_line_id=self.lid)
        plid = dm.row(self.con, 'SELECT id FROM purchase_lines WHERE order_line_id=?', (self.lid,))['id']
        iv.set_purchase_receive_mode(self.con, plid, {'receive_mode':'stock', 'warehouse_id':self.warehouse})
        self.assertEqual(dm.row(self.con, 'SELECT receive_mode FROM purchase_lines WHERE id=?', (plid,))['receive_mode'], 'stock')
        iv.post_receipt(self.con, {'warehouse_id':self.warehouse, 'lines':[{'purchase_line_id':plid, 'quantity':5}]})
        with self.assertRaisesRegex(ValueError, '已登记入库'):
            iv.set_purchase_receive_mode(self.con, plid, {'receive_mode':'direct'})

    def test_purchase_associations_support_item_only_lines(self):
        item_id = self.line_state()['item_id']
        pid = self.purchase(4, mode='direct', cost='200', code='JD-MIX', order_line_id=self.lid)
        dm.update_purchase_associations(self.con, pid, {'association_mode': 'order', 'lines': [
            {'order_line_id': self.lid, 'quantity': 4, 'cost': 200, 'receive_mode': 'direct', 'purchase_quantity': 4, 'purchase_unit': '个'},
            {'item_id': item_id, 'quantity': 3, 'cost': 150, 'receive_mode': 'stock', 'purchase_quantity': 3, 'purchase_unit': '个'}]})
        lines = [x for x in dm.get_state(self.con)['purchase_lines'] if x['purchase_id'] == pid]
        self.assertEqual(len(lines), 2)
        stock_line = next(x for x in lines if not x['order_line_id'])
        self.assertEqual((stock_line['item_id'], stock_line['receive_mode'], stock_line['item_name']), (item_id, 'stock', '化学螺栓'))
        with self.assertRaisesRegex(ValueError, '入库'):
            dm.update_purchase_associations(self.con, pid, {'association_mode': 'order', 'lines': [
                {'item_id': item_id, 'quantity': 3, 'cost': 150, 'receive_mode': 'direct'}]})
        dm.update_purchase_associations(self.con, pid, {'association_mode': 'order', 'lines': [
            {'order_line_id': self.lid, 'quantity': 4, 'cost': 200, 'receive_mode': 'direct'}]})
        self.assertEqual([x for x in dm.get_state(self.con)['purchase_lines'] if x['purchase_id'] == pid and not x['order_line_id']], [])
        iv.post_receipt(self.con, {'warehouse_id': self.warehouse, 'lines': [{'item_id': item_id, 'quantity': 2, 'cost': '100'}]})
        self.assertEqual(self.item_state()['on_hand'], 2)

    def test_warehouse_delete_rules(self):
        main = dm.row(self.con, 'SELECT * FROM warehouses ORDER BY id LIMIT 1')
        with self.assertRaisesRegex(ValueError, '默认仓库不能删除'):
            iv.dispatch(self.con, f"/api/warehouses/{main['id']}/delete", {})
        spare = iv.dispatch(self.con, '/api/warehouses', {'name': '临时仓库', 'location': 'C1'})['id']
        self.assertEqual(iv.dispatch(self.con, f'/api/warehouses/{spare}/delete', {})['id'], spare)
        self.assertIsNone(self.con.execute('SELECT id FROM warehouses WHERE id=?', (spare,)).fetchone())
        iv.dispatch(self.con, '/api/warehouses', {'name': '成都仓库', 'is_default': True})
        purchase_id = self.purchase(3, mode='stock', cost='150', code='JD-DEL-WH', order_line_id=self.lid)
        purchase_line = dm.row(self.con, 'SELECT id FROM purchase_lines WHERE purchase_id=?', (purchase_id,))
        receipt = iv.post_receipt(self.con, {'warehouse_id': main['id'], 'lines': [{'purchase_line_id': purchase_line['id'], 'quantity': 3}]})
        with self.assertRaisesRegex(ValueError, '仍有库存'):
            iv.dispatch(self.con, f"/api/warehouses/{main['id']}/delete", {})
        iv.dispatch(self.con, f"/api/receipts/{receipt['id']}/void", {'reason': '录错仓库'})
        with self.assertRaisesRegex(ValueError, '不能删除'):
            iv.dispatch(self.con, f"/api/warehouses/{main['id']}/delete", {})
        self.assertEqual(len(dm.get_state(self.con)['warehouses']), 2)

    def test_warehouse_rename_default_and_deactivate(self):
        main = dm.row(self.con, 'SELECT * FROM warehouses ORDER BY id LIMIT 1')
        self.assertEqual(main['is_default'], 1)
        iv.dispatch(self.con, f"/api/warehouses/{main['id']}", {'name': '主仓库', 'location': 'A1', 'note': '总仓'})
        self.assertEqual(dm.row(self.con, 'SELECT name FROM warehouses WHERE id=?', (main['id'],))['name'], '主仓库')
        second = iv.dispatch(self.con, '/api/warehouses', {'name': '成都仓库', 'location': 'B1', 'is_default': True})['id']
        state = dm.get_state(self.con)
        self.assertEqual(state['warehouses'][0]['name'], '成都仓库', '默认仓库应排在列表最前')
        self.assertEqual(iv.warehouse_id_of(self.con, None), second)
        with self.assertRaisesRegex(ValueError, '默认仓库不能停用'):
            iv.dispatch(self.con, f'/api/warehouses/{second}', {'name': '成都仓库', 'active': False})
        iv.post_receipt(self.con, {'warehouse_id': main['id'], 'lines': [{'item_id': self.line_state()['item_id'], 'quantity': 2, 'cost': '10'}]})
        with self.assertRaisesRegex(ValueError, '仍有库存'):
            iv.dispatch(self.con, f"/api/warehouses/{main['id']}", {'name': '主仓库', 'active': False})
        iv.dispatch(self.con, f"/api/warehouses/{main['id']}", {'name': '主仓库', 'is_default': True})
        iv.dispatch(self.con, f'/api/warehouses/{second}', {'name': '成都仓库', 'active': False})
        self.assertEqual(iv.warehouse_id_of(self.con, None), main['id'])
        self.assertEqual([x['name'] for x in dm.get_state(self.con)['warehouses'] if x['active'] == 1], ['主仓库'])

    def test_backfill_links_historical_lines(self):
        self.purchase(4, mode='stock', cost='200', code='JD-BACK', order_line_id=self.lid)
        self.con.execute('UPDATE order_lines SET item_id=NULL')
        self.con.execute('UPDATE purchase_lines SET item_id=NULL')
        result = iv.dispatch(self.con, '/api/items/backfill', {})
        self.assertEqual(result['linked'], 2)
        state = dm.get_state(self.con)
        self.assertTrue(all(x['item_id'] for x in state['order_lines']))
        self.assertTrue(all(x['item_id'] for x in state['purchase_lines']))
        self.assertEqual(len(state['items']), 1, '同名同规格的历史明细应归到同一料品')
        self.assertEqual(iv.dispatch(self.con, '/api/items/backfill', {})['linked'], 0)

    def test_item_aliases_can_be_managed(self):
        item_id = self.line_state()['item_id']
        alias_id = iv.dispatch(self.con, f'/api/items/{item_id}/aliases', {'source': '客户型号', 'alias': 'ABC-100'})['id']
        self.assertEqual([x['alias'] for x in dm.get_state(self.con)['item_aliases']], ['ABC-100'])
        _, other = self.order('PO-ALIAS', '客户叫法', '', 1, customer_code='ABC100')
        self.assertEqual(self.line_state(other)['item_id'], item_id)
        with self.assertRaisesRegex(ValueError, '已存在'):
            iv.dispatch(self.con, f'/api/items/{item_id}/aliases', {'source': '客户型号', 'alias': 'abc100'})
        iv.dispatch(self.con, f'/api/items/{item_id}/aliases/{alias_id}/delete', {})
        self.assertEqual(dm.get_state(self.con)['item_aliases'], [])

    def test_delete_blocked_by_reservation_and_receipt_history(self):
        item_id = self.line_state()['item_id']
        purchase_id = self.purchase(5, mode='stock', cost='250', code='JD-DEL', item_id=item_id)
        plid = dm.row(self.con, 'SELECT id FROM purchase_lines WHERE purchase_id=?', (purchase_id,))['id']
        iv.post_receipt(self.con, {'warehouse_id':self.warehouse, 'lines':[{'purchase_line_id':plid}]})
        iv.reservation(self.con, {'order_line_id':self.lid, 'quantity':5})
        with self.assertRaisesRegex(ValueError, '库存占用'):
            dm.delete_order_items(self.con, [{'type':'order', 'id':self.oid}])
        iv.release_order_reservations(self.con, self.lid, '测试释放')
        with self.assertRaisesRegex(ValueError, '入库记录'):
            dm.delete_purchases(self.con, [purchase_id])
        self.assertEqual(len(dm.get_state(self.con)['items']), 1)
        self.purchase(5, mode='direct', code='JD-M', order_line_id=self.lid)
        plid = dm.row(self.con, 'SELECT id FROM purchase_lines WHERE order_line_id=?', (self.lid,))['id']
        iv.set_purchase_receive_mode(self.con, plid, {'receive_mode':'stock', 'warehouse_id':self.warehouse})
        self.assertEqual(dm.row(self.con, 'SELECT receive_mode FROM purchase_lines WHERE id=?', (plid,))['receive_mode'], 'stock')
        iv.post_receipt(self.con, {'warehouse_id':self.warehouse, 'lines':[{'purchase_line_id':plid, 'quantity':5}]})
        with self.assertRaisesRegex(ValueError, '已登记入库'):
            iv.set_purchase_receive_mode(self.con, plid, {'receive_mode':'direct'})


if __name__ == '__main__':
    unittest.main()
