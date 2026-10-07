const {extractOrderList} = require('./extract-order-list.cjs');
const {extractOrder} = require('./extract-order.cjs');
const {isOrderURL} = require('./policy.cjs');

function scrollOrderList(reset = false) {
  const root = document.scrollingElement;
  const containers = [root, ...document.querySelectorAll('div,main,section')].filter(element => element &&
    element.scrollHeight > element.clientHeight + 2 && element.clientHeight > 100 &&
    (element === root || /auto|scroll/.test(getComputedStyle(element).overflowY) && /订单号/.test(element.innerText)));
  const container = containers.sort((a, b) => b.clientHeight - a.clientHeight)[0];
  if (!container) return false;
  if (reset) { container.scrollTop = 0; return true; }
  const before = container.scrollTop;
  container.scrollTop += Math.max(100, Math.floor(container.clientHeight * .8));
  return container.scrollTop > before + 1;
}

async function syncPurchaseDrafts({contents, api, shouldStop, onProgress = () => {}, wait = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
  const state = await api('/purchase-drafts/sync-state');
  if (!state.since || !Array.isArray(state.known)) throw new Error('采购草稿同步配置不可用');
  const known = new Set(state.known), pending = new Map();
  // Revisit the recent window so a missed order remains discoverable after a
  // later successful scan advances the checkpoint.
  const recent = new Date(state.through + 'T00:00:00Z');
  recent.setUTCDate(recent.getUTCDate() - 6);
  const since = [state.first_date, recent.toISOString().slice(0, 10)].sort().at(-1);
  let created = 0, error = '', completed = false;
  const pages = [], seenPages = new Set();
  let lastReadError = '', phase = 'list';
  const report = () => onProgress({startedAt, through:state.through, pages, discovered:pending.size, created, completed, phase, lastReadError, location:contents.getURL?.().split('?')[0] || '', error});
  const startedAt = new Date().toISOString();
  const read = fn => contents.executeJavaScriptInIsolatedWorld(1001, [{code:`(${fn.toString()})()`}]);
  const load = async url => {
    let timer;
    try { await Promise.race([contents.loadURL(url), new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('淘宝页面加载超时')),20000);})]); }
    catch (e) {
      // Taobao can replace the initial navigation with its own redirect. Read
      // and validate the resulting page instead of abandoning the whole scan.
      if (e.code !== 'ERR_ABORTED' && e.errno !== -3 && !/ERR_ABORTED/.test(e.message)) throw e;
    }
    finally {clearTimeout(timer);}
  };
  try {
    await load('https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm');
    let previousOrders = new Set(), previousPage = null;
    for (let page = 0; page < 100 && !shouldStop(); page++) {
      let result, bottom = false;
      await contents.executeJavaScriptInIsolatedWorld(1001, [{code:`(${scrollOrderList.toString()})(true)`}]);
      const pageOrders = new Map();
      for (let segment = 0; segment < 200 && !shouldStop(); segment++) {
        let signature = '', stable = 0;
        for (let attempt = 0; attempt < 20 && !shouldStop(); attempt++) {
          await wait(1000);
          try {
            const candidate = await read(extractOrderList);
            lastReadError = '';
            if (segment === 0 && previousOrders.size && (!candidate.orders.length || candidate.orders.every(o => previousOrders.has(o.platform_order)) || previousPage != null && candidate.currentPage != null && candidate.currentPage <= previousPage)) continue;
            const current = JSON.stringify(candidate);
            stable = current === signature ? stable + 1 : 1;
            signature = current;
            if (stable >= 3) {result = candidate; break;}
          } catch (e) { lastReadError = e.message; signature = ''; stable = 0; }
      }
      if (shouldStop()) break;
      if (!result) throw new Error(`第 ${page + 1} 页未加载新订单，翻页未成功或需要验证${lastReadError ? '：' + lastReadError : ''}`);
      for (const order of result.orders) {
        pageOrders.set(order.platform_order, order);
        if (!known.has(order.platform_order) && (!order.date || order.date >= since) && isOrderURL(order.source_url)) pending.set(order.platform_order, order);
      }
      if (!await read(scrollOrderList)) {bottom = true; break;}
      result = null;
      }
      if (shouldStop()) break;
      if (!bottom) throw new Error('订单列表尚未滚动扫描完成，请重试');
      if (page === 0 && result.currentPage != null && result.currentPage !== 1) throw new Error('订单列表未从第 1 页开始，采集未完成');
      const pageKey = [...pageOrders.keys()].sort().join(',');
      if (seenPages.has(pageKey)) throw new Error(`第 ${page + 1} 页重复，已停止以避免漏采`);
      seenPages.add(pageKey);
      pages.push({page:result.currentPage || page + 1, orders:[...pageOrders.keys()], count:pageOrders.size, hasNext:result.hasNext, lastPage:result.lastPage === true, pagination:result.pagination || ''});
      report();
      previousOrders = new Set(pageOrders.keys());
      previousPage = result.currentPage;
      if (pageOrders.size && [...pageOrders.values()].every(o => o.date && o.date < since)) {completed = true; break;}
      if (!result.hasNext) {
        if (result.lastPage !== true) throw new Error(`第 ${page + 1} 页未识别到下一页或明确末页，采集未完成`);
        completed = true; break;
      }
      if (!await contents.executeJavaScriptInIsolatedWorld(1001, [{code:`(${extractOrderList.toString()})(true)`}])) throw new Error('淘宝订单翻页失败，请重试');
      await contents.executeJavaScriptInIsolatedWorld(1001, [{code:`(${scrollOrderList.toString()})(true)`}]);
    }
  } catch (e) { error = e.message; report(); }
  phase = 'details';
  try {
    // Refresh transaction status as well as logistics for every active draft.
    for (const draft of state.drafts || []) {
      const source = draft.payload;
      if (isOrderURL(source.source_url)) pending.set(source.platform_order, source);
    }
    for (const order of pending.values()) {
      if (shouldStop()) break;
      try {
        await load(order.source_url);
        let source;
        for (let attempt = 0; attempt < 3; attempt++) {
          await wait(1800);
          try {source = await read(extractOrder); break;} catch { /* Retry rendering. */ }
        }
        if (!source || source.platform_order !== order.platform_order || !source.purchased_date || !source.transaction_status) throw new Error('订单详情或创建日期未能识别');
        if (source.purchased_date < state.first_date || source.purchased_date > state.through) continue;
        const saved = await api('/purchase-drafts', source);
        if (saved.created) created++;
      } catch { error = [error, `订单 ${order.platform_order} 详情或物流提取失败，下一轮自动重试`].filter(Boolean).join('；').slice(0, 500); }
    }
    if (shouldStop()) error = '本轮采集中断，下一轮继续';
    else if (!completed && !error) error = '订单列表未扫描完成，下一轮继续';
  } catch (e) { error = e.message; }
  phase = 'finished';
  report();
  await api('/purchase-drafts/sync-result', {through:state.through, error});
  return {created, error};
}
module.exports = {syncPurchaseDrafts};
