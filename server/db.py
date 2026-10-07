import os
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.environ.get('CAIDAN_DATA', ROOT / '.data'))

SCHEMA = '''
CREATE TABLE IF NOT EXISTS sync_request (
 id INTEGER PRIMARY KEY CHECK(id=1), request_id TEXT NOT NULL, status TEXT NOT NULL,
 requested_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS purchase_drafts (
 id INTEGER PRIMARY KEY, platform_order TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'active', purchase_id INTEGER REFERENCES purchases(id),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS purchase_draft_sync (
 id INTEGER PRIMARY KEY CHECK(id=1), first_date TEXT NOT NULL, scanned_through TEXT NOT NULL DEFAULT '',
 checked_at TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sync_settings (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL, interval_minutes INTEGER NOT NULL);
INSERT OR IGNORE INTO sync_settings VALUES(1,1,30);
CREATE TABLE IF NOT EXISTS customers (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
 invoice_info TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS customer_contacts (
 id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS customer_addresses (
 id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), address TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS imports (
 id INTEGER PRIMARY KEY, attachment_id TEXT NOT NULL REFERENCES attachments(id),
 warnings TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS intake_drafts (
 id INTEGER PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
 id INTEGER PRIMARY KEY, customer TEXT NOT NULL, po TEXT NOT NULL,
 contact TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', address TEXT NOT NULL,
 due_date TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'draft', version INTEGER NOT NULL DEFAULT 1,
 source_id TEXT REFERENCES attachments(id), created_at TEXT NOT NULL,
 cancelled_at TEXT NOT NULL DEFAULT '', cancellation_reason TEXT NOT NULL DEFAULT '',
 UNIQUE(customer, po)
);
CREATE TABLE IF NOT EXISTS order_lines (
 id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id),
 name TEXT NOT NULL, spec TEXT NOT NULL DEFAULT '', brand TEXT NOT NULL DEFAULT '',
 description TEXT NOT NULL DEFAULT '', quantity REAL NOT NULL CHECK(quantity>0),
 unit TEXT NOT NULL DEFAULT '个', customer_code TEXT NOT NULL DEFAULT '',
 price_cents INTEGER NOT NULL DEFAULT 0 CHECK(price_cents>=0)
);
CREATE TABLE IF NOT EXISTS quotes (
 id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id),
 version INTEGER NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(order_id, version)
);
CREATE TABLE IF NOT EXISTS purchases (
 id INTEGER PRIMARY KEY, platform TEXT NOT NULL, account TEXT NOT NULL DEFAULT '',
 shop TEXT NOT NULL, platform_order TEXT NOT NULL,
 amount_cents INTEGER NOT NULL CHECK(amount_cents>=0), refund_cents INTEGER NOT NULL DEFAULT 0,
 invoice_expected_cents INTEGER NOT NULL CHECK(invoice_expected_cents>=0),
 invoice_stage TEXT NOT NULL DEFAULT '待申请', invoice_reason TEXT NOT NULL DEFAULT '',
 invoice_due TEXT NOT NULL DEFAULT '', followup TEXT NOT NULL DEFAULT '', next_followup TEXT NOT NULL DEFAULT '',
 purchased_date TEXT NOT NULL, promised_date TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
 source_id TEXT REFERENCES attachments(id), created_at TEXT NOT NULL,
 UNIQUE(platform, account, platform_order)
);
CREATE TABLE IF NOT EXISTS purchase_attachments (
 id INTEGER PRIMARY KEY, purchase_id INTEGER NOT NULL REFERENCES purchases(id),
 attachment_id TEXT NOT NULL REFERENCES attachments(id), UNIQUE(purchase_id, attachment_id)
);
CREATE TABLE IF NOT EXISTS purchase_lines (
 id INTEGER PRIMARY KEY, purchase_id INTEGER NOT NULL REFERENCES purchases(id),
 order_line_id INTEGER NOT NULL REFERENCES order_lines(id), quantity REAL NOT NULL CHECK(quantity>0),
 purchase_spec TEXT NOT NULL DEFAULT '', purchase_quantity REAL NOT NULL CHECK(purchase_quantity>0),
 purchase_unit TEXT NOT NULL DEFAULT '个', link TEXT NOT NULL DEFAULT '',
 cost_cents INTEGER NOT NULL CHECK(cost_cents>=0),
 cancellation_resolution TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS packages (
 id INTEGER PRIMARY KEY, carrier TEXT NOT NULL, tracking TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT '待揽收', signed_at TEXT NOT NULL DEFAULT '',
 note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, UNIQUE(carrier, tracking)
);
CREATE TABLE IF NOT EXISTS package_lines (
 id INTEGER PRIMARY KEY, package_id INTEGER NOT NULL REFERENCES packages(id),
 purchase_line_id INTEGER NOT NULL REFERENCES purchase_lines(id), quantity REAL NOT NULL CHECK(quantity>0),
 UNIQUE(package_id, purchase_line_id)
);
CREATE TABLE IF NOT EXISTS tracking_events (
 id INTEGER PRIMARY KEY, package_id INTEGER NOT NULL REFERENCES packages(id),
 status TEXT NOT NULL, description TEXT NOT NULL, occurred_at TEXT NOT NULL, source TEXT NOT NULL DEFAULT '人工登记'
);
CREATE TABLE IF NOT EXISTS invoices (
 id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, seller TEXT NOT NULL,
 issued_date TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 attachment_id TEXT NOT NULL REFERENCES attachments(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invoice_allocations (
 invoice_id INTEGER NOT NULL REFERENCES invoices(id), purchase_id INTEGER NOT NULL REFERENCES purchases(id),
 amount_cents INTEGER NOT NULL CHECK(amount_cents>0), PRIMARY KEY(invoice_id,purchase_id)
);
CREATE TABLE IF NOT EXISTS deliveries (
 id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, customer TEXT NOT NULL,
 address TEXT NOT NULL, contact TEXT NOT NULL, phone TEXT NOT NULL, company TEXT NOT NULL,
 company_en TEXT NOT NULL DEFAULT '', company_address TEXT NOT NULL DEFAULT '', company_phone TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'active', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS delivery_lines (
 id INTEGER PRIMARY KEY, delivery_id INTEGER NOT NULL REFERENCES deliveries(id),
 package_line_id INTEGER REFERENCES package_lines(id), order_line_id INTEGER REFERENCES order_lines(id), quantity REAL NOT NULL CHECK(quantity>0),
 snapshot TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
 id INTEGER PRIMARY KEY, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL,
 detail TEXT NOT NULL, created_at TEXT NOT NULL, user_id INTEGER REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
 display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_login TEXT NOT NULL DEFAULT '',
 theme TEXT NOT NULL DEFAULT 'c'
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
 expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS company_profile (
 id INTEGER PRIMARY KEY CHECK(id=1), name TEXT NOT NULL DEFAULT '',
 name_en TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS company_stamps (
 kind TEXT PRIMARY KEY CHECK(kind IN ('contract','delivery')),
 attachment_id TEXT NOT NULL REFERENCES attachments(id)
);
CREATE TABLE IF NOT EXISTS purchase_sources (
 purchase_id INTEGER PRIMARY KEY REFERENCES purchases(id), payload TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_order_lines ON order_lines(order_id);
CREATE INDEX IF NOT EXISTS ix_purchase_lines ON purchase_lines(order_line_id);
CREATE INDEX IF NOT EXISTS ix_package_lines ON package_lines(purchase_line_id);
'''


