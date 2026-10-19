import React from 'react';
import { api, money } from './api';
import { Modal, Table, FixedCell, Badge, Button, Empty } from './components';
import { copyText } from './clipboard';

export const tradeStatus = p => p.transaction_status || p.taobao_source?.transaction_status || '未同步';
const entriesOf = p => p.taobao_source?.invoice_entries || [];
const isDraft = p => p.source_kind === 'draft';
const platformStatus = p => {
  if (isDraft(p)) return '未登记采购';
  const statuses = [...new Set(entriesOf(p).map(entry => entry.status).filter(Boolean))];
  return statuses.length ? statuses.join('、') : '未申请';
};
const pendingRequest = (data, p) => isDraft(p) ? null : (data.invoice_apply_requests || []).find(r => r.purchase_id === p.id && ['pending', 'running'].includes(r.status));
const lastRequest = (data, p) => isDraft(p) ? null : (data.invoice_apply_requests || []).find(r => r.purchase_id === p.id);
const reminded = p => Number(p.invoice_remind_count || 0);
const tradeUrl = p => `https://trade.taobao.com/trade/detail/trade_item_detail.htm?bizOrderId=${p.platform_order}`;
const sellerNick = p => String(p.seller_nick || p.taobao_source?.seller_nick || '').trim();
/** 卖家旺旺号已知时，直接打开店铺旺旺聊天（无需先进订单详情页）。 */
const wangwangUrl = p => { const nick = sellerNick(p); return nick ? `https://amos.alicdn.com/getcid.aw?v=3&charset=utf-8&s=1&site=cntaobao&uid=${encodeURIComponent(nick)}` : ''; };

/** 待开票（交易成功且未开票）的催办工作台：先平台内申请，再聊天催票。 */
const INVOICE_APPLY_STATUSES = ['交易成功'];
/** 交易成功、还没开票（且未作废）的淘宝采购：待催票。 */
export const isInvoiceRemindCandidate = p => !p.archived_at && p.platform === '淘宝' && p.remaining_cents > 0
  && p.invoice_stage !== '不需开票' && INVOICE_APPLY_STATUSES.includes(tradeStatus(p)) && !entriesOf(p).some(entry => entry.status === '已开票');

/** 淘宝订单（尚未登记采购的采购草稿）同样纳入催票：交易成功、金额大于 0、且还没有发票。 */
const draftAmountCents = draft => {
  const raw = String(draft.payload?.amount ?? '').replace(/[^\d.]/g, '');
  return Math.round((Number(raw) || 0) * 100);
};
const draftInvoiced = draft => {
  const payload = draft.payload || {};
  const entries = payload.invoice_entries || [];
  return (payload.invoice_details || []).length > 0 || entries.some(entry => entry?.status === '已开票') || payload.invoice_info?.status === '已开票';
};
export const isDraftInvoiceRemindCandidate = draft => draft.status === 'active'
  && draft.payload?.transaction_status === '交易成功' && !draftInvoiced(draft) && draftAmountCents(draft) > 0;
const draftCandidate = draft => ({
  ...(draft.payload || {}),
  id: draft.id, draft_id: draft.id, source_kind: 'draft', platform: '淘宝',
  platform_order: draft.platform_order || draft.payload?.platform_order,
  shop: draft.payload?.shop || '待核对',
  amount_cents: draftAmountCents(draft), remaining_cents: draftAmountCents(draft),
  transaction_status: draft.payload?.transaction_status, invoice_stage: '',
  taobao_source: draft.payload || {},
  invoice_remind_count: Number(draft.payload?.invoice_remind_count || 0),
  invoice_reminded_at: draft.payload?.invoice_reminded_at || '',
  next_followup: draft.payload?.next_followup || ''
});

export const invoiceRemindCandidates = data => [...(data.purchases || [])
    .filter(isInvoiceRemindCandidate)
    .sort((a, b) => reminded(b) - reminded(a) || String(a.next_followup || '').localeCompare(String(b.next_followup || '')) || b.id - a.id),
    ...(data.purchase_drafts || []).filter(isDraftInvoiceRemindCandidate).map(draftCandidate)
      .sort((a, b) => reminded(b) - reminded(a) || b.draft_id - a.draft_id)];

/** 催票话术：带上设置里的全部开票信息（公司名称/税号/地址/电话/开户行/账号/收票邮箱）。 */
const BILLING_SCRIPT_FIELDS = [['公司名称', 'name'], ['税号', 'tax_number'], ['地址', 'address'], ['电话', 'phone'], ['开户行', 'bank_name'], ['账号', 'bank_account'], ['收票邮箱', 'email']];
export const invoiceScriptFor = (p, company = {}) => {
  const billing = BILLING_SCRIPT_FIELDS.map(([label, key]) => [label, String(company[key] || '').trim()]).filter(([, value]) => value);
  return [
    `您好，订单号 ${p.platform_order}（${p.shop}，实付 ¥${(Number(p.amount_cents || 0) / 100).toFixed(2)}）已交易成功，麻烦帮忙开一下发票，谢谢！`,
    billing.length ? `开票信息：\n${billing.map(([label, value]) => `${label}：${value}`).join('\n')}` : ''
  ].filter(Boolean).join('\n');
};

