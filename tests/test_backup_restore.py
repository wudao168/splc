import base64
import hashlib
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from server.db import connect
from server.backups import snapshot, restore
import test_http


class BackupTests(unittest.TestCase):
    def test_new_server_restore_with_attachments_and_safety_copy(self):
        with tempfile.TemporaryDirectory() as old, tempfile.TemporaryDirectory() as new:
            source, target = connect(old), connect(new)
            try:
                content = b'attachment-data'
                key = hashlib.sha256(content).hexdigest()
                (Path(old) / 'attachments' / key).write_bytes(content)
                source.execute('INSERT INTO attachments VALUES(?,?,?,?)', (key, 'test.txt', 'text/plain', '2026-10-06'))
                source.execute("UPDATE users SET display_name='迁移管理员' WHERE id=1")
                source.commit()
                archive = snapshot(source, old)
                result = restore(target, new, archive)
                self.assertEqual(target.execute('SELECT display_name FROM users WHERE id=1').fetchone()[0], '迁移管理员')
                self.assertEqual((Path(new) / 'attachments' / key).read_bytes(), content)
                self.assertTrue((Path(new) / 'backups' / result['safety_backup']).exists())
                self.assertEqual(target.execute('SELECT COUNT(*) FROM sessions').fetchone()[0], 0)
            finally:
                source.close(); target.close()

    def test_invalid_archive_preserves_current_database(self):
        with tempfile.TemporaryDirectory() as folder:
            con = connect(folder)
            try:
                original = snapshot(con, folder)
                for name, payload in [('../escape', b'bad'), ('attachments/' + 'a' * 64, b'bad')]:
                    out = io.BytesIO()
                    with zipfile.ZipFile(io.BytesIO(original)) as valid, zipfile.ZipFile(out, 'w') as bad:
                        bad.writestr('caidan.sqlite3', valid.read('caidan.sqlite3'))
                        bad.writestr(name, payload)
                    with self.assertRaises(ValueError):
                        restore(con, folder, out.getvalue())
                    self.assertEqual(con.execute('SELECT username FROM users WHERE id=1').fetchone()[0], 'admin')
                out = io.BytesIO()
                with zipfile.ZipFile(out, 'w') as bad:
                    bad.writestr('caidan.sqlite3', b'not a database')
                with self.assertRaises(ValueError):
                    restore(con, folder, out.getvalue())
            finally:
                con.close()


class BackupHttpTests(unittest.TestCase):
    setUp = test_http.HttpTests.setUp
    tearDown = test_http.HttpTests.tearDown
    post = test_http.HttpTests.post
    get = test_http.HttpTests.get

    def test_restore_confirmation_permissions_and_session_reset(self):
        with self.get('/api/backup') as response:
            content = base64.b64encode(response.read()).decode()
        self.assertEqual(self.post('/api/restore', {'content': content})[0], 400)
        status, result = self.post('/api/restore', {'content': content, 'confirmation': '恢复全部数据'})
        self.assertEqual(status, 200, result)
        with self.get('/api/auth/status') as response:
            self.assertIsNone(json.load(response)['user'])
        self.assertEqual(self.post('/api/restore', {'content':content, 'confirmation':'恢复全部数据'})[0], 401)

    def test_ordinary_user_cannot_backup_or_restore(self):
        import urllib.error
        self.assertEqual(self.post('/api/users', {'username':'operator', 'display_name':'操作员', 'password':'11111111'})[0], 200)
        con = connect(self.temp.name)
        try:
            from server.auth import issue_session
            uid = con.execute("SELECT id FROM users WHERE username='operator'").fetchone()[0]
            token = issue_session(con, uid)
            con.commit()
            self.cookie = 'caidan_session=' + token
        finally:
            con.close()
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.get('/api/backup')
        self.assertEqual(error.exception.code, 403)
        self.assertEqual(self.post('/api/restore', {'content':'', 'confirmation':'恢复全部数据'})[0], 403)
