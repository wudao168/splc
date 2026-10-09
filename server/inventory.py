"""料品档案、仓库、采购收货、库存占用与出库。

第一期把两条履约路径接到同一套料品编号上：
- 采购直发客户：沿用采购记录、包裹物流、送货单流程（receive_mode='direct'）。
- 采购入库后发货：采购 → 到货入库 → 订单占用库存 → 出库 → 送货单 → 客户签收（receive_mode='stock'）。
库存按料品编号 + 仓库结存，采用移动加权平均成本，出库时才把成本计入客户订单。
"""
import re

from . import domain as dm

DEFAULT_WAREHOUSE = '主仓'
RECEIVE_MODES = ('direct', 'stock')
MODE_LABELS = {'direct': '直发客户', 'stock': '入库'}


def columns(con, table):
    return {r['name'] for r in con.execute(f'PRAGMA table_info({table})')}


def migrate(con):
    con.executescript('''
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      spec TEXT NOT NULL DEFAULT '', brand TEXT NOT NULL DEFAULT '', key_specs TEXT NOT NULL DEFAULT '',
      unit TEXT NOT NULL DEFAULT '个', purchase_unit TEXT NOT NULL DEFAULT '', unit_factor REAL NOT NULL DEFAULT 1,
      customer_code TEXT NOT NULL DEFAULT '', supplier_code TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
      cost_cents INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS item_aliases (
      id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id), source TEXT NOT NULL DEFAULT '',
      alias TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS warehouses (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, location TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS stock_balances (
      item_id INTEGER NOT NULL REFERENCES items(id), warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      quantity REAL NOT NULL DEFAULT 0, value_cents INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(item_id, warehouse_id)
    );
    CREATE TABLE IF NOT EXISTS stock_receipts (
      id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, purchase_id INTEGER REFERENCES purchases(id),
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id), supplier TEXT NOT NULL DEFAULT '',
      received_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'posted', note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, created_by INTEGER REFERENCES users(id), voided_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS stock_receipt_lines (
      id INTEGER PRIMARY KEY, receipt_id INTEGER NOT NULL REFERENCES stock_receipts(id),
      purchase_line_id INTEGER REFERENCES purchase_lines(id), item_id INTEGER NOT NULL REFERENCES items(id),
      quantity REAL NOT NULL CHECK(quantity>0), unit TEXT NOT NULL DEFAULT '个',
      value_cents INTEGER NOT NULL CHECK(value_cents>=0), location TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS stock_reservations (
      id INTEGER PRIMARY KEY, order_line_id INTEGER NOT NULL REFERENCES order_lines(id),
      item_id INTEGER NOT NULL REFERENCES items(id), warehouse_id INTEGER REFERENCES warehouses(id),
      quantity REAL NOT NULL CHECK(quantity>0), origin TEXT NOT NULL DEFAULT 'manual', status TEXT NOT NULL DEFAULT 'active',
      note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, released_at TEXT NOT NULL DEFAULT '',
      release_reason TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS stock_outbounds (
      id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      order_id INTEGER REFERENCES orders(id), customer TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'posted', delivery_id INTEGER REFERENCES deliveries(id),
      carrier TEXT NOT NULL DEFAULT '', tracking TEXT NOT NULL DEFAULT '', shipped_at TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, created_by INTEGER REFERENCES users(id),
      voided_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS stock_outbound_lines (
      id INTEGER PRIMARY KEY, outbound_id INTEGER NOT NULL REFERENCES stock_outbounds(id),
      order_line_id INTEGER NOT NULL REFERENCES order_lines(id), item_id INTEGER NOT NULL REFERENCES items(id),
      quantity REAL NOT NULL CHECK(quantity>0), value_cents INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS stock_entries (
      id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id), warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      direction TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL DEFAULT '',
      purchase_line_id INTEGER REFERENCES purchase_lines(id), order_line_id INTEGER REFERENCES order_lines(id),
      quantity REAL NOT NULL, value_cents INTEGER NOT NULL DEFAULT 0, balance_quantity REAL NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, voided_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS ix_item_aliases ON item_aliases(item_id);
    CREATE INDEX IF NOT EXISTS ix_stock_entries_item ON stock_entries(item_id,warehouse_id);
    CREATE INDEX IF NOT EXISTS ix_stock_reservations_line ON stock_reservations(order_line_id);
    ''')
    if not con.execute('SELECT 1 FROM warehouses').fetchone():
        con.execute('INSERT INTO warehouses(name,note,is_default,created_at) VALUES(?,?,1,?)', (DEFAULT_WAREHOUSE, '系统默认仓库', dm.now()))
    if 'is_default' not in columns(con, 'warehouses'):
        con.execute('ALTER TABLE warehouses ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0')
    if 'cost_cents' not in columns(con, 'items'):
        con.execute('ALTER TABLE items ADD COLUMN cost_cents INTEGER NOT NULL DEFAULT 0')
    if not con.execute('SELECT 1 FROM warehouses WHERE is_default=1').fetchone():
        first = con.execute('SELECT id FROM warehouses WHERE active=1 ORDER BY id LIMIT 1').fetchone() or con.execute('SELECT id FROM warehouses ORDER BY id LIMIT 1').fetchone()
        if first:
            con.execute('UPDATE warehouses SET is_default=1 WHERE id=?', (first['id'],))
    if 'item_id' not in columns(con, 'order_lines'):
        con.execute('ALTER TABLE order_lines ADD COLUMN item_id INTEGER REFERENCES items(id)')
    if 'receive_mode' in columns(con, 'purchase_lines') and 'item_id' in columns(con, 'purchase_lines'):
        # 常规采购需要记录手工输入的单价（平台采购按实付款分摊，单价由成本推算）。
        if 'unit_price_cents' not in columns(con, 'purchase_lines'):
            con.execute('ALTER TABLE purchase_lines ADD COLUMN unit_price_cents INTEGER')
        return
    # 采购明细需要支持“公共备货”暂不关联客户订单：order_line_id 改为可空，并补充收货方式。
    con.commit()
    isolation = con.isolation_level
    con.isolation_level = None
    try:
        con.execute('PRAGMA foreign_keys=OFF')
        con.executescript('''
        CREATE TABLE purchase_lines_new (
          id INTEGER PRIMARY KEY, purchase_id INTEGER NOT NULL REFERENCES purchases(id),
          order_line_id INTEGER REFERENCES order_lines(id), item_id INTEGER REFERENCES items(id),
          quantity REAL NOT NULL CHECK(quantity>0), purchase_spec TEXT NOT NULL DEFAULT '',
          purchase_quantity REAL NOT NULL CHECK(purchase_quantity>0), purchase_unit TEXT NOT NULL DEFAULT '个',
          link TEXT NOT NULL DEFAULT '', cost_cents INTEGER NOT NULL CHECK(cost_cents>=0),
          cancellation_resolution TEXT NOT NULL DEFAULT '', created_by_case_id INTEGER REFERENCES purchase_cases(id),
          receive_mode TEXT NOT NULL DEFAULT 'direct', warehouse_id INTEGER REFERENCES warehouses(id),
          unit_price_cents INTEGER
        );
        INSERT INTO purchase_lines_new(id,purchase_id,order_line_id,quantity,purchase_spec,purchase_quantity,
            purchase_unit,link,cost_cents,cancellation_resolution,created_by_case_id,receive_mode)
          SELECT id,purchase_id,order_line_id,quantity,purchase_spec,purchase_quantity,purchase_unit,link,
            cost_cents,cancellation_resolution,created_by_case_id,'direct' FROM purchase_lines;
        DROP TABLE purchase_lines;
        ALTER TABLE purchase_lines_new RENAME TO purchase_lines;
        CREATE INDEX IF NOT EXISTS ix_purchase_lines ON purchase_lines(order_line_id);
        ''')
        con.execute('PRAGMA foreign_keys=ON')
    finally:
        con.isolation_level = isolation or ''
    conflicts = list(con.execute('PRAGMA foreign_key_check'))
    dm.require(not conflicts, '采购明细结构升级后外键校验未通过')
    con.commit()


