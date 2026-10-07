"""Quantity-based order changes, after-sales and recoverable record management."""
import re
import json
from math import isfinite
from . import domain as dm


def migrate(con):
    for table, columns in {
        'orders': ('archived_at', 'deleted_at'),
        'purchases': ('archived_at', 'deleted_at'),
        'deliveries': ('shipped_at',),
    }.items():
        existing = {r['name'] for r in con.execute(f'PRAGMA table_info({table})')}
        for column in columns:
            if column not in existing:
                con.execute(f"ALTER TABLE {table} ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")
    if 'replacement_case_id' not in {r['name'] for r in con.execute('PRAGMA table_info(delivery_lines)')}:
        con.execute('ALTER TABLE delivery_lines ADD COLUMN replacement_case_id INTEGER REFERENCES order_cases(id)')
    if 'created_by_case_id' not in {r['name'] for r in con.execute('PRAGMA table_info(purchase_lines)')}:
        con.execute('ALTER TABLE purchase_lines ADD COLUMN created_by_case_id INTEGER REFERENCES purchase_cases(id)')
    con.executescript('''
    CREATE TABLE IF NOT EXISTS order_cases (
      id INTEGER PRIMARY KEY, order_line_id INTEGER NOT NULL REFERENCES order_lines(id),
      delivery_line_id INTEGER REFERENCES delivery_lines(id), purchase_line_id INTEGER REFERENCES purchase_lines(id),
      kind TEXT NOT NULL, quantity REAL NOT NULL CHECK(quantity>0), reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', received_quantity REAL NOT NULL DEFAULT 0,
      financial_type TEXT NOT NULL DEFAULT 'none', amount_cents INTEGER NOT NULL DEFAULT 0,
      finance_confirmed_at TEXT NOT NULL DEFAULT '', tracking TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '', evidence_id TEXT REFERENCES attachments(id),
      owner_id INTEGER REFERENCES users(id), created_at TEXT NOT NULL, completed_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS purchase_cases (
      id INTEGER PRIMARY KEY, purchase_line_id INTEGER NOT NULL REFERENCES purchase_lines(id),
      order_case_id INTEGER REFERENCES order_cases(id), quantity REAL NOT NULL CHECK(quantity>0),
      kind TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', reason TEXT NOT NULL,
      cost_cents INTEGER NOT NULL, amount_cents INTEGER NOT NULL DEFAULT 0,
      finance_confirmed_at TEXT NOT NULL DEFAULT '', target_order_line_id INTEGER REFERENCES order_lines(id),
      location TEXT NOT NULL DEFAULT '', tracking TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
      invoice_note TEXT NOT NULL DEFAULT '', evidence_id TEXT REFERENCES attachments(id),
      owner_id INTEGER REFERENCES users(id), created_at TEXT NOT NULL, completed_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS order_receipts (
      id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
      note TEXT NOT NULL, evidence_id TEXT REFERENCES attachments(id), created_at TEXT NOT NULL,
      voided_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS stock_moves (
      id INTEGER PRIMARY KEY, purchase_case_id INTEGER NOT NULL REFERENCES purchase_cases(id),
      purchase_line_id INTEGER NOT NULL REFERENCES purchase_lines(id), quantity REAL NOT NULL CHECK(quantity>0),
      cost_cents INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_order_cases_line ON order_cases(order_line_id);
    CREATE INDEX IF NOT EXISTS ix_purchase_cases_line ON purchase_cases(purchase_line_id);
    ''')
    if 'voided_at' not in {r['name'] for r in con.execute('PRAGMA table_info(stock_moves)')}:
        con.execute("ALTER TABLE stock_moves ADD COLUMN voided_at TEXT NOT NULL DEFAULT ''")


def admin(con):
    dm.require(dm.actor_id.get() == 1, '仅管理员可确认金额、恢复或撤销已完成操作')


def active_order(con, oid, allow_archived=False):
    order = dm.row(con, "SELECT * FROM orders WHERE id=? AND deleted_at=''", (oid,))
    dm.require(allow_archived or not order['archived_at'], '订单已归档，请先取消归档')
    return order


def evidence(con, d):
    aid = d.get('evidence_id') or None
    if aid:
        dm.row(con, 'SELECT id FROM attachments WHERE id=?', (aid,))
    return aid


def owner(con, d):
    uid = d.get('owner_id') or dm.actor_id.get() or 1
    dm.row(con, 'SELECT id FROM users WHERE id=? AND active=1', (uid,))
    return uid


def cancelled_qty(con, lid):
    total = con.execute("SELECT COALESCE(SUM(quantity),0) FROM order_cases WHERE order_line_id=? AND kind='cancel' AND status!='void'", (lid,)).fetchone()[0]
    line = dm.row(con, 'SELECT l.quantity,o.status FROM order_lines l JOIN orders o ON o.id=l.order_id WHERE l.id=?', (lid,))
    if line['status'] == 'cancelled' and not con.execute('SELECT 1 FROM order_cases WHERE order_line_id=?', (lid,)).fetchone():
        return line['quantity']
    return total


def purchase_balance(con, plid):
    line = dm.row(con, 'SELECT * FROM purchase_lines WHERE id=?', (plid,))
    if con.execute("SELECT 1 FROM stock_moves WHERE purchase_line_id=? AND voided_at!=''", (plid,)).fetchone():
        return 0, 0
    released = con.execute("SELECT COALESCE(SUM(quantity),0),COALESCE(SUM(cost_cents),0) FROM purchase_cases WHERE purchase_line_id=? AND status='completed'", (plid,)).fetchone()
    return round(line['quantity'] - released[0], 6), line['cost_cents'] - released[1]


def purchased_qty(con, lid):
    return sum(purchase_balance(con, r['id'])[0] for r in con.execute("SELECT pl.id FROM purchase_lines pl JOIN purchases p ON p.id=pl.purchase_id WHERE pl.order_line_id=? AND p.deleted_at=''", (lid,)))


def demand_qty(con, lid):
    line = dm.row(con, 'SELECT quantity FROM order_lines WHERE id=?', (lid,))
    returned = con.execute("SELECT COALESCE(SUM(received_quantity),0) FROM order_cases WHERE order_line_id=? AND kind='return' AND status!='void'", (lid,)).fetchone()[0]
    return max(0, line['quantity'] - cancelled_qty(con, lid) - returned)


