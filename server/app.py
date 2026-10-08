import argparse
import base64
import hashlib
import ipaddress
import json
import mimetypes
import os
import re
import sqlite3
import socket
import traceback
import hmac
import threading
from functools import wraps
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, unquote, quote

from .db import ROOT, DATA, connect
from . import domain as dm
from .importer import parse_file, parse_paste
from .exports import delivery_data, xlsx_delivery, pdf_delivery, html_delivery, xlsx_billing, pdf_billing, CUSTOMER_BILLING_FIELDS, quote_data, xlsx_quote, pdf_quote
from . import auth
from . import backups

data_lock = threading.RLock()


def serialized_data(fn):
    @wraps(fn)
    def wrapped(self):
        with data_lock:
            return fn(self)
    return wrapped

MAX_BODY = 30 * 1024 * 1024
MAX_IMPORT_FILE = 100 * 1024 * 1024
# JSON carries the file as base64, plus its name and other request metadata.
MAX_IMPORT_BODY = ((MAX_IMPORT_FILE + 2) // 3) * 4 + 1024 * 1024


def host_only(value):
    value = (value or '').strip().lower().rstrip('.')
    if value.startswith('['):  # IPv6 literal such as [::1]:8765
        return value[1:value.find(']')] if ']' in value else value
    return value.rsplit(':', 1)[0] if ':' in value else value


def allowed_hosts():
    """Names this server answers to; anything else is rejected to stop DNS rebinding."""
    names = {'127.0.0.1', 'localhost', '::1'}
    try:
        names.add(socket.gethostname().lower())
        for info in socket.getaddrinfo(socket.gethostname(), None):
            names.add(str(info[4][0]).lower())
    except OSError:
        pass
    for extra in (os.environ.get('CAIDAN_ALLOWED_HOSTS') or '').split(','):
        extra = extra.strip().lower().rstrip('.')
        if extra:
            names.add(extra)
    return frozenset(names)


ALLOWED_HOSTS = allowed_hosts()


def host_allowed(value):
    """Accept configured names and any literal public IP address.

    A literal public address cannot come from DNS rebinding, so it needs no
    configuration; names outside the allowlist are still rejected.
    """
    host = host_only(value)
    if host in ALLOWED_HOSTS:
        return True
    try:
        return ipaddress.ip_address(host).is_global
    except ValueError:
        return False


class Handler(BaseHTTPRequestHandler):
    def respond(self, status, body, mime='application/json; charset=utf-8', filename=None, cookie=None, remember=False):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cache-Control', 'no-store' if self.path.startswith('/api') else 'no-cache')
        if cookie is not None:
            age = f'; Max-Age={auth.REMEMBER_DAYS * 86400}' if cookie and remember else '; Max-Age=0' if not cookie else ''
            self.send_header('Set-Cookie', f'caidan_session={cookie}; HttpOnly; SameSite=Strict; Path=/{age}')
        if filename:
            self.send_header('Content-Disposition', "attachment; filename*=UTF-8''" + quote(filename))
        self.end_headers()
        self.wfile.write(body)

    def valid_host(self):
        if not host_allowed(self.headers.get('Host', '')):
            self.respond(403, {'error': '仅允许本机访问'})
            return False
        return True

    def internal_request(self, path):
        token = os.environ.get('CAIDAN_INTERNAL_TOKEN', '')
        allowed = path in ('/api/sync-now/start','/api/sync-now/heartbeat','/api/sync-now/finish','/api/purchase-drafts/sync-state', '/api/purchase-drafts/sync-result', '/api/purchase-drafts', '/api/sync-settings', '/api/state', '/api/taobao/invoices', '/api/attachments', '/api/invoice-apply/pending') or re.fullmatch(r'/api/(?:purchases/\d+/taobao(?:-sync-failed)?|invoice-apply/\d+/result)', path)
        return bool(token and allowed and hmac.compare_digest(self.headers.get('X-Caidan-Internal', ''), token))

    @serialized_data
    def do_GET(self):
        if not self.valid_host():
            return
        con = connect()
        try:
            path = unquote(urlparse(self.path).path)
            if path == '/api/auth/status':
                return self.respond(200, {'setup_required': not con.execute('SELECT 1 FROM users').fetchone(),
                                          'user': auth.current_user(con, self.headers)})
            if path.startswith('/api/') and path != '/api/health' and not (
                    auth.current_user(con, self.headers) or self.internal_request(path)):
                return self.respond(401, {'error': '请先登录'})
            if path == '/api/purchase-drafts/sync-state':
                from . import purchase_drafts
                result = purchase_drafts.sync_state(con)
                con.commit()
                return self.respond(200, result)
            if path == '/api/sync-settings':
                return self.respond(200, dm.get_sync_settings(con))
            if path == '/api/invoice-apply/pending':
                return self.respond(200, {'requests': dm.pending_invoice_applies(con)})
            if path in ('/api/reports', '/api/reports.xlsx'):
                from . import reports
                from urllib.parse import parse_qs, urlsplit
                report = reports.build(con, {k:v[0] for k,v in parse_qs(urlsplit(self.path).query).items()})
                if path.endswith('.xlsx'):
                    return self.respond(200, reports.xlsx(report), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', report['title']+'.xlsx')
                return self.respond(200, report)
            if path == '/api/state':
                return self.respond(200, dm.get_state(con))
            if path == '/api/health':
                return self.respond(200, {'ok': True, 'version': '0.1.0', 'mode': 'local'})
            if path == '/api/backup':
                if not auth.current_user(con, self.headers).get('is_admin'):
                    return self.respond(403, {'error': '仅管理员可以备份数据'})
                return self.respond(200, backups.snapshot(con, DATA), 'application/zip', f'采单备份-{dm.today()}.zip')
            match = re.fullmatch('/api/files/([a-f0-9]{64})', path)
            if match:
                f = dm.row(con, 'SELECT * FROM attachments WHERE id=?', (match[1],))
                preview = f['mime'] in ['application/pdf', 'image/png', 'image/jpeg', 'image/webp']
                return self.respond(200, (DATA / 'attachments' / f['id']).read_bytes(), f['mime'], None if preview else f['name'])
            match = re.fullmatch(r'/api/orders/(\d+)/quote/(xlsx|pdf)', path)
            if match:
                d = quote_data(con, int(match[1]))
                user = auth.current_user(con, self.headers)
                d['quoted_by'] = user['display_name'] or user['username']
                extension = match[2]
                content = xlsx_quote(d) if extension == 'xlsx' else pdf_quote(d)
                mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' if extension == 'xlsx' else 'application/pdf'
                return self.respond(200, content, mime, f"{d['po']}-报价V{d['version']}.{extension}")
            match = re.fullmatch(r'/api/deliveries/(\d+)/(xlsx|pdf|print)', path)
            if match:
                d = delivery_data(con, int(match[1]))
                if match[2] == 'xlsx':
                    return self.respond(200, xlsx_delivery(d), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', d['number'] + '.xlsx')
                if match[2] == 'pdf':
                    return self.respond(200, pdf_delivery(d), 'application/pdf', d['number'] + '.pdf')
                return self.respond(200, html_delivery(d), 'text/html; charset=utf-8')
            if path.startswith('/api/'):
                return self.respond(404, {'error': '接口不存在'})
            dist = (ROOT / 'dist').resolve()
            file = (dist / path.lstrip('/')).resolve()
            if not file.is_relative_to(dist):
                return self.respond(403, {'error': '路径无效'})
            if not file.is_file():
                file = dist / 'index.html'
            if not file.exists():
                return self.respond(503, {'error': '请先运行 npm run build，或使用 Vite 开发服务'})
            mime = mimetypes.guess_type(file.name)[0] or 'application/octet-stream'
            if file.suffix == '.js':
                mime = 'text/javascript'
            self.respond(200, file.read_bytes(), mime)
        except (ValueError, FileNotFoundError) as ex:
            self.respond(404, {'error': str(ex)})
        except Exception:
            traceback.print_exc()
            self.respond(500, {'error': '读取失败，请查看服务日志'})
        finally:
            con.close()

    @serialized_data
    def do_POST(self):
        if not self.valid_host():
            return
        origin = self.headers.get('Origin')
        if origin and not host_allowed(urlparse(origin).hostname):
            return self.respond(403, {'error': '来源不受信任'})
        if 'application/json' not in self.headers.get('Content-Type', ''):
            return self.respond(415, {'error': '仅接受 JSON 请求'})
        con = connect()
        try:
            path = urlparse(self.path).path
            size = int(self.headers.get('Content-Length', 0))
            body_limit = MAX_IMPORT_BODY if path in ('/api/imports', '/api/restore') else MAX_BODY
            file_limit_mb = 100 if path == '/api/imports' else 20
            dm.require(0 < size <= body_limit, f'请求过大或为空，单文件最大 {file_limit_mb} MB')
            d = json.loads(self.rfile.read(size))
            dm.require(isinstance(d, dict), '请求格式错误')
            user = auth.current_user(con, self.headers)
            if path == '/api/auth/setup':
                con.execute('BEGIN IMMEDIATE')
                dm.require(not con.execute('SELECT 1 FROM users').fetchone(), '首个账号已创建，请登录')
                uid = auth.create_user(con, d, True)
                remember = d.get('remember') is True
                token = auth.issue_session(con, uid, remember)
                result = auth.public_user(dm.row(con, 'SELECT * FROM users WHERE id=?', (uid,)))
                con.commit()
                return self.respond(200, {'user': result}, cookie=token, remember=remember)
            if path == '/api/auth/login':
                con.execute('BEGIN IMMEDIATE')
                remember = d.get('remember') is True
                token, result = auth.login(con, d, remember)
                con.commit()
                return self.respond(200, {'user': result}, cookie=token, remember=remember)
            if not user and not self.internal_request(path):
                return self.respond(401, {'error': '请先登录'})
            if path == '/api/restore':
                if not user or not user.get('is_admin'):
                    return self.respond(403, {'error': '仅管理员可以恢复数据'})
                dm.require(d.get('confirmation') == '恢复全部数据', '请确认替换当前全部业务数据')
                try:
                    content = base64.b64decode(d.get('content', ''), validate=True)
                except (ValueError, TypeError):
                    raise ValueError('备份文件编码错误')
                result = backups.restore(con, DATA, content)
                return self.respond(200, result, cookie='')
            match = re.fullmatch(r'/api/customers/(\d+)/invoice-info/(pdf|xlsx)', path)
            if match:
                dm.row(con, 'SELECT id FROM customers WHERE id=?', (int(match[1]),))
                profile = dm.customer_invoice_values(d)
                dm.require(profile.get('title'), '请填写发票抬头')
                if match[2] == 'pdf':
                    return self.respond(200, pdf_billing(profile, CUSTOMER_BILLING_FIELDS, '客户开票信息'), 'application/pdf', '客户开票信息.pdf')
                return self.respond(200, xlsx_billing(profile, CUSTOMER_BILLING_FIELDS, '客户开票信息'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '客户开票信息.xlsx')
            match = re.fullmatch(r'/api/company/billing/(pdf|xlsx)', path)
            if match:
                profile = auth.company_values(d)
                dm.require(profile['name'], '请填写公司名称')
                if match[1] == 'pdf':
                    return self.respond(200, pdf_billing(profile), 'application/pdf', '开票付款资料.pdf')
                return self.respond(200, xlsx_billing(profile), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '开票付款资料.xlsx')
            con.execute('BEGIN IMMEDIATE')
            actor = dm.actor_id.set(user['id'] if user else None)
            try:
                if path == '/api/auth/logout':
                    auth.logout(con, self.headers, user)
                    con.commit()
                    return self.respond(200, {'ok': True}, cookie='')
                result = self.mutate(con, path, d)
            finally:
                dm.actor_id.reset(actor)
            con.commit()
            self.respond(200, result)
        except (ValueError, KeyError, TypeError, sqlite3.IntegrityError) as ex:
            con.rollback()
            self.respond(400, {'error': str(ex) if not isinstance(ex, sqlite3.IntegrityError) else '记录重复或关联数据不存在，请刷新后核对'})
        except Exception:
            con.rollback()
            traceback.print_exc()
            self.respond(500, {'error': '保存失败，未提交本次数据；请查看服务日志'})
        finally:
            con.close()

    def mutate(self, con, path, d):
        from . import inventory, lifecycle, purchase_drafts
        from . import sales_invoices
        result = sales_invoices.dispatch(con, path, d)
        if result is not None:
            return result
        if path == '/api/sync-now':
            return dm.request_sync(con)
        if path in ('/api/sync-now/start','/api/sync-now/heartbeat','/api/sync-now/finish'):
            dm.require(self.internal_request(path), '仅允许客户端执行同步任务')
            return dm.update_sync_request(con, path.rsplit('/',1)[1], d)
        match = re.fullmatch(r'/api/invoice-apply/(\d+)/result', path)
        if match:
            dm.require(self.internal_request(path), '仅允许客户端回传申请开票结果')
            return dm.finish_invoice_apply(con, int(match[1]), d)
        if path == '/api/purchase-drafts/manual':
            from . import purchase_drafts
            return purchase_drafts.save(con, d, manual=True)
        if path == '/api/purchase-drafts':
            return purchase_drafts.save(con, d)
        if path in ('/api/purchase-drafts/delete', '/api/purchase-drafts/restore', '/api/purchase-drafts/clear'):
            return purchase_drafts.trash(con, path.rsplit('/', 1)[1], d)
        if path == '/api/purchase-drafts/sync-result':
            return purchase_drafts.finish(con, d)
        result = inventory.dispatch(con, path, d)
        if result is not None:
            return result
        result = lifecycle.dispatch(con, path, d)
        if result is not None:
            return result
        if path == '/api/users/me/theme':
            return auth.update_theme(con, dm.actor_id.get(), d)
        if path == '/api/users/me/columns':
            return auth.save_column_settings(con, dm.actor_id.get(), d)
        if path == '/api/users':
            return {'id': auth.create_user(con, d)}
        match = re.fullmatch(r'/api/users/(\d+)', path)
        if match:
            return auth.update_user(con, int(match[1]), d)
        if path == '/api/delivery-sender':
            return dm.save_delivery_sender(con, d)
        if path == '/api/tax-settings':
            return dm.save_tax_settings(con, d)
        if path == '/api/sync-settings':
            return dm.save_sync_settings(con, d)
        if path == '/api/company':
            dm.require(dm.actor_id.get() == 1, '仅管理员可以维护公司开票信息')
            return auth.save_company(con, d)
        if path == '/api/company/stamps':
            return auth.save_company_stamp(con, d, DATA)
        if path == '/api/activity':
            route = dm.txt(d, 'route', True)
            dm.require(route in ('dashboard', 'import', 'orders', 'customers', 'products', 'purchases', 'inventory', 'settings', 'sales-invoices'), '页面无效')
            dm.audit(con, '访问页面', 'page', route)
            return {'ok': True}
        if path in ['/api/attachments', '/api/imports']:
            name = Path(dm.txt(d, 'name', True)).name
            raw = base64.b64decode(d['content'], validate=True)
            file_limit = MAX_IMPORT_FILE if path == '/api/imports' else 20 * 1024 * 1024
            dm.require(0 < len(raw) <= file_limit, f'文件必须非空且不能超过 {file_limit // (1024 * 1024)} MB')
            ext = Path(name).suffix.lower()
            dm.require(ext in ['.xlsx', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.ofd'], '不支持此附件类型')
            aid = hashlib.sha256(raw).hexdigest()
            old = con.execute('SELECT 1 FROM attachments WHERE id=?', (aid,)).fetchone()
            mime = mimetypes.guess_type(name)[0] or 'application/octet-stream'
            if not old:
                (DATA / 'attachments' / aid).write_bytes(raw)
                con.execute('INSERT INTO attachments VALUES(?,?,?,?)', (aid, name, mime, dm.now()))
            if path == '/api/attachments':
                return {'id': aid, 'name': name, 'duplicate': bool(old)}
            parsed = parse_file(raw, name)
            con.execute('INSERT INTO imports(attachment_id,warnings,created_at) VALUES(?,?,?)', (aid, json.dumps(parsed['warnings'], ensure_ascii=False), dm.now()))
            existing_orders = dm.rows(con, 'SELECT id,customer,po FROM orders WHERE source_id=? ORDER BY id', (aid,))
            return {**parsed, 'source_id': aid, 'filename': name, 'duplicate': bool(existing_orders), 'existing_orders': existing_orders}
        if path == '/api/parse-text':
            return parse_paste(dm.txt(d, 'text', True), d.get('kind', 'purchase'))
        if path == '/api/intake-drafts':
            return dm.save_intake_draft(con, d)
        match = re.fullmatch(r'/api/intake-drafts/(\d+)', path)
        if match:
            return dm.save_intake_draft(con, d, int(match[1]))
        match = re.fullmatch(r'/api/intake-drafts/(\d+)/delete', path)
        if match:
            return dm.delete_intake_draft(con, int(match[1]))
        if path == '/api/orders/delete':
            return dm.delete_order_items(con, d.get('items'))
        if path == '/api/purchases/delete':
            return dm.delete_purchases(con, d.get('ids'))
        match = re.fullmatch(r'/api/orders/(\d+)/cancel', path)
        if match:
            return dm.cancel_order(con, int(match[1]), d)
        match = re.fullmatch(r'/api/purchase-lines/(\d+)/cancellation-resolution', path)
        if match:
            return dm.resolve_cancelled_purchase_line(con, int(match[1]), d)
        if path == '/api/orders':
            return dm.create_order(con, d)
        if path == '/api/orders/next-po':
            return dm.suggest_order_po(con, d)
        if path == '/api/customers':
            return dm.save_customer(con, d)
        match = re.fullmatch(r'/api/customers/(\d+)/invoice-info', path)
        if match:
            return dm.save_customer_invoice(con, int(match[1]), d)
        match = re.fullmatch(r'/api/customers/(\d+)/delete', path)
        if match:
            return dm.delete_customer(con, int(match[1]))
        match = re.fullmatch(r'/api/customers/(\d+)', path)
        if match:
            return dm.save_customer(con, d, int(match[1]))
        if path == '/api/purchases':
            return dm.create_purchase(con, d)
        match = re.fullmatch(r'/api/purchases/(\d+)/associations', path)
        if match:
            return dm.update_purchase_associations(con, int(match[1]), d)
        match = re.fullmatch(r'/api/purchases/(\d+)/attachments', path)
        if match:
            return dm.add_purchase_attachments(con, int(match[1]), d)
        match = re.fullmatch(r'/api/purchases/(\d+)/attachments/remove', path)
        if match:
            return dm.remove_purchase_attachment(con, int(match[1]), d)
        if path == '/api/taobao/invoices':
            return dm.save_taobao_invoice_snapshot(con, d)
        if path == '/api/packages':
            return dm.create_package(con, d)
        match = re.fullmatch(r'/api/purchases/(\d+)/taobao', path)
        if match:
            return dm.save_taobao_source(con, int(match[1]), d)
        match = re.fullmatch(r'/api/purchases/(\d+)/taobao-sync-failed', path)
        if match:
            return dm.taobao_sync_failed(con, int(match[1]))
        if path == '/api/invoices':
            return dm.create_invoice(con, d)
        if path == '/api/deliveries':
            return dm.create_deliveries(con, d)
        match = re.fullmatch(r'/api/orders/(\d+)/(quote|confirm|revise|edit|adjust)', path)
        if match:
            oid = int(match[1])
            if match[2] == 'adjust':
                return dm.adjust_order_lines(con, oid, d)
            if match[2] == 'edit':
                return dm.edit_order(con, oid, d)
            return dm.update_quote(con, oid, d) if match[2] == 'quote' else (dm.confirm_quote(con, oid) if match[2] == 'confirm' else dm.revise_quote(con, oid))
        match = re.fullmatch(r'/api/packages/(\d+)/tracking', path)
        if match:
            return dm.update_tracking(con, int(match[1]), d)
        match = re.fullmatch(r'/api/purchases/(\d+)/invoice-followup', path)
        if match:
            return dm.follow_invoice(con, int(match[1]), d)
        match = re.fullmatch(r'/api/purchases/(\d+)/invoice-remind', path)
        if match:
            return dm.remind_invoice(con, int(match[1]), d)
        match = re.fullmatch(r'/api/purchases/(\d+)/apply-invoice', path)
        if match:
            return dm.queue_invoice_apply(con, int(match[1]), d)
        match = re.fullmatch(r'/api/deliveries/(\d+)/void', path)
        if match:
            return dm.void_delivery(con, int(match[1]))
        match = re.fullmatch(r'/api/deliveries/(\d+)/edit', path)
        if match:
            return dm.edit_delivery(con, int(match[1]), d)
        raise ValueError('操作接口不存在')


class LocalHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = False

    def server_bind(self):
        if os.name == 'nt':
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--host', default='127.0.0.1', help='监听地址，局域网访问使用 0.0.0.0')
    args = parser.parse_args()
    connect().close()
    server = LocalHTTPServer((args.host, args.port), Handler)
    print(f'Caidan running at http://127.0.0.1:{server.server_port}', flush=True)
    if args.host not in ('127.0.0.1', 'localhost'):
        for name in sorted(ALLOWED_HOSTS):
            if name in ('127.0.0.1', 'localhost', '::1') or ':' in name:
                continue
            print(f'Caidan LAN access: http://{name}:{server.server_port}', flush=True)
        print('局域网设备请使用上面的地址；主机防火墙需放行该端口，且只在可信网络使用。', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()