def normalize(text):
    """型号比对用的归一化：忽略大小写、空格和常见连字符。"""
    return re.sub(r'[\s\-_/\\（）()]+', '', str(text or '')).upper()


def item_values(d, existing=None):
    name = dm.txt(d, 'name', True)
    spec = dm.txt(d, 'spec')
    brand = dm.txt(d, 'brand')
    unit = dm.txt(d, 'unit') or (existing['unit'] if existing else '个')
    code = dm.txt(d, 'code') or (existing['code'] if existing else '')
    cost = dm.money(d.get('cost')) if d.get('cost') not in (None, '') else (existing['cost_cents'] if existing else 0)
    values = (code, name, spec, brand, dm.txt(d, 'key_specs'), unit, dm.txt(d, 'purchase_unit'),
              dm.qty(d.get('unit_factor') or 1), dm.txt(d, 'customer_code'), dm.txt(d, 'supplier_code'), dm.txt(d, 'note'), cost)
    dm.require(float(values[7]) > 0, '包装换算系数必须大于零')
    return values


def purchase_inbound(con, item_id):
    """该料品是否已有采购入库：其成本由采购加权平均得出，不允许手工维护。"""
    return bool(con.execute('''SELECT 1 FROM stock_receipt_lines l JOIN stock_receipts r ON r.id=l.receipt_id
        WHERE l.item_id=? AND l.purchase_line_id IS NOT NULL AND r.voided_at='' LIMIT 1''', (item_id,)).fetchone())


def adjust_item_cost(con, item_id, cost):
    """把无采购来源（公共备货）料品当前库存的单位成本调整为 cost，按仓库重算库存金额并留成本调整流水。"""
    balances = dm.rows(con, 'SELECT * FROM stock_balances WHERE item_id=? AND ABS(quantity)>1e-9 ORDER BY warehouse_id', (item_id,))
    total = sum(row['quantity'] for row in balances)
    if total <= 1e-9:
        return
    target, assigned = int(round(cost * total)), 0
    for index, row in enumerate(balances):
        value = max(0, target - assigned) if index == len(balances) - 1 else int(round(cost * row['quantity']))
        assigned += value
        delta = value - row['value_cents']
        if delta:
            quantity_after = move_balance(con, item_id, row['warehouse_id'], 0, delta)
            entry(con, item_id, row['warehouse_id'], 'in' if delta > 0 else 'out', '成本调整', 0, delta, quantity_after, note='维护料品成本')


def create_item(con, d, item_id=None):
    existing = dm.row(con, 'SELECT * FROM items WHERE id=?', (item_id,)) if item_id else None
    code, name, spec, brand, key_specs, unit, purchase_unit, factor, customer_code, supplier_code, note, cost = item_values(d, existing)
    if existing and code and code != existing['code']:
        dm.require(not con.execute('SELECT 1 FROM items WHERE code=? AND id<>?', (code, item_id)).fetchone(), '料品编号已被占用')
    if existing:
        dm.require(not (cost != existing['cost_cents'] and purchase_inbound(con, item_id)),
                   '该料品已有采购入库，成本按采购加权平均自动计算，不能手工修改')
        if cost != existing['cost_cents']:
            adjust_item_cost(con, item_id, cost)
        con.execute('''UPDATE items SET code=?,name=?,spec=?,brand=?,key_specs=?,unit=?,purchase_unit=?,unit_factor=?,
            customer_code=?,supplier_code=?,note=?,active=?,cost_cents=? WHERE id=?''',
            (code, name, spec, brand, key_specs, unit, purchase_unit, factor, customer_code, supplier_code, note,
             0 if d.get('active') is False else 1, cost, item_id))
        dm.audit(con, '维护料品档案', 'item', item_id, f'{code} {name}')
        return {'id': item_id}
    dm.require(not code or not con.execute('SELECT 1 FROM items WHERE code=?', (code,)).fetchone(), '料品编号已存在，请直接使用该料品')
    item_id = con.execute('''INSERT INTO items(code,name,spec,brand,key_specs,unit,purchase_unit,unit_factor,
        customer_code,supplier_code,note,active,created_at,cost_cents) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?)''',
        (code, name, spec, brand, key_specs, unit, purchase_unit, factor, customer_code, supplier_code, note, dm.now(), cost)).lastrowid
    if not code:
        con.execute('UPDATE items SET code=? WHERE id=?', (f'LP{item_id:06d}', item_id))
    dm.audit(con, '新增料品档案', 'item', item_id, f'{code or "LP" + str(item_id)} {name}')
    return {'id': item_id}


def match_items(con, name='', spec='', brand='', customer_code='', code=''):
    """返回候选料品及匹配原因；只有编号、客户型号或“名称+规格+品牌”完全一致才算确定匹配。"""
    key_name, key_spec, key_brand = normalize(name), normalize(spec), normalize(brand)
    key_code, key_customer = normalize(code), normalize(customer_code)
    aliases = {}
    for row in con.execute('SELECT * FROM item_aliases'):
        aliases.setdefault(row['item_id'], []).append(row['alias'])
    candidates = []
    for item in con.execute('SELECT * FROM items ORDER BY id'):
        score, reason = 0, ''
        if key_code and normalize(item['code']) == key_code:
            score, reason = 100, '料品编号一致'
        elif key_customer and normalize(item['customer_code']) == key_customer:
            score, reason = 90, '客户型号一致'
        elif key_customer and any(normalize(alias) == key_customer for alias in aliases.get(item['id'], [])):
            score, reason = 85, '历史型号对应一致'
        elif key_name and normalize(item['name']) == key_name and key_spec and normalize(item['spec']) == key_spec:
            if not (key_brand and item['brand'] and normalize(item['brand']) != key_brand):
                score, reason = 80, '名称与规格一致'
        if score:
            candidates.append({'item': dict(item), 'score': score, 'reason': reason})
    return sorted(candidates, key=lambda x: (-x['score'], x['item']['id']))


