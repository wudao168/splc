import tempfile
import unittest
from server.db import connect
from server import domain as dm

class SyncSettingsTests(unittest.TestCase):
    def test_defaults_persistence_and_validation(self):
        with tempfile.TemporaryDirectory() as folder:
            con = connect(folder)
            self.assertEqual(dm.get_sync_settings(con), {'enabled': True, 'interval_minutes': 30})
            dm.save_sync_settings(con, {'enabled': False, 'interval_minutes': 5})
            con.commit()
            con.close()
            con = connect(folder)
            self.assertEqual(dm.get_sync_settings(con), {'enabled': False, 'interval_minutes': 5})
            for minutes in (0, 1441, 1.5, '30', True):
                with self.assertRaises(Exception):
                    dm.save_sync_settings(con, {'enabled': True, 'interval_minutes': minutes})
            self.assertFalse(dm.get_sync_settings(con)['enabled'])
            con.close()

    def test_manual_request_deduplication_claim_and_retry(self):
        with tempfile.TemporaryDirectory() as folder:
            con = connect(folder)
            dm.save_sync_settings(con, {'enabled':False,'interval_minutes':30})
            first = dm.request_sync(con)
            self.assertEqual(dm.request_sync(con)['request_id'], first['request_id'])
            body = {'request_id':first['request_id']}
            self.assertTrue(dm.update_sync_request(con,'start',body)['claimed'])
            self.assertFalse(dm.update_sync_request(con,'start',body)['claimed'])
            self.assertEqual(dm.request_sync(con)['status'],'running')
            dm.update_sync_request(con,'heartbeat',body)
            dm.update_sync_request(con,'finish',{**body,'error':'登录失效'})
            self.assertEqual(dm.get_sync_settings(con)['manual_sync']['status'],'failed')
            second = dm.request_sync(con)
            self.assertNotEqual(first['request_id'],second['request_id'])
            dm.update_sync_request(con,'start',{'request_id':second['request_id']})
            dm.update_sync_request(con,'finish',body)
            self.assertEqual(dm.get_sync_settings(con)['manual_sync']['status'],'running')
            dm.update_sync_request(con,'finish',{'request_id':second['request_id']})
            self.assertEqual(dm.get_sync_settings(con)['manual_sync']['status'],'done')
            con.close()
