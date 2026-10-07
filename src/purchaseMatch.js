const normalize = value => String(value || '').normalize('NFKC').toUpperCase().replace(/\s+/g, '').replace(/[×＊]/g, '*');
const modelTokens = value => [...new Set(normalize(value).match(/[A-Z]+[-.]?\d+(?:[.*\/-]\d+)*/g) || [])];

export function purchaseMatchCandidates(line, products) {
  const quantity = Number(line.demand_quantity ?? line.quantity) - Number(line.purchased || 0);
  const spec = normalize(line.spec);
  const tokens = modelTokens(line.spec);
  return products.map((product, index) => {
    const sameQuantity = quantity > 0 && Math.abs(Number(product.quantity) - quantity) < .000001;
    const productSpec = normalize(product.spec);
    const exactSpec = spec.length >= 3 && (spec === productSpec || productSpec.includes(spec));
    const shared = tokens.filter(token => modelTokens(product.spec).includes(token));
    const score = (sameQuantity ? 60 : 0) + (exactSpec ? 50 : Math.min(40, shared.length * 20));
    const reason = [sameQuantity ? `数量相同：${quantity}` : '', exactSpec ? '规格吻合' : shared.length ? `型号吻合：${shared.join('、')}` : ''].filter(Boolean).join('；');
    return {index, score, sameQuantity, reason};
  }).filter(candidate => candidate.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
}

export function suggestPurchaseMatches(lines, products, assignments) {
  const result = {...assignments};
  const pending = lines.filter(line => result[line.id] === undefined || result[line.id] === '');
  const candidates = pending.map(line => ({line, matches:purchaseMatchCandidates(line, products)}));
  const occupied = new Set(Object.values(result).filter(value => value !== '').map(Number));
  for (const {line, matches} of candidates) {
    const best = matches[0];
    if (!best?.sameQuantity || occupied.has(best.index) || matches[1] && best.score - matches[1].score < 20) continue;
    // Do not assign one product to competing order lines on quantity evidence alone.
    if (candidates.some(other => other.line.id !== line.id && other.matches.some(candidate => candidate.index === best.index && candidate.score >= best.score))) continue;
    result[line.id] = best.index;
    occupied.add(best.index);
  }
  return result;
}