def bindable_item(con, data):
    """按料品编号或型号定位料品；无法确定时返回 None（录入为待匹配料品）。"""
    item_id = data.get('item_id')
    if item_id not in (None, '', 0, '0'):
        item = dm.row(con, 'SELECT * FROM items WHERE id=?', (int(item_id),))
        remember_alias(con, item, data.get('customer_code'), '客户型号')
        return item['id']
    matches = match_items(con, data.get('name', ''), data.get('spec', ''), data.get('brand', ''), data.get('customer_code', ''))
    strong = [x for x in matches if x['score'] >= 80]
    if len(strong) == 1:
        remember_alias(con, strong[0]['item'], data.get('customer_code'), '客户型号')
        return strong[0]['item']['id']
    if strong:
        return None
    return create_item(con, {'name': data.get('name', ''), 'spec': data.get('spec', ''), 'brand': data.get('brand', ''),
                             'unit': data.get('unit') or '个', 'customer_code': data.get('customer_code', '')})['id']


def remember_alias(con, item, alias, source):
    """客户/供应商的型号写法只作为对应关系保存，不改变标准型号。"""
    alias = str(alias or '').strip()
    if not alias or normalize(alias) == normalize(item['customer_code'] if source == '客户型号' else item['supplier_code']):
        return
    if normalize(alias) == normalize(item['name']) or normalize(alias) == normalize(item['spec']):
        return
    if any(normalize(x['alias']) == normalize(alias) for x in dm.rows(con, 'SELECT alias FROM item_aliases WHERE item_id=?', (item['id'],))):
        return
    con.execute('INSERT INTO item_aliases(item_id,source,alias,note,created_at) VALUES(?,?,?,?,?)',
                (item['id'], source, alias[:120], '', dm.now()))


def set_order_line_item(con, line_id, data):
    line = dm.row(con, '''SELECT l.*,o.po FROM order_lines l JOIN orders o ON o.id=l.order_id WHERE l.id=?''', (line_id,))
    values = {key: data.get(key) for key in ('item_id', 'name', 'spec', 'brand', 'customer_code', 'unit') if data.get(key) not in (None, '')}
    item_id = bindable_item(con, values)
    con.execute('UPDATE order_lines SET item_id=? WHERE id=?', (item_id, line_id))
    dm.audit(con, '关联料品档案', 'order_line', line_id, f"{line['name']} → 料品 {item_id}")
    return {'id': line_id, 'item_id': item_id}


def set_purchase_line_item(con, line_id, data):
    line = dm.row(con, 'SELECT * FROM purchase_lines WHERE id=?', (line_id,))
    dm.require(line['order_line_id'] is None, '已关联客户订单的采购明细请通过订单料品维护')
    item_id = bindable_item(con, data)
    con.execute('UPDATE purchase_lines SET item_id=? WHERE id=?', (item_id, line_id))
    dm.audit(con, '关联料品档案', 'purchase_line', line_id, f'料品 {item_id}')
    return {'id': line_id, 'item_id': item_id}


ALIAS_SOURCES = ('客户型号', '供应商型号', '其他写法')


def add_alias(con, item_id, data):
    item = dm.row(con, 'SELECT * FROM items WHERE id=?', (item_id,))
    source = dm.txt(data, 'source') or ALIAS_SOURCES[0]
    dm.require(source in ALIAS_SOURCES, '型号来源无效')
    alias = dm.txt(data, 'alias', True)
    keys = {normalize(item['code']), normalize(item['name']), normalize(item['spec'])}
    dm.require(normalize(alias) not in keys, '该写法与料品编号、名称或标准型号重复，无需另建对应关系')
    dm.require(not any(normalize(x['alias']) == normalize(alias) for x in dm.rows(con, 'SELECT alias FROM item_aliases WHERE item_id=?', (item_id,))), '该型号写法已存在')
    aid = con.execute('INSERT INTO item_aliases(item_id,source,alias,note,created_at) VALUES(?,?,?,?,?)',
                      (item_id, source, alias[:120], dm.txt(data, 'note'), dm.now())).lastrowid
    dm.audit(con, '新增型号对应', 'item', item_id, f'{source} {alias}')
    return {'id': aid}


def backfill_items(con, _d=None):
    """按“名称 + 标准型号 + 品牌”精确匹配，为历史订单和采购明细补建或关联料品档案。"""
    linked, created, skipped = 0, 0, 0
    for line in dm.rows(con, 'SELECT * FROM order_lines WHERE item_id IS NULL ORDER BY id'):
        matches = [x for x in match_items(con, line['name'], line['spec'], line['brand'], line['customer_code']) if x['score'] >= 80]
        if len(matches) > 1:
            skipped += 1
            continue
        if matches:
            item_id = matches[0]['item']['id']
        else:
            item_id = create_item(con, {'name': line['name'], 'spec': line['spec'], 'brand': line['brand'],
                                        'unit': line['unit'] or '个', 'customer_code': line['customer_code']})['id']
            created += 1
        remember_alias(con, dm.row(con, 'SELECT * FROM items WHERE id=?', (item_id,)), line['customer_code'], '客户型号')
        con.execute('UPDATE order_lines SET item_id=? WHERE id=?', (item_id, line['id']))
        linked += 1
    for line in dm.rows(con, 'SELECT * FROM purchase_lines WHERE item_id IS NULL'):
        order_line = dm.row(con, 'SELECT item_id FROM order_lines WHERE id=?', (line['order_line_id'],)) if line['order_line_id'] else None
        if not order_line or not order_line['item_id']:
            skipped += 1
            continue
        con.execute('UPDATE purchase_lines SET item_id=? WHERE id=?', (order_line['item_id'], line['id']))
        linked += 1
    if linked:
        dm.audit(con, '补建料品档案', 'item', 0, f'关联 {linked} 条明细，新建 {created} 个料品，跳过 {skipped} 条')
    return {'linked': linked, 'created': created, 'skipped': skipped}


def remove_alias(con, item_id, alias_id):
    dm.row(con, 'SELECT id FROM item_aliases WHERE id=? AND item_id=?', (alias_id, item_id))
    con.execute('DELETE FROM item_aliases WHERE id=?', (alias_id,))
    dm.audit(con, '删除型号对应', 'item', item_id, str(alias_id))
    return {'id': alias_id}


def warehouse_id_of(con, value, required=False):
    if value in (None, '', 0, '0'):
        if required:
            dm.require(False, '请选择仓库')
        row = (con.execute('SELECT id FROM warehouses WHERE active=1 AND is_default=1 ORDER BY id LIMIT 1').fetchone()
               or con.execute('SELECT id FROM warehouses WHERE active=1 ORDER BY id LIMIT 1').fetchone())
        return row['id'] if row else None
    return dm.row(con, 'SELECT id FROM warehouses WHERE id=?', (int(value),))['id']