def shipped_qty(con, lid):
    delivered = con.execute("SELECT COALESCE(SUM(dl.quantity),0) FROM delivery_lines dl JOIN deliveries d ON d.id=dl.delivery_id WHERE dl.order_line_id=? AND dl.replacement_case_id IS NULL AND d.status='active' AND d.shipped_at!=''", (lid,)).fetchone()[0]
    # Logistics is also evidence of dispatch; a later 'returned' status must not release it.
    packaged = con.execute("""SELECT COALESCE(SUM(kl.quantity),0) FROM package_lines kl JOIN packages k ON k.id=kl.package_id
        JOIN purchase_lines pl ON pl.id=kl.purchase_line_id WHERE pl.order_line_id=? AND
        (k.status!='待揽收' OR EXISTS(SELECT 1 FROM tracking_events e WHERE e.package_id=k.id AND e.status!='待揽收'))""", (lid,)).fetchone()[0]
    return max(delivered, packaged)


def reserve_delivery(con, lid, replacement_case_id=None):
    return con.execute("""SELECT COALESCE(SUM(dl.quantity),0) FROM delivery_lines dl JOIN deliveries d ON d.id=dl.delivery_id
        WHERE dl.order_line_id=? AND dl.replacement_case_id IS ? AND d.status='active'""", (lid, replacement_case_id)).fetchone()[0]


def delivery_limit(con, lid, replacement_case_id=None):
    line = dm.row(con, 'SELECT * FROM order_lines WHERE id=?', (lid,))
    order = active_order(con, line['order_id'])
    dm.require(order['status'] == 'confirmed', '客户订单已取消或未确认，不能生成送货单')
    if replacement_case_id:
        case = dm.row(con, "SELECT * FROM order_cases WHERE id=? AND kind='exchange' AND status!='void'", (replacement_case_id,))
        dm.require(case['order_line_id'] == lid, '补发必须关联原换货料品')
        return case['received_quantity'] - reserve_delivery(con, lid, replacement_case_id)
    return line['quantity'] - cancelled_qty(con, lid) - reserve_delivery(con, lid)


def make_purchase_case(con, plid, amount, reason, order_case_id=None):
    balance, cost = purchase_balance(con, plid)
    pending = con.execute("SELECT COALESCE(SUM(quantity),0),COALESCE(SUM(cost_cents),0) FROM purchase_cases WHERE purchase_line_id=? AND status IN ('pending','processing')", (plid,)).fetchone()
    dm.require(amount <= balance - pending[0] + 1e-6, '采购待处理数量超过可处理数量')
    available_cost = cost - pending[1]
    allocated_cost = available_cost if abs(amount - (balance - pending[0])) < 1e-6 else round(available_cost * amount / (balance - pending[0]))
    return con.execute('INSERT INTO purchase_cases(purchase_line_id,order_case_id,quantity,reason,cost_cents,owner_id,created_at) VALUES(?,?,?,?,?,?,?)',
                       (plid, order_case_id, amount, reason, allocated_cost, dm.actor_id.get() or 1, dm.now())).lastrowid


def cancel_purchase_tasks(con, lid, case_id, reason):
    lines = dm.rows(con, "SELECT pl.* FROM purchase_lines pl JOIN purchases p ON p.id=pl.purchase_id WHERE pl.order_line_id=? AND p.deleted_at='' ORDER BY pl.id DESC", (lid,))
    pending = con.execute("SELECT COALESCE(SUM(pc.quantity),0) FROM purchase_cases pc JOIN purchase_lines pl ON pl.id=pc.purchase_line_id WHERE pl.order_line_id=? AND pc.status IN ('pending','processing')", (lid,)).fetchone()[0]
    remaining = max(0, purchased_qty(con, lid) - demand_qty(con, lid) - pending)
    for line in lines:
        reserved = con.execute("SELECT COALESCE(SUM(quantity),0) FROM purchase_cases WHERE purchase_line_id=? AND status IN ('pending','processing')", (line['id'],)).fetchone()[0]
        amount = min(remaining, purchase_balance(con, line['id'])[0] - reserved)
        if amount > 1e-6:
            make_purchase_case(con, line['id'], amount, reason, case_id)
            remaining -= amount


def refresh_order_status(con, oid):
    lines = dm.rows(con, 'SELECT * FROM order_lines WHERE order_id=?', (oid,))
    fully = all(cancelled_qty(con, l['id']) >= l['quantity'] - 1e-6 for l in lines)
    if fully:
        con.execute("UPDATE orders SET status='cancelled',cancelled_at=? WHERE id=?", (dm.now(), oid))
    elif dm.row(con, 'SELECT status FROM orders WHERE id=?', (oid,))['status'] == 'cancelled':
        confirmed = con.execute('SELECT 1 FROM quotes WHERE order_id=?', (oid,)).fetchone()
        con.execute("UPDATE orders SET status=?,cancelled_at='' WHERE id=?", ('confirmed' if confirmed else 'draft', oid))


