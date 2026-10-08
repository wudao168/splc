function splitCents(total, weights) {
  const positive = weights.map(value => Math.max(0, Number(value) || 0));
  const sum = positive.reduce((a, b) => a + b, 0);
  const shares = positive.map(value => total * (sum ? value / sum : 1 / weights.length));
  const cents = shares.map(Math.floor);
  const remainder = total - cents.reduce((a, b) => a + b, 0);
  shares.map((value, index) => ({index, fraction:value - cents[index]})).sort((a, b) => b.fraction - a.fraction || a.index - b.index).slice(0, remainder).forEach(({index}) => cents[index]++);
  return cents;
}

export function allocatePurchaseCosts(items, products, associations, amount, orderLines) {
  const total = Math.max(0, Math.round((Number(amount) || 0) * 100));
  const cents = value => Math.max(0, Math.round((Number(value) || 0) * 100));
  const keyOf = item => item.key ?? item.order_line_id;
  // 仅关联料品的备货行使用人工填写的成本，其余金额再按报价分摊给客户料品行。
  const fixed = items.filter(item => !item.order_line_id);
  const manual = fixed.reduce((sum, item) => sum + cents(item.cost), 0);
  const free = items.filter(item => item.order_line_id);
  const quoteWeight = item => (orderLines.find(line => line.id === item.order_line_id)?.price_cents || 0) * Number(item.quantity);
  const groups = products.length ? products.map((product, index) => ({
    items:free.filter(item => (associations[index] || []).includes(item.order_line_id)),
    cents:product.amount !== '' && product.amount != null && Number.isFinite(Number(product.amount)) && Number(product.amount) >= 0 ? Math.round(Number(product.amount) * 100) : null
  })).filter(group => group.items.length) : [{items:free, cents:null}];
  const missing = groups.filter(group => group.cents === null);
  const remaining = Math.max(0, total - manual - groups.reduce((sum, group) => sum + (group.cents || 0), 0));
  const fallback = splitCents(remaining, missing.map(group => group.items.reduce((sum, item) => sum + quoteWeight(item), 0)));
  missing.forEach((group, index) => { group.cents = fallback[index]; });
  const costs = new Map();
  groups.forEach(group => {
    splitCents(group.cents, group.items.map(quoteWeight)).forEach((cost, i) => costs.set(keyOf(group.items[i]), cost));
  });
  return items.map(item => item.order_line_id
    ? {...item, cost:((costs.get(keyOf(item)) || 0) / 100).toFixed(2)}
    : {...item, cost:(cents(item.cost) / 100).toFixed(2)});
}
