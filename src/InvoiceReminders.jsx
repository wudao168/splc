import React from 'react';
import { api, money } from './api';
import { Modal, Table, FixedCell, Badge, Button, Empty } from './components';

const tradeStatus = p => p.transaction_status || p.taobao_source?.transaction_status || '未同步';
const entriesOf = p => p.taobao_source?.invoice_entries || [];
const platformStatus = p => {
  const statuses = [...new Set(entriesOf(p).map(entry => entry.status).filter(Boolean))];
  return statuses.length ? statuses.join('、') : '未申请';
};
const pendingRequest = (data, p) => (data.invoice_apply_requests || []).find(r => r.purchase_id === p.id && ['pending', 'running'].includes(r.status));
const lastRequest = (data, p) => (data.invoice_apply_requests || []).find(r => r.purchase_id === p.id);
const reminded = p => Number(p.invoice_remind_count || 0);
const tradeUrl = p => `https://trade.taobao.com/trade/detail/trade_item_detail.htm?bizOrderId=${p.platform_order}`;

/** 待开票（交易成功、未开票）的催办工作台：先平台内申请，再聊天催票。 */
export const invoiceRemindCandidates = data => (data.purchases || [])
    .filter(p => !p.archived_at && p.platform === '淘宝' && p.remaining_cents > 0 && p.invoice_stage !== '不需开票'
      && tradeStatus(p) === '交易成功' && !entriesOf(p).some(entry => entry.status === '已开票'))
    .sort((a, b) => reminded(b) - reminded(a) || String(a.next_followup || '').localeCompare(String(b.next_followup || '')) || b.id - a.id);

export default function InvoiceReminders({ data, run, busy, onClose }) {
  const company = data.company || {};
  const candidates = invoiceRemindCandidates(data);
  const scriptFor = p => [
    `您好，订单号 ${p.platform_order}（${p.shop}，实付 ¥${(Number(p.amount_cents || 0) / 100).toFixed(2)}）已交易成功，麻烦帮忙开一下发票，谢谢！`,
    company.name ? `开票信息：${company.name}` : '',
    company.tax_number ? `税号：${company.tax_number}` : '',
    company.email ? `收票邮箱：${company.email}` : ''
  ].filter(Boolean).join('\n');
  const apply = p => run(async () => {
    if (window.caidanDesktop?.applyInvoice) return window.caidanDesktop.applyInvoice(p.id);
    await api(`/purchases/${p.id}/apply-invoice`, {});
    return { status: 'pending' };
  }, result => (result?.status === 'pending'
    ? '已排入客户端任务：请保持客户端运行并登录淘宝，客户端会在下次同步时申请开票'
    : { text: result?.message || '平台申请已提交，请稍后同步查看状态' }));
  const copyScript = p => run(async () => { await navigator.clipboard.writeText(scriptFor(p)); }, '催票话术已复制，可直接粘贴到聊天窗口');
  const recordRemind = p => run(() => api(`/purchases/${p.id}/invoice-remind`, { channel: '聊天催票' }), '已记录一次催票，5 天后再跟进');
  return <Modal wide title="发票催办 · 交易成功但未开票" onClose={onClose}>
    <p className="notice">优先在平台内申请开票（由桌面客户端执行，需保持客户端运行并登录淘宝）；平台没有提供自动申请入口时会提示你手动处理。平台申请后仍长时间未开票、或商家已拒绝，再复制话术去聊天催票。</p>
    {candidates.length ? <Table headers={['店铺 / 订单号', '交易状态', '采购金额', '平台申请状态', '已催票', '下次跟进', '操作']}>
      {candidates.map(p => <tr key={p.id}>
        <FixedCell title={`${p.shop} · ${p.platform_order}`}><strong>{p.shop}</strong><small className="mono">{p.platform_order}</small></FixedCell>
        <FixedCell><Badge tone="green">{tradeStatus(p)}</Badge></FixedCell>
        <FixedCell>{money(p.amount_cents)}</FixedCell>
        <FixedCell title={platformStatus(p)}>{platformStatus(p)}{lastRequest(data, p)?.status === 'failed' ? <small className="text-orange">{lastRequest(data, p).message || '申请失败，请重试'}</small> : null}</FixedCell>
        <FixedCell>{reminded(p) ? <>{reminded(p)} 次<small>{(p.invoice_reminded_at || '').slice(0, 10) || '—'}</small></> : '—'}</FixedCell>
        <FixedCell>{p.next_followup || '未设置'}</FixedCell>
        <FixedCell><div className="order-actions">
          {pendingRequest(data, p)
            ? <Badge>申请中…</Badge>
            : <Button secondary disabled={busy} onClick={() => apply(p)}>申请开票</Button>}
          <Button secondary disabled={busy} onClick={() => copyScript(p)}>复制催票话术</Button>
          <a className="button secondary" href={tradeUrl(p)} target="_blank" rel="noreferrer">打开淘宝订单</a>
          <Button secondary disabled={busy} onClick={() => recordRemind(p)}>记一次催票</Button>
        </div></FixedCell>
      </tr>)}
    </Table> : <Empty title="没有待催票的淘宝订单">交易成功且还没开票（剩余待收票金额大于 0）的采购会自动出现在这里。若交易状态显示未同步，请先在客户端同步采购草稿。</Empty>}
  </Modal>;
}