export default function InvoiceReminders({ data, run, busy, onClose }) {
  const company = data.company || {};
  const candidates = invoiceRemindCandidates(data);
  const scriptFor = p => invoiceScriptFor(p, company);
  const apply = p => run(async () => {
    if (window.caidanDesktop?.applyInvoice) return window.caidanDesktop.applyInvoice(p.id);
    await api(`/purchases/${p.id}/apply-invoice`, {});
    return { status: 'pending' };
  }, result => (result?.status === 'pending'
    ? '已排入客户端任务：请保持客户端运行并登录淘宝，客户端会在下次同步时申请开票'
    : { text: result?.message || '平台申请已提交，请稍后同步查看状态' }));
  const copyScript = p => run(async () => { const ok = await copyText(scriptFor(p)); if (!ok) throw new Error('当前环境不支持自动复制，请手动选中话术复制'); }, '催票话术已复制，可直接粘贴到聊天窗口');
  const recordRemind = p => run(() => isDraft(p)
    ? api(`/purchase-drafts/${p.draft_id}/invoice-remind`, { channel: '聊天催票' })
    : api(`/purchases/${p.id}/invoice-remind`, { channel: '聊天催票' }), '已记录一次催票，5 天后再跟进');
  const pendingList = candidates.filter(p => !isDraft(p) && !pendingRequest(data, p));
  const applyAll = () => run(async () => {
    for (const p of pendingList) await api(`/purchases/${p.id}/apply-invoice`, {});
    return pendingList.length;
  }, count => `已把 ${count} 笔订单排入平台申请开票队列，客户端下一轮同步会自动在订单页提交`);
  const remindAll = () => run(async () => {
    for (const p of candidates) await (isDraft(p)
      ? api(`/purchase-drafts/${p.draft_id}/invoice-remind`, { channel: '聊天催票' })
      : api(`/purchases/${p.id}/invoice-remind`, { channel: '聊天催票' }));
    return candidates.length;
  }, count => `已记一次催票（${count} 笔），5 天后再跟进`);
  const copyAll = () => run(async () => {
    const ok = await copyText(candidates.map(p => `${p.shop} · ${p.platform_order}\n${scriptFor(p)}`).join('\n\n'));
    if (!ok) throw new Error('当前环境不支持自动复制，请逐条点“复制催票话术”');
    return candidates.length;
  }, count => `已复制 ${count} 笔订单的催票话术，可逐条粘贴发送`);
  return <Modal wide title="发票催办 · 交易成功但未开票" onClose={onClose}>
    <p className="notice">系统不会代你自动发送聊天消息：请复制话术后在旺旺发送（桌面客户端可打开商家聊天并自动填好话术，按回车即可）。「淘宝订单」里尚未登记采购的交易成功订单也会列出，登记采购后才能走平台自动申请开票。</p>
    {candidates.length ? <div className="order-actions bulk-invoice-actions">
      <Button secondary disabled={busy || !pendingList.length} onClick={applyAll}>批量申请开票（{pendingList.length}）</Button>
      <Button secondary disabled={busy || !candidates.length} onClick={copyAll}>复制全部催票话术</Button>
      <Button secondary disabled={busy || !candidates.length} onClick={remindAll}>批量记一次催票</Button>
    </div> : null}
    {candidates.length ? <Table className="invoice-reminders-table" columnWidths={[0.9, 2.2, 0.9, 1, 1.2, 0.8, 0.8, 3]} headers={['来源', '店铺 / 订单号', '交易状态', '采购金额', '平台申请状态', '已催票', '下次跟进', '操作']}>
      {candidates.map(p => <tr key={`${isDraft(p) ? 'draft' : 'purchase'}-${p.id}`}>
        <FixedCell>{isDraft(p) ? <Badge tone="blue">淘宝订单</Badge> : <Badge>采购记录</Badge>}</FixedCell>
        <FixedCell title={`${p.shop} · ${p.platform_order}`}><strong>{p.shop}</strong><small className="mono">{p.platform_order}</small></FixedCell>
        <FixedCell><Badge tone="green">{tradeStatus(p)}</Badge></FixedCell>
        <FixedCell>{money(p.amount_cents)}</FixedCell>
        <FixedCell title={platformStatus(p)}>{platformStatus(p)}{lastRequest(data, p)?.status === 'failed' ? <small className="text-orange">{lastRequest(data, p).message || '申请失败，请重试'}</small> : null}</FixedCell>
        <FixedCell>{reminded(p) ? <>{reminded(p)} 次<small>{(p.invoice_reminded_at || '').slice(0, 10) || '—'}</small></> : '—'}</FixedCell>
        <FixedCell>{p.next_followup || '未设置'}</FixedCell>
        <FixedCell><div className="order-actions">
          {isDraft(p) ? null : pendingRequest(data, p)
            ? <Badge>申请中…</Badge>
            : <Button secondary disabled={busy} onClick={() => apply(p)}>申请开票</Button>}
          <Button secondary disabled={busy} onClick={() => copyScript(p)}>复制催票话术</Button>
          {wangwangUrl(p)
            ? <a className="button secondary" href={wangwangUrl(p)} target="_blank" rel="noreferrer" title={`直接打开与卖家旺旺 ${sellerNick(p)} 的聊天`}>打开旺旺聊天</a>
            : <a className="button secondary" href={tradeUrl(p)} target="_blank" rel="noreferrer">打开淘宝订单</a>}
          <Button secondary disabled={busy} onClick={() => recordRemind(p)}>记一次催票</Button>
        </div></FixedCell>
      </tr>)}
    </Table> : <Empty title="没有待催票的淘宝订单">交易成功且还没开票的采购记录与淘宝订单都会自动出现在这里。若交易状态显示未同步，请先在客户端同步淘宝订单。</Empty>}
  </Modal>;
}
