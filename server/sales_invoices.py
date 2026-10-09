"""Customer sales invoices and allocation of existing order receipts."""
import json
import re
from decimal import Decimal, ROUND_HALF_UP
from . import domain as dm


def migrate(con):
    con.executescript('''
    CREATE TABLE IF NOT EXISTS sales_invoices (
      id INTEGER PRIMARY KEY, customer TEXT NOT NULL, number TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL, issued_date TEXT NOT NULL, due_date TEXT NOT NULL DEFAULT '',
      amount_cents INTEGER NOT NULL CHECK(amount_cents>0), billing_info TEXT NOT NULL,
      attachment_id TEXT REFERENCES attachments(id), note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active', reason TEXT NOT NULL DEFAULT '',
      changed_at TEXT NOT NULL DEFAULT '', red_number TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sales_invoice_orders (
      invoice_id INTEGER NOT NULL REFERENCES sales_invoices(id), order_id INTEGER NOT NULL REFERENCES orders(id),
      amount_cents INTEGER NOT NULL CHECK(amount_cents>0), PRIMARY KEY(invoice_id,order_id)
    );
    CREATE TABLE IF NOT EXISTS sales_receipt_allocations (
      receipt_id INTEGER NOT NULL REFERENCES order_receipts(id), invoice_id INTEGER NOT NULL REFERENCES sales_invoices(id),
      amount_cents INTEGER NOT NULL CHECK(amount_cents>0), PRIMARY KEY(receipt_id,invoice_id)
    );
    ''')
    con.execute("CREATE TABLE IF NOT EXISTS sales_invoice_lines (invoice_id INTEGER NOT NULL REFERENCES sales_invoices(id), order_line_id INTEGER NOT NULL REFERENCES order_lines(id), amount_cents INTEGER NOT NULL CHECK(amount_cents>0), PRIMARY KEY(invoice_id,order_line_id))")
    columns = {r['name'] for r in con.execute('PRAGMA table_info(order_receipts)')}
    for name in ('received_date', 'method', 'reference'):
        if name not in columns:
            con.execute(f"ALTER TABLE order_receipts ADD COLUMN {name} TEXT NOT NULL DEFAULT ''")


def order_totals(con, oid):
    order = dm.row(con, 'SELECT * FROM orders WHERE id=?', (oid,))
    total = sum(int((Decimal(str(r['quantity'])) * r['price_cents']).quantize(Decimal('1'), rounding=ROUND_HALF_UP))
                for r in con.execute('SELECT quantity,price_cents FROM order_lines WHERE order_id=?', (oid,)))
    adjustment = con.execute("SELECT COALESCE(SUM(c.amount_cents),0) FROM order_cases c JOIN order_lines l ON l.id=c.order_line_id WHERE l.order_id=? AND c.status!='void' AND (c.finance_confirmed_at!='' OR c.financial_type='reduce_receivable')", (oid,)).fetchone()[0]
    invoiced = con.execute("SELECT COALESCE(SUM(a.amount_cents),0) FROM sales_invoice_orders a JOIN sales_invoices i ON i.id=a.invoice_id WHERE a.order_id=? AND i.status='active'", (oid,)).fetchone()[0]
    return order, max(0, total - adjustment), invoiced


def allocated_receipts(con, oid):
    return con.execute("SELECT COALESCE(SUM(a.amount_cents),0) FROM sales_receipt_allocations a JOIN order_receipts r ON r.id=a.receipt_id JOIN sales_invoices i ON i.id=a.invoice_id WHERE r.order_id=? AND r.voided_at='' AND i.status='active'", (oid,)).fetchone()[0]


