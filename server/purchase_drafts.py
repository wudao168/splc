"""Unassociated platform orders, kept outside procurement accounting."""
import json
import re
from datetime import date, timedelta
from urllib.parse import urlparse, parse_qs
from . import domain as dm


ALLOWED_TRANSACTION_STATUSES = ('买家已付款', '卖家已发货', '交易成功')


def trash(con, action, d):
    if action == 'clear':
        # Keep the order identity so background collection does not recreate it.
        con.execute("UPDATE purchase_drafts SET status='purged',payload='{}',updated_at=? WHERE status='trash'", (dm.now(),))
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
    state['drafts'] = [dict(r, payload=json.loads(r['payload'])) for r in con.execute("SELECT id,payload FROM purchase_drafts WHERE status='active'")]
    return state


def save(con, source, manual=False):
    order = dm.txt(source, 'platform_order', True)
    dm.require(re.fullmatch(r'\d{8,30}', order), '平台订单号无效')
    # Includes archived/deleted purchases, so background collection cannot resurrect them.
    existing = con.execute("SELECT id FROM purchases WHERE platform='淘宝' AND platform_order=?", (order,)).fetchone()
    if existing:
        return {'skipped': True, 'purchase_id': existing['id']}
    draft = con.execute('SELECT * FROM purchase_drafts WHERE platform_order=?', (order,)).fetchone()
    if draft and draft['status'] != 'active':
        return {'skipped': True}
    config = sync_state(con)
    purchased = dm.valid_date(source.get('purchased_date'), True)
    dm.require((manual or config['first_date'] <= purchased) and purchased <= dm.today(), '订单不在首次最近 7 天及后续新增范围内')
    url = urlparse(dm.txt(source, 'source_url', True))
    param = {('trade.taobao.com','/trade/detail/trade_order_detail.htm'):'biz_order_id', ('trade.tmall.com','/detail/orderDetail.htm'):'bizOrderId'}.get((url.hostname,url.path))
    dm.require(url.scheme == 'https' and not url.username and not url.password and param and parse_qs(url.query).get(param) == [order], '订单来源链接无效')
    clean = {key:dm.txt(source, key)[:500] for key in ('source_url','shop','amount','remark','transaction_status')}
    if manual:
        clean['account'] = dm.txt(source,'account')
        clean['promised_date'] = dm.valid_date(source.get('promised_date'))
        clean['attachment_ids'] = dm.purchase_attachment_ids(con, source.get('attachment_ids', []))
    clean.update(platform='淘宝', platform_order=order, purchased_date=purchased)
    if clean['amount']:
        dm.money(clean['amount'])
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
        packages = {p['tracking']:p for p in previous.get('packages', [])}
        for p in clean['packages']:
            old = packages.get(p['tracking'], {})
            events = {(e['occurred_at'],e['description']):e for e in old.get('events', []) + p['events']}
            packages[p['tracking']] = {**old, **{k:v for k,v in p.items() if v}, 'events':list(events.values())[-50:]}
        clean['packages'] = list(packages.values())[:100]
        con.execute('UPDATE purchase_drafts SET payload=?,status=?,updated_at=? WHERE id=?', (json.dumps(clean,ensure_ascii=False),'trash' if closed else 'active',dm.now(),draft['id']))
        return {'id':draft['id'], 'created':False}
    cur = con.execute('INSERT INTO purchase_drafts(platform_order,payload,status,created_at,updated_at) VALUES(?,?,?,?,?)', (order,json.dumps(clean,ensure_ascii=False),'trash' if closed else 'active',dm.now(),dm.now()))
    dm.audit(con, '手动保存采购草稿' if manual else '自动获取采购草稿', 'purchase_draft', cur.lastrowid, order)
    return {'id':cur.lastrowid, 'created':True}


def finish(con, data):
    config = sync_state(con)
    error = dm.txt(data, 'error')[:500]
    through = dm.valid_date(data.get('through'), True)
    dm.require(config['first_date'] <= through <= dm.today(), '扫描日期无效')
    con.execute("UPDATE purchase_draft_sync SET checked_at=?,error=?,scanned_through=CASE WHEN ?='' THEN MAX(scanned_through,?) ELSE scanned_through END WHERE id=1", (dm.now(),error,error,through))
    return {'ok':True}
