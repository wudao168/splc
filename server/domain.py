import json
from . import lifecycle as lc
import re
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone, date
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from math import isfinite

TZ = timezone(timedelta(hours=8))
actor_id = ContextVar('actor_id', default=None)


def now():
    return datetime.now(TZ).isoformat(timespec='seconds')


def today():
    return datetime.now(TZ).date().isoformat()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def txt(data, key, required=False):
    value = str(data.get(key, '') or '').strip()
    require(not required or bool(value), f'{key} 不能为空')
    require(len(value) <= 5000, f'{key} 过长')
    return value


def money(value):
    try:
        n = Decimal(str(value or 0))
        require(n.is_finite() and 0 <= n <= Decimal('1000000000'), '金额必须在 0 至 10 亿之间')
        return int((n * 100).quantize(Decimal('1'), rounding=ROUND_HALF_UP))
    except InvalidOperation:
        raise ValueError('金额格式错误')


def qty(value):
    try:
        n = float(value)
    except (TypeError, ValueError):
        raise ValueError('数量必须是有效数字')
    require(isfinite(n) and 0 < n <= 1e9, '数量必须大于零且不超过 10 亿')
    require(abs(n - round(n, 6)) < 1e-9, '数量最多支持 6 位小数')
    return round(n, 6)


def valid_date(value, required=False):
    value = str(value or '').strip()
    require(not required or bool(value), '日期不能为空')
    if value:
        try:
            date.fromisoformat(value)
        except ValueError:
            raise ValueError('日期格式应为 YYYY-MM-DD')
    return value


def row(con, sql, params=()):
    r = con.execute(sql, params).fetchone()
    require(r is not None, '记录不存在或已改变，请刷新后重试')
    return dict(r)


def rows(con, sql, params=()):
    return [dict(x) for x in con.execute(sql, params)]


def audit(con, action, entity, entity_id, detail=''):
    con.execute('INSERT INTO audit(action,entity,entity_id,detail,created_at,user_id) VALUES(?,?,?,?,?,?)',
                (action, entity, str(entity_id), detail, now(), actor_id.get()))


def unique_ids(items, key):
    require(bool(items), '至少选择一条明细')
    ids = [int(x[key]) for x in items]
    require(len(ids) == len(set(ids)), '同一明细不能重复添加')


def save_customer(con, d, cid=None):
    name = txt(d, 'name', True)
    require(not con.execute('SELECT 1 FROM customers WHERE name=? AND id<>?', (name, cid or 0)).fetchone(), '客户名称已存在')
    contacts = [(txt(x, 'name', True), txt(x, 'phone')) for x in d.get('contacts', [])]
    addresses = [(txt(x, 'address', True), txt(x, 'contact'), txt(x, 'phone')) for x in d.get('addresses', [])]
    require(len(contacts) == len(set(contacts)), '联系人和电话重复')
    require(len(addresses) == len(set(addresses)), '收货地址及收货联系人重复')
    if cid:
        row(con, 'SELECT id FROM customers WHERE id=?', (cid,))
        con.execute('UPDATE customers SET name=?,note=? WHERE id=?', (name, txt(d, 'note'), cid))
        con.execute('DELETE FROM customer_contacts WHERE customer_id=?', (cid,))
        con.execute('DELETE FROM customer_addresses WHERE customer_id=?', (cid,))
    else:
        cid = con.execute('INSERT INTO customers(name,note,created_at) VALUES(?,?,?)', (name, txt(d, 'note'), now())).lastrowid
    con.executemany('INSERT INTO customer_contacts(customer_id,name,phone) VALUES(?,?,?)', [(cid, *x) for x in contacts])
    con.executemany('INSERT INTO customer_addresses(customer_id,address,contact,phone) VALUES(?,?,?,?)', [(cid, *x) for x in addresses])
    audit(con, '保存客户资料', 'customer', cid, name)
    return {'id': cid}


def delete_customer(con, cid):
    """管理员删除客户资料：联系人与地址一并删除，历史订单保留客户名称、仅解除资料关联。"""
    require(actor_id.get() == 1, '仅管理员可以删除客户')
    customer = row(con, 'SELECT * FROM customers WHERE id=?', (cid,))
    linked = con.execute('SELECT COUNT(*) FROM orders WHERE customer_id=?', (cid,)).fetchone()[0]
    con.execute('DELETE FROM customer_contacts WHERE customer_id=?', (cid,))
    con.execute('DELETE FROM customer_addresses WHERE customer_id=?', (cid,))
    con.execute('UPDATE orders SET customer_id=NULL WHERE customer_id=?', (cid,))
    con.execute('DELETE FROM customers WHERE id=?', (cid,))
    audit(con, '删除客户', 'customer', cid, f"{customer['name']}（关联订单 {linked} 笔，订单保留原客户名称）")
    return {'id': cid, 'orders': linked}


def customer_invoice_values(d):
    fields = ('title', 'tax_number', 'address', 'phone', 'bank_name', 'bank_account', 'email')
    require(all(isinstance(d.get(key, ''), str) for key in fields), '开票信息格式错误')
    info = {key: txt(d, key) for key in fields}
    require(not any(info.values()) or info['title'], '请填写发票抬头')
    if not any(info.values()):
        info = {}
    return info


def save_customer_invoice(con, cid, d):
    row(con, 'SELECT id FROM customers WHERE id=?', (cid,))
    info = customer_invoice_values(d)
    con.execute('UPDATE customers SET invoice_info=? WHERE id=?', (json.dumps(info, ensure_ascii=False), cid))
    audit(con, '保存客户开票信息', 'customer', cid)
    return {'id': cid}


def customer_snapshot(con, d):
    # Legacy orders remain editable; new selector-based requests are validated against the directory.
    if 'customer_id' not in d:
        return d
    require(bool(d['customer_id']), '请选择客户列表中的客户')
    customer = row(con, 'SELECT * FROM customers WHERE id=?', (d['customer_id'],))
    contact, phone = txt(d, 'contact'), txt(d, 'phone')
    if contact or phone:
        require(con.execute('SELECT 1 FROM customer_contacts WHERE customer_id=? AND name=? AND phone=?',
            (customer['id'], contact, phone)).fetchone() or con.execute(
            'SELECT 1 FROM customer_addresses WHERE customer_id=? AND contact=? AND phone=?',
            (customer['id'], contact, phone)).fetchone(), '联系人资料已改变，请重新选择联系人')
    return {**d, 'customer': customer['name']}


def save_intake_draft(con, d, draft_id=None):
    payload = d.get('payload')
    require(isinstance(payload, dict), '草稿内容格式错误')
    require(isinstance(payload.get('form'), dict) and isinstance(payload.get('lines'), list), '草稿内容格式错误')
    encoded = json.dumps(payload, ensure_ascii=False)
    require(len(encoded.encode('utf-8')) <= 2 * 1024 * 1024, '草稿内容过大')
    if draft_id:
        row(con, "SELECT id FROM intake_drafts WHERE id=? AND status='active'", (draft_id,))
        con.execute('UPDATE intake_drafts SET payload=?,updated_at=? WHERE id=?', (encoded, now(), draft_id))
    else:
        draft_id = con.execute('INSERT INTO intake_drafts(payload,created_at,updated_at) VALUES(?,?,?)', (encoded, now(), now())).lastrowid
    audit(con, '暂存询价草稿', 'intake_draft', draft_id)
    return {'id': draft_id}


def delete_intake_draft(con, draft_id):
    row(con, "SELECT id FROM intake_drafts WHERE id=? AND status='active'", (draft_id,))
    con.execute("UPDATE intake_drafts SET status='deleted',updated_at=? WHERE id=?", (now(), draft_id))
    audit(con, '删除询价草稿', 'intake_draft', draft_id)
    return {'id': draft_id}


def delete_order_items(con, items):
    require(isinstance(items, list) and bool(items), '请先选择要删除的订单')
    selected = []
    for item in items:
        require(isinstance(item, dict) and item.get('type') in ('order', 'intake'), '删除项目类型无效')
        item_id = int(item.get('id'))
        require(item_id > 0 and (item['type'], item_id) not in selected, '删除项目重复或编号无效')
        if item['type'] == 'intake':
            row(con, "SELECT id FROM intake_drafts WHERE id=? AND status='active'", (item_id,))
        else:
            order = row(con, 'SELECT id,customer,po FROM orders WHERE id=?', (item_id,))
            require(not con.execute("""SELECT 1 FROM purchase_lines pl JOIN order_lines l ON l.id=pl.order_line_id JOIN purchases p ON p.id=pl.purchase_id
                WHERE l.order_id=? AND p.deleted_at='' """ , (item_id,)).fetchone(), f"订单 {order['po']} 已关联采购，不能删除")
            require(not con.execute('''SELECT 1 FROM delivery_lines dl JOIN order_lines l ON l.id=dl.order_line_id
                WHERE l.order_id=?''', (item_id,)).fetchone(), f"订单 {order['po']} 已关联送货单，不能删除")
        selected.append((item['type'], item_id))
    for kind, item_id in selected:
        if kind == 'intake':
            delete_intake_draft(con, item_id)
        else:
            lc.manage_record(con, 'orders', item_id, 'delete')
    return {'deleted': len(selected)}


def delete_purchases(con, ids):
    require(isinstance(ids, list) and 0 < len(ids) <= 100, '请先选择要删除的采购记录（最多 100 条）')
    require(all(type(pid) is int and pid > 0 for pid in ids) and len(ids) == len(set(ids)), '采购记录编号重复或无效')
    for pid in ids:
        lc.manage_record(con, 'purchases', pid, 'delete')
    return {'deleted': len(ids)}


