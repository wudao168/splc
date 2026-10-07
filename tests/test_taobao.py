import hashlib
import tempfile
import unittest
from server.db import connect
from server import domain as dm


class TaobaoTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.con = connect(self.temp.name)
        oid = dm.create_order(self.con, {'customer':'测试客户','po':'QA-001','address':'测试地址','lines':[{'name':'测试料品','quantity':3,'price':'10'}]})['id']
        dm.confirm_quote(self.con, oid)
        lid = self.con.execute('SELECT id FROM order_lines').fetchone()[0]
        self.source = {'platform_order':'1234567890123456789','transaction_status':'卖家已发货','packages':[{'carrier':'测试快递','tracking':'TEST12345678'}],'products':[], 'phone':'不应保存'}
        self.pid = dm.create_purchase(self.con, {'platform':'淘宝','shop':'测试店铺','platform_order':self.source['platform_order'],'amount':'30','taobao_source':self.source,'lines':[{'order_line_id':lid,'quantity':3,'cost':'30'}]})['id']

    def tearDown(self):
        self.con.close()
        self.temp.cleanup()

    def test_merge_packages_persist_without_duplicate_purchase_or_private_fields(self):
        source = dict(self.source, packages=self.source['packages'] + [{'carrier':'测试快递','tracking':'TEST87654321'}])
        dm.save_taobao_source(self.con,self.pid,source)
        dm.save_taobao_source(self.con,self.pid,source)
        self.con.commit()
        self.con.close()
        self.con = connect(self.temp.name)
        state = dm.get_state(self.con)
        self.assertEqual(len(state['purchases']),1)
        self.assertEqual(state['purchases'][0]['amount_cents'],3000)
        saved = state['purchases'][0]['taobao_source']
        self.assertEqual(len(saved['packages']),2)
        self.assertNotIn('phone',saved)
        self.assertEqual(state['packages'],[])

    def test_mismatched_order_and_unsafe_product_link_rejected(self):
        with self.assertRaisesRegex(ValueError,'不一致'):
            dm.save_taobao_source(self.con,self.pid,dict(self.source,platform_order='9999999999999999999'))
        with self.assertRaisesRegex(ValueError,'链接'):
            dm.save_taobao_source(self.con,self.pid,dict(self.source,products=[{'name':'商品','link':'javascript:alert(1)'}]))
        with self.assertRaisesRegex(ValueError,'链接'):
            dm.save_taobao_source(self.con,self.pid,dict(self.source,source_url='https://trade.taobao.com.evil.test/trade/detail/trade_order_detail.htm?biz_order_id=1234567890123456789'))

    def test_order_source_url_is_saved(self):
        url = 'https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=1234567890123456789'
        dm.save_taobao_source(self.con,self.pid,dict(self.source,source_url=url))
        self.assertEqual(dm.get_state(self.con)['purchases'][0]['taobao_source']['source_url'],url)

    def test_saved_shipments_still_require_quantity_allocation(self):
        line = self.con.execute('SELECT id FROM purchase_lines').fetchone()[0]
        dm.create_package(self.con, {'carrier':'测试快递','tracking':'TEST12345678','lines':[{'purchase_line_id':line,'quantity':2}]})
        with self.assertRaisesRegex(ValueError,'超过'):
            dm.create_package(self.con, {'carrier':'测试快递','tracking':'TEST87654321','lines':[{'purchase_line_id':line,'quantity':2}]})

    def test_tracking_nodes_update_registered_package_once(self):
        line = self.con.execute('SELECT id FROM purchase_lines').fetchone()[0]
        package_id = dm.create_package(self.con, {'carrier':'测试快递','tracking':'TEST12345678','lines':[{'purchase_line_id':line,'quantity':3}]})['id']
        source = dict(self.source, packages=[{'carrier':'测试快递','tracking':'TEST12345678','status':'已签收',
            'events':[{'occurred_at':'2026-09-29T10:00:00+08:00','description':'快件已揽收'},
                      {'occurred_at':'2026-09-30T12:00:00+08:00','description':'客户已签收'}]}])
        dm.save_taobao_source(self.con, self.pid, source)
        dm.save_taobao_source(self.con, self.pid, source)
        pkg = self.con.execute('SELECT status,signed_at FROM packages WHERE id=?', (package_id,)).fetchone()
        self.assertEqual(tuple(pkg), ('已签收', '2026-09-30'))
        events = self.con.execute("SELECT description FROM tracking_events WHERE package_id=? AND source='淘宝'", (package_id,)).fetchall()
        self.assertEqual(len(events), 2)
        self.assertEqual(dm.get_state(self.con)['purchases'][0]['taobao_source']['packages'][0]['status'], '已签收')

    def test_tracking_saved_before_package_registration_is_applied_later(self):
        source = dict(self.source, packages=[{'carrier':'测试快递','tracking':'TEST12345678','status':'运输中',
            'events':[{'occurred_at':'2026-09-29T10:00:00+08:00','description':'快件已揽收'}]}])
        dm.save_taobao_source(self.con, self.pid, source)
        line = self.con.execute('SELECT id FROM purchase_lines').fetchone()[0]
        package_id = dm.create_package(self.con, {'carrier':'测试快递','tracking':'TEST12345678','lines':[{'purchase_line_id':line,'quantity':3}]})['id']
        self.assertEqual(self.con.execute('SELECT status FROM packages WHERE id=?', (package_id,)).fetchone()[0], '运输中')

    def test_failed_sync_keeps_previous_tracking(self):
        dm.taobao_sync_failed(self.con, self.pid)
        source = dm.get_state(self.con)['purchases'][0]['taobao_source']
        self.assertEqual(source['packages'][0]['tracking'], 'TEST12345678')
        self.assertIn('未能识别', source['sync_error'])

    def test_invoice_snapshot_links_by_order_without_marking_receipt(self):
        entries = [
            {'platform_order':self.source['platform_order'],'status':'申请中','amount':'18.00',
             'title':'企业 - 测试客户','invoice_type':'普通发票-电子','applied_at':'2026.10.03 10:00:00'},
            {'platform_order':self.source['platform_order'],'status':'已开票','amount':'12.00',
             'title':'企业 - 测试客户','invoice_type':'普通发票-电子','date':'2026-10-03'},
            {'platform_order':'9999999999999999999','status':'已开票','amount':'50.00'}]
        details = [{'platform_order':self.source['platform_order'], 'invoices':[{
            'number':'26337000000000000001','code':'','amount':'12.00',
            'invoice_type':'普通发票-电子','date':'2026-10-03','title':'测试客户',
            'buyer_tax_id':'','content':''}]}]
        self.assertEqual(dm.save_taobao_invoice_snapshot(self.con, {'entries':entries, 'details':details})['updated'], 1)
        purchase = dm.get_state(self.con)['purchases'][0]
        self.assertEqual(len(purchase['taobao_source']['invoice_entries']), 2)
        self.assertEqual(purchase['taobao_source']['invoice_details'][0]['number'], '26337000000000000001')
        self.assertEqual(purchase['taobao_source']['packages'][0]['tracking'], 'TEST12345678')
        self.assertEqual(purchase['received_cents'], 0)
        self.assertEqual(purchase['remaining_cents'], 3000)
        self.assertEqual(self.con.execute('SELECT COUNT(*) FROM invoices').fetchone()[0], 0)

    def test_invoice_snapshot_rejects_invalid_status(self):
        with self.assertRaisesRegex(ValueError, '状态'):
            dm.save_taobao_invoice_snapshot(self.con, {'entries':[{'platform_order':self.source['platform_order'],
                'status':'已收齐','amount':'30'}]})
        with self.assertRaisesRegex(ValueError, '不一致'):
            dm.save_taobao_invoice_snapshot(self.con, {'entries':[], 'details':[
                {'platform_order':self.source['platform_order'], 'invoices':[{'number':'123','amount':'30','date':'2026-10-03'}]}]})

    def test_downloaded_invoice_waits_for_confirmation_and_survives_resync(self):
        content = b'%PDF-1.4 test invoice'
        aid = hashlib.sha256(content).hexdigest()
        self.con.execute('INSERT INTO attachments VALUES(?,?,?,?)',
                         (aid, 'invoice.pdf', 'application/pdf', dm.now()))
        entry = {'platform_order':self.source['platform_order'], 'status':'已开票', 'amount':'30.00'}
        invoice = {'number':'26337000000000000001', 'amount':'30.00', 'date':'2026-10-03',
                   'attachment_id':aid}
        dm.save_taobao_invoice_snapshot(self.con, {'entries':[entry], 'details':[
            {'platform_order':self.source['platform_order'], 'invoices':[invoice]}]})
        purchase = dm.get_state(self.con)['purchases'][0]
        self.assertEqual(purchase['taobao_source']['invoice_details'][0]['attachment_id'], aid)
        self.assertEqual(purchase['received_cents'], 0)
        dm.save_taobao_invoice_snapshot(self.con, {'entries':[entry], 'details':[
            {'platform_order':self.source['platform_order'], 'invoices':[{k:v for k,v in invoice.items() if k != 'attachment_id'}]}]})
        self.assertEqual(dm.get_state(self.con)['purchases'][0]['taobao_source']['invoice_details'][0]['attachment_id'], aid)
        dm.create_invoice(self.con, {'number':invoice['number'], 'seller':'测试店铺',
            'issued_date':invoice['date'], 'amount':'30.00', 'attachment_id':aid,
            'allocations':[{'purchase_id':self.pid, 'amount':'30.00'}]})
        purchase = dm.get_state(self.con)['purchases'][0]
        self.assertEqual(purchase['received_cents'], 3000)
        self.assertEqual(purchase['receipt_status'], '已收齐')

    def test_product_amount_is_saved_and_allocation_may_be_blank(self):
        oid = dm.create_order(self.con, {'customer':'测试客户','po':'QA-002','address':'测试地址','lines':[
            {'name':'商品甲','quantity':1,'price':'20'}, {'name':'商品乙','quantity':1,'price':'20'}]})['id']
        dm.confirm_quote(self.con, oid)
        line_ids = [row[0] for row in self.con.execute('SELECT id FROM order_lines WHERE order_id=? ORDER BY id', (oid,))]
        source = {'platform_order':'2222222222222222222','transaction_status':'卖家已发货','products':[
            {'name':'商品甲','spec':'A','quantity':'1','amount':'13.80','link':'https://item.taobao.com/item.htm?id=123456789'}]}
        pid = dm.create_purchase(self.con, {'platform':'淘宝','shop':'测试店铺','platform_order':source['platform_order'],
            'amount':'28.60','taobao_source':source,'lines':[
                {'order_line_id':line_ids[0],'quantity':1,'cost':'13.80'},
                {'order_line_id':line_ids[1],'quantity':1,'cost':''}]})['id']
        costs = [row[0] for row in self.con.execute('SELECT cost_cents FROM purchase_lines WHERE purchase_id=? ORDER BY id', (pid,))]
        self.assertEqual(costs, [1380, 0])
        saved = next(p for p in dm.get_state(self.con)['purchases'] if p['id'] == pid)
        self.assertEqual(saved['taobao_source']['products'][0]['amount'], '13.80')


if __name__ == '__main__':
    unittest.main()
