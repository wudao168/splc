"""Unassociated platform orders, kept outside procurement accounting."""
import json
import re
from datetime import date, timedelta
from urllib.parse import urlparse, parse_qs
from . import domain as dm


ALLOWED_TRANSACTION_STATUSES = ('买家已付款', '卖家已发货', '交易成功')


def trash(con, action, d):
    if action == 'clear':
        # 清空回收站=暂时忽略：保留订单号（避免每轮重复采集），同时保留最后一次交易状态，
        # 以便订单后来变成“已付款/已发货/交易成功”时可以自动恢复为草稿。
        con.execute("""UPDATE purchase_drafts SET status='purged',updated_at=?,
            payload=json_object('transaction_status',json_extract(payload,'$.transaction_status'),
                                 'purchased_date',json_extract(payload,'$.purchased_date'),
                                 'shop',json_extract(payload,'$.shop'))
            WHERE status='trash'""", (dm.now(),))
    else:
        expected, status = ('active', 'trash') if action == 'delete' else ('trash', 'active')
        draft = con.execute('SELECT status,payload FROM purchase_drafts WHERE id=?', (d.get('id'),)).fetchone()
        dm.require(draft and draft['status'] == expected, '草稿状态已变化，请刷新后重试')
        dm.require(action != 'restore' or json.loads(draft['payload']).get('transaction_status') in ALLOWED_TRANSACTION_STATUSES, '交易状态不符合采集范围，不能恢复为采购草稿')
        con.execute('UPDATE purchase_drafts SET status=?,updated_at=? WHERE id=?', (status, dm.now(), d['id']))
    return {'ok': True}


def sync_state(con):
    first = (date.fromisoformat(dm.today()) - timedelta(days=6)).isoformat()
    con.execute('INSERT OR IGNORE INTO purchase_draft_sync(id,first_date) VALUES(1,?)', (first,))
    state = dict(con.execute('SELECT * FROM purchase_draft_sync WHERE id=1').fetchone())
    state['since'] = max(state['first_date'], (date.fromisoformat(state['scanned_through']) - timedelta(days=1)).isoformat()) if state['scanned_through'] else state['first_date']
    state['through'] = dm.today()
    state['known'] = list({r[0] for r in con.execute("SELECT platform_order FROM purchases WHERE platform='淘宝' UNION SELECT platform_order FROM purchase_drafts")})
    # 回收站里的订单也要带回给客户端刷新：订单后来变成已付款/已发货/交易成功时，
    # 采集会把它们自动恢复成平台订单（否则会永远停在“等待买家付款”）。
    state['drafts'] = [dict(r, payload=json.loads(r['payload'])) for r in con.execute("SELECT id,status,updated_at,payload FROM purchase_drafts WHERE status IN ('active','trash')")]
    return state


def product_key(item):
    """提取商品行的稳定标识（与前端一致），用于记住“已删除/未关联”的商品。"""
    return '|'.join(str(item.get(key) or '').strip() for key in ('name', 'spec', 'quantity', 'amount', 'link'))