def create_order(con, d):
    d = customer_snapshot(con, d)
    if d.get('auto_po'):
        d = {**d, 'po': next_order_po(con, d.get('po'))}
    lines = d.get('lines', [])
    require(bool(lines), '至少添加一项料品')
    customer, po = txt(d, 'customer', True), txt(d, 'po', True)
    require(not con.execute('SELECT 1 FROM orders WHERE (customer=? OR customer_id=?) AND po=?', (customer, d.get('customer_id'), po)).fetchone(),
            '此客户 PO 已存在，请核对原订单或回收站记录，避免重复导入')
    cur = con.execute('''INSERT INTO orders(customer,po,contact,phone,address,due_date,note,source_id,created_at,salesperson_id)
        VALUES(?,?,?,?,?,?,?,?,?,?)''', (customer, po, txt(d, 'contact'), txt(d, 'phone'), txt(d, 'address', True),
        valid_date(d.get('due_date')), txt(d, 'note'), d.get('source_id') or None, now(), salesperson_id(con, d)))
    write_order_lines(con, cur.lastrowid, lines)
    con.execute('UPDATE orders SET customer_id=? WHERE id=?', (d.get('customer_id'), cur.lastrowid))
    if d.get('intake_draft_id'):
        draft_id = int(d['intake_draft_id'])
        row(con, "SELECT id FROM intake_drafts WHERE id=? AND status='active'", (draft_id,))
        con.execute("UPDATE intake_drafts SET status='completed',updated_at=? WHERE id=?", (now(), draft_id))
    audit(con, '创建订单', 'order', cur.lastrowid, po)
    return {'id': cur.lastrowid}


def valid_tax_rate(value):
    require(isinstance(value, (int,float)) and not isinstance(value,bool) and 0 <= value <= 100, '税率需为0至100之间的数字')
    return value


PO_SERIAL_WIDTH = 3


def salesperson_id(con, data, key='salesperson_id'):
    """业务员可选：支持留空，填写时须对应用户列表中的账号。"""
    value = data.get(key)
    if value in (None, '', 0, '0'):
        return None
    try:
        value = int(value)
    except (TypeError, ValueError):
        raise ValueError('业务员编号无效')
    require(value > 0 and con.execute('SELECT 1 FROM users WHERE id=?', (value,)).fetchone() is not None, '业务员不存在，请重新选择')
    return value


def po_company_code(con):
    record = con.execute('SELECT company_code FROM company_profile WHERE id=1').fetchone()
    return ((record['company_code'] if record else '') or '').strip().upper()


def po_prefix(con, day):
    code = po_company_code(con)
    require(bool(code), '请先在“设置 · 公司信息”中填写公司代码（一般为 2 个字母）')
    return f'PO{code}{day}'


def next_order_po(con, submitted='', commit=True):
    """内部 PO 号规则：PO + 公司代码 + 日期(YYYYMMDD) + 流水号，流水号按天递增且不重复。"""
    day = datetime.now(TZ).strftime('%Y%m%d')
    prefix = po_prefix(con, day)
    current = con.execute('SELECT last_no FROM order_po_serials WHERE day=?', (day,)).fetchone()
    serial = current['last_no'] if current else 0
    candidate = str(submitted or '').strip().upper()
    if re.fullmatch(re.escape(prefix) + rf'\d{{{PO_SERIAL_WIDTH}}}', candidate):
        number = int(candidate[len(prefix):])
        if number > serial and not con.execute('SELECT 1 FROM orders WHERE po=?', (candidate,)).fetchone():
            serial = number
        else:
            candidate = ''
    if not candidate:
        while True:
            serial += 1
            candidate = f'{prefix}{serial:0{PO_SERIAL_WIDTH}d}'
            if not con.execute('SELECT 1 FROM orders WHERE po=?', (candidate,)).fetchone():
                break
    if commit:
        con.execute('INSERT INTO order_po_serials(day,last_no) VALUES(?,?) ON CONFLICT(day) DO UPDATE SET last_no=excluded.last_no', (day, serial))
    return candidate


def suggest_order_po(con, _d=None):
    """预览下一个内部 PO 号，不占用流水号。"""
    day = datetime.now(TZ).strftime('%Y%m%d')
    return {'po': next_order_po(con, commit=False), 'company_code': po_company_code(con), 'date': day}


def write_order_lines(con, oid, lines):
    from . import inventory
    for item in lines:
        name = txt(item, 'name', True)
        item_id = inventory.bindable_item(con, {**item, 'name': name})
        con.execute('''INSERT INTO order_lines(order_id,name,spec,brand,description,quantity,unit,customer_code,price_cents,project_code,subproject_code,remark,tax_rate,item_id)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)''', (oid, name, txt(item, 'spec'), txt(item, 'brand'),
            txt(item, 'description'), qty(item.get('quantity')), txt(item, 'unit') or '个', txt(item, 'customer_code'), money(item.get('price')), txt(item, 'project_code'), txt(item, 'subproject_code'), txt(item, 'remark'), valid_tax_rate(item.get('tax_rate',get_tax_settings(con)['default_rate'])), item_id))


def edit_order(con, oid, d):
    d = customer_snapshot(con, d)
    order = row(con, 'SELECT * FROM orders WHERE id=?', (oid,))
    lc.active_order(con, oid)
    require(order['status'] == 'draft', '请先创建新报价草稿再修改订单')
    require(not con.execute('SELECT 1 FROM order_cases c JOIN order_lines l ON l.id=c.order_line_id WHERE l.order_id=?', (oid,)).fetchone(), '已有变更记录，不能重写订单明细')
    require(not con.execute('SELECT 1 FROM delivery_lines dl JOIN order_lines l ON l.id=dl.order_line_id WHERE l.order_id=?', (oid,)).fetchone(), '已有送货记录，不能重写订单明细')
    require(not con.execute('''SELECT 1 FROM purchase_lines pl JOIN order_lines l ON l.id=pl.order_line_id
        WHERE l.order_id=?''', (oid,)).fetchone(), '已经关联采购的订单不能修改料品结构和收货信息')
    customer, po = txt(d, 'customer', True), txt(d, 'po', True)
    require(not con.execute('SELECT 1 FROM orders WHERE (customer=? OR customer_id=?) AND po=? AND id<>?', (customer, d.get('customer_id'), po, oid)).fetchone(), '此客户 PO 已存在')
    require(bool(d.get('lines')), '至少添加一项料品')
    con.execute('''UPDATE orders SET customer=?,po=?,contact=?,phone=?,address=?,due_date=?,note=?,source_id=?,salesperson_id=? WHERE id=?''',
        (customer, po, txt(d,'contact'), txt(d,'phone'), txt(d,'address',True), valid_date(d.get('due_date')), txt(d,'note'), d.get('source_id') or order['source_id'],
         salesperson_id(con, d) if 'salesperson_id' in d else order['salesperson_id'], oid))
    con.execute('DELETE FROM order_lines WHERE order_id=?', (oid,))
    write_order_lines(con, oid, d['lines'])
    con.execute('UPDATE orders SET customer_id=? WHERE id=?', (d.get('customer_id', order['customer_id']), oid))
    audit(con, '修改订单草稿', 'order', oid, po)
    return {'id': oid}


def update_quote(con, oid, d):
    order = lc.active_order(con, oid)
    require(order['status'] == 'draft', '已确认报价不可改写，请先创建新报价版本')
    prices = d.get('prices', [])
    unique_ids(prices, 'id')
    current = rows(con, 'SELECT * FROM order_lines WHERE order_id=?', (oid,))
    require({x['id'] for x in current} == {int(x['id']) for x in prices}, '请提交全部料品报价')
    for x in prices:
        con.execute('UPDATE order_lines SET price_cents=? WHERE id=?', (money(x['price']), x['id']))
    audit(con, '保存报价', 'order', oid)
    return {'id': oid}


def adjust_order_lines(con, oid, d):
    order = lc.active_order(con, oid)
    require(order['status'] in ('draft', 'confirmed'), '已取消订单不能调整')
    current = rows(con, 'SELECT * FROM order_lines WHERE order_id=?', (oid,))
    submitted = d.get('lines', [])
    unique_ids(submitted, 'id')
    require({x['id'] for x in current} == {int(x['id']) for x in submitted}, '请提交全部订单料品')
    changes = []
    before = {line['id']: line for line in current}
    for item in submitted:
        lid = int(item['id'])
        quantity, price = qty(item['quantity']), money(item['price'])
        minimum = lc.cancelled_qty(con, lid) + max(lc.reserve_delivery(con, lid), lc.shipped_qty(con, lid))
        require(quantity + 1e-6 >= minimum, '数量不能低于已发货或有效送货单占用数量，请先核实对应送货单')
        changes.append((quantity, price, txt(item, 'remark') if 'remark' in item else before[lid]['remark'], valid_tax_rate(item.get('tax_rate',before[lid]['tax_rate'])), lid))
    if all(before[lid]['quantity'] == quantity and before[lid]['price_cents'] == price and before[lid]['remark'] == remark and before[lid]['tax_rate'] == tax_rate for quantity, price, remark, tax_rate, lid in changes):
        return {'id': oid}
    con.executemany('UPDATE order_lines SET quantity=?,price_cents=?,remark=?,tax_rate=? WHERE id=?', changes)
    from . import inventory
    for quantity, _price, _remark, _tax_rate, lid in changes:
        reserved = con.execute("SELECT COALESCE(SUM(quantity),0) FROM stock_reservations WHERE order_line_id=? AND status='active'", (lid,)).fetchone()[0]
        allowed = max(0, quantity - lc.cancelled_qty(con, lid) - lc.shipped_qty(con, lid))
        if reserved - allowed > 1e-6:
            inventory.release_order_reservations(con, lid, '订单减量释放占用', reserved - allowed)
    if order['status'] == 'confirmed':
        version = order['version'] + 1
        snapshot = rows(con, 'SELECT * FROM order_lines WHERE order_id=?', (oid,))
        con.execute('INSERT INTO quotes(order_id,version,snapshot,created_at) VALUES(?,?,?,?)',
                    (oid, version, json.dumps(snapshot, ensure_ascii=False), now()))
        con.execute('UPDATE orders SET version=? WHERE id=?', (version, oid))
    audit(con, '调整订单数量与价格', 'order', oid, json.dumps(changes, ensure_ascii=False))
    return {'id': oid}