def create_order_case(con, oid, d):
    order = active_order(con, oid, True)
    line = dm.row(con, 'SELECT * FROM order_lines WHERE id=? AND order_id=?', (d.get('order_line_id'), oid))
    kind, reason, quantity = dm.txt(d, 'kind', True), dm.txt(d, 'reason', True), dm.qty(d.get('quantity'))
    dm.require(kind in ('cancel', 'return', 'exchange', 'refund_only'), '业务处理类型无效')
    delivery_id, source_id = d.get('delivery_line_id') or None, d.get('purchase_line_id') or None
    if kind == 'cancel':
        dm.require(quantity <= line['quantity'] - cancelled_qty(con, line['id']) - shipped_qty(con, line['id']) + 1e-6, '只能取消尚未实际发出的数量；已发货部分请登记售后')
        reserved = reserve_delivery(con, line['id'])
        dm.require(quantity <= line['quantity'] - cancelled_qty(con, line['id']) - reserved + 1e-6, '未发货送货单已占用数量，请先作废对应送货单再取消')
        delivery_id, source_id = None, None
    else:
        delivery = dm.row(con, "SELECT dl.*,d.shipped_at FROM delivery_lines dl JOIN deliveries d ON d.id=dl.delivery_id WHERE dl.id=? AND dl.order_line_id=? AND d.status='active'", (delivery_id, line['id']))
        dm.require(delivery['shipped_at'], '请先核实并确认实际发货，再登记售后')
        used = con.execute("SELECT COALESCE(SUM(quantity),0) FROM order_cases WHERE delivery_line_id=? AND status!='void'", (delivery_id,)).fetchone()[0]
        dm.require(quantity + used <= delivery['quantity'] + 1e-6, '数量超过该次发货尚未申请售后的数量')
        if source_id:
            dm.row(con, "SELECT pl.id FROM purchase_lines pl JOIN purchases p ON p.id=pl.purchase_id WHERE pl.id=? AND pl.order_line_id=? AND p.deleted_at=''", (source_id, line['id']))
            dm.require(quantity <= purchase_balance(con, source_id)[0] + 1e-6, '退货数量超过所选采购来源数量，请分开登记')
    financial_type = d.get('financial_type', 'reduce_receivable' if kind == 'cancel' else 'none')
    dm.require(financial_type in ('none', 'reduce_receivable', 'refund_received'), '金额处理方式无效')
    amount = dm.money(d.get('amount', round(quantity * line['price_cents']) / 100 if kind == 'cancel' else 0)) if financial_type != 'none' else 0
    case_id = con.execute('''INSERT INTO order_cases(order_line_id,delivery_line_id,purchase_line_id,kind,quantity,reason,financial_type,amount_cents,owner_id,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)''', (line['id'], delivery_id, source_id, kind, quantity, reason, financial_type, amount, owner(con, d), dm.now())).lastrowid
    if kind == 'cancel':
        cancel_purchase_tasks(con, line['id'], case_id, reason)
        con.execute('UPDATE orders SET cancellation_reason=? WHERE id=?', (reason, oid))
        refresh_order_status(con, oid)
    dm.audit(con, '登记订单变更/售后', 'order_case', case_id, reason)
    return {'id': case_id}


def update_order_case(con, cid, d):
    case = dm.row(con, 'SELECT * FROM order_cases WHERE id=?', (cid,))
    dm.require(case['status'] in ('pending', 'processing'), '已完成或已撤销的售后不能直接修改')
    received = float(d.get('received_quantity', case['received_quantity']))
    dm.require(isfinite(received) and abs(received - round(received, 6)) < 1e-9 and 0 <= received <= case['quantity'] and received >= case['received_quantity'], '实收数量必须递增且不超过申请数量；错误实收请管理员撤销后重建')
    dm.require(case['kind'] in ('return', 'exchange') or received == 0, '此处理类型无需收货')
    note, location = dm.txt(d, 'note'), dm.txt(d, 'location')
    if received > case['received_quantity'] and case['purchase_line_id']:
        make_purchase_case(con, case['purchase_line_id'], round(received - case['received_quantity'], 6), '客户退回：' + case['reason'], cid)
    if received and not case['purchase_line_id']:
        dm.require(location, '未关联采购来源的退回货物，请登记存放位置')
    financial_type = d.get('financial_type', case['financial_type'])
    dm.require(financial_type in ('none', 'reduce_receivable', 'refund_received'), '金额处理方式无效')
    amount = dm.money(d.get('amount', case['amount_cents'] / 100)) if financial_type != 'none' else 0
    dm.require(not case['finance_confirmed_at'] or (amount == case['amount_cents'] and financial_type == case['financial_type']), '金额已确认，请管理员撤销后更正')
    con.execute('''UPDATE order_cases SET received_quantity=?,status='processing',tracking=?,note=?,location=?,evidence_id=?,owner_id=?,financial_type=?,amount_cents=? WHERE id=?''',
                (received, dm.txt(d, 'tracking'), note, location, evidence(con, d), owner(con, d), financial_type, amount, cid))
    dm.audit(con, '更新售后进度', 'order_case', cid, note)
    return {'id': cid}


def confirm_case_finance(con, table, cid):
    admin(con)
    case = dm.row(con, f'SELECT * FROM {table} WHERE id=?', (cid,))
    dm.require(case['status'] not in ('void', 'completed') and not case['finance_confirmed_at'], '该金额已确认或业务已结束')
    if table == 'order_cases':
        oid = dm.row(con, 'SELECT order_id FROM order_lines WHERE id=?', (case['order_line_id'],))['order_id']
        if case['financial_type'] == 'refund_received':
            receipts = con.execute("SELECT COALESCE(SUM(amount_cents),0) FROM order_receipts WHERE order_id=? AND voided_at=''", (oid,)).fetchone()[0]
            refunded = con.execute("SELECT COALESCE(SUM(c.amount_cents),0) FROM order_cases c JOIN order_lines l ON l.id=c.order_line_id WHERE l.order_id=? AND c.financial_type='refund_received' AND c.finance_confirmed_at!='' AND c.status!='void'", (oid,)).fetchone()[0]
            dm.require(case['amount_cents'] <= receipts - refunded, '退款超过已登记收款余额，请先核对收款记录')
            from .sales_invoices import allocated_receipts
            dm.require(case['amount_cents'] <= receipts - refunded - allocated_receipts(con, oid), '回款已分配至发票，请先调整发票回款分配再确认退款')
    else:
        pid = dm.row(con, 'SELECT purchase_id FROM purchase_lines WHERE id=?', (case['purchase_line_id'],))['purchase_id']
        paid = dm.row(con, 'SELECT amount_cents FROM purchases WHERE id=?', (pid,))['amount_cents']
        refunded = con.execute("SELECT COALESCE(SUM(c.amount_cents),0) FROM purchase_cases c JOIN purchase_lines l ON l.id=c.purchase_line_id WHERE l.purchase_id=? AND c.finance_confirmed_at!='' AND c.status!='void'", (pid,)).fetchone()[0]
        dm.require(case['amount_cents'] <= paid - refunded, '供应商退款累计超过采购实付款')
    con.execute(f'UPDATE {table} SET finance_confirmed_at=? WHERE id=?', (dm.now(), cid))
    dm.audit(con, '确认退款/金额调整', table, cid, str(case['amount_cents']))
    return {'id': cid}