def auto_allocate(con, iid, allocations):
    """新开发票后，把该订单此前登记但尚未分配的回款自动关联到这张发票。"""
    for oid, cents in allocations:
        refunded = con.execute("SELECT COALESCE(SUM(c.amount_cents),0) FROM order_cases c JOIN order_lines l ON l.id=c.order_line_id WHERE l.order_id=? AND c.financial_type='refund_received' AND c.finance_confirmed_at!='' AND c.status!='void'", (oid,)).fetchone()[0]
        received = con.execute("SELECT COALESCE(SUM(amount_cents),0) FROM order_receipts WHERE order_id=? AND voided_at=''", (oid,)).fetchone()[0]
        budget = min(cents, max(0, received - refunded - allocated_receipts(con, oid)))
        if budget <= 0:
            continue
        rows = con.execute('''SELECT r.id, r.amount_cents - COALESCE((SELECT SUM(a.amount_cents) FROM sales_receipt_allocations a
                JOIN sales_invoices i ON i.id=a.invoice_id WHERE a.receipt_id=r.id AND i.status='active'),0) AS free
            FROM order_receipts r WHERE r.order_id=? AND r.voided_at='' ORDER BY COALESCE(NULLIF(r.received_date,''), r.created_at), r.id''', (oid,)).fetchall()
        for row in rows:
            amount = min(budget, max(0, int(row['free'])))
            if amount:
                con.execute('INSERT INTO sales_receipt_allocations(receipt_id,invoice_id,amount_cents) VALUES(?,?,?)', (row['id'], iid, amount))
                budget -= amount
            if budget <= 0:
                break


def attachment(con, d, key):
    value = dm.txt(d, key) or None
    if value:
        dm.row(con, 'SELECT id FROM attachments WHERE id=?', (value,))
    return value


def create(con, d):
    customer, number = dm.txt(d, 'customer', True), dm.txt(d, 'number', True)
    dm.require(not con.execute('SELECT 1 FROM sales_invoices WHERE number=?', (number,)).fetchone(), '该发票号码已登记')
    kind = dm.txt(d, 'kind', True)
    dm.require(kind in ('增值税专用发票', '普通发票', '其他'), '发票类型无效')
    issued, due = dm.valid_date(d.get('issued_date'), True), dm.valid_date(d.get('due_date'))
    dm.require(not due or due >= issued, '回款到期日不能早于开票日期')
    amount = dm.money(d.get('amount'))
    dm.require(amount > 0, '发票金额必须大于零')
    selected_lines = []
    if 'order_line_ids' in d:
        ids = d['order_line_ids']
        dm.require(isinstance(ids,list) and ids and len(set(ids)) == len(ids), '请选择不重复的订单料品')
        totals = {}
        for lid in ids:
            line = dm.row(con, 'SELECT * FROM order_lines WHERE id=?', (int(lid),))
            dm.require(not con.execute("SELECT 1 FROM sales_invoice_lines l JOIN sales_invoices i ON i.id=l.invoice_id WHERE l.order_line_id=? AND i.status='active'", (int(lid),)).fetchone(), '所选料品已开票')
            cents = int((Decimal(str(line['quantity'])) * line['price_cents']).quantize(Decimal('1'), rounding=ROUND_HALF_UP))
            dm.require(cents > 0, '所选料品含税金额需大于零')
            selected_lines.append((int(lid), cents))
            totals[line['order_id']] = totals.get(line['order_id'],0) + cents
        d = {**d, 'orders':[{'order_id':oid,'amount':str(Decimal(cents)/100)} for oid,cents in totals.items()]}
    allocations, seen = [], set()
    for item in d.get('orders', []):
        oid, cents = int(item['order_id']), dm.money(item.get('amount'))
        dm.require(oid not in seen and cents > 0, '订单不能重复且分摊金额必须大于零')
        seen.add(oid)
        order, total, invoiced = order_totals(con, oid)
        dm.require(order['customer'] == customer and order['status'] == 'confirmed' and not order['deleted_at'], '仅可关联同一客户的已确认订单')
        dm.require(cents <= total - invoiced, f"订单 {order['po']} 分摊金额超过待开票金额")
        allocations.append((oid, cents))
    dm.require(allocations and sum(a[1] for a in allocations) == amount, '订单分摊金额合计必须等于发票金额')
    billing = d.get('billing_info') or {}
    dm.require(isinstance(billing, dict), '开票信息格式错误')
    iid = con.execute('INSERT INTO sales_invoices(customer,number,kind,issued_date,due_date,amount_cents,billing_info,attachment_id,note,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
                      (customer, number, kind, issued, due, amount, json.dumps(billing, ensure_ascii=False), attachment(con, d, 'attachment_id'), dm.txt(d, 'note'), dm.now())).lastrowid
    con.executemany('INSERT INTO sales_invoice_orders VALUES(?,?,?)', [(iid, oid, cents) for oid, cents in allocations])
    con.executemany('INSERT INTO sales_invoice_lines VALUES(?,?,?)', [(iid,lid,cents) for lid,cents in selected_lines])
    auto_allocate(con, iid, allocations)
    dm.audit(con, '登记销售发票', 'sales_invoice', iid, number)
    return {'id': iid}