def set_purchase_receive_mode(con, line_id, data):
    line = dm.row(con, 'SELECT * FROM purchase_lines WHERE id=?', (line_id,))
    dm.require(not con.execute('''SELECT 1 FROM stock_receipt_lines srl JOIN stock_receipts r ON r.id=srl.receipt_id
        WHERE srl.purchase_line_id=? AND r.voided_at='' ''', (line_id,)).fetchone(), '该采购明细已登记入库，不能改回直发；请先撤销入库单')
    mode = dm.txt(data, 'receive_mode', True)
    dm.require(mode in RECEIVE_MODES, '收货方式无效')
    warehouse = warehouse_id_of(con, data.get('warehouse_id')) if mode == 'stock' else None
    con.execute('UPDATE purchase_lines SET receive_mode=?,warehouse_id=? WHERE id=?', (mode, warehouse, line_id))
    dm.audit(con, '登记采购收货方式', 'purchase_line', line_id, MODE_LABELS[mode])
    return {'id': line_id}


def balance(con, item_id, warehouse_id):
    row = con.execute('SELECT * FROM stock_balances WHERE item_id=? AND warehouse_id=?', (item_id, warehouse_id)).fetchone()
    return dict(row) if row else {'item_id': item_id, 'warehouse_id': warehouse_id, 'quantity': 0.0, 'value_cents': 0}


def move_balance(con, item_id, warehouse_id, quantity, value_cents):
    current = balance(con, item_id, warehouse_id)
    next_quantity, next_value = current['quantity'] + quantity, current['value_cents'] + value_cents
    dm.require(next_quantity >= -1e-6, '库存不足，不能出库')
    dm.require(next_value >= 0, '库存成本异常，请核对入库成本')
    if abs(next_quantity) < 1e-9:
        next_quantity, next_value = 0.0, 0
    con.execute('''INSERT INTO stock_balances(item_id,warehouse_id,quantity,value_cents,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(item_id,warehouse_id) DO UPDATE SET quantity=excluded.quantity,value_cents=excluded.value_cents,updated_at=excluded.updated_at''',
        (item_id, warehouse_id, next_quantity, max(0, int(next_value)), dm.now()))
    return next_quantity


def entry(con, item_id, warehouse_id, direction, kind, quantity, value_cents, balance_quantity, **extra):
    return con.execute('''INSERT INTO stock_entries(item_id,warehouse_id,direction,kind,source,purchase_line_id,order_line_id,
        quantity,value_cents,balance_quantity,note,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)''',
        (item_id, warehouse_id, direction, kind, extra.get('source', ''), extra.get('purchase_line_id'),
         extra.get('order_line_id'), quantity, value_cents, balance_quantity, extra.get('note', ''), dm.now())).lastrowid


def on_hand(con, item_id, warehouse_id=None):
    if warehouse_id:
        return float(con.execute('SELECT COALESCE(SUM(quantity),0) FROM stock_balances WHERE item_id=? AND warehouse_id=?', (item_id, warehouse_id)).fetchone()[0])
    return float(con.execute('SELECT COALESCE(SUM(quantity),0) FROM stock_balances WHERE item_id=?', (item_id,)).fetchone()[0])


def reserved_total(con, item_id, warehouse_id=None):
    sql = "SELECT COALESCE(SUM(quantity),0) FROM stock_reservations WHERE item_id=? AND status='active'"
    params = [item_id]
    if warehouse_id:
        sql += ' AND (warehouse_id=? OR warehouse_id IS NULL)'
        params.append(warehouse_id)
    return float(con.execute(sql, params).fetchone()[0])


def available_quantity(con, item_id, warehouse_id=None):
    return on_hand(con, item_id, warehouse_id) - reserved_total(con, item_id, warehouse_id)


def reservation(con, data):
    line = dm.row(con, '''SELECT l.*,o.po,o.status order_status FROM order_lines l JOIN orders o ON o.id=l.order_id WHERE l.id=?''',
                  (data.get('order_line_id'),))
    dm.require(line['order_status'] == 'confirmed', '仅已确认订单可以占用库存')
    dm.require(line['item_id'], '该订单料品尚未匹配料品档案，请先关联料品编号')
    amount = dm.qty(data.get('quantity'))
    warehouse = warehouse_id_of(con, data.get('warehouse_id')) if data.get('warehouse_id') else None
    dm.require(amount <= available_quantity(con, line['item_id'], warehouse) + 1e-6, '可用库存不足，请核对现存量与其他订单占用')
    rid = con.execute('''INSERT INTO stock_reservations(order_line_id,item_id,warehouse_id,quantity,origin,note,created_at)
        VALUES(?,?,?,?,?,?,?)''', (line['id'], line['item_id'], warehouse, amount, data.get('origin') or 'manual',
        dm.txt(data, 'note'), dm.now())).lastrowid
    dm.audit(con, '安排库存占用', 'stock_reservation', rid, f"{line['name']} × {amount}")
    return {'id': rid}


def release_reservation(con, rid, data):
    dm.row(con, "SELECT * FROM stock_reservations WHERE id=? AND status='active'", (rid,))
    reason = dm.txt(data, 'reason', True)
    con.execute("UPDATE stock_reservations SET status='released',released_at=?,release_reason=? WHERE id=?", (dm.now(), reason, rid))
    dm.audit(con, '释放库存占用', 'stock_reservation', rid, reason)
    return {'id': rid}


def release_order_reservations(con, order_line_id, reason, limit=None):
    """订单取消或减量时释放占用，返回实际释放数量。"""
    remaining = None if limit is None else float(limit)
    released = 0.0
    for item in dm.rows(con, "SELECT * FROM stock_reservations WHERE order_line_id=? AND status='active' ORDER BY id", (order_line_id,)):
        if remaining is not None and remaining <= 1e-9:
            break
        amount = item['quantity'] if remaining is None else min(item['quantity'], remaining)
        if amount + 1e-9 >= item['quantity']:
            con.execute("UPDATE stock_reservations SET status='released',released_at=?,release_reason=? WHERE id=?", (dm.now(), reason, item['id']))
        else:
            con.execute('UPDATE stock_reservations SET quantity=quantity-? WHERE id=?', (amount, item['id']))
            rid = con.execute('''INSERT INTO stock_reservations(order_line_id,item_id,warehouse_id,quantity,origin,status,note,created_at,released_at,release_reason)
                VALUES(?,?,?,?,?,'released',?,?,?,?)''', (item['order_line_id'], item['item_id'], item['warehouse_id'], amount,
                item['origin'], item['note'], item['created_at'], dm.now(), reason)).lastrowid
            dm.audit(con, '释放部分库存占用', 'stock_reservation', rid, reason)
        released += amount
        if remaining is not None:
            remaining -= amount
    return released