def complete_order_case(con, cid):
    case = dm.row(con, 'SELECT * FROM order_cases WHERE id=?', (cid,))
    dm.require(case['status'] in ('pending', 'processing'), '该售后已结束')
    if case['kind'] in ('return', 'exchange'):
        dm.require(case['received_quantity'] >= case['quantity'] - 1e-6, '退回货物尚未收齐')
    dm.require(not case['amount_cents'] or case['financial_type'] == 'none' or case['finance_confirmed_at'], '金额尚待管理员最终确认')
    dm.require(not con.execute("SELECT 1 FROM purchase_cases WHERE order_case_id=? AND status IN ('pending','processing')", (cid,)).fetchone(), '关联采购处理尚未完成')
    if case['kind'] == 'exchange':
        sent = con.execute("SELECT COALESCE(SUM(dl.quantity),0) FROM delivery_lines dl JOIN deliveries d ON d.id=dl.delivery_id WHERE dl.replacement_case_id=? AND d.status='active' AND d.shipped_at!=''", (cid,)).fetchone()[0]
        dm.require(sent >= case['quantity'] - 1e-6, '换货补发尚未完成，请从送货单选择此换货记录补发')
    dm.require(case['note'] or case['kind'] == 'cancel', '请记录货物处理结果')
    con.execute("UPDATE order_cases SET status='completed',completed_at=? WHERE id=?", (dm.now(), cid))
    dm.audit(con, '完成订单售后', 'order_case', cid)
    return {'id': cid}


def update_purchase_case(con, cid, d):
    case = dm.row(con, 'SELECT * FROM purchase_cases WHERE id=?', (cid,))
    dm.require(case['status'] in ('pending', 'processing'), '采购处理已结束')
    kind = dm.txt(d, 'kind', True)
    dm.require(kind in ('cancel', 'supplier_return', 'stock', 'transfer'), '请选择取消采购、退供应商、转库存或转其他订单')
    amount = dm.money(d.get('amount'))
    dm.require(kind in ('cancel', 'supplier_return') or amount == 0, '转库存或转单不应登记供应商退款')
    dm.require(not case['finance_confirmed_at'] or (amount == case['amount_cents'] and kind == case['kind']), '已确认的退款不能直接修改')
    target = d.get('target_order_line_id') or None
    if kind == 'transfer':
        target_line = dm.row(con, 'SELECT * FROM order_lines WHERE id=?', (target,))
        order = active_order(con, target_line['order_id'])
        dm.require(order['status'] == 'confirmed', '转入订单必须为已确认订单')
        source = dm.row(con, 'SELECT order_line_id FROM purchase_lines WHERE id=?', (case['purchase_line_id'],))
        dm.require(target != source['order_line_id'], '请选择其他订单料品')
    else:
        target = None
    location, note = dm.txt(d, 'location'), dm.txt(d, 'note', True)
    dm.require(kind != 'stock' or location, '转库存必须填写存放位置')
    con.execute("""UPDATE purchase_cases SET kind=?,status='processing',amount_cents=?,target_order_line_id=?,location=?,tracking=?,note=?,invoice_note=?,evidence_id=?,owner_id=? WHERE id=?""",
                (kind, amount, target, location, dm.txt(d, 'tracking'), note, dm.txt(d, 'invoice_note'), evidence(con, d), owner(con, d), cid))
    dm.audit(con, '更新采购处理', 'purchase_case', cid, note)
    return {'id': cid}


def complete_purchase_case(con, cid):
    case = dm.row(con, 'SELECT * FROM purchase_cases WHERE id=?', (cid,))
    dm.require(case['status'] == 'processing' and case['kind'], '请先填写采购处理方式和结果')
    dm.require(case['kind'] == 'supplier_return' or not case['amount_cents'] or case['finance_confirmed_at'], '供应商退款尚待管理员确认实际到账')
    line = dm.row(con, 'SELECT * FROM purchase_lines WHERE id=?', (case['purchase_line_id'],))
    dm.require(case['quantity'] <= purchase_balance(con, line['id'])[0] + 1e-6, '采购可处理数量不足')
    returned = con.execute("SELECT COALESCE(SUM(received_quantity),0) FROM order_cases WHERE order_line_id=? AND status!='void'", (line['order_line_id'],)).fetchone()[0]
    dispatched = con.execute("SELECT COALESCE(SUM(dl.quantity),0) FROM delivery_lines dl JOIN deliveries d ON d.id=dl.delivery_id WHERE dl.order_line_id=? AND d.status='active' AND d.shipped_at!=''", (line['order_line_id'],)).fetchone()[0]
    retained = max(0, max(dispatched, shipped_qty(con, line['order_line_id'])) - returned)
    dm.require(purchased_qty(con, line['order_line_id']) - case['quantity'] >= retained - 1e-6, '此数量仍在已发给客户的货物中，请先核实退回收货记录')
    if case['kind'] != 'supplier_return' and case['amount_cents'] and con.execute('SELECT 1 FROM invoice_allocations WHERE purchase_id=?', (line['purchase_id'],)).fetchone():
        dm.require(case['invoice_note'], '采购已关联发票，请记录发票调整核对结果')
    if case['kind'] == 'transfer':
        target = dm.row(con, 'SELECT * FROM order_lines WHERE id=?', (case['target_order_line_id'],))
        dm.require(active_order(con, target['order_id'])['status'] == 'confirmed', '目标订单已取消或未确认')
        dm.require(case['quantity'] + purchased_qty(con, target['id']) <= demand_qty(con, target['id']) + 1e-6, '转入数量超过目标订单待采购数量')
        con.execute('''INSERT INTO purchase_lines(purchase_id,order_line_id,quantity,purchase_spec,purchase_quantity,purchase_unit,link,cost_cents,created_by_case_id)
            VALUES(?,?,?,?,?,?,?,?,?)''', (line['purchase_id'], target['id'], case['quantity'], line['purchase_spec'],
            line['purchase_quantity'] * case['quantity'] / line['quantity'], line['purchase_unit'], line['link'], case['cost_cents'], cid))
    con.execute("UPDATE purchase_cases SET status='completed',completed_at=? WHERE id=?", (dm.now(), cid))
    dm.audit(con, '完成采购处理', 'purchase_case', cid, case['kind'])
    return {'id': cid}


