import React, { useMemo, useState } from 'react';
import { Panel, Empty } from './components';
import { dashboardAnalytics } from './dashboardAnalytics';
const colors=['#117d75','#4f8bcc','#d89939','#8a6ac5','#cb6b78','#5e9c70'];
const number=value=>Number(value||0).toLocaleString('zh-CN',{maximumFractionDigits:2});
const unitText=values=>Object.entries(values).filter(([,v])=>v>0).map(([u,v])=>`${number(v)} ${u}`).join(' / ')||'0';
function Bars({rows,series}) {
  const maximum=Math.max(1,...rows.flatMap(row=>series.map(s=>row[s.key]||0)));
  return rows.length ? <div className="analytics-bars">{rows.map(row=><div className="analytics-bar-row" key={row.label}><span title={row.label}>{row.label}</span><div>{series.map((s,i)=><div className="analytics-bar-value" key={s.key}><div style={{width:`${(row[s.key]||0)/maximum*100}%`,background:colors[i]}} title={`${s.label}：${number(row[s.key])}`}/><small>{s.label} {number(row[s.key])}</small></div>)}</div></div>)}</div> : <Empty compact title="暂无统计数据"/>;
}
function Donut({rows}) {
  const positive=rows.filter(r=>r.value>0),total=positive.reduce((n,r)=>n+r.value,0);let offset=0;
  return total ? <div className="analytics-donut"><svg viewBox="0 0 160 160" role="img" aria-label={positive.map(r=>`${r.label} ${number(r.value)}`).join('；')}><circle cx="80" cy="80" r="58" fill="none" stroke="#edf1f5" strokeWidth="22"/>{positive.map((r,i)=>{const fraction=r.value/total;const previous=offset;offset+=fraction;return <circle key={r.label} cx="80" cy="80" r="58" fill="none" stroke={colors[i%colors.length]} strokeWidth="22" pathLength="100" strokeDasharray={`${fraction*100} ${100-fraction*100}`} strokeDashoffset={-previous*100} transform="rotate(-90 80 80)"><title>{r.label}：{number(r.value)}（{number(fraction*100)}%）</title></circle>;})}<text x="80" y="76" textAnchor="middle">合计</text><text x="80" y="96" textAnchor="middle">{number(total)}</text></svg><ul>{positive.map((r,i)=><li key={r.label}><i style={{background:colors[i%colors.length]}}/>{r.label}：{number(r.value)} <small>{number(r.value/total*100)}%</small></li>)}</ul></div> : <Empty compact title="暂无统计数据"/>;
}
export default function DashboardCharts({data}) {
  const [period,setPeriod]=useState('month'),[start,setStart]=useState(`${data.today.slice(0,4)}-01-01`),[end,setEnd]=useState(data.today),[customer,setCustomer]=useState(''),[platform,setPlatform]=useState('');
  const [customerMetric,setCustomerMetric]=useState('amount'),[platformMetric,setPlatformMetric]=useState('amount'),[materialMetric,setMaterialMetric]=useState('items'),[unit,setUnit]=useState(''),[invoiceMetric,setInvoiceMetric]=useState('invoiceAmount');
  const result=useMemo(()=>dashboardAnalytics(data,{period,start,end,customer,platform}),[data,period,start,end,customer,platform]);
  const s=result.summary, selectedUnit=result.units.includes(unit)?unit:result.units[0];
  const select=(label,value,set,options)=><select aria-label={label} value={value} onChange={e=>set(e.target.value)}>{options.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select>;
  return <section className="dashboard-analytics" aria-label="统计图">
    <Panel title="统计图"><div className="toolbar analytics-filters">{select('统计周期',period,setPeriod,[['month','月度'],['quarter','季度'],['year','年度']])}<input aria-label="统计开始日期" title="统计开始日期" type="date" value={start} onChange={e=>setStart(e.target.value)}/><span>至</span><input aria-label="统计截止日期" title="统计截止日期" type="date" value={end} onChange={e=>setEnd(e.target.value)}/>{select('统计客户',customer,setCustomer,[['','全部客户'],...[...new Set(data.orders.map(o=>o.customer))].sort().map(v=>[v,v])])}{select('统计平台',platform,setPlatform,[['','全部平台'],...[...new Set(data.purchases.map(p=>p.platform))].sort().map(v=>[v,v])])}</div></Panel>
    {start && end && start>end ? <p className="error" role="alert">开始日期不能晚于截止日期</p> : <>
    <div className="analytics-summary">{[['客户订单',`${s.orderCount} 单 / ¥${number(s.orderAmount)}`],['物料',`${s.itemCount} 项 / ${unitText(s.quantities)}`],['平台采购',`${s.purchaseCount} 单 / ¥${number(s.purchaseAmount)}`],['有效采购成本',`¥${number(s.cost)}`],['已确认发票',`${s.invoiceCount} 张 / ¥${number(s.invoiceAmount)}`],['采购退货',unitText(s.returned)],['确认到账退款',`¥${number(s.refund)}`],['待采购',unitText(s.pending)],['待交付',unitText(s.delivery)]].map(([label,value])=><div key={label}><small>{label}</small><strong>{value}</strong></div>)}</div>
    <div className="analytics-grid">
      <Panel title="各客户订单" action={select('客户图指标',customerMetric,setCustomerMetric,[['amount','金额（元）'],['count','订单数']])}><Bars rows={[...result.customers].sort((a,b)=>b[customerMetric]-a[customerMetric])} series={[{key:customerMetric,label:customerMetric==='amount'?'金额':'订单数'}]}/></Panel>
      <Panel title="订单金额与采购成本（元）"><Bars rows={result.periods} series={[{key:'orders',label:'订单金额'},{key:'cost',label:'采购成本'}]}/></Panel>
      <Panel title="物料统计" action={<>{select('物料图指标',materialMetric,setMaterialMetric,[['items','物料项数'],['quantity','物料数量']])}{materialMetric==='quantity'?select('物料统计单位',selectedUnit||'',setUnit,result.units.map(u=>[u,u])):null}</>}><Bars rows={result.periods.map(r=>({...r,quantity:r.quantities[selectedUnit]||0}))} series={[{key:materialMetric,label:materialMetric==='items'?'项数':selectedUnit||'数量'}]}/></Panel>
      <Panel title="采购平台占比" action={select('平台图指标',platformMetric,setPlatformMetric,[['amount','实付款（元）'],['count','订单数']])}><Donut rows={result.platforms.map(r=>({label:r.label,value:r[platformMetric]}))}/></Panel>
      <Panel title="已确认发票" action={select('发票图指标',invoiceMetric,setInvoiceMetric,[['invoiceAmount','金额（元）'],['invoiceCount','发票张数']])}><Bars rows={result.periods} series={[{key:invoiceMetric,label:invoiceMetric==='invoiceAmount'?'金额':'张数'}]}/></Panel>
      <Panel title="收票完成情况（元）"><Donut rows={result.receipt}/></Panel>
    </div>
    <details className="analytics-definitions"><summary>统计口径</summary><p>客户订单按创建日期、采购成本与实付款按采购日期、发票按开票日期归期，缺少日期单列。包含已归档的确认订单，扣除已取消需求；草稿不计入。采购成本已扣除退货释放部分。退款按确认到账日期统计。数量按单位分别汇总。发票按唯一记录去重。</p><p>客户或平台筛选匹配关联单据：订单金额、采购实付款及发票金额按匹配单据全额统计，跨客户合单不拆分；客户采购成本按关联料品分摊。收票完成情况按所选采购日期范围计算。</p></details>
    </>}
  </section>;
}
