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
        self.assertEqual([d for d in drafts.sync_state(self.con)['drafts'] if d['status'] == 'active'], [])

    def test_existing_draft_moves_to_trash_when_order_closes(self):
        result = drafts.save(self.con, self.source)
        drafts.save(self.con, dict(self.source, transaction_status='交易关闭'))
        self.assertEqual(self.con.execute('SELECT status FROM purchase_drafts WHERE id=?', (result['id'],)).fetchone()[0], 'trash')

    def test_trash_restore_clear_and_collection_does_not_resurrect(self):
        item = drafts.save(self.con, self.source)
        drafts.trash(self.con, 'delete', item)
        self.assertEqual([d for d in drafts.sync_state(self.con)['drafts'] if d['status'] == 'active'], [])
        self.assertTrue(drafts.save(self.con, self.source)['skipped'])
        drafts.trash(self.con, 'restore', item)
        self.assertEqual(len(drafts.sync_state(self.con)['drafts']), 1)
        drafts.trash(self.con, 'delete', item)
        drafts.trash(self.con, 'clear', {})
        row = self.con.execute('SELECT status,payload FROM purchase_drafts').fetchone()
        self.assertEqual(row['status'], 'purged')
        self.assertEqual(json.loads(row['payload'])['purchased_date'], self.source['purchased_date'])
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
    def test_registration_carries_invoice_already_collected_on_draft(self):
        draft = drafts.save(self.con, self.source)
        stored = json.loads(self.con.execute('SELECT payload FROM purchase_drafts WHERE id=?', (draft['id'],)).fetchone()[0])
        stored['invoice_entries'] = [{'status': '已开票', 'amount_cents': 2000, 'date': '2026-10-15'}]
        stored['invoice_details'] = [{'number': '56014083', 'amount_cents': 2000, 'date': '2026-10-15'}]
        stored['invoice_checked_at'] = dm.now()
        self.con.execute('UPDATE purchase_drafts SET payload=? WHERE id=?', (json.dumps(stored, ensure_ascii=False), draft['id']))
        oid = dm.create_order(self.con, dict(customer='测试客户', po='PO-INV', address='地址', lines=[dict(name='物料', quantity=2, price='10')]))['id']
        dm.confirm_quote(self.con, oid)
        line = self.con.execute('SELECT id FROM order_lines').fetchone()[0]
        dm.create_purchase(self.con, dict(platform='淘宝', platform_order=self.source['platform_order'], shop='测试店铺', amount='20',
                                          purchase_draft_id=draft['id'], taobao_source=stored, lines=[dict(order_line_id=line, quantity=2, cost='20')]))
        payload = json.loads(self.con.execute('SELECT payload FROM purchase_sources').fetchone()[0])
        self.assertEqual(payload['invoice_entries'][0]['status'], '已开票')
        self.assertEqual(payload['invoice_details'][0]['number'], '56014083')
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM purchase_drafts WHERE status='active'").fetchone()[0], 0)

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

    def test_sync_stats_reported_and_range_adjustable(self):
        # 采集统计（扫描页数/读取笔数/新增/跳过）必须被保存下来，供页面提示，避免静默漏采。
        drafts.finish(self.con, dict(through=dm.today(), error='', stats={
            'since':'2026-10-01','pages':5,'read':150,'new':34,'created':0,'skipped':34,
            'skipped_sample':[{'order':'3316453539295008552','date':'2026-09-20'}],
            'warning':'发现 34 笔订单的采购日期早于采集起始日 2026-10-01，本次未导入。',
        }))
        stats = json.loads(drafts.sync_state(self.con)['stats'])
        self.assertEqual((stats['read'], stats['created'], stats['skipped']), (150, 0, 34))
        self.assertIn('早于采集起始日', stats['warning'])
        # 调整采集起始日后可以补采更早订单
        result = drafts.set_range(self.con, {'first_date':'2026-09-01'})
        self.assertEqual(result, {'first_date':'2026-09-01', 'previous':(date.fromisoformat(dm.today())-timedelta(days=6)).isoformat()})
        self.assertEqual(drafts.sync_state(self.con)['first_date'], '2026-09-01')
        with self.assertRaises(ValueError):
            drafts.set_range(self.con, {'first_date':'2999-01-01'})

    def test_cleared_trash_is_ignored_until_order_becomes_valid_and_can_be_revived(self):
        # 未成交订单先进入回收站，清空回收站后保留“暂时忽略”标记。
        oid = '3316486587011071390'
        unpaid = dict(self.source, platform_order=oid, transaction_status='等待买家付款',
                      source_url=f'https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id={oid}')
        item = drafts.save(self.con, unpaid)
        self.assertEqual(self.con.execute('SELECT status FROM purchase_drafts WHERE id=?', (item['id'],)).fetchone()[0], 'trash')
        drafts.trash(self.con, 'clear', {})
        row = self.con.execute('SELECT status,payload FROM purchase_drafts WHERE id=?', (item['id'],)).fetchone()
        self.assertEqual(row['status'], 'purged')
        self.assertEqual(json.loads(row['payload'])['transaction_status'], '等待买家付款')
        # 仍为未成交时不恢复
        self.assertTrue(drafts.save(self.con, unpaid)['skipped'])
        # 订单变成已付款后自动恢复为草稿
        paid = dict(unpaid, transaction_status='买家已付款')
        result = drafts.save(self.con, paid)
        self.assertFalse(result['created'])
        active = drafts.sync_state(self.con)['drafts']
        self.assertEqual(len(active), 1)
        self.assertEqual(active[0]['payload']['transaction_status'], '买家已付款')
        # 重新采集已忽略订单：清空忽略标记，供下一轮采集
        drafts.trash(self.con, 'delete', {'id': item['id']})
        drafts.trash(self.con, 'clear', {})
        self.assertEqual(drafts.revive(self.con), {'cleared': 1})
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM purchase_drafts WHERE status='purged'").fetchone()[0], 0)

    def test_sync_state_returns_trash_drafts_for_status_refresh(self):
        # 回收站订单也要参与每轮刷新，否则“等待买家付款”永远不会变成已付款。
        unpaid = dict(self.source, transaction_status='等待买家付款')
        drafts.save(self.con, unpaid)
        active = dict(self.source, platform_order='3316450000000000001', source_url='https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=3316450000000000001')
        drafts.save(self.con, active)
        state = drafts.sync_state(self.con)
        self.assertEqual(len(state['drafts']), 2)
        statuses = sorted(item['payload']['transaction_status'] for item in state['drafts'])
        self.assertEqual(statuses, ['卖家已发货', '等待买家付款'])

    def test_refund_or_closed_order_goes_to_trash_and_keeps_latest_status(self):
        # 已付款/已发货的订单后来变成“退款中/交易关闭”：自动移入回收站，并持续刷新最后状态。
        refunding = dict(self.source, transaction_status='退款中的订单')
        item = drafts.save(self.con, refunding)
        row = self.con.execute('SELECT status,payload FROM purchase_drafts WHERE id=?', (item['id'],)).fetchone()
        self.assertEqual(row['status'], 'trash')
        self.assertEqual(json.loads(row['payload'])['transaction_status'], '退款中的订单')
        closed = dict(self.source, transaction_status='交易关闭')
        self.assertFalse(drafts.save(self.con, closed)['created'])
        row = self.con.execute('SELECT status,payload FROM purchase_drafts WHERE id=?', (item['id'],)).fetchone()
        self.assertEqual(row['status'], 'trash')
        self.assertEqual(json.loads(row['payload'])['transaction_status'], '交易关闭')
        # 状态恢复有效 → 自动回到淘宝订单（active）
        success = dict(self.source, transaction_status='交易成功')
        self.assertFalse(drafts.save(self.con, success)['created'])
        row = self.con.execute('SELECT status,payload FROM purchase_drafts WHERE id=?', (item['id'],)).fetchone()
        self.assertEqual(row['status'], 'active')
        self.assertEqual(json.loads(row['payload'])['transaction_status'], '交易成功')
        # 清空回收站（已忽略）后不再自动刷新/恢复
        drafts.trash(self.con, 'delete', {'id': item['id']})
        drafts.trash(self.con, 'clear', {})
        tomb = self.con.execute('SELECT status,payload FROM purchase_drafts WHERE id=?', (item['id'],)).fetchone()
        self.assertEqual(tomb['status'], 'purged')
        self.assertTrue(drafts.save(self.con, closed)['skipped'])
        after = self.con.execute('SELECT status,payload FROM purchase_drafts WHERE id=?', (item['id'],)).fetchone()
        self.assertEqual((after['status'], after['payload']), (tomb['status'], tomb['payload']))