def confirm_quote(con, oid):
    order = lc.active_order(con, oid)
    require(order['status'] == 'draft', '此报价已确认')
    lines = rows(con, 'SELECT * FROM order_lines WHERE order_id=?', (oid,))
    con.execute('INSERT INTO quotes(order_id,version,snapshot,created_at) VALUES(?,?,?,?)',
                (oid, order['version'], json.dumps(lines, ensure_ascii=False), now()))
    con.execute("UPDATE orders SET status='confirmed' WHERE id=?", (oid,))
    audit(con, '确认报价', 'order', oid, f"版本 {order['version']}")
    return {'id': oid}


def revise_quote(con, oid):
    order = lc.active_order(con, oid)
    require(order['status'] == 'confirmed', '当前已经是报价草稿')
    con.execute("UPDATE orders SET status='draft',version=version+1 WHERE id=?", (oid,))
    audit(con, '新建报价版本', 'order', oid)
    return {'id': oid}


def cancel_order(con, oid, d):
    lc.active_order(con, oid)
    reason = txt(d, 'reason', True)
    lines = rows(con, 'SELECT * FROM order_lines WHERE order_id=?', (oid,))
    pending = [(l, l['quantity'] - lc.cancelled_qty(con, l['id']) - lc.shipped_qty(con, l['id'])) for l in lines]
    require(any(n > 1e-6 for _, n in pending), '没有可取消的未发数量；已发货部分请登记售后')
    for line, amount in pending:
        if amount > 1e-6:
            lc.create_order_case(con, oid, {'order_line_id':line['id'], 'kind':'cancel', 'quantity':amount, 'reason':reason})
    return {'id': oid}


def resolve_cancelled_purchase_line(con, line_id, d):
    raise ValueError('请在采购处理内按数量、处理方式和退款进度办理，不能仅填写备注完成')


def purchase_attachment_ids(con, values):
    require(isinstance(values, list) and len(values) <= 20, '采购附件最多 20 个')
    ids = []
    for aid in values:
        require(isinstance(aid, str) and re.fullmatch(r'[a-f0-9]{64}', aid), '附件编号无效')
        require(con.execute('SELECT 1 FROM attachments WHERE id=?', (aid,)).fetchone(), '附件不存在')
        if aid not in ids:
            ids.append(aid)
    return ids


def add_purchase_attachments(con, pid, d):
    row(con, "SELECT id FROM purchases WHERE id=? AND deleted_at=''", (pid,))
    ids = purchase_attachment_ids(con, d.get('attachment_ids'))
    existing = {r[0] for r in con.execute('SELECT attachment_id FROM purchase_attachments WHERE purchase_id=?', (pid,))}
    require(len(existing | set(ids)) <= 20, '采购附件最多 20 个')
    for aid in ids:
        con.execute('INSERT OR IGNORE INTO purchase_attachments(purchase_id,attachment_id) VALUES(?,?)', (pid, aid))
    con.execute('''UPDATE purchases SET source_id=(SELECT attachment_id FROM purchase_attachments
        WHERE purchase_id=? ORDER BY id LIMIT 1) WHERE id=?''', (pid, pid))
    if ids:
        audit(con, '添加采购附件', 'purchase', pid, f'{len(ids)} 个')
    return {'id': pid}


def remove_purchase_attachment(con, pid, d):
    row(con, "SELECT id FROM purchases WHERE id=? AND deleted_at=''", (pid,))
    aid = txt(d, 'attachment_id', True)
    deleted = con.execute('DELETE FROM purchase_attachments WHERE purchase_id=? AND attachment_id=?', (pid, aid))
    require(deleted.rowcount, '该附件未关联此采购')
    con.execute('''UPDATE purchases SET source_id=(SELECT attachment_id FROM purchase_attachments
        WHERE purchase_id=? ORDER BY id LIMIT 1) WHERE id=?''', (pid, pid))
    audit(con, '移除采购附件', 'purchase', pid, aid)
    return {'id': pid}


def create_purchase(con, d):
    from . import inventory
    require(not d.get('taobao_source') or d['taobao_source'].get('transaction_status') in ('买家已付款','卖家已发货','交易成功'), '交易状态不符合采集范围，请重新提取后核对')
    draft_id = d.get('purchase_draft_id')
    if draft_id:
        draft = row(con, "SELECT * FROM purchase_drafts WHERE id=? AND status='active'", (int(draft_id),))
        require(d.get('platform') == '淘宝' and d.get('platform_order') == draft['platform_order'], '草稿订单号不能更改')
        require(not con.execute("SELECT 1 FROM purchases WHERE platform='淘宝' AND platform_order=?", (draft['platform_order'],)).fetchone(), '该平台订单已登记')
        require(d.get('lines'), '请先关联客户料品')
    items = d.get('lines', [])
    require(isinstance(items, list) and 0 < len(items) <= 100, '请填写采购明细')
    linked, stocked = set(), set()
    for x in items:
        if not x.get('order_line_id'):
            require((x.get('receive_mode') or 'direct') == 'stock', '未关联客户订单的采购必须选择“入库”收货方式')
            item_key = x.get('item_id')
            require(item_key not in (None, '', 0, '0') and item_key not in stocked, '同一备货料品只能有一条采购明细')
            stocked.add(item_key)
        else:
            require(x['order_line_id'] not in linked, '同一客户料品只能有一条采购明细')
            linked.add(x['order_line_id'])
    amount = money(d.get('amount'))
    costs = [money(x.get('cost')) for x in items]
    prepared = []
    for x in items:
        mode = txt(x, 'receive_mode') or 'direct'
        require(mode in inventory.RECEIVE_MODES, '收货方式无效')
        warehouse = inventory.warehouse_id_of(con, x.get('warehouse_id')) if mode == 'stock' and x.get('warehouse_id') else None
        if x.get('order_line_id'):
            line = row(con, '''SELECT l.*,o.status FROM order_lines l JOIN orders o ON o.id=l.order_id WHERE l.id=?''', (x['order_line_id'],))
            require(line['status'] == 'confirmed', '请先确认客户报价，再登记采购')
            lc.active_order(con, line['order_id'])
            allocated = lc.purchased_qty(con, line['id']) + con.execute(
                "SELECT COALESCE(SUM(quantity),0) FROM stock_reservations WHERE order_line_id=? AND status='active'",
                (line['id'],)).fetchone()[0]
            require(qty(x['quantity']) + allocated <= lc.demand_qty(con, line['id']) + 1e-6, f"{line['name']} 采购数量超过客户需求")
            item_id = line['item_id'] or inventory.bindable_item(con, {**line, 'name': line['name']})
            if not line['item_id']:
                con.execute('UPDATE order_lines SET item_id=? WHERE id=?', (item_id, line['id']))
            prepared.append((x['order_line_id'], item_id, mode, warehouse))
        else:
            item_id = inventory.bindable_item(con, x)
            prepared.append((None, item_id, mode, warehouse))
    keys = (txt(d, 'platform', True), txt(d, 'account'), txt(d, 'platform_order', True))
    require(not con.execute('SELECT 1 FROM purchases WHERE platform=? AND account=? AND platform_order=?', keys).fetchone(), '该平台订单已登记，请核对现有记录或回收站，避免重复录入')
    attachment_ids = purchase_attachment_ids(con, d.get('attachment_ids', [d['source_id']] if d.get('source_id') else []))
    cur = con.execute('''INSERT INTO purchases(platform,account,shop,platform_order,amount_cents,invoice_expected_cents,
        purchased_date,promised_date,note,source_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)''',
        (keys[0], keys[1], txt(d, 'shop', True), keys[2], amount, money(d.get('invoice_expected', d.get('amount'))),
         valid_date(d.get('purchased_date') or today(), True), valid_date(d.get('promised_date')), txt(d, 'note'), attachment_ids[0] if attachment_ids else None, now()))
    for aid in attachment_ids:
        con.execute('INSERT INTO purchase_attachments(purchase_id,attachment_id) VALUES(?,?)', (cur.lastrowid, aid))
    for x, cost, (order_line_id, item_id, mode, warehouse) in zip(items, costs, prepared):
        con.execute('''INSERT INTO purchase_lines(purchase_id,order_line_id,item_id,quantity,purchase_spec,purchase_quantity,purchase_unit,link,cost_cents,receive_mode,warehouse_id)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)''', (cur.lastrowid, order_line_id, item_id, qty(x['quantity']), txt(x, 'purchase_spec'),
            qty(x.get('purchase_quantity', x['quantity'])), txt(x, 'purchase_unit') or '个', txt(x, 'link'), cost, mode, warehouse))
    audit(con, '登记采购', 'purchase', cur.lastrowid, keys[2])
    if d.get('taobao_source'):
        save_taobao_source(con, cur.lastrowid, d['taobao_source'])
    con.execute("UPDATE purchase_drafts SET status='completed',purchase_id=?,updated_at=? WHERE platform_order=? AND status='active' AND ?='淘宝'", (cur.lastrowid, now(), keys[2], keys[0]))
    return {'id': cur.lastrowid}


