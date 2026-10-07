import tempfile
import unittest
from server.db import connect
from server import domain as dm

class OrderTaxTests(unittest.TestCase):
    def test_default_rate_and_adjustment_snapshot(self):
        with tempfile.TemporaryDirectory() as folder:
            con = connect(folder)
            try:
                oid = dm.create_order(con, dict(customer='客户',po='PO-TAX',address='地址',lines=[dict(name='料品',quantity=2,price='113')]))['id']
                line = dict(con.execute('SELECT * FROM order_lines').fetchone())
                self.assertEqual((line['price_cents'],line['tax_rate']), (11300,13))
                dm.confirm_quote(con,oid)
                body = dict(lines=[dict(id=line['id'],quantity=2,price='106',tax_rate=6)])
                dm.adjust_order_lines(con,oid,body)
                line = dict(con.execute('SELECT * FROM order_lines').fetchone())
                self.assertEqual((line['price_cents'],line['tax_rate']), (10600,6))
                body['lines'][0]['tax_rate']=-1
                with self.assertRaisesRegex(ValueError,'税率'): dm.adjust_order_lines(con,oid,body)
            finally:
                con.close()