def allocate(con, rid, d):
    receipt = dm.row(con, "SELECT * FROM order_receipts WHERE id=? AND voided_at=''", (rid,))
    allocations, seen = [], set()
    for item in d.get('invoices', []):
        iid, amount = int(item['invoice_id']), dm.money(item.get('amount'))
        dm.require(iid not in seen and amount > 0, '发票不能重复且分配金额必须大于零')
        seen.add(iid)
        part = dm.row(con, "SELECT a.* FROM sales_invoice_orders a JOIN sales_invoices i ON i.id=a.invoice_id WHERE a.invoice_id=? AND a.order_id=? AND i.status='active'", (iid, receipt['order_id']))
        paid = con.execute("SELECT COALESCE(SUM(a.amount_cents),0) FROM sales_receipt_allocations a JOIN order_receipts r ON r.id=a.receipt_id WHERE a.invoice_id=? AND r.order_id=? AND r.voided_at='' AND r.id!=?", (iid, receipt['order_id'], rid)).fetchone()[0]
        dm.require(amount <= part['amount_cents'] - paid, '分配金额超过该订单在发票中的未回款金额')
        allocations.append((rid, iid, amount))
    assigned = sum(x[2] for x in allocations)
    dm.require(assigned <= receipt['amount_cents'], '分配金额超过该笔到账金额')
    oid = receipt['order_id']
    refunded = con.execute("SELECT COALESCE(SUM(c.amount_cents),0) FROM order_cases c JOIN order_lines l ON l.id=c.order_line_id WHERE l.order_id=? AND c.financial_type='refund_received' AND c.finance_confirmed_at!='' AND c.status!='void'", (oid,)).fetchone()[0]
    received = con.execute("SELECT COALESCE(SUM(amount_cents),0) FROM order_receipts WHERE order_id=? AND voided_at=''", (oid,)).fetchone()[0]
    previous = con.execute("SELECT COALESCE(SUM(a.amount_cents),0) FROM sales_receipt_allocations a JOIN sales_invoices i ON i.id=a.invoice_id WHERE a.receipt_id=? AND i.status='active'", (rid,)).fetchone()[0]
    dm.require(allocated_receipts(con, oid) - previous + assigned <= received - refunded, '分配金额超过扣除退款后的收款余额')
    con.execute('DELETE FROM sales_receipt_allocations WHERE receipt_id=?', (rid,))
    con.executemany('INSERT INTO sales_receipt_allocations VALUES(?,?,?)', allocations)
    dm.audit(con, '分配发票回款', 'order_receipt', rid, json.dumps(d.get('invoices', []), ensure_ascii=False))
    return {'id': rid}