def void_case(con, table, cid, d):
    reason = dm.txt(d, 'reason', True)
    case = dm.row(con, f'SELECT * FROM {table} WHERE id=?', (cid,))
    if table != 'purchase_cases' or case['kind'] != 'supplier_return':
        admin(con)
    elif case['status'] == 'completed':
        line = dm.row(con, 'SELECT * FROM purchase_lines WHERE id=?', (case['purchase_line_id'],))
        dm.require(purchased_qty(con, line['order_line_id']) + case['quantity'] <= demand_qty(con, line['order_line_id']) + 1e-6, '已重新采购或需求已减少，请核对后再恢复采购')
    dm.require(case['status'] != 'void', '已撤销')
    if table == 'order_cases':
        dm.require(not con.execute("SELECT 1 FROM purchase_cases WHERE order_case_id=? AND status='completed'", (cid,)).fetchone(), '请先撤销已完成的关联采购处理')
        dm.require(not con.execute("SELECT 1 FROM delivery_lines dl JOIN deliveries d ON d.id=dl.delivery_id WHERE dl.replacement_case_id=? AND d.status='active'", (cid,)).fetchone(), '请先处理关联补发送货单')
        con.execute("UPDATE purchase_cases SET status='void' WHERE order_case_id=?", (cid,))
        con.execute("UPDATE order_cases SET status='void' WHERE id=?", (cid,))
        oid = dm.row(con, 'SELECT order_id FROM order_lines WHERE id=?', (case['order_line_id'],))['order_id']
        refresh_order_status(con, oid)
    else:
        dm.require(not con.execute("SELECT 1 FROM stock_moves WHERE purchase_case_id=? AND voided_at=''", (cid,)).fetchone(), '库存已经转出，不能撤销来源处理')
        targets = dm.rows(con, 'SELECT * FROM purchase_lines WHERE created_by_case_id=?', (cid,))
        for target in targets:
            dm.require(not con.execute('SELECT 1 FROM package_lines WHERE purchase_line_id=?', (target['id'],)).fetchone(), '转入料品已分包，请先处理下游记录')
            dm.require(not con.execute('SELECT 1 FROM delivery_lines WHERE order_line_id=?', (target['order_line_id'],)).fetchone(), '转入订单已有送货记录，请先处理下游记录')
            dm.require(not con.execute('SELECT 1 FROM purchase_cases WHERE purchase_line_id=?', (target['id'],)).fetchone(), '转入料品已有后续采购处理')
            con.execute('DELETE FROM purchase_lines WHERE id=?', (target['id'],))
        con.execute("UPDATE purchase_cases SET status='void' WHERE id=?", (cid,))
        if case['order_case_id']:
            make_purchase_case(con, case['purchase_line_id'], case['quantity'], '重新处理：' + case['reason'], case['order_case_id'])
            con.execute("UPDATE order_cases SET status='processing',completed_at='' WHERE id=? AND status='completed'", (case['order_case_id'],))
    dm.audit(con, '撤销业务处理', table, cid, reason)
    return {'id': cid}


def confirm_shipment(con, did):
    delivery = dm.row(con, "SELECT * FROM deliveries WHERE id=? AND status='active'", (did,))
    dm.require(not delivery['shipped_at'], '已经确认发货')
    for line in dm.rows(con, 'SELECT * FROM delivery_lines WHERE delivery_id=?', (did,)):
        order_line = dm.row(con, 'SELECT * FROM order_lines WHERE id=?', (line['order_line_id'],))
        dm.require(active_order(con, order_line['order_id'])['status'] == 'confirmed', '订单已取消或未确认，不能发货')
        dm.require(delivery_limit(con, order_line['id'], line['replacement_case_id']) >= -1e-6, '取消或退货后的可发数量不足，请重新核对送货单')
    con.execute('UPDATE deliveries SET shipped_at=? WHERE id=?', (dm.now(), did))
    dm.audit(con, '确认实际发货', 'delivery', did)
    return {'id': did}


def receipt(con, oid, d):
    admin(con)
    active_order(con, oid, True)
    amount = dm.money(d.get('amount'))
    dm.require(amount > 0, '收款金额必须大于零')
    rid = con.execute('INSERT INTO order_receipts(order_id,amount_cents,note,evidence_id,created_at) VALUES(?,?,?,?,?)',
                      (oid, amount, dm.txt(d, 'note', True), evidence(con, d), dm.now())).lastrowid
    dm.audit(con, '登记客户实际收款', 'order_receipt', rid)
    return {'id': rid}


def move_stock(con, cid, d):
    case = dm.row(con, "SELECT * FROM purchase_cases WHERE id=? AND status='completed' AND kind='stock'", (cid,))
    amount = dm.qty(d.get('quantity'))
    used = con.execute("SELECT COALESCE(SUM(quantity),0),COALESCE(SUM(cost_cents),0) FROM stock_moves WHERE purchase_case_id=? AND voided_at=''", (cid,)).fetchone()
    dm.require(amount <= case['quantity'] - used[0] + 1e-6, '转出超过库存剩余数量')
    target = dm.row(con, 'SELECT * FROM order_lines WHERE id=?', (d.get('target_order_line_id'),))
    dm.require(active_order(con, target['order_id'])['status'] == 'confirmed', '转入订单必须已确认')
    dm.require(amount + purchased_qty(con, target['id']) <= demand_qty(con, target['id']) + 1e-6, '转入超过订单待采购数量')
    source = dm.row(con, 'SELECT * FROM purchase_lines WHERE id=?', (case['purchase_line_id'],))
    cost = case['cost_cents'] - used[1] if abs(amount - (case['quantity'] - used[0])) < 1e-6 else round((case['cost_cents'] - used[1]) * amount / (case['quantity'] - used[0]))
    lid = con.execute('''INSERT INTO purchase_lines(purchase_id,order_line_id,quantity,purchase_spec,purchase_quantity,purchase_unit,link,cost_cents)
        VALUES(?,?,?,?,?,?,?,?)''', (source['purchase_id'], target['id'], amount, source['purchase_spec'], source['purchase_quantity'] * amount / source['quantity'], source['purchase_unit'], source['link'], cost)).lastrowid
    con.execute('INSERT INTO stock_moves(purchase_case_id,purchase_line_id,quantity,cost_cents,created_at) VALUES(?,?,?,?,?)', (cid, lid, amount, cost, dm.now()))
    dm.audit(con, '库存转入订单', 'purchase_case', cid, f"料品 {target['id']}，数量 {amount}")
    return {'id': lid}