def next_number(con, table, prefix):
    day = dm.datetime.now(dm.TZ).strftime('%Y%m%d')
    like = f'{prefix}{day}%'
    tail = len(prefix) + 8
    rows = con.execute(f'SELECT number FROM {table} WHERE number LIKE ?', (like,)).fetchall()
    sequence = max([int(r['number'][tail:]) for r in rows if r['number'][tail:].isdigit()] + [0]) + 1
    return f'{prefix}{day}{sequence:03d}'


def purchase_open_quantity(con, purchase_line_id):
    """采购明细尚未入库且未处理的剩余数量。"""
    line = dm.row(con, 'SELECT * FROM purchase_lines WHERE id=?', (purchase_line_id,))
    if con.execute("SELECT 1 FROM stock_moves WHERE purchase_line_id=? AND voided_at!=''", (purchase_line_id,)).fetchone():
        return 0.0
    released = con.execute("SELECT COALESCE(SUM(quantity),0) FROM purchase_cases WHERE purchase_line_id=? AND status='completed'",
                           (purchase_line_id,)).fetchone()[0]
    pending = con.execute("SELECT COALESCE(SUM(quantity),0) FROM purchase_cases WHERE purchase_line_id=? AND status IN ('pending','processing')",
                          (purchase_line_id,)).fetchone()[0]
    received = received_quantity(con, purchase_line_id)
    return max(0.0, round(line['quantity'] - released - pending - received, 6))


def received_quantity(con, purchase_line_id):
    return float(con.execute('''SELECT COALESCE(SUM(srl.quantity),0) FROM stock_receipt_lines srl
        JOIN stock_receipts r ON r.id=srl.receipt_id WHERE srl.purchase_line_id=? AND r.voided_at='' ''', (purchase_line_id,)).fetchone()[0])


def post_receipt(con, data):
    warehouse = warehouse_id_of(con, data.get('warehouse_id'), True)
    lines = data.get('lines', [])
    dm.require(isinstance(lines, list) and 0 < len(lines) <= 100, '请填写入库明细')
    received_at = dm.valid_date(data.get('received_at') or dm.today(), True)
    purchase_id, prepared = data.get('purchase_id') or None, []
    for line in lines:
        purchase_line_id = line.get('purchase_line_id') or None
        if purchase_line_id:
            source = dm.row(con, 'SELECT * FROM purchase_lines WHERE id=?', (int(purchase_line_id),))
            dm.require(source['receive_mode'] == 'stock', '直发客户的采购不能办理入库，请先改为“入库”收货方式')
            purchase_id = purchase_id or source['purchase_id']
            dm.require(source['purchase_id'] == purchase_id, '入库明细必须属于同一采购记录')
            item_id = source['item_id'] or (dm.row(con, 'SELECT item_id FROM order_lines WHERE id=?', (source['order_line_id'],))['item_id']
                                            if source['order_line_id'] else None)
            dm.require(item_id, '该采购明细尚未关联料品档案，请先维护料品')
            open_quantity = purchase_open_quantity(con, source['id'])
            amount = dm.qty(line.get('quantity', open_quantity))
            dm.require(amount <= open_quantity + 1e-6, '入库数量超过该采购明细尚未入库数量')
            unit = source['purchase_unit'] or '个'
            value = dm.money(line['cost']) if line.get('cost') not in (None, '') else int(round(source['cost_cents'] * amount / source['quantity']))
        else:
            item_id = line.get('item_id')
            dm.require(item_id not in (None, '', 0, '0'), '请选择入库料品')
            dm.row(con, 'SELECT id FROM items WHERE id=?', (int(item_id),))
            item_id = int(item_id)
            amount, unit = dm.qty(line.get('quantity')), dm.txt(line, 'unit') or '个'
            value = int(round(dm.money(line.get('cost') or 0) * amount))   # 无采购来源入库按单价 × 数量计入库存金额
        prepared.append((purchase_line_id, item_id, amount, unit, value, dm.txt(line, 'location'), dm.txt(line, 'note')))
    number = next_number(con, 'stock_receipts', 'RKD-')
    rid = con.execute('''INSERT INTO stock_receipts(number,purchase_id,warehouse_id,supplier,received_at,note,created_at,created_by)
        VALUES(?,?,?,?,?,?,?,?)''', (number, purchase_id, warehouse, dm.txt(data, 'supplier'), received_at,
        dm.txt(data, 'note'), dm.now(), dm.actor_id.get() or 1)).lastrowid
    entry_kind = dm.txt(data, 'entry_kind') or '采购入库'
    for purchase_line_id, item_id, amount, unit, value, location, note in prepared:
        con.execute('''INSERT INTO stock_receipt_lines(receipt_id,purchase_line_id,item_id,quantity,unit,value_cents,location,note)
            VALUES(?,?,?,?,?,?,?,?)''', (rid, purchase_line_id, item_id, amount, unit, value, location, note))
        quantity_after = move_balance(con, item_id, warehouse, amount, value)
        entry(con, item_id, warehouse, 'in', entry_kind, amount, value, quantity_after,
              source=f'入库单 {number}', purchase_line_id=purchase_line_id, note=location or note)
        if purchase_line_id:
            source = dm.row(con, 'SELECT * FROM purchase_lines WHERE id=?', (purchase_line_id,))
            if source['order_line_id']:
                con.execute('''INSERT INTO stock_reservations(order_line_id,item_id,warehouse_id,quantity,origin,note,created_at)
                    VALUES(?,?,?,?,'receipt',?,?)''', (source['order_line_id'], item_id, warehouse, amount,
                    f'采购入库自动占用 · 入库单 {number}', dm.now()))
    dm.audit(con, '登记采购入库', 'stock_receipt', rid, number)
    return {'id': rid, 'number': number}


def void_receipt(con, rid, data):
    reason = dm.txt(data, 'reason', True)
    receipt = dm.row(con, "SELECT * FROM stock_receipts WHERE id=? AND voided_at=''", (rid,))
    for line in dm.rows(con, 'SELECT * FROM stock_receipt_lines WHERE receipt_id=?', (rid,)):
        consumed = con.execute('''SELECT COALESCE(SUM(sol.quantity),0) FROM stock_outbound_lines sol
            JOIN stock_outbounds so ON so.id=sol.outbound_id
            WHERE so.voided_at='' AND sol.item_id=? AND sol.order_line_id IN
            (SELECT order_line_id FROM stock_reservations WHERE note LIKE ?)''', (line['item_id'], f'%{receipt["number"]}%')).fetchone()[0]
        dm.require(not consumed, '入库货物已出库，不能直接撤销入库单；请先办理退货或盘亏')
        for item in dm.rows(con, "SELECT * FROM stock_reservations WHERE origin='receipt' AND status='active' AND note LIKE ?",
                            (f'%{receipt["number"]}%',)):
            con.execute("UPDATE stock_reservations SET status='released',released_at=?,release_reason=? WHERE id=?",
                        (dm.now(), '撤销入库单：' + reason, item['id']))
        quantity_after = move_balance(con, line['item_id'], receipt['warehouse_id'], -line['quantity'], -line['value_cents'])
        entry(con, line['item_id'], receipt['warehouse_id'], 'in', '入库撤销', -line['quantity'], -line['value_cents'],
              quantity_after, source=f'入库单 {receipt["number"]}', purchase_line_id=line['purchase_line_id'], note=reason)
    con.execute('UPDATE stock_receipts SET status=?,voided_at=? WHERE id=?', ('void', dm.now(), rid))
    dm.audit(con, '撤销入库单', 'stock_receipt', rid, reason)
    return {'id': rid}


