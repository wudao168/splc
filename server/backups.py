"""Full database/attachment snapshots and validated, serialized restores."""
import hashlib
import io
import re
import sqlite3
import tempfile
import uuid
import zipfile
from pathlib import Path

from .domain import require

MAX_ARCHIVE = 100 * 1024 * 1024
MAX_EXPANDED = 512 * 1024 * 1024


def snapshot(con, data):
    target = sqlite3.connect(':memory:')
    try:
        con.backup(target)
        blob = target.serialize()
    finally:
        target.close()
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('caidan.sqlite3', blob)
        for item in con.execute('SELECT id FROM attachments'):
            name = item[0]
            require(bool(re.fullmatch('[a-f0-9]{64}', name)), '附件标识无效')
            file = Path(data) / 'attachments' / name
            require(file.is_file(), f'附件缺失，无法创建完整备份：{name}')
            archive.write(file, 'attachments/' + name)
    return out.getvalue()


def schema(con):
    return sorted(tuple(row) for row in con.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"))


def restore(con, data, content):
    require(len(content) <= MAX_ARCHIVE, '备份文件不能超过 100 MB')
    data = Path(data)
    try:
        archive = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile:
        raise ValueError('不是有效的 ZIP 备份文件')
    with archive, tempfile.TemporaryDirectory(prefix='restore-', dir=data) as folder:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        require(len(names) == len(set(names)) and len(names) <= 100000, '备份包含重复或过多文件')
        require('caidan.sqlite3' in names, '备份缺少数据库')
        require(all(name == 'caidan.sqlite3' or re.fullmatch(r'attachments/[a-f0-9]{64}', name) for name in names), '备份包含不允许的文件路径')
        require(sum(entry.file_size for entry in entries) <= MAX_EXPANDED, '备份解压后不能超过 512 MB')
        try:
            for name in names:
                file = Path(folder) / name
                file.parent.mkdir(exist_ok=True)
                payload = archive.read(name)
                if name.startswith('attachments/'):
                    require(hashlib.sha256(payload).hexdigest() == name.split('/')[1], '备份附件校验失败')
                file.write_bytes(payload)
        except (zipfile.BadZipFile, RuntimeError):
            raise ValueError('备份损坏或已加密，无法恢复')
        source = sqlite3.connect(Path(folder) / 'caidan.sqlite3')
        try:
            source.execute('PRAGMA trusted_schema=OFF')
            require(schema(source) == schema(con), '备份数据库版本不兼容，请使用生成备份时的系统版本恢复')
            require(source.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', '备份数据库完整性检查失败')
            require(not source.execute('PRAGMA foreign_key_check').fetchall(), '备份数据库关联数据损坏')
            require(source.execute('SELECT 1 FROM users WHERE id=1 AND active=1').fetchone(), '备份缺少有效管理员账号')
            for item in source.execute('SELECT id FROM attachments'):
                require('attachments/' + item[0] in names, '备份缺少数据库引用的附件')
            # Sessions are device-specific and must not survive a restore.
            source.execute('DELETE FROM sessions')
            source.commit()
            backup_dir = data / 'backups'
            backup_dir.mkdir(exist_ok=True)
            backup_name = 'before-restore-' + uuid.uuid4().hex + '.zip'
            (backup_dir / backup_name).write_bytes(snapshot(con, data))
            # Content-addressed files can be copied first without changing live records.
            for file in (Path(folder) / 'attachments').glob('*'):
                destination = data / 'attachments' / file.name
                if destination.exists():
                    require(hashlib.sha256(destination.read_bytes()).hexdigest() == file.name, '现有附件损坏，请先处理后再恢复')
                else:
                    temporary = destination.with_suffix('.restore')
                    temporary.write_bytes(file.read_bytes())
                    temporary.replace(destination)
            # SQLite backup replaces the database in one transaction; do not replace WAL files.
            source.backup(con)
            return {'ok': True, 'safety_backup': backup_name, 'login_required': True}
        except sqlite3.DatabaseError:
            raise ValueError('备份数据库损坏，无法恢复')
        finally:
            source.close()