def receipt(con, d):
    if d.get('invoice_id'):
        iid = int(d['invoice_id'])
        dm.row(con, "SELECT id FROM sales_invoices WHERE id=? AND status='active'", (iid,))
        parts = dm.rows(con, "SELECT a.order_id,a.amount_cents-COALESCE((SELECT SUM(x.amount_cents) FROM sales_receipt_allocations x JOIN order_receipts r ON r.id=x.receipt_id WHERE x.invoice_id=a.invoice_id AND r.order_id=a.order_id AND r.voided_at=''),0) AS remaining FROM sales_invoice_orders a WHERE a.invoice_id=? ORDER BY a.order_id", (iid,))
        amount = dm.money(d.get('amount'))
        dm.require(0 < amount <= sum(p['remaining'] for p in parts), '回款金额必须大于零且不能超过发票未回款金额')
        ids = []
        for part in parts:
            assigned = min(amount, max(0, part['remaining']))
            if assigned:
                result = receipt(con, {**d, 'invoice_id': None, 'order_id': part['order_id'], 'amount': str(Decimal(assigned)/100), 'invoices': [{'invoice_id': iid, 'amount': str(Decimal(assigned)/100)}]})
                ids.append(result['id'])
                amount -= assigned
        return {'ids': ids}
    oid = int(d['order_id'])
    order, total, _ = order_totals(con, oid)
    dm.require(order['status'] == 'confirmed' and not order['deleted_at'], '仅可登记已确认订单的回款')
    amount = dm.money(d.get('amount'))
    dm.require(amount > 0, '回款金额必须大于零')
    received_date = dm.valid_date(d.get('received_date'), True)
    dm.require(received_date <= dm.today(), '到账日期不能晚于今天')
    rid = con.execute('INSERT INTO order_receipts(order_id,amount_cents,note,evidence_id,created_at,received_date,method,reference) VALUES(?,?,?,?,?,?,?,?)',
                      (oid, amount, dm.txt(d, 'note'), attachment(con, d, 'evidence_id'), dm.now(), received_date, dm.txt(d, 'method', True), dm.txt(d, 'reference'))).lastrowid
    allocate(con, rid, d)
    dm.audit(con, '登记客户回款', 'order_receipt', rid)
    return {'id': rid}


def dispatch(con, path, d):
    if path == '/api/sales-invoices':
        return create(con, d)
    if path == '/api/sales-receipts':
        return receipt(con, d)
    match = re.fullmatch(r'/api/sales-receipts/(\d+)/allocate', path)
    if match:
        return allocate(con, int(match[1]), d)
    match = re.fullmatch(r'/api/sales-invoices/(\d+)/(void|red)', path)
    if match:
        iid, status = int(match[1]), match[2]
        dm.row(con, "SELECT id FROM sales_invoices WHERE id=? AND status='active'", (iid,))
        reason = dm.txt(d, 'reason', True)
        red_number = dm.txt(d, 'red_number', status == 'red')
        con.execute('UPDATE sales_invoices SET status=?,reason=?,red_number=?,changed_at=? WHERE id=?', (status, reason, red_number, dm.now(), iid))
        dm.audit(con, '作废销售发票' if status == 'void' else '全额红冲销售发票', 'sales_invoice', iid, reason)
        return {'id': iid}
    return None


def enrich_state(con, data):
    data['sales_invoices'] = dm.rows(con, 'SELECT * FROM sales_invoices ORDER BY id DESC')
    data['sales_invoice_lines'] = dm.rows(con, 'SELECT * FROM sales_invoice_lines')
    data['sales_invoice_orders'] = dm.rows(con, 'SELECT * FROM sales_invoice_orders')
    data['sales_receipt_allocations'] = dm.rows(con, 'SELECT * FROM sales_receipt_allocations')
    receipts = {r['id']: r for r in data['order_receipts']}
    active = {i['id'] for i in data['sales_invoices'] if i['status'] == 'active'}
    for invoice in data['sales_invoices']:
        invoice['billing_info'] = json.loads(invoice['billing_info'])
        invoice['paid_cents'] = sum(a['amount_cents'] for a in data['sales_receipt_allocations'] if a['invoice_id'] == invoice['id'] and not receipts[a['receipt_id']]['voided_at']) if invoice['id'] in active else 0
        invoice['remaining_cents'] = invoice['amount_cents'] - invoice['paid_cents'] if invoice['id'] in active else 0
        invoice['payment_status'] = '已结清' if not invoice['remaining_cents'] else '部分回款' if invoice['paid_cents'] else '未回款'
        invoice['overdue'] = bool(invoice['remaining_cents'] and invoice['due_date'] and invoice['due_date'] < dm.today())
    for r in data['order_receipts']:
        r['allocated_cents'] = sum(a['amount_cents'] for a in data['sales_receipt_allocations'] if a['receipt_id'] == r['id'] and a['invoice_id'] in active) if not r['voided_at'] else 0
    for order in data['orders']:
        _, total, invoiced = order_totals(con, order['id'])
        order['receivable_cents'], order['invoiced_cents'] = total, invoiced
        order['invoice_status'] = '未开票' if not invoiced else '部分开票' if invoiced < total else '已开齐'
        order['invoice_excess_cents'] = max(0, invoiced - total)