def update_purchase_associations(con, pid, d):
    from . import inventory
    purchase = row(con, "SELECT * FROM purchases WHERE id=? AND deleted_at='' AND archived_at=''", (pid,))
    previous = rows(con, 'SELECT * FROM purchase_lines WHERE purchase_id=?', (pid,))
    for line in previous:
        lid = line['id']
        require(not line['created_by_case_id'] and not con.execute('SELECT 1 FROM stock_moves WHERE purchase_line_id=?', (lid,)).fetchone(), '转单产生的采购明细请先处理来源记录')
        require(not con.execute('SELECT 1 FROM stock_receipt_lines WHERE purchase_line_id=?', (lid,)).fetchone(), '已有入库记录的采购明细请先撤销或更正入库单')
        require(not con.execute('SELECT 1 FROM package_lines WHERE purchase_line_id=?', (lid,)).fetchone(), '已有包裹分配，请先解除包裹关联再修改料品')
        require(not con.execute('SELECT 1 FROM purchase_cases WHERE purchase_line_id=?', (lid,)).fetchone() and not con.execute('SELECT 1 FROM order_cases WHERE purchase_line_id=?', (lid,)).fetchone(), '已有退货或采购处理记录，请先处理下游记录')
        if line['order_line_id']:
            require(not con.execute('SELECT 1 FROM delivery_lines WHERE order_line_id=?', (line['order_line_id'],)).fetchone(), '已有送货记录，不能直接修改关联料品')
    items = d.get('lines', [])
    require(isinstance(items, list) and 0 < len(items) <= 100, '请选择采购料品')
    own = {line['order_line_id']: line['quantity'] for line in previous if line['order_line_id']}
    own_stock = {line['item_id']: line['quantity'] for line in previous if not line['order_line_id']}
    linked, stocked = set(), set()
    validated = []
    for item in items:
        mode = txt(item, 'receive_mode') or 'direct'
        require(mode in inventory.RECEIVE_MODES, '收货方式无效')
        warehouse = inventory.warehouse_id_of(con, item.get('warehouse_id')) if mode == 'stock' and item.get('warehouse_id') else None
        quantity = qty(item.get('quantity'))
        if item.get('order_line_id'):
            require(item['order_line_id'] not in linked, '同一客户料品只能有一条采购明细')
            linked.add(item['order_line_id'])
            line = row(con, 'SELECT l.*,o.status FROM order_lines l JOIN orders o ON o.id=l.order_id WHERE l.id=?', (item['order_line_id'],))
            require(line['status'] == 'confirmed', '请先确认客户报价')
            lc.active_order(con, line['order_id'])
            require(lc.purchased_qty(con, line['id']) - own.get(line['id'], 0) + quantity <= lc.demand_qty(con, line['id']) + 1e-6, f"{line['name']} 采购数量超过客户需求")
            validated.append({'order_line_id': line['id'], 'item_id': line['item_id'], 'quantity': quantity,
                              'receive_mode': mode, 'warehouse_id': warehouse})
        else:
            require(mode == 'stock', '未关联客户订单的采购必须选择“入库”收货方式')
            item_id = item.get('item_id')
            require(item_id not in (None, '', 0, '0'), '请选择料品或客户订单料品')
            item_id = int(item_id)
            require(item_id not in stocked, '同一备货料品只能有一条采购明细')
            stocked.add(item_id)
            row(con, 'SELECT id FROM items WHERE id=?', (item_id,))
            validated.append({'order_line_id': None, 'item_id': item_id, 'quantity': quantity,
                              'receive_mode': mode, 'warehouse_id': warehouse})
    for entry, item in zip(validated, items):
        entry['purchase_spec'] = txt(item, 'purchase_spec')
        entry['purchase_quantity'] = qty(item.get('purchase_quantity', entry['quantity']))
        entry['purchase_unit'] = txt(item, 'purchase_unit') or '个'
        entry['link'] = txt(item, 'link')
        entry['cost'] = money(item.get('cost'))
    source = con.execute('SELECT payload FROM purchase_sources WHERE purchase_id=?', (pid,)).fetchone()
    payload = json.loads(source['payload']) if source else None
    if payload and payload.get('products'):
        if d.get('association_mode') == 'order':
            for product in payload['products']:
                product.pop('order_line_ids', None)
        else:
            associations = d.get('product_order_line_ids')
            require(isinstance(associations, list) and len(associations) == len(payload['products']), '商品关联信息已变化，请重新打开明细')
            allowed = {entry['order_line_id'] for entry in validated if entry['order_line_id']}
            require(all(isinstance(ids, list) and ids and len(ids) == len(set(ids)) and set(ids) <= allowed for ids in associations), '每个商品均需选择有效的客户料品')
            require(set().union(*(set(ids) for ids in associations)) == allowed, '客户料品需要对应到商品')
            for product, ids in zip(payload['products'], associations):
                product['order_line_ids'] = ids
    retained_linked = {entry['order_line_id'] for entry in validated if entry['order_line_id']}
    retained_stock = {entry['item_id'] for entry in validated if not entry['order_line_id']}
    for line in previous:
        keep = line['order_line_id'] in retained_linked if line['order_line_id'] else line['item_id'] in retained_stock
        if not keep:
            con.execute('DELETE FROM purchase_lines WHERE id=?', (line['id'],))
    existing = {line['order_line_id']: line['id'] for line in previous if line['order_line_id']}
    existing_stock = {line['item_id']: line['id'] for line in previous if not line['order_line_id']}
    for entry in validated:
        values = (entry['order_line_id'], entry['quantity'], entry['purchase_spec'], entry['purchase_quantity'], entry['purchase_unit'],
                  entry['link'], entry['cost'], entry['receive_mode'], entry['warehouse_id'], entry['item_id'])
        current = existing.get(entry['order_line_id']) if entry['order_line_id'] else existing_stock.get(entry['item_id'])
        if current:
            con.execute('''UPDATE purchase_lines SET order_line_id=?,quantity=?,purchase_spec=?,purchase_quantity=?,purchase_unit=?,link=?,
                cost_cents=?,receive_mode=?,warehouse_id=?,item_id=? WHERE id=?''', (*values, current))
        else:
            con.execute('''INSERT INTO purchase_lines(purchase_id,order_line_id,quantity,purchase_spec,purchase_quantity,purchase_unit,link,cost_cents,
                receive_mode,warehouse_id,item_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)''', (pid, *values))
    if payload:
        con.execute('UPDATE purchase_sources SET payload=? WHERE purchase_id=?', (json.dumps(payload, ensure_ascii=False), pid))
    audit(con, '修改采购关联料品', 'purchase', pid, purchase['platform_order'])
    return {'id': pid}


def save_taobao_source(con, pid, d):
    purchase = row(con, "SELECT * FROM purchases WHERE id=? AND deleted_at=''", (pid,))
    require(isinstance(d, dict), '淘宝提取结果格式不正确')
    require(purchase['platform'] == '淘宝' and txt(d, 'platform_order', True) == purchase['platform_order'], '提取结果与采购订单号不一致')
    previous = con.execute('SELECT payload FROM purchase_sources WHERE purchase_id=?', (pid,)).fetchone()
    payload = json.loads(previous['payload']) if previous else {'packages': [], 'products': []}
    payload['platform_order'] = purchase['platform_order']
    if d.get('transaction_status'):
        status = txt(d, 'transaction_status')
        require(status in ('买家已付款', '卖家已发货', '交易成功', '交易关闭', '交易取消', '退款中的订单'), '交易状态不正确')
        payload['transaction_status'] = status
    if isinstance(d.get('invoice_info'), dict):
        payload['invoice_info'] = {key:txt(d['invoice_info'], key)[:500] for key in ('status','text')}
    if d.get('background') is True:
        payload['sync_checked_at'] = now()
        payload['sync_error'] = ''
    if d.get('source_url'):
        from urllib.parse import urlparse, parse_qs
        source_url = txt(d, 'source_url')
        url = urlparse(source_url)
        routes = {('trade.taobao.com', '/trade/detail/trade_order_detail.htm'): 'biz_order_id',
                  ('trade.tmall.com', '/detail/orderDetail.htm'): 'bizOrderId'}
        parameter = routes.get((url.hostname, url.path))
        require(url.scheme == 'https' and not url.username and not url.password and parameter and
                parse_qs(url.query).get(parameter) == [purchase['platform_order']], '订单来源链接无效')
        payload['source_url'] = source_url
    for collection, keys in [('packages', ('carrier', 'tracking')), ('products', ('name', 'spec', 'quantity', 'amount', 'link'))]:
        incoming = d.get(collection, [])
        require(isinstance(incoming, list) and len(incoming) <= 100, '提取条目过多或格式错误')
        for item in incoming:
            require(isinstance(item, dict), '提取条目格式错误')
            clean = {key: txt(item, key)[:500] for key in keys}
            if collection == 'packages':
                require(bool(re.fullmatch(r'[A-Za-z0-9-]{6,80}', clean['tracking'])), '提取的运单号格式不正确')
                status = txt(item, 'status')
                require(status in ('', '待揽收', '运输中', '派送中', '已签收', '异常', '退回'), '提取的物流状态不正确')
                events = item.get('events', [])
                require(isinstance(events, list) and len(events) <= 50, '提取的物流轨迹过多或格式错误')
                clean['events'] = []
                for event in events:
                    require(isinstance(event, dict), '提取的物流节点格式错误')
                    description = txt(event, 'description')[:200]
                    stamp = txt(event, 'occurred_at')
                    require(description and re.fullmatch(r'20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00', stamp), '提取的物流节点时间或描述无效')
                    try:
                        moment = datetime.fromisoformat(stamp)
                    except ValueError:
                        raise ValueError('提取的物流节点时间或描述无效')
                    require(moment <= datetime.now(TZ) and (stamp, description) not in [(e['occurred_at'], e['description']) for e in clean['events']], '提取的物流节点重复或时间无效')
                    clean['events'].append({'occurred_at': stamp, 'description': description})
                if status:
                    clean['status'] = status
                existing = next((p for p in payload[collection] if p['tracking'] == clean['tracking']), None)
                if existing:
                    if clean['carrier']:
                        existing['carrier'] = clean['carrier']
                    if status:
                        existing['status'] = status
                    known = {(e['occurred_at'], e['description']) for e in existing.get('events', [])}
                    existing.setdefault('events', [])
                    for event in clean['events']:
                        if (event['occurred_at'], event['description']) not in known:
                            existing['events'].append(event)
                    existing['events'] = sorted(existing['events'], key=lambda e: e['occurred_at'])[-100:]
                    _apply_taobao_tracking(con, pid, existing)
                    continue
            elif clean['link']:
                from urllib.parse import urlparse
                url = urlparse(clean['link'])
                require(url.scheme == 'https' and url.hostname in ('item.taobao.com', 'detail.tmall.com'), '商品链接格式不正确')
            if collection == 'products':
                if 'order_line_ids' in item:
                    allowed = {r[0] for r in con.execute('SELECT order_line_id FROM purchase_lines WHERE purchase_id=?', (pid,))}
                    clean['order_line_ids'] = [int(value) for value in item['order_line_ids'] if int(value) in allowed]
                if clean['amount']:
                    money(clean['amount'])
                existing = next((p for p in payload[collection] if (p.get('name'), p.get('spec'), p.get('link')) == (clean['name'], clean['spec'], clean['link'])), None)
                if existing:
                    existing.update({key: value for key, value in clean.items() if value})
                    continue
            if clean not in payload[collection]:
                payload[collection].append(clean)
            if collection == 'packages':
                _apply_taobao_tracking(con, pid, clean)
        require(len(payload[collection]) <= 100, '累计提取条目超过 100 条，请手工核对')
    con.execute('INSERT INTO purchase_sources VALUES(?,?,?) ON CONFLICT(purchase_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at', (pid, json.dumps(payload, ensure_ascii=False), now()))
    audit(con, '保存淘宝提取信息', 'purchase', pid)
    return {'id': pid}


