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
  const quoteWeight = item => (orderLines.find(line => line.id === item.order_line_id)?.price_cents || 0) * Number(item.quantity);
  const groups = products.length ? products.map((product, index) => ({
    items:items.filter(item => (associations[index] || []).includes(item.order_line_id)),
    cents:product.amount !== '' && product.amount != null && Number.isFinite(Number(product.amount)) && Number(product.amount) >= 0 ? Math.round(Number(product.amount) * 100) : null
  })).filter(group => group.items.length) : [{items, cents:null}];
  const missing = groups.filter(group => group.cents === null);
  const remaining = Math.max(0, total - groups.reduce((sum, group) => sum + (group.cents || 0), 0));
  const fallback = splitCents(remaining, missing.map(group => group.items.reduce((sum, item) => sum + quoteWeight(item), 0)));
  missing.forEach((group, index) => { group.cents = fallback[index]; });
  const costs = new Map();
  groups.forEach(group => {
    const groupTotal = group.cents;
    splitCents(groupTotal, group.items.map(quoteWeight)).forEach((cost, i) => costs.set(group.items[i].order_line_id, cost));
  });
  return items.map(item => ({...item, cost:((costs.get(item.order_line_id) || 0) / 100).toFixed(2)}));
}