def consume_reservations(con, order_line_id, item_id, warehouse_id, amount, outbound_number):
    """出库时按先进先出扣减本单占用；占用不足且可用库存充足时自动补占。"""
    remaining = amount
    for item in dm.rows(con, """SELECT * FROM stock_reservations WHERE order_line_id=? AND item_id=? AND status='active'
        AND (warehouse_id IS NULL OR warehouse_id=?) ORDER BY id""", (order_line_id, item_id, warehouse_id)):
        if remaining <= 1e-9:
            break
        taken = min(item['quantity'], remaining)
        if taken + 1e-9 >= item['quantity']:
            con.execute("UPDATE stock_reservations SET status='completed',released_at=? WHERE id=?", (dm.now(), item['id']))
        else:
            con.execute('UPDATE stock_reservations SET quantity=quantity-? WHERE id=?', (taken, item['id']))
        remaining -= taken
    if remaining > 1e-9:
        dm.require(remaining <= available_quantity(con, item_id, warehouse_id) + 1e-6,
                   '可用库存不足：部分数量已被其他订单占用，请先补充入库或调整占用')
        rid = con.execute('''INSERT INTO stock_reservations(order_line_id,item_id,warehouse_id,quantity,origin,status,note,created_at,released_at)
            VALUES(?,?,?,?,'outbound','completed',?,?,?)''', (order_line_id, item_id, warehouse_id, remaining,
            f'出库单 {outbound_number} 出库时占用', dm.now(), dm.now())).lastrowid
        dm.audit(con, '出库时占用库存', 'stock_reservation', rid, outbound_number)


def post_outbound(con, data):
    lines = data.get('lines', [])
    dm.require(isinstance(lines, list) and 0 < len(lines) <= 100, '请填写出库明细')
    warehouse = warehouse_id_of(con, data.get('warehouse_id'), True)
    order_id, customer, prepared = data.get('order_id') or None, '', []
    for line in lines:
        order_line = dm.row(con, '''SELECT l.*,o.customer,o.address,o.contact,o.phone,o.po,o.status order_status
            FROM order_lines l JOIN orders o ON o.id=l.order_id WHERE l.id=?''', (line.get('order_line_id'),))
        dm.require(order_line['order_status'] == 'confirmed', '仅已确认订单可以出库')
        if order_id:
            dm.require(order_line['order_id'] == int(order_id), '出库明细必须属于同一订单')
        order_id, customer = order_line['order_id'], order_line['customer']
        if not order_line['item_id']:
            strong = [x for x in match_items(con, order_line['name'], order_line['spec'], order_line['brand'], order_line['customer_code']) if x['score'] >= 80]
            if len(strong) == 1:
                order_line = dict(order_line)
                order_line['item_id'] = strong[0]['item']['id']
                con.execute('UPDATE order_lines SET item_id=? WHERE id=?', (order_line['item_id'], order_line['id']))
                remember_alias(con, strong[0]['item'], order_line['customer_code'], '客户型号')
        dm.require(order_line['item_id'], '该订单料品尚未匹配料品档案，请先在库存页或订单明细中关联料品编号')
        amount = dm.qty(line.get('quantity'))
        current = balance(con, order_line['item_id'], warehouse)
        dm.require(amount <= current['quantity'] + 1e-6, f"{order_line['name']} 现存量不足，不能出库")
        value = current['value_cents'] if abs(amount - current['quantity']) < 1e-9 else (
            int(round(current['value_cents'] * amount / current['quantity'])) if current['quantity'] else 0)
        prepared.append((order_line, amount, value))
    number = next_number(con, 'stock_outbounds', 'CKD-')
    oid = con.execute('''INSERT INTO stock_outbounds(number,warehouse_id,order_id,customer,address,carrier,tracking,note,created_at,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?)''', (number, warehouse, order_id, customer, dm.txt(data, 'address'),
        dm.txt(data, 'carrier'), dm.txt(data, 'tracking'), dm.txt(data, 'note'), dm.now(), dm.actor_id.get() or 1)).lastrowid
    for order_line, amount, value in prepared:
        consume_reservations(con, order_line['id'], order_line['item_id'], warehouse, amount, number)
        con.execute('''INSERT INTO stock_outbound_lines(outbound_id,order_line_id,item_id,quantity,value_cents,note)
            VALUES(?,?,?,?,?,?)''', (oid, order_line['id'], order_line['item_id'], amount, value, dm.txt(data, 'note')))
        quantity_after = move_balance(con, order_line['item_id'], warehouse, -amount, -value)
        entry(con, order_line['item_id'], warehouse, 'out', '销售出库', -amount, -value, quantity_after,
              source=f'出库单 {number}', order_line_id=order_line['id'], note=dm.txt(data, 'note'))
    delivery_id = None
    if data.get('create_delivery', True):
        result = dm.create_deliveries(con, {
            'company': dm.txt(data, 'company', True), 'company_en': dm.txt(data, 'company_en'),
            'company_address': dm.txt(data, 'company_address'), 'company_phone': dm.txt(data, 'company_phone'),
            'note': dm.txt(data, 'note'), 'carrier': dm.txt(data, 'carrier'), 'tracking': dm.txt(data, 'tracking'),
            'lines': [{'order_line_id': order_line['id'], 'quantity': amount, 'remark': dm.txt(data, 'note')}
                      for order_line, amount, _ in prepared]})
        delivery_id = (result['ids'] or [None])[0]
        if delivery_id:
            con.execute('UPDATE stock_outbounds SET delivery_id=? WHERE id=?', (delivery_id, oid))
    dm.audit(con, '办理库存出库', 'stock_outbound', oid, number)
    return {'id': oid, 'number': number, 'delivery_id': delivery_id}


