import json
import hashlib
import hmac
import re
import secrets
from datetime import datetime, timedelta
from http.cookies import SimpleCookie

from . import domain as dm

SESSION_DAYS = 7
REMEMBER_DAYS = 365


def public_user(user):
    return {**{key: user[key] for key in ('id', 'username', 'display_name', 'theme')},
            'is_admin': user['id'] == 1, 'column_settings': column_settings(user)}


COLUMN_TABLES = ('orders', 'purchases', 'products', 'import_lines')


def column_settings(user):
    raw = user['column_settings'] if 'column_settings' in user.keys() else ''
    try:
        parsed = json.loads(raw) if raw else {}
    except ValueError:
        parsed = {}
    return parsed if isinstance(parsed, dict) else {}


def save_column_settings(con, user_id, data):
    table = dm.txt(data, 'table', True)
    dm.require(table in COLUMN_TABLES, '列设置对象无效')
    hidden = data.get('hidden', [])
    dm.require(isinstance(hidden, list) and len(hidden) <= 60, '列设置格式错误')
    keys = []
    for key in hidden:
        dm.require(isinstance(key, str) and re.fullmatch(r'[a-z_]{1,30}', key), '列设置格式错误')
        if key not in keys:
            keys.append(key)
    row = dm.row(con, 'SELECT column_settings FROM users WHERE id=?', (user_id,))
    try:
        settings = json.loads(row['column_settings']) if row['column_settings'] else {}
    except ValueError:
        settings = {}
    if not isinstance(settings, dict):
        settings = {}
    if keys:
        settings[table] = keys
    else:
        settings.pop(table, None)
    con.execute('UPDATE users SET column_settings=? WHERE id=?', (json.dumps(settings, ensure_ascii=False), user_id))
    dm.audit(con, '更新列设置', 'user', user_id, f'{table}: {",".join(keys) or "默认"}')
    return {'column_settings': settings}


def password_hash(password):
    dm.require(isinstance(password, str) and 8 <= len(password) <= 128, '密码须为 8 至 128 个字符')
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1)
    return salt.hex() + ':' + digest.hex()


def password_matches(password, stored):
    try:
        salt, digest = stored.split(':', 1)
        actual = hashlib.scrypt(str(password).encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1)
        return hmac.compare_digest(actual, bytes.fromhex(digest))
    except (ValueError, TypeError):
        return False


def create_user(con, data, first=False):
    username = dm.txt(data, 'username', True)
    dm.require(bool(re.fullmatch(r'[A-Za-z0-9_.-]{3,40}', username)), '账号须为 3 至 40 位字母、数字、点、下划线或短横线')
    display_name = dm.txt(data, 'display_name', True)
    dm.require(len(display_name) <= 80, '姓名不能超过 80 个字符')
    dm.require(not con.execute('SELECT 1 FROM users WHERE username=?', (username,)).fetchone(), '账号已存在')
    cur = con.execute('INSERT INTO users(username,display_name,password_hash,created_at) VALUES(?,?,?,?)',
                      (username, display_name, password_hash(data.get('password')), dm.now()))
    dm.audit(con, '创建首个账号' if first else '新增用户', 'user', cur.lastrowid, username)
    return cur.lastrowid


def issue_session(con, user_id, remember=False):
    token = secrets.token_urlsafe(32)
    expires = (datetime.now(dm.TZ) + timedelta(days=REMEMBER_DAYS if remember else SESSION_DAYS)).isoformat(timespec='seconds')
    con.execute('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)',
                (hashlib.sha256(token.encode()).hexdigest(), user_id, expires))
    return token


def session_token(headers):
    cookie = SimpleCookie()
    try:
        cookie.load(headers.get('Cookie', ''))
        return cookie['caidan_session'].value if 'caidan_session' in cookie else ''
    except Exception:
        return ''


def current_user(con, headers):
    token = session_token(headers)
    if not token:
        return None
    row = con.execute('''SELECT u.id,u.username,u.display_name,u.theme,u.column_settings FROM sessions s JOIN users u ON u.id=s.user_id
                         WHERE s.token_hash=? AND s.expires_at>? AND u.active=1''',
                      (hashlib.sha256(token.encode()).hexdigest(), dm.now())).fetchone()
    return public_user(row) if row else None


def login(con, data, remember=False):
    user = con.execute('SELECT * FROM users WHERE username=? AND active=1', (dm.txt(data, 'username'),)).fetchone()
    if not user or not password_matches(data.get('password'), user['password_hash']):
        raise ValueError('账号或密码错误')
    con.execute('UPDATE users SET last_login=? WHERE id=?', (dm.now(), user['id']))
    token = issue_session(con, user['id'], remember)
    previous = dm.actor_id.set(user['id'])
    try:
        dm.audit(con, '登录', 'user', user['id'])
    finally:
        dm.actor_id.reset(previous)
    return token, public_user(user)


