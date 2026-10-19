import json
import tempfile
import unittest
from datetime import datetime, timedelta
from server.db import connect
from server import domain as dm


class StatusMessageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.con = connect(self.temp.name)

    def tearDown(self):
        self.con.close()
        self.temp.cleanup()

    def test_fresh_system_reports_missing_client(self):
        messages = dm.status_messages(self.con)
        self.assertTrue(any('尚未检测到客户端在线' in item['text'] for item in messages))

    def test_client_heartbeat_is_throttled_and_marks_online(self):
        seen = dm.touch_client(self.con)
        self.assertEqual(dm.touch_client(self.con), seen)
        self.assertEqual(dm.client_seen(self.con), (seen, True))
        messages = dm.status_messages(self.con)
        self.assertTrue(any(item['level'] == 'ok' and '客户端在线' in item['text'] for item in messages))

    def test_stale_heartbeat_marks_client_offline(self):
        stamp = (datetime.now(dm.TZ) - timedelta(minutes=30)).isoformat(timespec='seconds')
        self.con.execute('UPDATE sync_settings SET client_seen_at=? WHERE id=1', (stamp,))
        self.assertEqual(dm.client_seen(self.con), (stamp, False))
        messages = dm.status_messages(self.con)
        self.assertEqual(messages[0]['level'], 'warn')
        self.assertIn('客户端离线', messages[0]['text'])

    def test_verification_error_outranks_other_messages(self):
        dm.touch_client(self.con)
        self.con.execute("INSERT INTO purchase_draft_sync(id,first_date,checked_at,error,stats) VALUES(1,?,?,?,?)",
                         (dm.today(), dm.now(), '淘宝要求验证：请打开客户端里的“淘宝订单”窗口完成滑块验证，完成后会自动继续同步',
                          json.dumps({'pages': 3, 'read': 60, 'created': 0, 'failed': 0, 'warning': ''})))
        messages = dm.status_messages(self.con)
        self.assertEqual(messages[0]['level'], 'error')
        self.assertIn('验证', messages[0]['text'])

    def test_verification_shot_is_attached_to_message(self):
        dm.touch_client(self.con)
        self.con.execute("INSERT INTO attachments(id,name,mime,created_at) VALUES(?,?,?,?)",
                         ('a' * 64, '淘宝验证截图.png', 'image/png', dm.now()))
        dm.save_verification_shot(self.con, {'attachment_id': 'a' * 64})
        self.con.execute("INSERT INTO purchase_draft_sync(id,first_date,checked_at,error,stats) VALUES(1,?,?,?,?)",
                         (dm.today(), dm.now(), '淘宝要求验证：请打开客户端里的“淘宝订单”窗口完成滑块验证，完成后会自动继续同步', '{}'))
        messages = dm.status_messages(self.con)
        verify = [item for item in messages if item['level'] == 'error' and '验证' in item['text']]
        self.assertTrue(verify)
        self.assertEqual(verify[0].get('image'), 'a' * 64)

    def test_manual_sync_request_waits_for_client(self):
        dm.request_sync(self.con)
        messages = dm.status_messages(self.con)
        self.assertTrue(any(item['level'] == 'info' and '等待客户端执行' in item['text'] for item in messages))
        self.con.execute('UPDATE sync_request SET status=?,requested_at=?,updated_at=? WHERE id=1',
                         ('pending', (datetime.now(dm.TZ) - timedelta(minutes=30)).isoformat(timespec='seconds'),
                          (datetime.now(dm.TZ) - timedelta(minutes=30)).isoformat(timespec='seconds')))
        messages = dm.status_messages(self.con)
        self.assertTrue(any(item['level'] == 'warn' and '客户端可能未启动或离线' in item['text'] for item in messages))

    def test_failed_request_is_hidden_after_later_success(self):
        dm.request_sync(self.con)
        self.con.execute("UPDATE sync_request SET status='failed', updated_at=? WHERE id=1", (dm.now(),))
        self.con.execute("UPDATE sync_request SET error='物流：1 笔订单读取失败' WHERE id=1")
        later = (datetime.now(dm.TZ) + timedelta(minutes=1)).isoformat(timespec='seconds')
        self.con.execute("INSERT INTO purchase_draft_sync(id,first_date,checked_at,error,stats) VALUES(1,?,?,?,?)",
                         (dm.today(), later, '', json.dumps({'pages': 11, 'read': 330, 'created': 0, 'failed': 0, 'warning': ''})))
        messages = dm.status_messages(self.con)
        self.assertFalse(any('上次同步失败' in item['text'] for item in messages))
        self.con.execute("UPDATE purchase_draft_sync SET checked_at=? WHERE id=1", ('2026-01-01T00:00:00+08:00',))
        messages = dm.status_messages(self.con)
        self.assertTrue(any('上次同步失败' in item['text'] for item in messages))

    def test_sync_summary_and_warnings(self):
        self.con.execute("INSERT INTO purchase_draft_sync(id,first_date,checked_at,error,stats) VALUES(1,?,?,?,?)",
                         (dm.today(), dm.now(), '',
                          json.dumps({'pages': 10, 'read': 300, 'created': 0, 'failed': 2,
                                      'warning': '有 61 笔订单早于采集起始日 2026-10-01，本次未导入。'})))
        messages = dm.status_messages(self.con)
        self.assertTrue(any(item['level'] == 'warn' and '读取失败' in item['text'] for item in messages))
        self.assertTrue(any(item['level'] == 'ok' and '最近同步' in item['text'] for item in messages))
        self.assertEqual(messages[0]['level'], 'warn')

    def test_start_date_exclusions_are_not_warnings(self):
        self.con.execute("INSERT INTO purchase_draft_sync(id,first_date,checked_at,error,stats) VALUES(1,?,?,?,?)",
                         (dm.today(), dm.now(), '',
                          json.dumps({'pages': 10, 'read': 300, 'created': 0, 'failed': 0,
                                      'excluded_by_list_date': 63,
                                      'warning': '有 63 笔订单早于采集起始日 2026-10-01，本次未导入。'})))
        messages = dm.status_messages(self.con)
        self.assertFalse(any('早于采集起始日' in item['text'] for item in messages))
        # 详情日期与列表日期不一致这类真异常仍然提示。
        self.con.execute("UPDATE purchase_draft_sync SET stats=? WHERE id=1",
                         (json.dumps({'pages': 10, 'read': 300, 'created': 0, 'failed': 0,
                                      'warning': '发现 1 笔订单的采购日期早于采集起始日 2026-10-01，本次未导入；如需补采更早的订单，请在“采购 · 自动同步”中调整采集起始日。'}),))
        messages = dm.status_messages(self.con)
        self.assertTrue(any(item['level'] == 'warn' and '采购日期早于采集起始日' in item['text'] for item in messages))

    def test_sync_report_summarises_invoice_and_logistics(self):
        self.con.execute("INSERT INTO purchase_draft_sync(id,first_date,checked_at,error,stats) VALUES(1,?,?,?,?)",
                         (dm.today(), dm.now(), '', json.dumps({'pages': 11, 'read': 330, 'created': 0, 'failed': 0})))
        dm.save_sync_report(self.con, {'report': {'finishedAt': dm.now(),
                                                  'invoice': {'pages': 16, 'matched': 2, 'downloaded': 1},
                                                  'tracking': {'attempted': 15, 'saved': 14, 'failed': [{'order': '3316934569036008552', 'reason': '页面未能识别'}]},
                                                  'errors': ['发票：2 份文件下载失败']}})
        messages = dm.status_messages(self.con)
        summary = [item for item in messages if item['level'] == 'ok' and '最近同步' in item['text']][0]['text']
        self.assertIn('发票 16 页', summary)
        self.assertIn('下载 1 份', summary)
        self.assertIn('物流更新 14/15 笔', summary)
        self.assertIn('1 笔待重试', summary)
        self.assertTrue(any(item['level'] == 'warn' and '下载失败' in item['text'] for item in messages))

    def test_outside_sync_window_pauses_auto_sync(self):
        moment = datetime.now(dm.TZ)
        start = (moment + timedelta(hours=2)).strftime('%H:%M')
        end = (moment + timedelta(hours=3)).strftime('%H:%M')
        self.con.execute('UPDATE sync_settings SET sync_windows=? WHERE id=1', (json.dumps([[start, end]]),))
        messages = dm.status_messages(self.con)
        self.assertTrue(any('不在同步时段' in item['text'] for item in messages))
        current = moment.strftime('%H') + ':00'
        later = (moment + timedelta(hours=2)).strftime('%H') + ':59'
        self.con.execute('UPDATE sync_settings SET sync_windows=? WHERE id=1', (json.dumps([[current, later]]),))
        messages = dm.status_messages(self.con)
        self.assertFalse(any('不在同步时段' in item['text'] for item in messages))


if __name__ == '__main__':
    unittest.main()