def _apply_taobao_tracking(con, purchase_id, shipment):
    package = con.execute('''SELECT k.* FROM packages k JOIN package_lines kl ON kl.package_id=k.id
        JOIN purchase_lines pl ON pl.id=kl.purchase_line_id
        WHERE pl.purchase_id=? AND k.tracking=? LIMIT 1''', (purchase_id, shipment['tracking'])).fetchone()
    if not package:
        return
    old = con.execute('''SELECT MAX(occurred_at) FROM tracking_events
        WHERE package_id=? AND description!='人工登记运单，待核实物流' ''', (package['id'],)).fetchone()[0] or ''
    events = sorted(shipment.get('events', []), key=lambda e: e['occurred_at'])
    for index, event in enumerate(events):
        description, stamp = event['description'], event['occurred_at']
        if con.execute("SELECT 1 FROM tracking_events WHERE package_id=? AND occurred_at=? AND description=? AND source='淘宝'", (package['id'], stamp, description)).fetchone():
            continue
        status = ('已签收' if re.search('已签收|签收成功', description) else
                  '派送中' if re.search('派送中|正在派送', description) else
                  '退回' if re.search('退回|退件', description) else
                  '异常' if '异常' in description else
                  '运输中' if re.search('已揽收|运输|已发货|已到达', description) else
                  shipment.get('status', '运输中') if index == len(events) - 1 else '运输中')
        con.execute('INSERT INTO tracking_events(package_id,status,description,occurred_at,source) VALUES(?,?,?,?,?)',
                    (package['id'], status, description, stamp, '淘宝'))
    if events and events[-1]['occurred_at'] >= old and package['status'] != '已签收':
        latest = con.execute("SELECT status FROM tracking_events WHERE package_id=? AND occurred_at=? AND source='淘宝' ORDER BY id DESC LIMIT 1",
                             (package['id'], events[-1]['occurred_at'])).fetchone()
        status = latest[0] if latest else ''
        if status:
            signed = events[-1]['occurred_at'][:10] if status == '已签收' else ''
            con.execute('UPDATE packages SET status=?, signed_at=? WHERE id=?', (status, signed, package['id']))


def taobao_sync_failed(con, pid):
    purchase = row(con, "SELECT platform FROM purchases WHERE id=? AND deleted_at=''", (pid,))
    require(purchase['platform'] == '淘宝', '采购平台不支持淘宝同步')
    previous = con.execute('SELECT payload FROM purchase_sources WHERE purchase_id=?', (pid,)).fetchone()
    if not previous:
        return {'id': pid}
    payload = json.loads(previous['payload'])
    payload['sync_checked_at'] = now()
    payload['sync_error'] = '登录已失效、页面需要验证或未能识别订单物流；原记录未更改'
    con.execute('UPDATE purchase_sources SET payload=?,updated_at=? WHERE purchase_id=?',
                (json.dumps(payload, ensure_ascii=False), now(), pid))
    return {'id': pid}


def save_taobao_invoice_snapshot(con, d):
    entries = d.get('entries')
    require(isinstance(entries, list) and len(entries) <= 500, '淘宝发票条目格式不正确')
    by_order = {}
    for item in entries:
        require(isinstance(item, dict), '淘宝发票条目格式不正确')
        order = txt(item, 'platform_order', True)
        require(bool(re.fullmatch(r'\d{8,30}', order)), '淘宝发票订单号无效')
        status = txt(item, 'status', True)
        require(status in ('已开票', '申请中', '商家拒绝'), '淘宝发票状态无效')
        amount = money(item.get('amount'))
        require(amount > 0, '淘宝发票金额无效')
        date_value = txt(item, 'date')
        if date_value:
            valid_date(date_value, True)
        clean = {'status': status, 'amount_cents': amount, 'shop': txt(item, 'shop')[:200],
                 'title': txt(item, 'title')[:200], 'invoice_type': txt(item, 'invoice_type')[:100],
                 'date': date_value, 'applied_at': txt(item, 'applied_at')[:30],
                 'note': txt(item, 'note')[:300]}
        if clean not in by_order.setdefault(order, []):
            by_order[order].append(clean)
    details = d.get('details', [])
    require(isinstance(details, list) and len(details) <= 500, '淘宝发票详情格式不正确')
    by_order_detail = {}
    for item in details:
        require(isinstance(item, dict), '淘宝发票详情格式不正确')
        order = txt(item, 'platform_order', True)
        require(order in by_order and any(x['status'] == '已开票' for x in by_order[order]), '发票详情与已开票订单不一致')
        invoices = item.get('invoices')
        require(isinstance(invoices, list) and len(invoices) <= 50, '淘宝发票详情条目过多或格式错误')
        clean_invoices = []
        for invoice in invoices:
            require(isinstance(invoice, dict), '淘宝发票详情格式不正确')
            number = txt(invoice, 'number', True)
            require(len(number) <= 80 and bool(re.fullmatch(r'[A-Za-z0-9-]+', number)), '发票号码格式不正确')
            amount = money(invoice.get('amount'))
            require(amount > 0, '发票金额无效')
            issued = valid_date(txt(invoice, 'date', True), True)
            clean = {'number': number, 'code': txt(invoice, 'code')[:80], 'amount_cents': amount,
                     'invoice_type': txt(invoice, 'invoice_type')[:100], 'date': issued,
                     'title': txt(invoice, 'title')[:200], 'buyer_tax_id': txt(invoice, 'buyer_tax_id')[:80],
                     'content': txt(invoice, 'content')[:500]}
            aid = txt(invoice, 'attachment_id')
            if aid:
                require(bool(re.fullmatch(r'[a-f0-9]{64}', aid)), '发票附件编号无效')
                row(con, 'SELECT * FROM attachments WHERE id=?', (aid,))
                clean['attachment_id'] = aid
            if number not in [x['number'] for x in clean_invoices]:
                clean_invoices.append(clean)
        if clean_invoices:
            by_order_detail[order] = clean_invoices
    updated = 0
    for order, invoice_entries in by_order.items():
        for purchase in con.execute("SELECT id FROM purchases WHERE platform=? AND platform_order=? AND deleted_at=''", ('淘宝', order)):
            previous = con.execute('SELECT payload FROM purchase_sources WHERE purchase_id=?', (purchase['id'],)).fetchone()
            payload = json.loads(previous['payload']) if previous else {'packages': [], 'products': []}
            payload['platform_order'] = order
            payload['invoice_entries'] = invoice_entries
            payload['invoice_checked_at'] = now()
            if order in by_order_detail:
                previous_files = {item['number']: item.get('attachment_id') for item in payload.get('invoice_details', [])}
                for invoice in by_order_detail[order]:
                    if not invoice.get('attachment_id') and previous_files.get(invoice['number']):
                        invoice['attachment_id'] = previous_files[invoice['number']]
                payload['invoice_details'] = by_order_detail[order]
                payload['invoice_detail_checked_at'] = now()
            con.execute('INSERT INTO purchase_sources VALUES(?,?,?) ON CONFLICT(purchase_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at',
                        (purchase['id'], json.dumps(payload, ensure_ascii=False), now()))
            updated += 1
    return {'updated': updated}


def create_package(con, d):
    items = d.get('lines', [])
    unique_ids(items, 'purchase_line_id')
    recipients = set()
    for x in items:
        line = row(con, '''SELECT pl.*,o.customer,o.address,o.status order_status FROM purchase_lines pl
            JOIN order_lines l ON l.id=pl.order_line_id JOIN orders o ON o.id=l.order_id WHERE pl.id=?''', (x['purchase_line_id'],))
        lc.active_order(con, row(con, 'SELECT order_id FROM order_lines WHERE id=?', (line['order_line_id'],))['order_id'])
        row(con, "SELECT id FROM purchases WHERE id=? AND deleted_at='' AND archived_at=''", (line['purchase_id'],))
        require(line['order_status'] == 'confirmed', '客户订单已取消或未确认，不能新增包裹')
        used = con.execute('SELECT COALESCE(SUM(quantity),0) FROM package_lines WHERE purchase_line_id=?', (line['id'],)).fetchone()[0]
        pending = con.execute("SELECT COALESCE(SUM(quantity),0) FROM purchase_cases WHERE purchase_line_id=? AND status IN ('pending','processing')", (line['id'],)).fetchone()[0]
        require(qty(x['quantity']) + used + pending <= lc.purchase_balance(con, line['id'])[0] + 1e-6, '包裹数量超过尚未分配的采购数量，或料品正在退货/转单处理')
        recipients.add((line['customer'], line['address']))
    require(len(recipients) == 1, '一个包裹只能对应同一客户及收货地址')
    carrier, tracking = txt(d, 'carrier', True), txt(d, 'tracking', True)
    require(not con.execute('SELECT 1 FROM packages WHERE carrier=? AND tracking=?', (carrier, tracking)).fetchone(), '该运单已登记')
    cur = con.execute('INSERT INTO packages(carrier,tracking,note,created_at) VALUES(?,?,?,?)', (carrier, tracking, txt(d, 'note'), now()))
    for x in items:
        con.execute('INSERT INTO package_lines(package_id,purchase_line_id,quantity) VALUES(?,?,?)', (cur.lastrowid, x['purchase_line_id'], qty(x['quantity'])))
    con.execute('INSERT INTO tracking_events(package_id,status,description,occurred_at) VALUES(?,?,?,?)', (cur.lastrowid, '待揽收', '人工登记运单，待核实物流', now()))
    for purchase_id in {con.execute('SELECT purchase_id FROM purchase_lines WHERE id=?', (x['purchase_line_id'],)).fetchone()[0] for x in items}:
        source = con.execute('SELECT payload FROM purchase_sources WHERE purchase_id=?', (purchase_id,)).fetchone()
        if source:
            for shipment in json.loads(source['payload']).get('packages', []):
                if shipment.get('tracking') == tracking:
                    _apply_taobao_tracking(con, purchase_id, shipment)
    audit(con, '登记包裹', 'package', cur.lastrowid, tracking)
    return {'id': cur.lastrowid}