def manage_record(con, table, rid, action):
    dm.require(table in ('orders', 'purchases'), '记录类型无效')
    record = dm.row(con, f'SELECT * FROM {table} WHERE id=?', (rid,))
    if action == 'restore':
        admin(con)
    if action == 'delete':
        if table == 'orders':
            dm.require(not con.execute("SELECT 1 FROM purchase_lines pl JOIN order_lines l ON l.id=pl.order_line_id JOIN purchases p ON p.id=pl.purchase_id WHERE l.order_id=? AND p.deleted_at=''", (rid,)).fetchone(), '已关联采购，请先处理采购记录；仅隐藏请使用归档')
            dm.require(not con.execute('SELECT 1 FROM delivery_lines dl JOIN order_lines l ON l.id=dl.order_line_id WHERE l.order_id=?', (rid,)).fetchone(), '已有送货历史，请更正或归档')
            dm.require(not con.execute('SELECT 1 FROM order_cases c JOIN order_lines l ON l.id=c.order_line_id WHERE l.order_id=?', (rid,)).fetchone(), '已有变更或售后记录，请归档')
            dm.require(not con.execute('SELECT 1 FROM order_receipts WHERE order_id=?', (rid,)).fetchone(), '已有收款记录，请归档')
            dm.require(not con.execute('SELECT 1 FROM sales_invoice_orders WHERE order_id=?', (rid,)).fetchone(), '已有销售发票历史，请归档')
        else:
            source = con.execute('SELECT payload FROM purchase_sources WHERE purchase_id=?', (rid,)).fetchone()
            payload = json.loads(source[0]) if source else {}
            dm.require(not payload.get('invoice_details'), '已获取平台发票信息，请归档保留记录')
            dm.require(not any(p.get('status') and p['status'] != '待揽收' for p in payload.get('packages', [])), '平台已有发货信息，请核实采购处理或归档')
            dm.require(not con.execute('SELECT 1 FROM package_lines kl JOIN purchase_lines pl ON pl.id=kl.purchase_line_id WHERE pl.purchase_id=?', (rid,)).fetchone(), '已有包裹记录，请先核实更正；仅隐藏请使用归档')
            dm.require(not con.execute('SELECT 1 FROM invoice_allocations WHERE purchase_id=?', (rid,)).fetchone(), '已关联发票，请归档保留记录')
            dm.require(not con.execute('SELECT 1 FROM purchase_cases c JOIN purchase_lines pl ON pl.id=c.purchase_line_id WHERE pl.purchase_id=?', (rid,)).fetchone(), '已有采购处理记录，请归档')
            dm.require(not con.execute('SELECT 1 FROM delivery_lines dl JOIN purchase_lines pl ON pl.order_line_id=dl.order_line_id WHERE pl.purchase_id=?', (rid,)).fetchone(), '已关联送货单，请更正或归档')
        dm.require(not record['deleted_at'], '已经在回收站')
        con.execute(f'UPDATE {table} SET deleted_at=? WHERE id=?', (dm.now(), rid))
    elif action == 'restore':
        dm.require(record['deleted_at'], '记录不在回收站')
        if table == 'purchases':
            for line in dm.rows(con, 'SELECT * FROM purchase_lines WHERE purchase_id=?', (rid,)):
                target = dm.row(con, 'SELECT order_id FROM order_lines WHERE id=?', (line['order_line_id'],))
                dm.require(active_order(con, target['order_id'])['status'] == 'confirmed', '请先恢复并确认关联客户订单')
                dm.require(purchased_qty(con, line['order_line_id']) + line['quantity'] <= demand_qty(con, line['order_line_id']) + 1e-6, '恢复后将超过客户需求，请先更正现有采购')
        con.execute(f"UPDATE {table} SET deleted_at='' WHERE id=?", (rid,))
    else:
        dm.require(not record['deleted_at'], '请先恢复记录')
        con.execute(f'UPDATE {table} SET archived_at=? WHERE id=?', (dm.now() if action == 'archive' else '', rid))
    dm.audit(con, {'delete':'移入回收站','restore':'从回收站恢复','archive':'归档','unarchive':'取消归档'}[action], table, rid)
    return {'id': rid}


