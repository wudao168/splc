import tempfile
import unittest
from server.db import connect
from server import domain as dm

class SyncSettingsTests(unittest.TestCase):
    def test_defaults_persistence_and_validation(self):
        with tempfile.TemporaryDirectory() as folder:
            con = connect(folder)
            self.assertEqual(dm.get_sync_settings(con), {'enabled': True, 'interval_minutes': 60, 'client_seen_at': '', 'sync_windows': [['00:00', '06:00']]})
            dm.save_sync_settings(con, {'enabled': False, 'interval_minutes': 90, 'sync_windows': [['00:00', '06:00'], ['22:00', '23:00']]})
            con.commit()
            con.close()
            con = connect(folder)
            self.assertEqual(dm.get_sync_settings(con), {'enabled': False, 'interval_minutes': 90, 'client_seen_at': '', 'sync_windows': [['00:00', '06:00'], ['22:00', '23:00']]})
            # 同步时段：最多 3 段、HH:MM、开始不能等于结束
            for bad in ({'sync_windows': [['8:00', '22:00']]}, {'sync_windows': [['08:00', '08:00']]}, {'sync_windows': [['01:00', '02:00']] * 4}):
                with self.assertRaises(Exception):
                    dm.save_sync_settings(con, {'enabled': True, 'interval_minutes': 60, **bad})
            dm.save_sync_settings(con, {'enabled': False, 'interval_minutes': 60, 'sync_windows': []})
            self.assertEqual(dm.get_sync_settings(con)['sync_windows'], [])
            self.assertFalse(dm.get_sync_settings(con)['enabled'])
            for minutes in (0, 59, 1441, 1.5, '30', True):
                with self.assertRaises(Exception):
                    dm.save_sync_settings(con, {'enabled': True, 'interval_minutes': minutes})
            self.assertFalse(dm.get_sync_settings(con)['enabled'])
            con.close()

    def test_manual_request_deduplication_claim_and_retry(self):
        with tempfile.TemporaryDirectory() as folder:
            con = connect(folder)
            dm.save_sync_settings(con, {'enabled':False,'interval_minutes':60})
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
