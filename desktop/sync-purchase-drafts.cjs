const {extractOrderList} = require('./extract-order-list.cjs');
const {extractOrder} = require('./extract-order.cjs');
const {isOrderURL, isTaobaoVerifyURL, isTaobaoTransientRedirect} = require('./policy.cjs');

// 淘宝风控对“高频打开订单详情页”非常敏感。按需刷新 + 每轮限量 + 随机间隔，
// 遇到验证立刻停手，避免越试越容易被要求验证。
const REFRESH_HOURS = 12;          // 活跃／回收站订单默认 12 小时刷新一次
const SETTLED_REFRESH_HOURS = 24;  // 物流已终结（已签收／退回／异常）24 小时刷新一次
const MAX_DETAILS_PER_RUN = 20;    // 每轮最多打开 20 个订单详情页
const DETAIL_DELAY_MIN = 3000;     // 详情页之间随机等待 3～6 秒
const DETAIL_DELAY_MAX = 6000;
const SETTLED_STATUSES = ['已签收', '退回', '异常'];
const needsVerify = value => /验证|滑块|登录|安全/.test(String(value || ''));

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
  // 扫描下限＝采集起始日（而不是“今天往前 6 天”）：否则一旦某笔订单在
  // 首次扫描时漏掉，过了 6 天窗口就永远补不回来，而且不会报错。
  const since = state.first_date;
  const readOrders = new Set(), newIds = new Set(), skippedRange = [], excludedByListDate = [], failedOrders = [];
  let created = 0, error = '', completed = false, stalePages = 0, deferred = 0;
  const pages = [], seenPages = new Set();
  let lastReadError = '', phase = 'list';
  const report = () => onProgress({startedAt, through:state.through, since, pages, read:readOrders.size, discovered:newIds.size, created, skipped:skippedRange.length, failed:failedOrders.length, completed, phase, lastReadError, location:contents.getURL?.().split('?')[0] || '', error});
  const startedAt = new Date().toISOString();
  const read = fn => contents.executeJavaScriptInIsolatedWorld(1001, [{code:`(${fn.toString()})()`}]);
  const load = async (url, timeoutMs = 20000) => {
    let timer;
    try { await Promise.race([contents.loadURL(url), new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('淘宝页面加载超时')),timeoutMs);})]); }
    catch (e) {
      // Taobao can replace the initial navigation with its own redirect. Read
      // and validate the resulting page instead of abandoning the whole scan.
      if (e.code !== 'ERR_ABORTED' && e.errno !== -3 && !/ERR_ABORTED/.test(e.message)) throw e;
    }
    finally {clearTimeout(timer);}
  };
  // 淘宝刷新 UMID 时会先跳到 login.taobao.com/havanaone/render_*.htm 再自动跳回，
  // 这里等它跳完，避免把中转页误判成“需要验证”。
  const settleRedirect = async () => { for (let i = 0; i < 8 && isTaobaoTransientRedirect(contents.getURL?.()); i++) await wait(1200); };
  try {
    // 订单列表首屏偶尔会因淘宝本身响应慢而超时：放宽到 45 秒并重试一次，
    // 只有连续两次失败才把这一轮判为超时。
    for (let attempt = 0; ; attempt++) {
      try { await load('https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm', 45000); break; }
      catch (error) {
        if (attempt >= 1 || !/超时/.test(error?.message || '')) throw error;
        await wait(3000);
      }
    }
    await settleRedirect();
    if (isTaobaoVerifyURL(contents.getURL?.())) throw new Error('淘宝要求验证：请打开客户端里的“淘宝订单”窗口完成滑块验证，完成后会自动继续同步');
    let previousOrders = new Set(), previousPage = null;
    for (let page = 0; page < 100 && !shouldStop(); page++) {
      let result, bottom = false;
      await contents.executeJavaScriptInIsolatedWorld(1001, [{code:`(${scrollOrderList.toString()})(true)`}]);
      const pageOrders = new Map();
      for (let segment = 0; segment < 200 && !shouldStop(); segment++) {
        let signature = '', stable = 0;
        for (let attempt = 0; attempt < 20 && !shouldStop(); attempt++) {
          await wait(1000);
          if (isTaobaoTransientRedirect(contents.getURL?.())) { await settleRedirect(); continue; }
          try {
            const candidate = await read(extractOrderList);
            lastReadError = '';
            if (segment === 0 && previousOrders.size && (!candidate.orders.length || candidate.orders.every(o => previousOrders.has(o.platform_order)) || previousPage != null && candidate.currentPage != null && candidate.currentPage <= previousPage)) continue;
            const current = JSON.stringify(candidate);
            stable = current === signature ? stable + 1 : 1;
            signature = current;
            if (stable >= 3) {result = candidate; break;}
          } catch (e) {
            lastReadError = e.message; signature = ''; stable = 0;
            if (needsVerify(e.message) || isTaobaoVerifyURL(contents.getURL?.())) throw new Error('淘宝要求验证：请打开客户端里的“淘宝订单”窗口完成滑块验证，完成后会自动继续同步');
          }
      }
      if (shouldStop()) break;
      if (!result) throw new Error(`第 ${page + 1} 页未加载新订单，翻页未成功或需要验证${lastReadError ? '：' + lastReadError : ''}`);
      for (const order of result.orders) {
        pageOrders.set(order.platform_order, order);
        readOrders.add(order.platform_order);
        if (known.has(order.platform_order)) continue;
        if (order.date && order.date < since) { excludedByListDate.push({order:order.platform_order, date:order.date}); continue; }
        if (isOrderURL(order.source_url)) { pending.set(order.platform_order, order); newIds.add(order.platform_order); }
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
      // 连续两页都早于采集起始日才收工：单页日期识别异常时不再提前结束扫描。
      stalePages = pageOrders.size && [...pageOrders.values()].every(o => o.date && o.date < since) ? stalePages + 1 : 0;
      if (stalePages >= 2) {completed = true; break;}
      if (!result.hasNext) {
        if (result.lastPage !== true) throw new Error(`第 ${page + 1} 页未识别到下一页或明确末页，采集未完成`);
        completed = true; break;
      }
      if (!await contents.executeJavaScriptInIsolatedWorld(1001, [{code:`(${extractOrderList.toString()})(true)`}])) throw new Error('淘宝订单翻页失败，请重试');
      await contents.executeJavaScriptInIsolatedWorld(1001, [{code:`(${scrollOrderList.toString()})(true)`}]);
    }
  } catch (e) { error = needsVerify(e?.message) ? '淘宝要求验证：请打开客户端里的“淘宝订单”窗口完成滑块验证，完成后会自动继续同步' : e.message; report(); }
  phase = 'details';
  try {
    // 按需刷新：新订单立即抓取；已在库的活跃／回收站订单按时间与物流状态决定是否重新打开详情页。
    const now = Date.now();
    for (const draft of state.drafts || []) {
      const source = draft.payload || {};
      if (!isOrderURL(source.source_url)) continue;
      if (pending.has(source.platform_order)) continue;
      const stamp = Date.parse(draft.updated_at || source.sync_checked_at || '') || 0;
      const ageHours = stamp ? (now - stamp) / 3600000 : Infinity;
      const packages = source.packages || [];
      const settled = packages.length > 0 && packages.every(item => SETTLED_STATUSES.includes(item.status));
      if (ageHours < (settled ? SETTLED_REFRESH_HOURS : REFRESH_HOURS)) { deferred++; continue; }
      pending.set(source.platform_order, source);
    }
    let fetched = 0;
    for (const order of pending.values()) {
      if (shouldStop()) break;
      if (fetched >= MAX_DETAILS_PER_RUN) { deferred += pending.size - fetched; break; }
      fetched++;
      try {
        await load(order.source_url);
        await settleRedirect();
        let source, readError = '';
        for (let attempt = 0; attempt < 3; attempt++) {
          await wait(1800);
          try {source = await read(extractOrder); break;} catch (e) { readError = e.message; /* Retry rendering. */ }
        }
        if (!source || source.platform_order !== order.platform_order || !source.purchased_date || !source.transaction_status) throw new Error(`订单详情或创建日期未能识别${readError ? '：' + readError : ''}`);
        if (source.purchased_date < state.first_date || source.purchased_date > state.through) {
          skippedRange.push({order:order.platform_order, date:source.purchased_date});
          continue;
        }
        const saved = await api('/purchase-drafts', source);
        if (saved.created) created++;
      } catch (e) {
        // 遇到淘宝验证／登录页立刻停手，避免连续访问加重风控。
        if (needsVerify(e?.message) || isTaobaoVerifyURL(contents.getURL?.())) {
          error = '淘宝要求验证：请打开客户端里的“淘宝订单”窗口完成滑块验证，完成后会自动继续同步';
          break;
        }
        failedOrders.push(order.platform_order);
        error = [error, `订单 ${order.platform_order} 详情或物流提取失败，下一轮自动重试`].filter(Boolean).join('；').slice(0, 500);
      }
      await wait(DETAIL_DELAY_MIN + Math.floor(Math.random() * (DETAIL_DELAY_MAX - DETAIL_DELAY_MIN)));
    }
    if (shouldStop()) error = '本轮采集中断，下一轮继续';
    else if (!completed && !error) error = '订单列表未扫描完成，下一轮继续';
  } catch (e) { error = e.message; }
  phase = 'finished';
  const stats = {
    since, through:state.through, pages:pages.length, read:readOrders.size, known:readOrders.size - newIds.size,
    new:newIds.size, created, skipped:skippedRange.length, skipped_sample:skippedRange.slice(0, 10),
    deferred, details_per_run: MAX_DETAILS_PER_RUN,
    excluded_by_list_date:excludedByListDate.length, excluded_sample:excludedByListDate.slice(0, 10),
    failed:failedOrders.length, failed_sample:failedOrders.slice(0, 10), warning:'',
  };
  // 订单列表里早于采集起始日的订单是按设置正常排除，不当作异常提醒；
  // 只有“列表日期在范围内、但详情日期早于起始日”这类不一致才提示。
  if (skippedRange.length) stats.warning = `发现 ${skippedRange.length} 笔订单的采购日期早于采集起始日 ${state.first_date}，本次未导入；如需补采更早的订单，请在“采购 · 自动同步”中调整采集起始日。`;
  report();
  await api('/purchase-drafts/sync-result', {through:state.through, error, stats});
  return {created, error, stats};
}
module.exports = {syncPurchaseDrafts};