def dispatch(con, path, d):
    match = re.fullmatch(r'/api/stock-moves/(\d+)/void', path)
    if match:
        admin(con)
        reason = dm.txt(d, 'reason', True)
        move = dm.row(con, "SELECT * FROM stock_moves WHERE id=? AND voided_at=''", (int(match[1]),))
        line = dm.row(con, 'SELECT * FROM purchase_lines WHERE id=?', (move['purchase_line_id'],))
        dm.require(not con.execute('SELECT 1 FROM package_lines WHERE purchase_line_id=?', (line['id'],)).fetchone(), '转入料品已有包裹，不能撤销')
        dm.require(not con.execute('SELECT 1 FROM delivery_lines WHERE order_line_id=?', (line['order_line_id'],)).fetchone(), '转入订单已有送货历史，不能撤销')
        dm.require(not con.execute('SELECT 1 FROM purchase_cases WHERE purchase_line_id=?', (line['id'],)).fetchone(), '转入料品已有后续处理，不能撤销')
        # The zeroed allocation remains for provenance and audit; balances exclude it.
        con.execute('UPDATE stock_moves SET voided_at=? WHERE id=?', (dm.now(), move['id']))
        dm.audit(con, '撤销库存转单', 'stock_move', move['id'], reason)
        return {'id': move['id']}
    match = re.fullmatch(r'/api/intake-drafts/(\d+)/restore', path)
    if match:
        admin(con)
        rid = int(match[1])
        dm.row(con, "SELECT id FROM intake_drafts WHERE id=? AND status='deleted'", (rid,))
        con.execute("UPDATE intake_drafts SET status='active',updated_at=? WHERE id=?", (dm.now(), rid))
        dm.audit(con, '恢复询价草稿', 'intake_draft', rid)
        return {'id': rid}
    match = re.fullmatch(r'/api/purchase-cases/(\d+)/split', path)
    if match:
        cid = int(match[1])
        case = dm.row(con, 'SELECT * FROM purchase_cases WHERE id=?', (cid,))
        dm.require(case['status'] in ('pending', 'processing') and not case['finance_confirmed_at'], '仅未确认金额的待处理记录可拆分')
        amount = dm.qty(d.get('quantity'))
        dm.require(amount < case['quantity'] - 1e-6, '拆分数量应小于待处理数量')
        cost = round(case['cost_cents'] * amount / case['quantity'])
        con.execute("UPDATE purchase_cases SET quantity=quantity-?,cost_cents=cost_cents-? WHERE id=?", (amount, cost, cid))
        new_id = con.execute('INSERT INTO purchase_cases(purchase_line_id,order_case_id,quantity,reason,cost_cents,owner_id,created_at) VALUES(?,?,?,?,?,?,?)', (case['purchase_line_id'],case['order_case_id'],amount,case['reason'],cost,case['owner_id'],dm.now())).lastrowid
        dm.audit(con, '拆分采购处理', 'purchase_case', cid, f'新处理记录 {new_id}，数量 {amount}')
        return {'id': new_id}
    match = re.fullmatch(r'/api/order-receipts/(\d+)/void', path)
    if match:
        admin(con)
        reason = dm.txt(d, 'reason', True)
        item = dm.row(con, "SELECT * FROM order_receipts WHERE id=? AND voided_at=''", (int(match[1]),))
        received = con.execute("SELECT COALESCE(SUM(amount_cents),0) FROM order_receipts WHERE order_id=? AND voided_at=''", (item['order_id'],)).fetchone()[0]
        refunded = con.execute("SELECT COALESCE(SUM(c.amount_cents),0) FROM order_cases c JOIN order_lines l ON l.id=c.order_line_id WHERE l.order_id=? AND c.financial_type='refund_received' AND c.finance_confirmed_at!='' AND c.status!='void'", (item['order_id'],)).fetchone()[0]
        dm.require(received - item['amount_cents'] >= refunded, '此收款已用于退款确认，请先更正退款记录')
        other_allocated = con.execute("SELECT COALESCE(SUM(a.amount_cents),0) FROM sales_receipt_allocations a JOIN order_receipts r ON r.id=a.receipt_id JOIN sales_invoices i ON i.id=a.invoice_id WHERE r.order_id=? AND r.id!=? AND r.voided_at='' AND i.status='active'", (item['order_id'], item['id'])).fetchone()[0]
        dm.require(other_allocated <= received - item['amount_cents'] - refunded, '撤销后不足以覆盖已分配的发票回款，请先调整回款分配')
        con.execute('UPDATE order_receipts SET voided_at=? WHERE id=?', (dm.now(), item['id']))
        dm.audit(con, '撤销错误收款登记', 'order_receipt', item['id'], reason)
        return {'id': item['id']}
    match = re.fullmatch(r'/api/deliveries/(\d+)/unship', path)
    if match:
        admin(con)
        reason = dm.txt(d, 'reason', True)
        did = int(match[1])
        dm.row(con, "SELECT id FROM deliveries WHERE id=? AND status='active' AND shipped_at!=''", (did,))
        dm.require(not con.execute("SELECT 1 FROM order_cases c JOIN delivery_lines dl ON dl.id=c.delivery_line_id WHERE dl.delivery_id=? AND c.status!='void'", (did,)).fetchone(), '请先撤销该次发货关联的售后记录')
        dm.require(not con.execute("SELECT 1 FROM delivery_lines dl JOIN order_cases c ON c.id=dl.replacement_case_id WHERE dl.delivery_id=? AND c.status='completed'", (did,)).fetchone(), '该补发的换货处理已完成，请先更正售后')
        con.execute("UPDATE deliveries SET shipped_at='' WHERE id=?", (did,))
        dm.audit(con, '更正实际发货确认', 'delivery', did, reason)
        return {'id': did}
    match = re.fullmatch(r'/api/purchase-cases/(\d+)/stock-transfer', path)
    if match:
        return move_stock(con, int(match[1]), d)
    match = re.fullmatch(r'/api/purchase-lines/(\d+)/correct', path)
    if match:
        admin(con)
        reason = dm.txt(d, 'reason', True)
        lid = int(match[1])
        line = dm.row(con, 'SELECT * FROM purchase_lines WHERE id=?', (lid,))
        dm.row(con, "SELECT id FROM purchases WHERE id=? AND deleted_at='' AND archived_at=''", (line['purchase_id'],))
        active_order(con, dm.row(con, 'SELECT order_id FROM order_lines WHERE id=?', (line['order_line_id'],))['order_id'])
        dm.require(not line['created_by_case_id'] and not con.execute('SELECT 1 FROM stock_moves WHERE purchase_line_id=?', (lid,)).fetchone(), '转单产生的明细请更正来源处理')
        dm.require(not con.execute('SELECT 1 FROM package_lines WHERE purchase_line_id=?', (lid,)).fetchone(), '已有包裹，不能直接修改数量；请通过采购处理记录变更')
        dm.require(not con.execute('SELECT 1 FROM purchase_cases WHERE purchase_line_id=?', (lid,)).fetchone(), '已有处理记录，不能直接修改')
        dm.require(not con.execute('SELECT 1 FROM delivery_lines WHERE order_line_id=?', (line['order_line_id'],)).fetchone(), '已有送货记录，不能直接修改；请先核对下游记录')
        quantity, cost = dm.qty(d.get('quantity')), dm.money(d.get('cost'))
        dm.require(purchased_qty(con, line['order_line_id']) - line['quantity'] + quantity <= demand_qty(con, line['order_line_id']) + 1e-6, '更正后的采购数量超过需求')
        con.execute('UPDATE purchase_lines SET quantity=?,purchase_quantity=?,cost_cents=? WHERE id=?', (quantity, dm.qty(d.get('purchase_quantity', quantity)), cost, lid))
        dm.audit(con, '更正采购明细', 'purchase_line', lid, f"{line['quantity']} → {quantity}；成本 {line['cost_cents']} → {cost}；{reason}")
        return {'id': lid}
    match = re.fullmatch(r'/api/(orders|purchases)/(\d+)/(archive|unarchive|restore)', path)
    if match:
        return manage_record(con, match[1], int(match[2]), match[3])
    match = re.fullmatch(r'/api/orders/(\d+)/(cases|receipts)', path)
    if match:
        return create_order_case(con, int(match[1]), d) if match[2] == 'cases' else receipt(con, int(match[1]), d)
    match = re.fullmatch(r'/api/purchases/(\d+)/(return|restore-return)', path)
    if match:
        pid, action = int(match[1]), match[2]
        lines = dm.rows(con, 'SELECT * FROM purchase_lines WHERE purchase_id=?', (pid,))
        dm.require(lines, '采购记录不存在')
        if action == 'return':
            pending_returns = dm.rows(con, "SELECT c.id FROM purchase_cases c JOIN purchase_lines l ON l.id=c.purchase_line_id WHERE l.purchase_id=? AND c.kind='supplier_return' AND c.status IN ('pending','processing')", (pid,))
            for pending_return in pending_returns:
                con.execute("UPDATE purchase_cases SET status='processing' WHERE id=?", (pending_return['id'],))
                complete_purchase_case(con, pending_return['id'])
            processed = len(pending_returns)
            for line in lines:
                quantity = purchase_balance(con, line['id'])[0]
                if quantity <= 1e-6:
                    continue
                cid = make_purchase_case(con, line['id'], quantity, '全量退货')
                con.execute("UPDATE purchase_cases SET kind='supplier_return',status='processing' WHERE id=?", (cid,))
                complete_purchase_case(con, cid)
                processed += 1
            dm.require(processed, '没有可退货的采购数量')
        else:
            cases = dm.rows(con, "SELECT c.* FROM purchase_cases c JOIN purchase_lines l ON l.id=c.purchase_line_id WHERE l.purchase_id=? AND c.kind='supplier_return' AND c.status!='void'", (pid,))
            dm.require(cases, '没有可恢复的退货记录')
            for case in cases:
                void_case(con, 'purchase_cases', case['id'], {'reason':'快捷恢复采购'})
        return {'id': pid}
    match = re.fullmatch(r'/api/(order-cases|purchase-cases)/(\d+)/(update|finance|complete|void)', path)
    if match:
        table, cid, action = match[1].replace('-', '_'), int(match[2]), match[3]
        if action == 'finance':
            return confirm_case_finance(con, table, cid)
        if action == 'void':
            return void_case(con, table, cid, d)
        if table == 'order_cases':
            return update_order_case(con, cid, d) if action == 'update' else complete_order_case(con, cid)
        return update_purchase_case(con, cid, d) if action == 'update' else complete_purchase_case(con, cid)
    match = re.fullmatch(r'/api/deliveries/(\d+)/ship', path)
    if match:
        return confirm_shipment(con, int(match[1]))
    match = re.fullmatch(r'/api/purchase-lines/(\d+)/cases', path)
    if match:
        plid = int(match[1])
        dm.row(con, "SELECT pl.id FROM purchase_lines pl JOIN purchases p ON p.id=pl.purchase_id WHERE pl.id=? AND p.deleted_at=''", (plid,))
        quantity = dm.qty(d.get('quantity'))
        returning = d.get('kind') == 'supplier_return'
        if returning:
            dm.require(quantity >= 1 and quantity.is_integer(), '退货数量须为至少 1 的整数')
        cid = make_purchase_case(con, plid, quantity, dm.txt(d, 'reason', not returning))
        if returning:
            con.execute("UPDATE purchase_cases SET kind='supplier_return',status='processing' WHERE id=?", (cid,))
            dm.audit(con, '登记采购退货', 'purchase_case', cid, dm.txt(d, 'reason'))
            if d.get('immediate'):
                complete_purchase_case(con, cid)
        return {'id': cid}
    return None


