import io
import sqlite3
import tempfile
import unittest

from openpyxl import Workbook
from server.db import connect, SCHEMA
from server import domain as dm
from server.importer import parse_file, metadata


class CustomerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.con = connect(self.temp.name)

    def tearDown(self):
        self.con.close()
        self.temp.cleanup()

    def test_admin_deletes_customer_and_orders_keep_name(self):
        cid = dm.save_customer(self.con, {'name': '待删客户', 'contacts': [{'name': '张工', 'phone': '020-1'}],
                                          'addresses': [{'address': '地址A'}]})['id']
        oid = dm.create_order(self.con, {'customer_id': cid, 'po': 'PO-DEL-1', 'address': '地址A', 'contact': '张工',
                                         'phone': '020-1', 'lines': [{'name': '螺丝', 'quantity': 1}]})['id']
        actor = dm.actor_id.set(2)
        with self.assertRaisesRegex(ValueError, '仅管理员'):
            dm.delete_customer(self.con, cid)
        dm.actor_id.set(1)
        self.assertEqual(dm.delete_customer(self.con, cid), {'id': cid, 'orders': 1})
        dm.actor_id.reset(actor)
        state = dm.get_state(self.con)
        self.assertEqual(state['customers'], [])
        order = next(o for o in state['orders'] if o['id'] == oid)
        self.assertEqual(order['customer'], '待删客户')
        self.assertIsNone(order['customer_id'])
        self.assertEqual(self.con.execute('SELECT COUNT(*) FROM customer_contacts').fetchone()[0], 0)
        self.assertEqual(self.con.execute('SELECT COUNT(*) FROM customer_addresses').fetchone()[0], 0)

    def test_directory_roundtrip_and_order_snapshot(self):
        payload = {'name': '测试客户', 'contacts': [{'name': '张工', 'phone': '020-12345678'}],
                   'addresses': [{'address': '测试地址一'}, {'address': '测试地址二'}]}
        cid = dm.save_customer(self.con, payload)['id']
        c = dm.get_state(self.con)['customers'][0]
        self.assertEqual(len(c['addresses']), 2)
        self.assertEqual(c['contacts'][0]['phone'], '020-12345678')
        order = {'customer_id': cid, 'customer': '不信任前端名称', 'po': 'PO001', 'contact': '张工',
                 'phone': '020-12345678', 'address': '本次临时地址', 'lines': [{'name': '螺丝', 'quantity': 1}]}
        oid = dm.create_order(self.con, order)['id']
        dm.save_customer(self.con, {**payload, 'name': '测试客户新名称', 'contacts': [], 'addresses': []}, cid)
        snapshot = dm.row(self.con, 'SELECT * FROM orders WHERE id=?', (oid,))
        self.assertEqual(snapshot['customer'], '测试客户')
        self.assertEqual(snapshot['customer_id'], cid)
        self.assertEqual(snapshot['contact'], '张工')
        self.assertEqual(snapshot['address'], '本次临时地址')
        with self.assertRaisesRegex(ValueError, '此客户 PO 已存在'):
            dm.create_order(self.con, {**order, 'contact': '', 'phone': ''})
        with self.assertRaisesRegex(ValueError, '联系人资料已改变'):
            dm.create_order(self.con, {**order, 'po': 'PO002'})
        with self.assertRaisesRegex(ValueError, '请选择客户'):
            dm.create_order(self.con, {**order, 'customer_id': ''})
        with self.assertRaisesRegex(ValueError, '客户名称已存在'):
            dm.save_customer(self.con, {'name': '测试客户新名称'})

    def test_legacy_migration_preserves_order(self):
        with tempfile.TemporaryDirectory() as folder:
            old = sqlite3.connect(folder + '/caidan.sqlite3')
            old.executescript(SCHEMA)
            old.execute('INSERT INTO orders(customer,po,contact,phone,address,created_at) VALUES(?,?,?,?,?,?)',
                        ('旧客户', 'OLD-001', '采购员', '12345', '原地址', dm.now()))
            old.commit(); old.close()
            new = connect(folder)
            try:
                c = dm.get_state(new)['customers'][0]
                self.assertEqual(c['contacts'][0]['name'], '采购员')
                self.assertEqual(c['addresses'][0]['address'], '原地址')
                self.assertEqual(dm.get_state(new)['orders'][0]['customer_id'], c['id'])
            finally:
                new.close()
            again = connect(folder)
            self.assertEqual(len(dm.get_state(again)['customers']), 1)
            again.close()

    def test_invoice_info_persists_without_changing_customer_or_orders(self):
        payload = {'name': '开票测试客户', 'note': '原备注', 'contacts': [{'name': '采购员', 'phone': '123'}],
                   'addresses': [{'address': '原收货地址'}]}
        cid = dm.save_customer(self.con, payload)['id']
        other = dm.save_customer(self.con, {'name': '另一客户'})['id']
        oid = dm.create_order(self.con, {'customer_id': cid, 'po': 'BILLING-001', 'address': '原收货地址',
                                       'lines': [{'name': '螺丝', 'quantity': 1}]})['id']
        before = next(c for c in dm.get_state(self.con)['customers'] if c['id'] == cid)
        snapshot = dm.row(self.con, 'SELECT * FROM orders WHERE id=?', (oid,))
        info = {'title': '开票抬头', 'tax_number': '001234567890123456', 'address': '注册地址', 'phone': '021-12345678',
                'bank_name': '测试银行', 'bank_account': '00012345678901234567890', 'email': 'invoice@example.com'}
        dm.save_customer_invoice(self.con, cid, {**info, 'title': ' 开票抬头 '})
        self.con.commit()
        self.con.close()
        self.con = connect(self.temp.name)
        customers = dm.get_state(self.con)['customers']
        saved = next(c for c in customers if c['id'] == cid)
        self.assertEqual(saved['invoice_info'], info)
        self.assertEqual({**saved, 'invoice_info': {}}, before)
        self.assertEqual(next(c for c in customers if c['id'] == other)['invoice_info'], {})
        self.assertEqual(dm.row(self.con, 'SELECT * FROM orders WHERE id=?', (oid,)), snapshot)
        dm.save_customer(self.con, {**payload, 'note': '修改客户资料'}, cid)
        self.assertEqual(next(c for c in dm.get_state(self.con)['customers'] if c['id'] == cid)['invoice_info'], info)
        for invalid in ({'tax_number': '123'}, {'title': ['错误类型']}, {'title': 'x' * 5001}):
            with self.assertRaises(ValueError):
                dm.save_customer_invoice(self.con, cid, invalid)
        self.assertEqual(next(c for c in dm.get_state(self.con)['customers'] if c['id'] == cid)['invoice_info'], info)
        with self.assertRaisesRegex(ValueError, '记录不存在'):
            dm.save_customer_invoice(self.con, 99999, info)
        dm.save_customer_invoice(self.con, cid, {key: ' ' for key in info})
        self.assertEqual(next(c for c in dm.get_state(self.con)['customers'] if c['id'] == cid)['invoice_info'], {})

    def test_invoice_info_migrates_existing_customers(self):
        with tempfile.TemporaryDirectory() as folder:
            old = sqlite3.connect(folder + '/caidan.sqlite3')
            old.executescript(SCHEMA.replace(",\n invoice_info TEXT NOT NULL DEFAULT '{}'", ''))
            old.execute('INSERT INTO customers(name,created_at) VALUES(?,?)', ('原客户', dm.now()))
            old.execute('INSERT INTO customer_contacts(customer_id,name,phone) VALUES(1,?,?)', ('原联系人', '123'))
            old.commit(); old.close()
            for _ in range(2):
                new = connect(folder)
                customer = dm.get_state(new)['customers'][0]
                self.assertEqual(customer['invoice_info'], {})
                self.assertEqual(customer['name'], '原客户')
                self.assertEqual(customer['contacts'][0]['name'], '原联系人')
                new.close()

    def test_po_in_repeated_column_and_ambiguous_file(self):
        wb = Workbook(); ws = wb.active
        ws.append(['业务日期', '单据编号', '料品名称', '采购数量'])
        ws.append(['2026-09-29', 'PO02609290020', '螺丝', 1])
        ws.append(['2026-09-29', 'PO02609290020', '垫片', 2])
        out = io.BytesIO(); wb.save(out)
        result = parse_file(out.getvalue(), '客户询价.xlsx')
        self.assertEqual(result['metadata']['po'], 'PO02609290020')
        self.assertEqual(result['tables'][0]['po_column'], 1)
        self.assertEqual(len(result['tables'][0]['rows']), 2)
        ws.append(['2026-09-29', 'PO02609290021', '螺母', 3])
        out = io.BytesIO(); wb.save(out)
        result = parse_file(out.getvalue(), '客户询价.xlsx')
        self.assertNotIn('po', result['metadata'])
        self.assertEqual(len(result['tables'][0]['po_candidates']), 2)
        self.assertTrue(any('多个 PO' in x for x in result['warnings']))
        self.assertEqual(metadata('客户 PO：PO02609290020')['po'], 'PO02609290020')

    def test_address_recipients_and_order_snapshot(self):
        addresses = [
            {'address': '同一园区', 'contact': '一号仓收货员', 'phone': '020-11111111'},
            {'address': '同一园区', 'contact': '二号仓收货员', 'phone': '020-22222222'}]
        cid = dm.save_customer(self.con, {'name': '收货客户', 'addresses': addresses})['id']
        stored = next(c for c in dm.get_state(self.con)['customers'] if c['id'] == cid)['addresses']
        self.assertEqual([(a['address'], a['contact'], a['phone']) for a in stored],
                         [(a['address'], a['contact'], a['phone']) for a in addresses])
        order = {'customer_id': cid, 'po': 'ADDRESS-001', **addresses[1], 'lines': [{'name': '螺丝', 'quantity': 1}]}
        oid = dm.create_order(self.con, order)['id']
        with self.assertRaisesRegex(ValueError, '联系人资料已改变'):
            dm.create_order(self.con, {**order, 'po': 'ADDRESS-002', 'phone': '020-11111111'})
        with self.assertRaisesRegex(ValueError, '收货地址及收货联系人重复'):
            dm.save_customer(self.con, {'name': '重复地址客户', 'addresses': [addresses[0], addresses[0]]})
        dm.save_customer(self.con, {'name': '收货客户', 'addresses': [addresses[0]]}, cid)
        snapshot = dm.row(self.con, 'SELECT * FROM orders WHERE id=?', (oid,))
        self.assertEqual(snapshot['contact'], '二号仓收货员')
        self.assertEqual(snapshot['phone'], '020-22222222')
        self.assertEqual(snapshot['address'], '同一园区')

    def test_existing_address_migration_keeps_unknown_recipient_empty(self):
        with tempfile.TemporaryDirectory() as folder:
            old = sqlite3.connect(folder + '/caidan.sqlite3')
            old.executescript(SCHEMA)
            old.execute('INSERT INTO customers(name,created_at) VALUES(?,?)', ('原客户', dm.now()))
            old.execute('INSERT INTO customer_addresses(customer_id,address) VALUES(1,?)', ('原收货地址',))
            old.commit(); old.close()
            new = connect(folder)
            address = dm.get_state(new)['customers'][0]['addresses'][0]
            self.assertEqual((address['address'], address['contact'], address['phone']), ('原收货地址', '', ''))
            new.close()


if __name__ == '__main__':
    unittest.main()
