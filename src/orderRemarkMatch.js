const normalize = value => String(value || '').normalize('NFKC').toUpperCase().replace(/[×*＊]/g, 'X').replace(/[^A-Z0-9]/g, '');
const codes = value => new Set((String(value || '').toUpperCase().match(/[A-Z]{1,8}\s*\d{2,}(?:[\s-]+[A-Z0-9]{1,8})*/g) || []).map(normalize).filter(code => code.length >= 4 && !/^PO\d{6,}$/.test(code)));

// Similar models are references only; they never affect automatic selection.
export function similarOrderLineScores(remark, available) {
  const models = (String(remark || '').normalize('NFKC').toUpperCase().replace(/[×*＊]/g, 'X').match(/[A-Z][A-Z0-9]*(?:[-/.][A-Z0-9]+)+/g) || []).map(normalize).filter(model => model.length >= 6 && /\d/.test(model));
  const scores = new Map();
  for (const line of available) {
    const spec = normalize(line.spec);
    if (spec.length < 6) continue;
    for (const model of models) {
      if (spec.match(/^[A-Z]+/)?.[0] !== model.match(/^[A-Z]+/)?.[0]) continue;
      let row = Array.from({length:model.length + 1}, (_, i) => i);
      for (let i = 1; i <= spec.length; i++) {
        const next = [i];
        for (let j = 1; j <= model.length; j++) next[j] = Math.min(next[j-1]+1, row[j]+1, row[j-1]+(spec[i-1] === model[j-1] ? 0 : 1));
        row = next;
      }
      const score = 1 - row[model.length] / Math.max(spec.length, model.length);
      if (score >= .85) scores.set(line.id, Math.max(scores.get(line.id) || 0, score));
    }
  }
  return scores;
}

export function suggestOrderLineIds(remark, available, orders, orderId = null) {
  if (!remark?.trim()) return [];
  const note = remark.toUpperCase();
  const notePOs = new Set((note.match(/(?:PO|C)[\s:-]*\d{6,}/g) || []).map(normalize));
  const noteCodes = codes(note);
  const similarities = similarOrderLineScores(remark, available);
  const candidates = available.filter(line => !orderId || line.order_id === Number(orderId)).map(line => {
    const po = normalize(orders[line.order_id]?.po);
    const poMatch = po && notePOs.has(po);
    const spec = normalize(line.spec);
    const exactSpec = spec.length >= 4 && new RegExp(spec.split('').join('[^A-Z0-9]*') + '(?![0-9])').test(note.normalize('NFKC').replace(/[×*＊]/g, 'X'));
    const modelMatch = exactSpec || (!similarities.has(line.id) && [...codes(`${line.name} ${line.spec} ${line.description}`)].some(code => noteCodes.has(code)));
    return {id:line.id, poMatch, modelMatch, exactSpec, spec};
  });
  const poMatches = candidates.filter(item => item.poMatch);
  if (!orderId && poMatches.length === 1) {
    const conflictingModel = candidates.some(item => item.modelMatch && !item.poMatch);
    return conflictingModel && !poMatches[0].modelMatch ? [] : [poMatches[0].id];
  }
  const modelMatches = (orderId ? candidates : poMatches.length ? poMatches : candidates).filter(item => item.modelMatch);
  const exactMatches = modelMatches.filter(item => item.exactSpec);
  if (exactMatches.length) return exactMatches.filter(item => exactMatches.filter(other => other.spec === item.spec).length === 1).map(item => item.id);
  return modelMatches.length === 1 ? [modelMatches[0].id] : [];
}