def void_outbound(con, oid, data):
    reason = dm.txt(data, 'reason', True)
    outbound = dm.row(con, "SELECT * FROM stock_outbounds WHERE id=? AND voided_at=''", (oid,))
    if outbound['delivery_id']:
        delivery = dm.row(con, 'SELECT * FROM deliveries WHERE id=?', (outbound['delivery_id'],))
        dm.require(delivery['status'] == 'void', '请先作废关联送货单，再撤销出库')
    for line in dm.rows(con, 'SELECT * FROM stock_outbound_lines WHERE outbound_id=?', (oid,)):
        quantity_after = move_balance(con, line['item_id'], outbound['warehouse_id'], line['quantity'], line['value_cents'])
        entry(con, line['item_id'], outbound['warehouse_id'], 'out', '出库撤销', line['quantity'], line['value_cents'],
              quantity_after, source=f'出库单 {outbound["number"]}', order_line_id=line['order_line_id'], note=reason)
        order_line = dm.row(con, 'SELECT order_id FROM order_lines WHERE id=?', (line['order_line_id'],))
        if dm.row(con, 'SELECT status FROM orders WHERE id=?', (order_line['order_id'],))['status'] == 'confirmed':
            con.execute('''INSERT INTO stock_reservations(order_line_id,item_id,warehouse_id,quantity,origin,note,created_at)
                VALUES(?,?,?,?,'outbound-void',?,?)''', (line['order_line_id'], line['item_id'], outbound['warehouse_id'],
                line['quantity'], f'出库撤销恢复占用 · 出库单 {outbound["number"]}', dm.now()))
    con.execute("UPDATE stock_outbounds SET status='void',voided_at=? WHERE id=?", (dm.now(), oid))
    dm.audit(con, '撤销出库单', 'stock_outbound', oid, reason)
    return {'id': oid}


def adjust_stock(con, data):
    item_id, warehouse = int(data.get('item_id') or 0), warehouse_id_of(con, data.get('warehouse_id'), True)
    dm.row(con, 'SELECT id FROM items WHERE id=?', (item_id,))
    amount, reason = dm.qty(data.get('quantity')), dm.txt(data, 'reason', True)
    direction = dm.txt(data, 'direction', True)
    dm.require(direction in ('gain', 'loss'), '请选择盘盈或盘亏')
    dm.require(amount > 0, '盘点数量必须大于零')
    if direction == 'loss':
        current = balance(con, item_id, warehouse)
        dm.require(amount <= current['quantity'] + 1e-6, '盘亏数量超过现存量')
        value = current['value_cents'] if abs(amount - current['quantity']) < 1e-9 else (
            int(round(current['value_cents'] * amount / current['quantity'])) if current['quantity'] else 0)
        quantity_after = move_balance(con, item_id, warehouse, -amount, -value)
        entry(con, item_id, warehouse, 'out', '盘亏', -amount, -value, quantity_after, note=reason)
    else:
        value = dm.money(data.get('amount') or 0)
        quantity_after = move_balance(con, item_id, warehouse, amount, value)
        entry(con, item_id, warehouse, 'in', '盘盈', amount, value, quantity_after, note=reason)
    dm.audit(con, '登记库存盘点', 'item', item_id, f'{direction} {amount}；{reason}')
    return {'id': item_id}


def create_warehouse(con, d, wid=None):
    name = dm.txt(d, 'name', True)
    dm.require(not con.execute('SELECT 1 FROM warehouses WHERE name=? AND id<>?', (name, wid or 0)).fetchone(), '仓库名称已存在')
    active = 0 if d.get('active') is False else 1
    wanted_default = bool(d.get('is_default'))
    if wid:
        existing = dm.row(con, 'SELECT * FROM warehouses WHERE id=?', (wid,))
        dm.require(active or not existing['is_default'], '默认仓库不能停用，请先把其他仓库设为默认')
        dm.require(active or not con.execute('SELECT 1 FROM stock_balances WHERE warehouse_id=? AND ABS(quantity)>0.000001', (wid,)).fetchone(),
                   '该仓库仍有库存，不能停用；请先出库或调整库存')
        con.execute('UPDATE warehouses SET name=?,location=?,note=?,active=? WHERE id=?',
                    (name, dm.txt(d, 'location'), dm.txt(d, 'note'), active, wid))
        if wanted_default and active:
            con.execute('UPDATE warehouses SET is_default=0 WHERE id<>?', (wid,))
            con.execute('UPDATE warehouses SET is_default=1 WHERE id=?', (wid,))
        elif wanted_default:
            dm.require(False, '已停用的仓库不能设为默认')
        dm.audit(con, '维护仓库', 'warehouse', wid, name)
        return {'id': wid}
    make_default = wanted_default or not con.execute('SELECT 1 FROM warehouses').fetchone()
    dm.require(active or not make_default, '已停用的仓库不能设为默认')
    wid = con.execute('INSERT INTO warehouses(name,location,note,active,is_default,created_at) VALUES(?,?,?,?,?,?)',
                      (name, dm.txt(d, 'location'), dm.txt(d, 'note'), active, 1 if make_default else 0, dm.now())).lastrowid
    if make_default:
        con.execute('UPDATE warehouses SET is_default=0 WHERE id<>?', (wid,))
    dm.audit(con, '新增仓库', 'warehouse', wid, name)
    return {'id': wid}


def delete_warehouse(con, wid):
    """只允许删除从未使用过的仓库；有库存或任何历史记录的仓库请改用停用。"""
    warehouse = dm.row(con, 'SELECT * FROM warehouses WHERE id=?', (wid,))
    dm.require(not warehouse['is_default'], '默认仓库不能删除，请先把其他仓库设为默认')
    dm.require(con.execute('SELECT COUNT(*) FROM warehouses').fetchone()[0] > 1, '至少保留一个仓库，不能删除最后一个仓库')
    dm.require(not con.execute('SELECT 1 FROM stock_balances WHERE warehouse_id=? AND ABS(quantity)>0.000001', (wid,)).fetchone(),
               '该仓库仍有库存，不能删除；请先出库或调整库存，或改用停用')
    for table, label in (('stock_receipts', '入库单'), ('stock_outbounds', '出库单'), ('stock_entries', '库存流水'),
                         ('stock_reservations', '库存占用'), ('stock_balances', '库存结存'), ('purchase_lines', '采购明细')):
        dm.require(not con.execute(f'SELECT 1 FROM {table} WHERE warehouse_id=? LIMIT 1', (wid,)).fetchone(),
                   f'该仓库已有{label}记录，不能删除；请改用停用')
    con.execute('DELETE FROM warehouses WHERE id=?', (wid,))
    dm.audit(con, '删除仓库', 'warehouse', wid, warehouse['name'])
    return {'id': wid}