def update_tracking(con, pid, d):
    row(con, 'SELECT * FROM packages WHERE id=?', (pid,))
    status = txt(d, 'status', True)
    require(status in ['待揽收', '运输中', '派送中', '已签收', '异常', '退回'], '物流状态不正确')
    signed = valid_date(d.get('signed_at'), status == '已签收') if status == '已签收' else ''
    require(not signed or signed <= today(), '签收日期不能晚于今天')
    con.execute('UPDATE packages SET status=?,signed_at=? WHERE id=?', (status, signed, pid))
    con.execute('INSERT INTO tracking_events(package_id,status,description,occurred_at) VALUES(?,?,?,?)',
                (pid, status, txt(d, 'description') or '人工更新物流状态', now()))
    audit(con, '更新物流', 'package', pid, status)
    return {'id': pid}


def follow_invoice(con, pid, d):
    p = row(con, "SELECT * FROM purchases WHERE id=? AND deleted_at=''", (pid,))
    stage = txt(d, 'invoice_stage', True)
    require(stage in ['待申请', '已申请待开票', '店铺表示已开票', '不需开票'], '发票状态不正确')
    reason = txt(d, 'invoice_reason')
    require(stage != '不需开票' or reason, '不需开票时请填写原因')
    expected = money(d.get('invoice_expected', p['invoice_expected_cents'] / 100))
    received = con.execute('SELECT COALESCE(SUM(amount_cents),0) FROM invoice_allocations WHERE purchase_id=?', (pid,)).fetchone()[0]
    require(expected >= received, '应开票金额不能低于已关联发票金额')
    con.execute('''UPDATE purchases SET invoice_stage=?,invoice_reason=?,invoice_due=?,followup=?,next_followup=?,invoice_expected_cents=? WHERE id=?''',
        (stage, reason, valid_date(d.get('invoice_due')), txt(d, 'followup'), valid_date(d.get('next_followup')), expected, pid))
    audit(con, '跟进发票', 'purchase', pid, txt(d, 'followup') or stage)
    return {'id': pid}


def create_invoice(con, d):
    items = d.get('allocations', [])
    unique_ids(items, 'purchase_id')
    amount = money(d.get('amount'))
    require(amount > 0, '发票金额必须大于零')
    require(sum(money(x['amount']) for x in items) == amount, '发票分配金额之和必须等于发票金额')
    aid = txt(d, 'attachment_id', True)
    row(con, 'SELECT * FROM attachments WHERE id=?', (aid,))
    number = txt(d, 'number', True)
    require(not con.execute('SELECT 1 FROM invoices WHERE number=?', (number,)).fetchone(), '该发票号码已登记')
    for x in items:
        p = row(con, "SELECT * FROM purchases WHERE id=? AND deleted_at=''", (x['purchase_id'],))
        require(p['invoice_stage'] != '不需开票', '请先将采购改为需要开票')
        received = con.execute('SELECT COALESCE(SUM(amount_cents),0) FROM invoice_allocations WHERE purchase_id=?', (p['id'],)).fetchone()[0]
        require(money(x['amount']) > 0, '每笔分配金额必须大于零')
        require(received + money(x['amount']) <= p['invoice_expected_cents'], '分配金额超过此采购待收票金额，请先核对应开票金额')
    cur = con.execute('INSERT INTO invoices(number,seller,issued_date,amount_cents,attachment_id,created_at) VALUES(?,?,?,?,?,?)',
        (number, txt(d, 'seller', True), valid_date(d.get('issued_date'), True), amount, aid, now()))
    for x in items:
        con.execute('INSERT INTO invoice_allocations VALUES(?,?,?)', (cur.lastrowid, x['purchase_id'], money(x['amount'])))
    audit(con, '登记收票', 'invoice', cur.lastrowid, number)
    return {'id': cur.lastrowid}


def next_delivery_number(con, po):
    numbers = [r[0] for r in con.execute('''SELECT DISTINCT d.number FROM deliveries d
        JOIN delivery_lines dl ON dl.delivery_id=d.id
        JOIN order_lines l ON l.id=dl.order_line_id
        JOIN orders o ON o.id=l.order_id WHERE o.po=?''', (po,))]
    prefix = f'SHD-{po}-'
    sequence = max([len(numbers)] + [int(number[len(prefix):]) for number in numbers
        if number.startswith(prefix) and number[len(prefix):].isdigit()]) + 1
    return f'{prefix}{sequence:05d}'


