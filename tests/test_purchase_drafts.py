import json
import tempfile
import unittest
from datetime import date, timedelta
from server.db import connect
from server import domain as dm, purchase_drafts as drafts

class PurchaseDraftTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.con = connect(self.temp.name)
        self.source = dict(platform_order='12345678901', source_url='https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=12345678901', shop='测试店铺', amount='20', purchased_date=dm.today(), products=[dict(name='测试商品',spec='A',quantity='2',amount='10',link='')], packages=[dict(carrier='测试快递',tracking='TRACK123',status='运输中',events=[])])
        self.source['transaction_status'] = '卖家已发货'
    def tearDown(self):
        self.con.close()
        self.temp.cleanup()

    def test_only_three_transaction_statuses_are_active(self):
        for index, status in enumerate(['买家已付款','卖家已发货','交易成功','等待买家付款','付款确认中','退款中的订单','交易关闭']):
            order = str(12345679000 + index)
            source = dict(self.source, transaction_status=status, platform_order=order, source_url='https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=' + order)
            result = drafts.save(self.con, source)
            actual = self.con.execute('SELECT status FROM purchase_drafts WHERE id=?', (result['id'],)).fetchone()[0]
            self.assertEqual(actual, 'active' if index < 3 else 'trash')
        with self.assertRaisesRegex(ValueError, '未识别交易状态'):
            drafts.save(self.con, dict(self.source, transaction_status=''))

    def test_closed_order_is_not_an_active_draft(self):
        result = drafts.save(self.con, dict(self.source, transaction_status='交易关闭'))
        saved = self.con.execute('SELECT status,payload FROM purchase_drafts WHERE id=?', (result['id'],)).fetchone()
        self.assertEqual(saved['status'], 'trash')
        self.assertEqual(json.loads(saved['payload'])['transaction_status'], '交易关闭')
        with self.assertRaisesRegex(ValueError, '交易状态不符合'):
            drafts.trash(self.con, 'restore', {'id':result['id']})
        self.assertEqual(drafts.sync_state(self.con)['drafts'], [])

    def test_existing_draft_moves_to_trash_when_order_closes(self):
        result = drafts.save(self.con, self.source)
        drafts.save(self.con, dict(self.source, transaction_status='交易关闭'))
        self.assertEqual(self.con.execute('SELECT status FROM purchase_drafts WHERE id=?', (result['id'],)).fetchone()[0], 'trash')

    def test_trash_restore_clear_and_collection_does_not_resurrect(self):
        item = drafts.save(self.con, self.source)
        drafts.trash(self.con, 'delete', item)
        self.assertEqual(drafts.sync_state(self.con)['drafts'], [])
        self.assertTrue(drafts.save(self.con, self.source)['skipped'])
        drafts.trash(self.con, 'restore', item)
        self.assertEqual(len(drafts.sync_state(self.con)['drafts']), 1)
        drafts.trash(self.con, 'delete', item)
        drafts.trash(self.con, 'clear', {})
        row = self.con.execute('SELECT status,payload FROM purchase_drafts').fetchone()
        self.assertEqual((row['status'], row['payload']), ('purged', '{}'))
        self.assertTrue(drafts.save(self.con, self.source)['skipped'])
    def test_recent_seven_days_dedupe_and_logistics_merge(self):
        state = drafts.sync_state(self.con)
        self.assertEqual(state['first_date'], (date.fromisoformat(dm.today()) - timedelta(days=6)).isoformat())
        old = dict(self.source,purchased_date=(date.fromisoformat(dm.today()) - timedelta(days=7)).isoformat())
        with self.assertRaises(ValueError): drafts.save(self.con,old)
        boundary = dict(self.source,purchased_date=state['first_date'])
        first = drafts.save(self.con,boundary)
        second = drafts.save(self.con,boundary)
        self.assertEqual(first['id'],second['id'])
        self.assertFalse(second['created'])
        self.assertEqual(self.con.execute('SELECT COUNT(*) FROM purchases').fetchone()[0],0)
        self.assertEqual(self.con.execute('SELECT COUNT(*) FROM purchase_lines').fetchone()[0],0)
        saved = drafts.sync_state(self.con)['drafts'][0]['payload']
        self.assertEqual(saved['packages'][0]['tracking'],'TRACK123')
        drafts.save(self.con,dict(boundary,packages=[]))
        self.assertEqual(len(drafts.sync_state(self.con)['drafts'][0]['payload']['packages']),1)
    def test_confirmation_moves_draft_once_and_preserves_logistics(self):
        draft = drafts.save(self.con,self.source)
        oid = dm.create_order(self.con,dict(customer='测试客户',po='PO-DRAFT',address='地址',lines=[dict(name='物料',quantity=2,price='10')]))['id']
        dm.confirm_quote(self.con,oid)
        line = self.con.execute('SELECT id FROM order_lines').fetchone()[0]
        body = dict(platform='淘宝',platform_order=self.source['platform_order'],shop='测试店铺',amount='20',purchase_draft_id=draft['id'],taobao_source=self.source,lines=[dict(order_line_id=line,quantity=2,cost='20')])
        result = dm.create_purchase(self.con,body)
        self.assertEqual(self.con.execute('SELECT status FROM purchase_drafts').fetchone()[0],'completed')
        payload = json.loads(self.con.execute('SELECT payload FROM purchase_sources').fetchone()[0])
        self.assertEqual(payload['packages'][0]['status'],'运输中')
        self.assertEqual(dm.lc.purchased_qty(self.con,line),2)
        self.assertTrue(drafts.save(self.con,self.source)['skipped'])
        with self.assertRaises(ValueError): dm.create_purchase(self.con,body)
    def test_manual_old_order_and_invoice_information(self):
        old = dict(self.source, purchased_date='2026-01-01', invoice_info={'status':'已开票','text':'订单页面显示已开票'})
        with self.assertRaises(ValueError): drafts.save(self.con, old)
        result = drafts.save(self.con, old, manual=True)
        payload = drafts.sync_state(self.con)['drafts'][0]['payload']
        self.assertEqual(payload['invoice_info']['status'], '已开票')
        self.assertEqual(self.con.execute('SELECT COUNT(*) FROM purchases').fetchone()[0], 0)
        self.assertEqual(drafts.save(self.con,old,manual=True)['id'],result['id'])

    def test_failed_scan_does_not_advance_cursor(self):
        state = drafts.sync_state(self.con)
        drafts.finish(self.con,dict(through=dm.today(),error='登录失效'))
        self.assertEqual(drafts.sync_state(self.con)['scanned_through'],'')
        drafts.finish(self.con,dict(through=dm.today(),error=''))
        state = drafts.sync_state(self.con)
        self.assertEqual(state['scanned_through'],dm.today())
        self.assertEqual(state['since'],(date.fromisoformat(dm.today())-timedelta(days=1)).isoformat())