def save(con, source, manual=False):
    order = dm.txt(source, 'platform_order', True)
    dm.require(re.fullmatch(r'\d{8,30}', order), '平台订单号无效')
    # Includes archived/deleted purchases, so background collection cannot resurrect them.
    existing = con.execute("SELECT id FROM purchases WHERE platform='淘宝' AND platform_order=?", (order,)).fetchone()
    if existing:
        return {'skipped': True, 'purchase_id': existing['id']}
    draft = con.execute('SELECT * FROM purchase_drafts WHERE platform_order=?', (order,)).fetchone()
    config = sync_state(con)
    purchased = dm.valid_date(source.get('purchased_date'), True)
    dm.require((manual or config['first_date'] <= purchased) and purchased <= dm.today(), '订单不在首次最近 7 天及后续新增范围内')
    if draft and draft['status'] != 'active':
        # 只有“之前因为未成交被隐藏、现在已变成有效交易状态”的订单才自动恢复；
        # 其他（例如用户主动删除的已成交订单）继续保持忽略。
        try:
            previous = json.loads(draft['payload'])
        except ValueError:
            previous = {}
        before = previous.get('transaction_status')
        revived = bool(before) and before not in ALLOWED_TRANSACTION_STATUSES and source.get('transaction_status') in ALLOWED_TRANSACTION_STATUSES
        if not revived:
            if draft['status'] == 'purged':
                # 清空回收站=用户主动忽略：不刷新、不恢复，直到用户点“重新采集已忽略订单”。
                return {'skipped': True}
            if source.get('transaction_status') in ALLOWED_TRANSACTION_STATUSES:
                # 回收站里本来就是有效状态的订单（用户主动删过）不自动拉回，只保留在回收站。
                return {'skipped': True}
            # 仍在退款中／交易关闭等无效状态：继续刷新内容，状态保持“回收站”。
    url = urlparse(dm.txt(source, 'source_url', True))
    param = {('trade.taobao.com','/trade/detail/trade_order_detail.htm'):'biz_order_id', ('trade.tmall.com','/detail/orderDetail.htm'):'bizOrderId'}.get((url.hostname,url.path))
    dm.require(url.scheme == 'https' and not url.username and not url.password and param and parse_qs(url.query).get(param) == [order], '订单来源链接无效')
    clean = {key:dm.txt(source, key)[:500] for key in ('source_url','shop','amount','remark','transaction_status')}
    clean['seller_nick'] = dm.txt(source, 'seller_nick')[:100]
    if manual:
        clean['account'] = dm.txt(source,'account')
        clean['promised_date'] = dm.valid_date(source.get('promised_date'))
        clean['attachment_ids'] = dm.purchase_attachment_ids(con, source.get('attachment_ids', []))
    purchased_at = dm.txt(source, 'purchased_at')[:19]
    clean.update(platform='淘宝', platform_order=order, purchased_date=purchased,
                 purchased_at=purchased_at if purchased_at.startswith(purchased) else '')
    if clean['amount']:
        dm.money(clean['amount'])
    for key in ('removed_products', 'unlinked_products'):
        values = source.get(key) or []
        dm.require(isinstance(values, list) and len(values) <= 200, '提取内容过多')
        clean[key] = [str(value)[:500] for value in values]
    for collection, keys in [('products', ('name','spec','quantity','amount','link')), ('packages', ('carrier','tracking','status'))]:
        items = source.get(collection, [])
        dm.require(isinstance(items, list) and len(items) <= 100, '提取内容过多')
        clean[collection] = []
        for item in items:
            dm.require(isinstance(item, dict), '提取条目无效')
            value = {key:dm.txt(item, key)[:500] for key in keys}
            if collection == 'packages':
                dm.require(re.fullmatch(r'[A-Za-z0-9-]{6,80}', value['tracking']), '运单号无效')
                dm.require(value['status'] in ('','待揽收','运输中','派送中','已签收','异常','退回'), '物流状态无效')
                events = item.get('events', [])
                dm.require(isinstance(events, list) and len(events) <= 50, '物流轨迹无效')
                value['events'] = [{'occurred_at':dm.txt(e,'occurred_at')[:40], 'description':dm.txt(e,'description')[:200]} for e in events]
            elif value['link']:
                link = urlparse(value['link'])
                dm.require(link.scheme == 'https' and link.hostname in ('item.taobao.com','detail.tmall.com') and not link.username, '商品链接无效')
            clean[collection].append(value)
    invoice = source.get('invoice_info')
    if isinstance(invoice, dict):
        clean['invoice_info'] = {key:dm.txt(invoice,key)[:500] for key in ('status','text')}
    clean['sync_checked_at'] = dm.now()
    clean['warnings'] = [str(w)[:200] for w in source.get('warnings', [])[:10]]
    dm.require(clean['transaction_status'], '未识别交易状态，请更新客户端后重新采集')
    closed = clean['transaction_status'] not in ALLOWED_TRANSACTION_STATUSES
    if draft:
        previous = json.loads(draft['payload'])
        # A temporarily incomplete page must not erase already collected details.
        for key in ('account','promised_date','attachment_ids'):
            if key not in clean and key in previous: clean[key] = previous[key]
        if not clean.get('invoice_info') and previous.get('invoice_info'):
            clean['invoice_info'] = previous['invoice_info']
        for key in ('shop','amount','remark','products'):
            if not clean[key]:
                clean[key] = previous.get(key, clean[key])
        # 手动勾选/删除的结果要跨同步保留：同步只带来新商品，不能把已删除的又加回来。
        for key in ('removed_products','unlinked_products'):
            if not clean.get(key):
                clean[key] = previous.get(key, [])
        # 发票催办记录属于用户操作，不能被每轮采集的新内容覆盖。
        for key in ('invoice_remind_count','invoice_reminded_at','next_followup'):
            if key in previous:
                clean[key] = previous[key]
        packages = {p['tracking']:p for p in previous.get('packages', [])}
        for p in clean['packages']:
            old = packages.get(p['tracking'], {})
            events = {(e['occurred_at'],e['description']):e for e in old.get('events', []) + p['events']}
            packages[p['tracking']] = {**old, **{k:v for k,v in p.items() if v}, 'events':list(events.values())[-50:]}
        clean['packages'] = list(packages.values())[:100]
    # 已删除的商品不再出现在草稿里（跨同步保留）。
    removed = set(clean.get('removed_products') or [])
    if removed:
        clean['products'] = [item for item in clean['products'] if product_key(item) not in removed]
    if draft:
        con.execute('UPDATE purchase_drafts SET payload=?,status=?,updated_at=? WHERE id=?', (json.dumps(clean,ensure_ascii=False),'trash' if closed else 'active',dm.now(),draft['id']))
        return {'id':draft['id'], 'created':False}
    cur = con.execute('INSERT INTO purchase_drafts(platform_order,payload,status,created_at,updated_at) VALUES(?,?,?,?,?)', (order,json.dumps(clean,ensure_ascii=False),'trash' if closed else 'active',dm.now(),dm.now()))
    dm.audit(con, '手动保存采购草稿' if manual else '自动获取采购草稿', 'purchase_draft', cur.lastrowid, order)
    return {'id':cur.lastrowid, 'created':True}