def connect(data=None):
    folder = Path(data) if data else DATA
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'attachments').mkdir(exist_ok=True)
    con = sqlite3.connect(folder / 'caidan.sqlite3', timeout=15)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA foreign_keys=ON')
    con.execute('PRAGMA journal_mode=WAL')
    con.executescript(SCHEMA)
    con.execute("CREATE TABLE IF NOT EXISTS tax_settings (id INTEGER PRIMARY KEY CHECK(id=1), rates TEXT NOT NULL, default_rate REAL NOT NULL)")
    con.execute("INSERT OR IGNORE INTO tax_settings VALUES(1,'[13,6,9]',13)")
    con.execute("CREATE TABLE IF NOT EXISTS delivery_sender (id INTEGER PRIMARY KEY CHECK(id=1), name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '')")
    con.execute('INSERT OR IGNORE INTO delivery_sender(id) VALUES(1)')
    company_columns = {r['name'] for r in con.execute('PRAGMA table_info(company_profile)')}
    for column in ('bank_name', 'bank_account', 'tax_number', 'email'):
        if column not in company_columns:
            con.execute(f"ALTER TABLE company_profile ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")
    order_columns = {r['name'] for r in con.execute('PRAGMA table_info(orders)')}
    line_columns = {r['name'] for r in con.execute('PRAGMA table_info(order_lines)')}
    if 'tax_rate' not in line_columns:
        con.execute('ALTER TABLE order_lines ADD COLUMN tax_rate INTEGER NOT NULL DEFAULT 13')
    for column in ('project_code', 'subproject_code', 'remark'):
        if column not in line_columns:
            con.execute(f"ALTER TABLE order_lines ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")
    for column in ('cancelled_at', 'cancellation_reason'):
        if column not in order_columns:
            con.execute(f"ALTER TABLE orders ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")
    if 'cancellation_resolution' not in {r['name'] for r in con.execute('PRAGMA table_info(purchase_lines)')}:
        con.execute("ALTER TABLE purchase_lines ADD COLUMN cancellation_resolution TEXT NOT NULL DEFAULT ''")
    con.execute('''INSERT OR IGNORE INTO purchase_attachments(purchase_id,attachment_id)
        SELECT id,source_id FROM purchases WHERE source_id IS NOT NULL''')
    delivery_columns = {r['name'] for r in con.execute('PRAGMA table_info(deliveries)')}
    for column in ('company_en', 'company_address', 'company_phone'):
        if column not in delivery_columns:
            con.execute(f"ALTER TABLE deliveries ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")
    if 'order_line_id' not in [r['name'] for r in con.execute('PRAGMA table_info(delivery_lines)')]:
        con.executescript('''CREATE TABLE delivery_lines_new (
            id INTEGER PRIMARY KEY, delivery_id INTEGER NOT NULL REFERENCES deliveries(id),
            package_line_id INTEGER REFERENCES package_lines(id), order_line_id INTEGER REFERENCES order_lines(id),
            quantity REAL NOT NULL CHECK(quantity>0), snapshot TEXT NOT NULL);
            INSERT INTO delivery_lines_new(id,delivery_id,package_line_id,order_line_id,quantity,snapshot)
            SELECT dl.id,dl.delivery_id,dl.package_line_id,pl.order_line_id,dl.quantity,dl.snapshot
            FROM delivery_lines dl JOIN package_lines kl ON kl.id=dl.package_line_id
            JOIN purchase_lines pl ON pl.id=kl.purchase_line_id;
            DROP TABLE delivery_lines;
            ALTER TABLE delivery_lines_new RENAME TO delivery_lines;''')
    if 'invoice_info' not in {r['name'] for r in con.execute('PRAGMA table_info(customers)')}:
        con.execute("ALTER TABLE customers ADD COLUMN invoice_info TEXT NOT NULL DEFAULT '{}'")
    address_columns = {r['name'] for r in con.execute('PRAGMA table_info(customer_addresses)')}
    for column in ('contact', 'phone'):
        if column not in address_columns:
            con.execute(f"ALTER TABLE customer_addresses ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")
    if 'customer_id' not in [r['name'] for r in con.execute('PRAGMA table_info(orders)')]:
        con.execute('ALTER TABLE orders ADD COLUMN customer_id INTEGER REFERENCES customers(id)')
        for order in con.execute('SELECT * FROM orders').fetchall():
            con.execute('INSERT OR IGNORE INTO customers(name,created_at) VALUES(?,?)', (order['customer'], order['created_at']))
            cid = con.execute('SELECT id FROM customers WHERE name=?', (order['customer'],)).fetchone()[0]
            con.execute('UPDATE orders SET customer_id=? WHERE id=?', (cid, order['id']))
            if order['contact'] and not con.execute('SELECT 1 FROM customer_contacts WHERE customer_id=? AND name=? AND phone=?', (cid, order['contact'], order['phone'])).fetchone():
                con.execute('INSERT INTO customer_contacts(customer_id,name,phone) VALUES(?,?,?)', (cid, order['contact'], order['phone']))
            if not con.execute('SELECT 1 FROM customer_addresses WHERE customer_id=? AND address=?', (cid, order['address'])).fetchone():
                con.execute('INSERT INTO customer_addresses(customer_id,address) VALUES(?,?)', (cid, order['address']))
        con.commit()
    if 'user_id' not in [r['name'] for r in con.execute('PRAGMA table_info(audit)')]:
        con.execute('ALTER TABLE audit ADD COLUMN user_id INTEGER REFERENCES users(id)')
    if 'theme' not in [r['name'] for r in con.execute('PRAGMA table_info(users)')]:
        con.execute("ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'c'")
    if not con.execute('SELECT 1 FROM users').fetchone():
        from .auth import password_hash
        from .domain import now
        con.execute('INSERT OR IGNORE INTO users(username,display_name,password_hash,created_at) VALUES(?,?,?,?)',
                    ('admin', '管理员', password_hash('11111111'), now()))
    from .lifecycle import migrate
    migrate(con)
    from .sales_invoices import migrate as migrate_sales
    migrate_sales(con)
    con.commit()
    return con
