import React from 'react';
import { Table, FixedCell } from './components';

export default function TaobaoSource({ source, renderAssociation, purchaseSummary }) {
  if (!source) return null;
  return <section className={`taobao-source ${renderAssociation ? 'with-association' : ''}`}><div className="taobao-source-heading"><h3>淘宝提取信息 · 请核对</h3>{source.sync_checked_at ? <span className="muted">淘宝后台同步：{source.sync_error || '已检查'} · {source.sync_checked_at.replace('T', ' ').slice(0, 19)}</span> : null}</div>
    {source.remark ? <p className="notice">订单备注：{source.remark}</p> : null}
    {source.warnings?.filter(text => text !== '仅提取页面已展示的商品和包裹；如有折叠内容，请展开后重新提取。').map((text,i) => <p className="notice" key={i}>{text}</p>)}
    {source.products?.length ? <Table className="taobao-products-table" minWidth={620} headers={['商品名称','规格','数量','商品金额','商品链接', ...(renderAssociation ? ['关联客户料品'] : [])]}>{source.products.map((p,i) => <tr key={i}><td title={p.name}>{p.name}</td><td title={p.spec}>{p.spec || '未识别'}</td><td>{p.quantity || '未识别'}</td><td>{p.amount ? `¥${p.amount}` : '未识别'}</td><td>{p.link ? <a href={p.link} target="_blank" rel="noreferrer">查看商品</a> : '—'}</td>{renderAssociation ? <td>{renderAssociation(p, i)}</td> : null}</tr>)}</Table> : null}
    {source.packages?.length || purchaseSummary ? <Table className="taobao-packages-table" minWidth={620} headers={[...(purchaseSummary ? ['店铺','实付款','物流运单'] : []),'快递公司','运单号','淘宝物流']}>{(source.packages?.length ? source.packages : [{}]).map((p,i) => <tr key={i}>{purchaseSummary ? <><FixedCell>{purchaseSummary.shop}</FixedCell><FixedCell>{purchaseSummary.amount}</FixedCell><FixedCell>{purchaseSummary.count} 个</FixedCell></> : null}<FixedCell>{p.carrier || '待补充'}</FixedCell><FixedCell className="mono">{p.tracking || '—'}</FixedCell><FixedCell>{p.status || '未识别'}{p.events?.length ? <small>{p.events[p.events.length - 1].description}</small> : null}</FixedCell></tr>)}</Table> : <p className="muted">暂无提取到的运单。发货后可以再次打开淘宝订单提取。</p>}
    <section className="purchase-order-note" aria-label="提取发票信息"><h3>发票提取信息</h3><p>{source.invoice_info?.status && source.invoice_info.status !== '未提取' ? `订单页状态：${source.invoice_info.status}` : source.invoice_details?.length ? '已提取发票明细' : '发票信息未提取'}</p>{source.invoice_info?.text ? <p>{source.invoice_info.text}</p> : null}{source.invoice_details?.map(invoice => <p key={invoice.number}>发票号：{invoice.number} · {invoice.amount_cents != null ? `¥${(invoice.amount_cents / 100).toFixed(2)}` : '金额待核对'}{invoice.attachment_id ? <> · <a href={`/api/files/${invoice.attachment_id}`} target="_blank" rel="noreferrer">查看文件</a></> : ' · 文件未获取'}</p>)}</section>
  </section>;
}