def remind_invoice(con, did, d):
    """记录一次发票催办：淘宝订单（尚未登记采购）也能跟踪催票次数与下次跟进日。"""
    draft = con.execute("SELECT * FROM purchase_drafts WHERE id=? AND status='active'", (did,)).fetchone()
    dm.require(draft is not None, '淘宝订单不存在或已移入回收站')
    payload = json.loads(draft['payload'] or '{}')
    count = int(payload.get('invoice_remind_count') or 0) + 1
    days = str(d.get('next_days') or '').strip()
    interval = int(days) if days.isdigit() and 0 < int(days) <= 90 else 5
    next_followup = dm.valid_date(d.get('next_followup')) or (date.fromisoformat(dm.today()) + timedelta(days=interval)).isoformat()
    payload['invoice_remind_count'] = count
    payload['invoice_reminded_at'] = dm.now()
    payload['next_followup'] = next_followup
    con.execute('UPDATE purchase_drafts SET payload=?,updated_at=? WHERE id=?', (json.dumps(payload, ensure_ascii=False), dm.now(), did))
    dm.audit(con, '催开发票（淘宝订单）', 'purchase_draft', did, draft['platform_order'])
    return {'id': did, 'invoice_remind_count': count, 'invoice_reminded_at': payload['invoice_reminded_at'], 'next_followup': next_followup}


def finish(con, data):
    config = sync_state(con)
    error = dm.txt(data, 'error')[:500]
    through = dm.valid_date(data.get('through'), True)
    dm.require(config['first_date'] <= through <= dm.today(), '扫描日期无效')
    stats = data.get('stats')
    text = ''
    if isinstance(stats, dict):
        clean = {}
        for key, value in list(stats.items())[:30]:
            if isinstance(value, (int, float, str)):
                clean[str(key)[:40]] = value[:200] if isinstance(value, str) else value
            elif isinstance(value, list):
                clean[str(key)[:40]] = [{str(k)[:40]: (v[:200] if isinstance(v, str) else v) for k, v in item.items() if isinstance(v, (int, float, str))} for item in value[:10] if isinstance(item, dict)]
        text = json.dumps(clean, ensure_ascii=False)[:4000]
    con.execute("UPDATE purchase_draft_sync SET checked_at=?,error=?,stats=?,scanned_through=CASE WHEN ?='' THEN MAX(scanned_through,?) ELSE scanned_through END WHERE id=1", (dm.now(),error,text,error,through))
    return {'ok':True}


def set_range(con, data):
    """调整采集起始日；客户端会从该日期起重新扫描（用于补采更早的订单）。"""
    first = dm.valid_date(data.get('first_date'), True)
    dm.require(first <= dm.today(), '采集起始日不能晚于今天')
    previous = con.execute('SELECT first_date FROM purchase_draft_sync WHERE id=1').fetchone()
    dm.require(previous is not None, '采购草稿同步配置不可用')
    con.execute('UPDATE purchase_draft_sync SET first_date=? WHERE id=1', (first,))
    dm.audit(con, '调整采购草稿采集起始日', 'settings', 1, f"{previous['first_date']} → {first}")
    return {'first_date': first, 'previous': previous['first_date']}


def revive(con):
    """允许重新采集此前“清空回收站”忽略的订单（已登记采购的订单不受影响）。"""
    count = con.execute("SELECT COUNT(*) FROM purchase_drafts WHERE status='purged'").fetchone()[0]
    con.execute("DELETE FROM purchase_drafts WHERE status='purged'")
    dm.audit(con, '重新采集已忽略的采购草稿', 'purchase_draft', 0, str(count))
    return {'cleared': count}
