export function dashboardAnalytics(data, filters) {
  const {period='month', start='', end='', customer='', platform=''} = filters;
  const bucket = date => !date ? '日期待补充' : period === 'year' ? date.slice(0,4) : period === 'quarter' ? `${date.slice(0,4)} Q${Math.ceil(Number(date.slice(5,7))/3)}` : date.slice(0,7);
  const inRange = date => !date || ((!start || date.slice(0,10)>=start) && (!end || date.slice(0,10)<=end));
  const orders = new Map(data.orders.filter(o=>!o.deleted_at && o.status==='confirmed').map(o=>[o.id,o]));
  const lines = new Map(data.order_lines.filter(l=>orders.has(l.order_id)).map(l=>[l.id,l]));
  const purchases = data.purchases.filter(p=>!p.deleted_at && (!platform || p.platform===platform));
  const purchaseIds = new Set(purchases.map(p=>p.id));
  const relatedLines = data.purchase_lines.filter(l=>purchaseIds.has(l.purchase_id));
  const platformOrderIds = new Set(relatedLines.map(l=>lines.get(l.order_line_id)?.order_id));
  const selectedOrders = [...orders.values()].filter(o=>(!customer || o.customer===customer) && (!platform || platformOrderIds.has(o.id)));
  const selectedOrderIds = new Set(selectedOrders.map(o=>o.id));
  const selectedLines = [...lines.values()].filter(l=>selectedOrderIds.has(l.order_id));
  const linkedToCustomer = p => !customer || relatedLines.some(l=>l.purchase_id===p.id && orders.get(lines.get(l.order_line_id)?.order_id)?.customer===customer);
  const selectedPurchases = purchases.filter(linkedToCustomer);
  const selectedPurchaseIds = new Set(selectedPurchases.map(p=>p.id));
  const periods = new Map(), customers = new Map(), platforms = new Map(), units = new Set();
  const periodRow = date => {const key=bucket(date); if(!periods.has(key)) periods.set(key,{label:key,orders:0,cost:0,items:0,quantities:{},invoiceCount:0,invoiceAmount:0});return periods.get(key);};
  const addUnit = (target,unit,amount) => {unit=unit||'未注明单位';target[unit]=(target[unit]||0)+amount;};
  const summary = {orderCount:0,orderAmount:0,itemCount:0,quantities:{},purchaseCount:0,purchaseAmount:0,cost:0,invoiceCount:0,invoiceAmount:0,returned:{},refund:0,pending:{},delivery:{}};
  for(const o of selectedOrders.filter(o=>inRange(o.created_at))) {
    const items=selectedLines.filter(l=>l.order_id===o.id && l.demand_quantity>0);
    const amount=items.reduce((sum,l)=>sum+Math.round(l.demand_quantity*l.price_cents),0)/100;
    const row=periodRow(o.created_at), c=customers.get(o.customer)||{label:o.customer,count:0,amount:0};
    c.count++;c.amount+=amount;customers.set(o.customer,c);row.orders+=amount;row.items+=items.length;
    summary.orderCount++;summary.orderAmount+=amount;summary.itemCount+=items.length;
    for(const l of items) {const unit=l.unit||'未注明单位';units.add(unit);addUnit(row.quantities,unit,l.demand_quantity);addUnit(summary.quantities,unit,l.demand_quantity);addUnit(summary.pending,unit,Math.max(0,l.demand_quantity-l.purchased));addUnit(summary.delivery,unit,Math.max(0,l.demand_quantity-l.dispatched_quantity));}
  }
  let received=0,missing=0;
  for(const p of selectedPurchases.filter(p=>inRange(p.purchased_date))) {
    const cost=relatedLines.filter(l=>l.purchase_id===p.id && (!customer || orders.get(lines.get(l.order_line_id)?.order_id)?.customer===customer)).reduce((s,l)=>s+l.cost_cents,0)/100;
    const row=platforms.get(p.platform)||{label:p.platform,count:0,amount:0};row.count++;row.amount+=p.amount_cents/100;platforms.set(p.platform,row);
    summary.purchaseCount++;summary.purchaseAmount+=p.amount_cents/100;summary.cost+=cost;periodRow(p.purchased_date).cost+=cost;
    if(p.invoice_stage!=='不需开票') {received+=p.received_cents/100;missing+=Math.max(0,p.remaining_cents)/100;}
  }
  const invoiceIds=new Set(data.invoice_allocations.filter(a=>selectedPurchaseIds.has(a.purchase_id)).map(a=>a.invoice_id));
  for(const invoice of data.invoices.filter(i=>invoiceIds.has(i.id) && inRange(i.issued_date))) {summary.invoiceCount++;summary.invoiceAmount+=invoice.amount_cents/100;const row=periodRow(invoice.issued_date);row.invoiceCount++;row.invoiceAmount+=invoice.amount_cents/100;}
  const purchaseLineMap=new Map(relatedLines.map(l=>[l.id,l]));
  for(const c of data.purchase_cases||[]) {
    const pl=purchaseLineMap.get(c.purchase_line_id), line=lines.get(pl?.order_line_id);
    if(!pl || !selectedPurchaseIds.has(pl.purchase_id) || (customer && orders.get(line?.order_id)?.customer!==customer) || c.status==='void') continue;
    if(c.kind==='supplier_return' && c.status==='completed' && inRange(c.completed_at)) addUnit(summary.returned,line?.unit,c.quantity);
    if(c.finance_confirmed_at && inRange(c.finance_confirmed_at)) summary.refund+=c.amount_cents/100;
  }
  return {summary,periods:[...periods.values()].sort((a,b)=>a.label==='日期待补充'?1:b.label==='日期待补充'?-1:a.label.localeCompare(b.label)),customers:[...customers.values()],platforms:[...platforms.values()],units:[...units].sort(),receipt:[{label:'已收票',value:received},{label:'待收票',value:missing}]};
}