def enrich_state(con, data):
    data['order_cases'] = dm.rows(con, 'SELECT * FROM order_cases ORDER BY id DESC')
    data['purchase_cases'] = dm.rows(con, 'SELECT * FROM purchase_cases ORDER BY id DESC')
    data['order_receipts'] = dm.rows(con, 'SELECT * FROM order_receipts ORDER BY id DESC')
    data['stock_moves'] = dm.rows(con, 'SELECT * FROM stock_moves ORDER BY id DESC')
    data['trash'] = ([dict(r, type='orders', label=r['po']) for r in dm.rows(con, "SELECT id,po,deleted_at FROM orders WHERE deleted_at!=''")] +
                     [dict(r, type='purchases', label=r['platform_order']) for r in dm.rows(con, "SELECT id,platform_order,deleted_at FROM purchases WHERE deleted_at!=''")])
    data['trash'] += [dict(type='intake-drafts', id=r['id'], label=json.loads(r['payload']).get('form', {}).get('po') or f"询价草稿 {r['id']}", deleted_at=r['updated_at']) for r in dm.rows(con, "SELECT * FROM intake_drafts WHERE status='deleted'")]
    for line in data['order_lines']:
        cases = [c for c in data['order_cases'] if c['order_line_id'] == line['id'] and c['status'] != 'void']
        line['cancelled_quantity'] = cancelled_qty(con, line['id'])
        line['dispatched_quantity'] = con.execute("SELECT COALESCE(SUM(dl.quantity),0) FROM delivery_lines dl JOIN deliveries d ON d.id=dl.delivery_id WHERE dl.order_line_id=? AND d.status='active' AND d.shipped_at!=''", (line['id'],)).fetchone()[0]
        line['logistics_dispatched_quantity'] = shipped_qty(con, line['id'])
        line['returned_quantity'] = sum(c['received_quantity'] for c in cases)
        line['returning_quantity'] = sum(c['quantity'] - c['received_quantity'] for c in cases if c['kind'] in ('return', 'exchange'))
        line['demand_quantity'] = demand_qty(con, line['id'])
        line['purchased'] = purchased_qty(con, line['id'])
        line['cost_cents'] = sum(purchase_balance(con, p['id'])[1] for p in data['purchase_lines'] if p['order_line_id'] == line['id'])
        line['cancel_available'] = max(0, line['quantity'] - line['cancelled_quantity'] - max(line['logistics_dispatched_quantity'], reserve_delivery(con, line['id'])))
    for line in data['purchase_lines']:
        line['original_quantity'], line['original_cost_cents'] = line['quantity'], line['cost_cents']
        line['quantity'], line['cost_cents'] = purchase_balance(con, line['id'])
        line['pending_quantity'] = sum(c['quantity'] for c in data['purchase_cases'] if c['purchase_line_id'] == line['id'] and c['status'] in ('pending', 'processing'))
    for order in data['orders']:
        lids = {l['id'] for l in data['order_lines'] if l['order_id'] == order['id']}
        cases = [c for c in data['order_cases'] if c['order_line_id'] in lids and c['status'] != 'void']
        order['open_cases'] = sum(c['status'] != 'completed' for c in cases)
        order['adjustment_cents'] = sum(c['amount_cents'] for c in cases if c['finance_confirmed_at'])
        order['refunded_cents'] = sum(c['amount_cents'] for c in cases if c['finance_confirmed_at'] and c['financial_type'] == 'refund_received')
        order['paid_cents'] = sum(r['amount_cents'] for r in data['order_receipts'] if r['order_id'] == order['id'] and not r['voided_at'])
    for purchase in data['purchases']:
        lids = {l['id'] for l in data['purchase_lines'] if l['purchase_id'] == purchase['id']}
        cases = [c for c in data['purchase_cases'] if c['purchase_line_id'] in lids and c['status'] != 'void']
        purchase['open_cases'] = sum(c['status'] != 'completed' for c in cases)
        purchase['refund_cents'] = sum(c['amount_cents'] for c in cases if c['finance_confirmed_at'])