def logout(con, headers, user):
    token = session_token(headers)
    if token:
        con.execute('DELETE FROM sessions WHERE token_hash=?', (hashlib.sha256(token.encode()).hexdigest(),))
    if user:
        dm.audit(con, '退出登录', 'user', user['id'])


def update_user(con, user_id, data):
    user = dm.row(con, 'SELECT id,username,display_name,active FROM users WHERE id=?', (user_id,))
    if 'password' in data and data['password']:
        con.execute('UPDATE users SET password_hash=? WHERE id=?', (password_hash(data['password']), user_id))
        con.execute('DELETE FROM sessions WHERE user_id=?', (user_id,))
        dm.audit(con, '重置用户密码', 'user', user_id, user['username'])
    if 'active' in data:
        active = 1 if data['active'] else 0
        if not active:
            count = con.execute('SELECT COUNT(*) FROM users WHERE active=1').fetchone()[0]
            dm.require(not user['active'] or count > 1, '至少保留一个启用的账号')
            con.execute('DELETE FROM sessions WHERE user_id=?', (user_id,))
        con.execute('UPDATE users SET active=? WHERE id=?', (active, user_id))
        dm.audit(con, '启用用户' if active else '停用用户', 'user', user_id, user['username'])
    return {'id': user_id}


def update_theme(con, user_id, data):
    theme = dm.txt(data, 'theme', True)
    dm.require(theme in ('a', 'c', 'o'), '主题无效')
    con.execute('UPDATE users SET theme=? WHERE id=?', (theme, user_id))
    dm.audit(con, '切换主题', 'user', user_id, theme)
    return {'theme': theme}


COMPANY_FIELDS = ('name', 'name_en', 'address', 'phone', 'bank_name', 'bank_account', 'tax_number', 'email', 'company_code')
COMPANY_CODE_PATTERN = re.compile(r'[A-Za-z]{0,6}')


def company_values(data):
    values = [dm.txt(data, key) for key in COMPANY_FIELDS]
    dm.require(len(values[0]) <= 200 and all(len(value) <= 500 for value in values[1:]), '公司信息过长')
    profile = dict(zip(COMPANY_FIELDS, values))
    dm.require(COMPANY_CODE_PATTERN.fullmatch(profile['company_code']) is not None, '公司代码请使用 1 至 6 个英文字母')
    profile['company_code'] = profile['company_code'].upper()
    return profile


def save_company(con, data):
    current = dict(con.execute('SELECT * FROM company_profile WHERE id=1').fetchone() or {})
    profile = company_values({**current, **data})
    values = [profile[key] for key in COMPANY_FIELDS]
    con.execute('''INSERT INTO company_profile(id,name,name_en,address,phone,bank_name,bank_account,tax_number,email,company_code)
                   VALUES(1,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                   name=excluded.name,name_en=excluded.name_en,address=excluded.address,phone=excluded.phone,
                   bank_name=excluded.bank_name,bank_account=excluded.bank_account,tax_number=excluded.tax_number,email=excluded.email,
                   company_code=excluded.company_code''', values)
    dm.audit(con, '修改公司信息', 'company', 1, values[0])
    return profile


def save_company_stamp(con, data, folder):
    kind = dm.txt(data, 'kind', True)
    dm.require(kind in ('contract', 'delivery'), '印章类型无效')
    attachment_id = dm.txt(data, 'attachment_id')
    if attachment_id:
        attachment = dm.row(con, 'SELECT * FROM attachments WHERE id=?', (attachment_id,))
        dm.require(attachment['mime'] in ('image/png', 'image/jpeg', 'image/webp'), '印章请使用 PNG、JPG 或 WebP 图片')
        from PIL import Image, UnidentifiedImageError
        try:
            with Image.open(folder / 'attachments' / attachment_id) as image:
                dm.require(image.format in ('PNG', 'JPEG', 'WEBP'), '印章图片格式无效')
                image.verify()
        except (UnidentifiedImageError, OSError) as ex:
            raise ValueError('印章图片无法读取，请重新上传') from ex
        con.execute('INSERT INTO company_stamps(kind,attachment_id) VALUES(?,?) ON CONFLICT(kind) DO UPDATE SET attachment_id=excluded.attachment_id', (kind, attachment_id))
    else:
        con.execute('DELETE FROM company_stamps WHERE kind=?', (kind,))
    dm.audit(con, '维护合同章' if kind == 'contract' else '维护发货章', 'company', 1, '保存印章' if attachment_id else '移除印章')
    return {'kind': kind, 'attachment_id': attachment_id}
