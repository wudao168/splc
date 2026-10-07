import tempfile
import unittest
from server.db import connect
from server import domain as dm

class OrderAdjustTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.con=connect(self.temp.name)
        self.oid=dm.create_order(self.con,{'customer':'测试','po':'ADJUST','address':'测试地址','lines':[{'name':'料品','quantity':10,'price':'12'}]})['id']
        self.lid=dm.row(self.con,'SELECT id FROM order_lines WHERE order_id=?',(self.oid,))['id'];dm.confirm_quote(self.con,self.oid)
    def tearDown(self):
        self.con.close();self.temp.cleanup()
    def adjust(self,n,price='15'):
        return dm.adjust_order_lines(self.con,self.oid,{'lines':[{'id':self.lid,'quantity':n,'price':price}]})
    def test_adjust_preserves_purchase_and_quote_history(self):
        dm.create_purchase(self.con,{'platform':'淘宝','shop':'测试','platform_order':'TEST123','amount':'100','lines':[{'order_line_id':self.lid,'quantity':10,'cost':'100'}]})
        self.adjust(8);self.adjust(12,'20')
        line=dm.row(self.con,'SELECT * FROM order_lines WHERE id=?',(self.lid,));self.assertEqual(line['quantity'],12);self.assertEqual(line['price_cents'],2000)
        self.assertEqual(self.con.execute('SELECT COUNT(*) FROM purchase_lines').fetchone()[0],1)
        quotes=dm.rows(self.con,'SELECT * FROM quotes WHERE order_id=? ORDER BY version',(self.oid,));self.assertEqual(len(quotes),3);self.assertIn('1200',quotes[0]['snapshot'])
        self.assertEqual(dm.row(self.con,'SELECT status FROM orders WHERE id=?',(self.oid,))['status'],'confirmed')
    def test_delivery_floor_and_invalid_values_leave_order_unchanged(self):
        dm.create_deliveries(self.con,{'company':'测试','lines':[{'order_line_id':self.lid,'quantity':6}]})
        for n in [5,0,-1]:
            with self.assertRaises(ValueError):self.adjust(n)
        self.assertEqual(dm.row(self.con,'SELECT quantity FROM order_lines WHERE id=?',(self.lid,))['quantity'],10)
        self.adjust(6)

    def test_line_remark_saved_and_preserved_by_price_only_updates(self):
        import json
        dm.adjust_order_lines(self.con,self.oid,{'lines':[{'id':self.lid,'quantity':10,'price':12,'remark':'按图供货'}]})
        self.con.commit()
        check=connect(self.temp.name)
        try:
            self.assertEqual(dm.row(check,'SELECT remark FROM order_lines WHERE id=?',(self.lid,))['remark'],'按图供货')
        finally:check.close()
        self.adjust(10,'13')
        self.assertEqual(dm.row(self.con,'SELECT remark FROM order_lines WHERE id=?',(self.lid,))['remark'],'按图供货')
        latest=dm.row(self.con,'SELECT snapshot FROM quotes WHERE order_id=? ORDER BY version DESC LIMIT 1',(self.oid,))
        self.assertEqual(json.loads(latest['snapshot'])[0]['remark'],'按图供货')

    def test_imported_remark_survives_order_structure_edit(self):
        from server.importer import guess_mapping
        self.assertEqual(guess_mapping(['子项目号','备注']),{'subproject_code':0,'remark':1})
        oid=dm.create_order(self.con,{'customer':'测试','po':'REMARK','address':'测试地址','lines':[{'name':'料品','quantity':1,'remark':'进口备注'}]})['id']
        item=dm.row(self.con,'SELECT * FROM order_lines WHERE order_id=?',(oid,))
        self.assertEqual(item['remark'],'进口备注')
        dm.edit_order(self.con,oid,{'customer':'测试','po':'REMARK','address':'新地址','lines':[{**item,'price':0}]})
        self.assertEqual(dm.row(self.con,'SELECT remark FROM order_lines WHERE order_id=?',(oid,))['remark'],'进口备注')

if __name__=='__main__':unittest.main()