def dispatch(con, path, d):
    match = re.fullmatch(r'/api/items/(\d+)', path)
    if match:
        return create_item(con, d, int(match[1]))
    match = re.fullmatch(r'/api/items/(\d+)/aliases', path)
    if match:
        return add_alias(con, int(match[1]), d)
    match = re.fullmatch(r'/api/items/(\d+)/aliases/(\d+)/delete', path)
    if match:
        return remove_alias(con, int(match[1]), int(match[2]))
    if path == '/api/items/backfill':
        return backfill_items(con, d)
    if path == '/api/items':
        return create_item(con, d)
    if path == '/api/items/match':
        matches = match_items(con, d.get('name', ''), d.get('spec', ''), d.get('brand', ''), d.get('customer_code', ''), d.get('code', ''))
        return {'matches': [{'id': x['item']['id'], 'code': x['item']['code'], 'name': x['item']['name'], 'spec': x['item']['spec'],
                             'brand': x['item']['brand'], 'unit': x['item']['unit'], 'reason': x['reason'],
                             'on_hand': on_hand(con, x['item']['id']), 'available': available_quantity(con, x['item']['id'])}
                            for x in matches[:20]]}
    if path == '/api/warehouses':
        return create_warehouse(con, d)
    match = re.fullmatch(r'/api/warehouses/(\d+)/delete', path)
    if match:
        return delete_warehouse(con, int(match[1]))
    match = re.fullmatch(r'/api/warehouses/(\d+)', path)
    if match:
        return create_warehouse(con, d, int(match[1]))
    if path == '/api/receipts':
        return post_receipt(con, d)
    match = re.fullmatch(r'/api/receipts/(\d+)/void', path)
    if match:
        dm.require(dm.actor_id.get() == 1, '仅管理员可以撤销入库单')
        return void_receipt(con, int(match[1]), d)
    if path == '/api/reservations':
        return reservation(con, d)
    match = re.fullmatch(r'/api/reservations/(\d+)/release', path)
    if match:
        return release_reservation(con, int(match[1]), d)
    if path == '/api/outbounds':
        return post_outbound(con, d)
    match = re.fullmatch(r'/api/outbounds/(\d+)/void', path)
    if match:
        dm.require(dm.actor_id.get() == 1, '仅管理员可以撤销出库单')
        return void_outbound(con, int(match[1]), d)
    if path == '/api/stock-adjust':
        return adjust_stock(con, d)
    match = re.fullmatch(r'/api/purchase-lines/(\d+)/receive-mode', path)
    if match:
        return set_purchase_receive_mode(con, int(match[1]), d)
    match = re.fullmatch(r'/api/purchase-lines/(\d+)/item', path)
    if match:
        return set_purchase_line_item(con, int(match[1]), d)
    match = re.fullmatch(r'/api/order-lines/(\d+)/item', path)
    if match:
        return set_order_line_item(con, int(match[1]), d)
    return None


def enrich_state(con, data):
    data['items'] = dm.rows(con, 'SELECT * FROM items ORDER BY code')
    data['item_aliases'] = dm.rows(con, 'SELECT * FROM item_aliases ORDER BY id')
    data['warehouses'] = dm.rows(con, 'SELECT * FROM warehouses ORDER BY is_default DESC, id')
    for table in ('stock_receipts', 'stock_receipt_lines', 'stock_reservations', 'stock_outbounds', 'stock_outbound_lines', 'stock_entries'):
        data[table] = dm.rows(con, f'SELECT * FROM {table} ORDER BY id DESC')
    balances = dm.rows(con, 'SELECT * FROM stock_balances')
    active_reservations = [x for x in data['stock_reservations'] if x['status'] == 'active']
    items = {x['id']: x for x in data['items']}
    for item in data['items']:
        own = [x for x in balances if x['item_id'] == item['id']]
        item['on_hand'] = sum(x['quantity'] for x in own)
        item['value_cents'] = sum(x['value_cents'] for x in own)
        item['avg_cost_cents'] = round(item['value_cents'] / item['on_hand']) if item['on_hand'] > 1e-9 else 0
        item['purchase_inbound'] = purchase_inbound(con, item['id'])
        item['reserved'] = sum(x['quantity'] for x in active_reservations if x['item_id'] == item['id'])
        item['available'] = item['on_hand'] - item['reserved']
        item['incoming'] = sum(x['quantity'] for x in data['purchase_lines']
                               if x['item_id'] == item['id'] and x.get('receive_mode') == 'stock')
        item['incoming_unallocated'] = sum(x['quantity'] for x in data['purchase_lines']
                                           if x['item_id'] == item['id'] and x.get('receive_mode') == 'stock' and not x['order_line_id'])
        item['warehouse_stock'] = [{'warehouse_id': x['warehouse_id'], 'quantity': x['quantity'], 'value_cents': x['value_cents']} for x in own]
    active_outbound_ids = {x['id'] for x in data['stock_outbounds'] if not x['voided_at']}
    outbound_values = {}
    for line in data['stock_outbound_lines']:
        if line['outbound_id'] in active_outbound_ids:
            outbound_values[line['order_line_id']] = outbound_values.get(line['order_line_id'], 0) + line['value_cents']
    for line in data['purchase_lines']:
        line['receive_mode'] = line.get('receive_mode') or 'direct'
        line['mode_label'] = MODE_LABELS[line['receive_mode']]
        if not line['item_id'] and line['order_line_id']:
            line['item_id'] = next((x['item_id'] for x in data['order_lines'] if x['id'] == line['order_line_id']), None)
        line['item_name'] = (items.get(line['item_id']) or {}).get('name', '')
        line['received_quantity'] = received_quantity(con, line['id'])
    for line in data['order_lines']:
        item = items.get(line.get('item_id'))
        line['stock_cost_cents'] = outbound_values.get(line['id'], 0)
        line['cost_cents'] = (line.get('cost_cents') or 0) + line['stock_cost_cents']
        line['stock_on_hand'] = item['on_hand'] if item else 0
        line['stock_reserved'] = sum(x['quantity'] for x in active_reservations if x['order_line_id'] == line['id'])
        line['stock_available'] = item['available'] if item else 0
        line['stock_incoming_stock'] = sum(x['quantity'] for x in data['purchase_lines']
                                           if x['order_line_id'] == line['id'] and x['receive_mode'] == 'stock')
        line['stock_incoming_direct'] = sum(x['quantity'] for x in data['purchase_lines']
                                            if x['order_line_id'] == line['id'] and x['receive_mode'] == 'direct')
        line['stock_pool'] = item['incoming_unallocated'] if item else 0
        line['stock_expected'] = line['stock_available'] + max(0, line['stock_pool'])
        line['secured_quantity'] = (line.get('purchased') or 0) + line['stock_reserved']
        line['gap_quantity'] = max(0, (line.get('demand_quantity') or 0)
                                   - (line.get('logistics_dispatched_quantity') or 0) - line['secured_quantity'])
    data['inventory_totals'] = {
        'items': len(data['items']),
        'on_hand': sum(x['on_hand'] for x in data['items']),
        'reserved': sum(x['reserved'] for x in data['items']),
        'available': sum(x['available'] for x in data['items']),
        'value_cents': sum(x['value_cents'] for x in data['items']),
        'incoming': sum(x['incoming_unallocated'] for x in data['items']),
    }
    return data