def create_deliveries(con, d):
    items = d.get('lines', [])
    if items and 'order_line_id' in items[0]:
        unique_ids(items, 'order_line_id')
        require(all('order_line_id' in x for x in items), '料品选择不正确')
        groups = {}
        for x in items:
            item = row(con, '''SELECT l.*,o.customer,o.address,o.contact,o.phone,o.po,o.status order_status
                FROM order_lines l JOIN orders o ON o.id=l.order_id WHERE l.id=?''', (x['order_line_id'],))
            require(item['order_status'] == 'confirmed', '客户订单已取消或未确认，不能生成送货单')
            used = con.execute('''SELECT COALESCE(SUM(dl.quantity),0) FROM delivery_lines dl
                JOIN deliveries d ON d.id=dl.delivery_id WHERE dl.order_line_id=? AND d.status='active' ''', (item['id'],)).fetchone()[0]
            amount = qty(x['quantity'])
            require(amount <= lc.delivery_limit(con, item['id'], d.get('replacement_case_id') or None) + 1e-6, '本次开单数量超过订单剩余数量')
            package = con.execute('''SELECT k.carrier,k.tracking FROM package_lines kl
                JOIN purchase_lines pl ON pl.id=kl.purchase_line_id JOIN packages k ON k.id=kl.package_id
                WHERE pl.order_line_id=? AND k.tracking<>'' ORDER BY k.id DESC LIMIT 1''', (item['id'],)).fetchone()
            if not package:
                sources = rows(con, "SELECT ps.payload FROM purchase_sources ps JOIN purchases p ON p.id=ps.purchase_id JOIN purchase_lines pl ON pl.purchase_id=p.id WHERE pl.order_line_id=? AND p.deleted_at='' ORDER BY p.id DESC", (item['id'],))
                package = next((shipment for source in sources for shipment in json.loads(source['payload']).get('packages', []) if shipment.get('tracking')), None)
            snapshot = dict(item)
            snapshot['carrier'] = package['carrier'] if package else txt(d, 'carrier')
            snapshot['tracking'] = package['tracking'] if package else txt(d, 'tracking')
            group = (item['customer'], item['address'], item['contact'], item['phone'])
            groups.setdefault(group, []).append((snapshot, amount, txt(x, 'remark')))
        require(len(groups) == 1, '所选料品的收货信息必须一致')
        ids = []
        for key, values in groups.items():
            pos = {item['po'] for item, _, _ in values}
            require(len(pos) == 1, '一张送货单只能关联一个客户 PO')
            number = next_delivery_number(con, pos.pop())
            stamp = now()
            cur = con.execute('INSERT INTO deliveries(number,customer,address,contact,phone,company,company_en,company_address,company_phone,note,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                ('TEMP-' + stamp, *key, txt(d, 'company', True), txt(d, 'company_en'), txt(d, 'company_address'), txt(d, 'company_phone'), txt(d, 'note'), stamp))
            did = cur.lastrowid
            con.execute('UPDATE deliveries SET number=?,shipped_at=? WHERE id=?', (number, stamp, did))
            for item, amount, remark in values:
                con.execute('INSERT INTO delivery_lines(delivery_id,order_line_id,quantity,snapshot,replacement_case_id,remark) VALUES(?,?,?,?,?,?)',
                    (did, item['id'], amount, json.dumps(item, ensure_ascii=False), d.get('replacement_case_id') or None, remark))
            audit(con, '生成送货单', 'delivery', did)
            ids.append(did)
        return {'ids': ids}
    unique_ids(items, 'package_line_id')
    mode = d.get('mode', 'combined')
    require(mode in ['combined', 'separate'], '开单方式错误')
    groups = {}
    totals = {}
    for x in items:
        item = row(con, '''SELECT kl.id,kl.quantity,k.id package_id,k.carrier,k.tracking,k.status,
            l.id order_line_id,l.name,l.spec,l.brand,l.description,l.unit,l.customer_code,o.customer,o.address,o.contact,o.phone,o.po,o.status order_status
            FROM package_lines kl JOIN packages k ON k.id=kl.package_id
            JOIN purchase_lines pl ON pl.id=kl.purchase_line_id JOIN order_lines l ON l.id=pl.order_line_id
            JOIN orders o ON o.id=l.order_id WHERE kl.id=?''', (x['package_line_id'],))
        require(item['order_status'] == 'confirmed', '客户订单已取消或未确认，不能生成送货单')
        require(item['status'] not in ['待揽收', '退回'], '待揽收或已退回包裹不能开送货单，请先核实发货')
        used = con.execute('''SELECT COALESCE(SUM(dl.quantity),0) FROM delivery_lines dl JOIN deliveries d ON d.id=dl.delivery_id
            WHERE dl.package_line_id=? AND d.status='active' ''', (item['id'],)).fetchone()[0]
        amount = qty(x['quantity'])
        require(used + amount <= item['quantity'] + 1e-6, '本次开单数量超过尚未开单数量')
        totals[item['order_line_id']] = totals.get(item['order_line_id'], 0) + amount
        require(totals[item['order_line_id']] <= lc.delivery_limit(con, item['order_line_id']) + 1e-6, '本次开单数量超过取消后的订单剩余数量')
        group = (item['customer'], item['address'], item['contact'], item['phone'])
        if mode == 'separate':
            group += (item['package_id'],)
        groups.setdefault(group, []).append((item, amount))
    require(mode == 'separate' or len(groups) == 1, '合并开单要求客户、收货地址及联系人相同；不同收货信息请批量分别开单')
    ids = []
    for key, values in groups.items():
        pos = {item['po'] for item, _ in values}
        require(len(pos) == 1, '一张送货单只能关联一个客户 PO')
        number = next_delivery_number(con, pos.pop())
        stamp = now()
        cur = con.execute('INSERT INTO deliveries(number,customer,address,contact,phone,company,company_en,company_address,company_phone,note,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            ('TEMP-' + stamp + '-' + str(len(ids)), *key[:4], txt(d, 'company', True), txt(d, 'company_en'), txt(d, 'company_address'), txt(d, 'company_phone'), txt(d, 'note'), stamp))
        did = cur.lastrowid
        con.execute('UPDATE deliveries SET number=?,shipped_at=? WHERE id=?', (number, stamp, did))
        for item, amount in values:
            con.execute('INSERT INTO delivery_lines(delivery_id,package_line_id,order_line_id,quantity,snapshot) VALUES(?,?,?,?,?)',
                (did, item['id'], item['order_line_id'], amount, json.dumps(item, ensure_ascii=False)))
        audit(con, '生成送货单', 'delivery', did)
        ids.append(did)
    return {'ids': ids}


def edit_delivery(con, did, d):
    """修改已生成的送货单：料品与数量、公司抬头、备注；送货单号与实际发货日期保持不变。"""
    delivery = row(con, 'SELECT * FROM deliveries WHERE id=?', (did,))
    require(delivery['status'] == 'active', '已作废的送货单不能修改')
    items = d.get('lines', [])
    require(bool(items) and all('order_line_id' in x for x in items), '请至少保留一项料品')
    unique_ids(items, 'order_line_id')
    replacement = d.get('replacement_case_id') or None
    prepared, groups, pos = [], set(), set()
    for x in items:
        item = row(con, "SELECT l.*,o.customer,o.address,o.contact,o.phone,o.po,o.status order_status FROM order_lines l JOIN orders o ON o.id=l.order_id WHERE l.id=?", (x['order_line_id'],))
        require(item['order_status'] == 'confirmed', '客户订单已取消或未确认，不能修改送货单')
        own = con.execute('SELECT COALESCE(SUM(quantity),0) FROM delivery_lines WHERE delivery_id=? AND order_line_id=? AND replacement_case_id IS ?', (did, item['id'], replacement)).fetchone()[0]
        amount = qty(x['quantity'])
        require(amount <= lc.delivery_limit(con, item['id'], replacement) + own + 1e-6, '本次开单数量超过订单剩余数量')
        package = con.execute("SELECT k.carrier,k.tracking FROM package_lines kl JOIN purchase_lines pl ON pl.id=kl.purchase_line_id JOIN packages k ON k.id=kl.package_id WHERE pl.order_line_id=? AND k.tracking<>'' ORDER BY k.id DESC LIMIT 1", (item['id'],)).fetchone()
        if not package:
            sources = rows(con, "SELECT ps.payload FROM purchase_sources ps JOIN purchases p ON p.id=ps.purchase_id JOIN purchase_lines pl ON pl.purchase_id=p.id WHERE pl.order_line_id=? AND p.deleted_at='' ORDER BY p.id DESC", (item['id'],))
            package = next((shipment for source in sources for shipment in json.loads(source['payload']).get('packages', []) if shipment.get('tracking')), None)
        snapshot = dict(item)
        snapshot['carrier'] = package['carrier'] if package else ''
        snapshot['tracking'] = package['tracking'] if package else ''
        groups.add((item['customer'], item['address'], item['contact'], item['phone']))
        pos.add(item['po'])
        prepared.append((snapshot, amount, txt(x, 'remark')))
    require(len(groups) == 1, '所选料品的收货信息必须一致')
    require(len(pos) == 1, '一张送货单只能关联一个客户 PO')
    group = groups.pop()
    con.execute('DELETE FROM delivery_lines WHERE delivery_id=?', (did,))
    for snapshot, amount, remark in prepared:
        con.execute('INSERT INTO delivery_lines(delivery_id,order_line_id,quantity,snapshot,replacement_case_id,remark) VALUES(?,?,?,?,?,?)',
                    (did, snapshot['id'], amount, json.dumps(snapshot, ensure_ascii=False), replacement, remark))
    con.execute("UPDATE deliveries SET customer=?,address=?,contact=?,phone=?,company=?,company_en=?,company_address=?,company_phone=?,note=? WHERE id=?",
                (txt(d, 'customer') or group[0], txt(d, 'address') or group[1], txt(d, 'contact') or group[2], txt(d, 'phone') or group[3],
                 txt(d, 'company', True), txt(d, 'company_en'), txt(d, 'company_address'), txt(d, 'company_phone'), txt(d, 'note'), did))
    audit(con, '修改送货单', 'delivery', did)
    return {'id': did}


def void_delivery(con, did):
    delivery = row(con, 'SELECT * FROM deliveries WHERE id=?', (did,))
    require(not delivery['shipped_at'], '已实际发货不能直接作废，请登记退货；录入错误需管理员撤销发货确认')
    con.execute("UPDATE deliveries SET status='void' WHERE id=?", (did,))
    audit(con, '作废送货单', 'delivery', did)
    return {'id': did}


def get_state(con):
    data = {table: rows(con, f'SELECT * FROM {table} ORDER BY id DESC') for table in
            ['orders', 'order_lines', 'purchases', 'purchase_lines', 'packages', 'package_lines', 'invoices', 'deliveries', 'delivery_lines', 'tracking_events', 'quotes']}
    data['orders'] = [o for o in data['orders'] if not o['deleted_at']]
    data['purchases'] = [p for p in data['purchases'] if not p['deleted_at']]
    order_ids = {o['id'] for o in data['orders']}
    purchase_ids = {p['id'] for p in data['purchases']}
    data['order_lines'] = [l for l in data['order_lines'] if l['order_id'] in order_ids]
    data['purchase_lines'] = [l for l in data['purchase_lines'] if l['purchase_id'] in purchase_ids]
    data['quotes'] = [q for q in data['quotes'] if q['order_id'] in order_ids]
    data['purchase_drafts'] = [dict(r, payload=json.loads(r['payload'])) for r in con.execute("SELECT * FROM purchase_drafts WHERE status IN ('active','trash') ORDER BY created_at DESC")]
    data['purchase_draft_sync'] = dict(con.execute('SELECT * FROM purchase_draft_sync WHERE id=1').fetchone() or {})
    data['intake_drafts'] = rows(con, "SELECT id,payload,created_at,updated_at FROM intake_drafts WHERE status='active' ORDER BY updated_at DESC")
    for draft in data['intake_drafts']:
        draft['payload'] = json.loads(draft['payload'])
    data['invoice_allocations'] = rows(con, 'SELECT * FROM invoice_allocations')
    sources = {r['purchase_id']: json.loads(r['payload']) for r in con.execute('SELECT * FROM purchase_sources')}
    draft_status = {}
    for row_item in con.execute("SELECT platform_order,payload FROM purchase_drafts WHERE status IN ('active','completed')"):
        draft_status[row_item['platform_order']] = (json.loads(row_item['payload']) or {}).get('transaction_status', '')
    purchase_files = rows(con, '''SELECT pa.purchase_id,pa.attachment_id,a.name,a.mime FROM purchase_attachments pa
        JOIN attachments a ON a.id=pa.attachment_id ORDER BY pa.id''')
    for purchase in data['purchases']:
        purchase['taobao_source'] = sources.get(purchase['id'])
        purchase['transaction_status'] = (purchase['taobao_source'] or {}).get('transaction_status') or draft_status.get(purchase['platform_order'], '')
        purchase['attachments'] = [file for file in purchase_files if file['purchase_id'] == purchase['id']]
    data['customers'] = rows(con, 'SELECT * FROM customers ORDER BY name')
    contacts = rows(con, 'SELECT * FROM customer_contacts ORDER BY id')
    addresses = rows(con, 'SELECT * FROM customer_addresses ORDER BY id')
    for customer in data['customers']:
        customer['invoice_info'] = json.loads(customer['invoice_info'])
        customer['contacts'] = [x for x in contacts if x['customer_id'] == customer['id']]
        customer['addresses'] = [x for x in addresses if x['customer_id'] == customer['id']]
    data['attachments'] = rows(con, 'SELECT * FROM attachments ORDER BY created_at DESC')
    data['audit'] = rows(con, 'SELECT * FROM audit ORDER BY id DESC LIMIT 100')
    data['users'] = rows(con, 'SELECT id,username,display_name,active,created_at,last_login FROM users ORDER BY id')
    company_fields = ('name', 'name_en', 'address', 'phone', 'bank_name', 'bank_account', 'tax_number', 'email', 'company_code')
    data['company'] = dict(con.execute(f"SELECT {','.join(company_fields)} FROM company_profile WHERE id=1").fetchone() or
                           {key: '' for key in company_fields})
    data['today'] = today()
    data['delivery_sender'] = dict(con.execute('SELECT name,phone,address FROM delivery_sender WHERE id=1').fetchone())
    data['tax_settings'] = get_tax_settings(con)
    data['sync_settings'] = get_sync_settings(con)
    data['sync_request'] = dict(con.execute('SELECT * FROM sync_request WHERE id=1').fetchone() or {})
    data['invoice_apply_requests'] = rows(con, 'SELECT * FROM invoice_apply_requests ORDER BY id DESC LIMIT 200')
    data['company_stamps'] = {x['kind']: x['attachment_id'] for x in rows(con, 'SELECT * FROM company_stamps')}
    for line in data['order_lines']:
        pls = [x for x in data['purchase_lines'] if x['order_line_id'] == line['id']]
        line['purchased'] = sum(x['quantity'] for x in pls)
        line['cost_cents'] = sum(x['cost_cents'] for x in pls)
        line['quote_cents'] = int((Decimal(str(line['quantity'])) * line['price_cents']).quantize(Decimal('1'), rounding=ROUND_HALF_UP))
        plids = {x['id'] for x in pls}
        packed = [x for x in data['package_lines'] if x['purchase_line_id'] in plids]
        states = {x['id']: x['status'] for x in data['packages']}
        line['shipped'] = sum(x['quantity'] for x in packed if states[x['package_id']] in ['运输中', '派送中', '已签收', '异常'])
        line['signed'] = sum(x['quantity'] for x in packed if states[x['package_id']] == '已签收')
    for pl in data['purchase_lines']:
        pl['packaged'] = sum(x['quantity'] for x in data['package_lines'] if x['purchase_line_id'] == pl['id'])
    packages = {x['id']: x for x in data['packages']}
    active_deliveries = {x['id'] for x in data['deliveries'] if x['status'] == 'active'}
    for kl in data['package_lines']:
        kl['delivered'] = sum(x['quantity'] for x in data['delivery_lines'] if x['package_line_id'] == kl['id'] and x['delivery_id'] in active_deliveries)
    for p in data['purchases']:
        received = sum(x['amount_cents'] for x in data['invoice_allocations'] if x['purchase_id'] == p['id'])
        p['received_cents'] = received
        p['remaining_cents'] = max(0, p['invoice_expected_cents'] - received)
        p['receipt_status'] = '已收齐' if p['remaining_cents'] == 0 else ('部分收票' if received else '未收票')
        pls = [x for x in data['purchase_lines'] if x['purchase_id'] == p['id']]
        plids = {x['id'] for x in pls}
        kls = [x for x in data['package_lines'] if x['purchase_line_id'] in plids]
        complete = all(x['packaged'] >= x['quantity'] - 1e-6 for x in pls) and bool(kls)
        complete = complete and all(packages[x['package_id']]['status'] == '已签收' for x in kls)
        auto_due = ''
        if complete:
            signed = max(packages[x['package_id']]['signed_at'] for x in kls)
            auto_due = (date.fromisoformat(signed) + timedelta(days=7)).isoformat()
        p['effective_due'] = p['invoice_due'] or auto_due
        p['overdue'] = bool(p['remaining_cents'] and p['invoice_stage'] != '不需开票' and p['effective_due'] and p['effective_due'] <= today())
        p['followup_due'] = bool(p['remaining_cents'] and p['invoice_stage'] != '不需开票' and p['next_followup'] and p['next_followup'] <= today())
    lc.enrich_state(con, data)
    from .sales_invoices import enrich_state
    enrich_state(con, data)
    from . import inventory
    inventory.enrich_state(con, data)
    data['capabilities'] = {'platform_sync': False, 'live_tracking': False, 'ocr': False, 'mode': 'local'}
    return data


def get_sync_settings(con):
    config = dict(con.execute('SELECT enabled,interval_minutes FROM sync_settings WHERE id=1').fetchone())
    config['enabled'] = bool(config['enabled'])
    request = con.execute('SELECT * FROM sync_request WHERE id=1').fetchone()
    if request:
        config['manual_sync'] = dict(request)
    return config


def save_sync_settings(con, d):
    require(type(d.get('enabled')) is bool, '同步开关无效')
    minutes = d.get('interval_minutes')
    require(type(minutes) is int and 1 <= minutes <= 1440, '同步间隔须为 1 至 1440 分钟的整数')
    con.execute('UPDATE sync_settings SET enabled=?,interval_minutes=? WHERE id=1', (d['enabled'], minutes))
    audit(con, '更新同步设置', 'settings', 1)
    return get_sync_settings(con)


REMIND_INTERVAL_DAYS = 5


def remind_invoice(con, pid, d):
    """记录一次发票催办：累计催票次数，更新催票时间与下次跟进日。"""
    purchase = row(con, "SELECT * FROM purchases WHERE id=? AND deleted_at=''", (pid,))
    require(purchase['invoice_stage'] != '不需开票', '该采购设置为不需开票')
    channel = txt(d, 'channel') or '催票'
    note = txt(d, 'note')
    days = str(d.get('next_days') or '').strip()
    interval = int(days) if days.isdigit() and 0 < int(days) <= 90 else REMIND_INTERVAL_DAYS
    next_followup = valid_date(d.get('next_followup')) or (datetime.now(TZ) + timedelta(days=interval)).date().isoformat()
    con.execute('UPDATE purchases SET invoice_remind_count=invoice_remind_count+1, invoice_reminded_at=?, next_followup=?, followup=? WHERE id=?',
                (now(), next_followup, note or purchase['followup'], pid))
    audit(con, '催开发票', 'purchase', pid, (channel + '：' + note) if note else channel)
    return dict(row(con, 'SELECT id,invoice_remind_count,invoice_reminded_at,next_followup FROM purchases WHERE id=?', (pid,)))


def queue_invoice_apply(con, pid, d):
    """把「平台内申请开票」排入客户端任务队列（需客户端在线并登录淘宝）。"""
    purchase = row(con, "SELECT * FROM purchases WHERE id=? AND deleted_at='' AND archived_at=''", (pid,))
    require(purchase['platform'] == '淘宝', '目前仅支持淘宝平台内申请开票')
    require(purchase['invoice_stage'] != '不需开票', '该采购设置为不需开票')
    require(not con.execute("SELECT 1 FROM invoice_apply_requests WHERE purchase_id=? AND status IN ('pending','running')", (pid,)).fetchone(),
            '该采购已有待执行的申请开票任务')
    rid = con.execute('''INSERT INTO invoice_apply_requests(purchase_id,platform_order,shop,status,message,created_by,created_at,updated_at)
        VALUES(?,?,?,'pending',?,?,?,?)''',
        (pid, purchase['platform_order'], purchase['shop'], txt(d, 'note'), actor_id.get() or None, now(), now())).lastrowid
    audit(con, '申请开票（平台）', 'purchase', pid, '已排入客户端任务队列')
    return {'id': rid, 'status': 'pending'}


def pending_invoice_applies(con):
    """客户端领取任务；超过 3 分钟没有更新的 running 任务会重新排队。"""
    stale = (datetime.now(TZ) - timedelta(minutes=3)).isoformat(timespec='seconds')
    con.execute("UPDATE invoice_apply_requests SET status='pending',updated_at=? WHERE status='running' AND updated_at<?", (now(), stale))
    return [dict(r) for r in rows(con, "SELECT * FROM invoice_apply_requests WHERE status='pending' ORDER BY id LIMIT 20")]


def finish_invoice_apply(con, rid, d):
    request = row(con, 'SELECT * FROM invoice_apply_requests WHERE id=?', (rid,))
    status = txt(d, 'status', True)
    require(status in ('done', 'failed', 'manual'), '申请开票结果无效')
    message = txt(d, 'message')[:500]
    con.execute('UPDATE invoice_apply_requests SET status=?,message=?,updated_at=? WHERE id=?', (status, message, now(), rid))
    if status == 'done':
        remind_invoice(con, request['purchase_id'], {'channel': '平台申请', 'note': message})
    audit(con, '申请开票结果', 'invoice_apply', rid, message or status)
    return {'id': rid, 'status': status}


def request_sync(con):
    import uuid
    current = con.execute('SELECT * FROM sync_request WHERE id=1').fetchone()
    if current and current['status'] in ('pending','running') and (current['status'] == 'pending' or datetime.fromisoformat(current['updated_at']) > datetime.now(TZ) - timedelta(minutes=2)):
        return dict(current)
    con.execute("INSERT INTO sync_request VALUES(1,?,'pending',?,?,'') ON CONFLICT(id) DO UPDATE SET request_id=excluded.request_id,status='pending',requested_at=excluded.requested_at,updated_at=excluded.updated_at,error=''", (uuid.uuid4().hex,now(),now()))
    audit(con, '请求立即同步', 'settings', 1)
    return dict(con.execute('SELECT * FROM sync_request WHERE id=1').fetchone())


def update_sync_request(con, action, d):
    request_id = txt(d, 'request_id', True)
    if action == 'start':
        changed = con.execute("UPDATE sync_request SET status='running',updated_at=? WHERE id=1 AND request_id=? AND (status='pending' OR (status='running' AND updated_at<?))", (now(),request_id,(datetime.now(TZ)-timedelta(minutes=2)).isoformat(timespec='seconds')))
        return {'claimed':bool(changed.rowcount)}
    if action == 'heartbeat':
        con.execute("UPDATE sync_request SET updated_at=? WHERE id=1 AND request_id=? AND status='running'", (now(),request_id))
    else:
        error = txt(d,'error')[:1000]
        con.execute("UPDATE sync_request SET status=?,updated_at=?,error=? WHERE id=1 AND request_id=? AND status='running'", ('failed' if error else 'done',now(),error,request_id))
    return {'ok':True}

def save_delivery_sender(con, d):
    values = [txt(d, key) for key in ('name','phone','address')]
    require(len(values[0]) <= 60 and len(values[1]) <= 60 and len(values[2]) <= 200, '发货人信息过长')
    con.execute('UPDATE delivery_sender SET name=?,phone=?,address=? WHERE id=1', values)
    audit(con, '更新发货人信息', 'settings', 1)
    return {'ok': True}

def get_tax_settings(con):
    config = dict(con.execute('SELECT rates,default_rate FROM tax_settings WHERE id=1').fetchone())
    config['rates'] = json.loads(config['rates'])
    return config

def save_tax_settings(con, d):
    rates = d.get('rates', [])
    require(isinstance(rates,list) and 0 < len(rates) <= 30, '请设置1至30种税率')
    rates = list(dict.fromkeys(valid_tax_rate(r) for r in rates))
    default = valid_tax_rate(d.get('default_rate'))
    require(default in rates, '默认税率必须在税率列表中')
    con.execute('UPDATE tax_settings SET rates=?,default_rate=? WHERE id=1',(json.dumps(rates),default))
    audit(con,'更新全局税率','settings',1)
    return get_tax_settings(con)
