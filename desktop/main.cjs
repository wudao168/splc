const { app, BrowserWindow, WebContentsView, ipcMain, session, dialog, Menu, Tray } = require('electron');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { syncPurchaseDrafts } = require('./sync-purchase-drafts.cjs');
const { extractOrder } = require('./extract-order.cjs');
const { extractInvoicePage } = require('./extract-invoices.cjs');
const { extractInvoiceDetail } = require('./extract-invoice-detail.cjs');
const { extractInvoiceSummary } = require('./extract-invoice-summary.cjs');
const { downloadInvoiceFile } = require('./download-invoice.cjs');
const { needsInvoiceFile, selectInvoicePurchases } = require('./invoice-targets.cjs');
const { isTaobaoURL, isOrderURL, isTaobaoLoginRedirect, isTaobaoVerifyURL, isTaobaoTransientRedirect } = require('./policy.cjs');
const { applyInvoiceInPage } = require('./apply-invoice.cjs');
const { submitInvoiceForm } = require('./apply-invoice-form.cjs');
const { clickSellerChat, fillSellerChat } = require('./seller-chat.cjs');

const root = path.resolve(__dirname, '..');
const dataDir = path.resolve(process.env.CAIDAN_DATA || (app.isPackaged ? path.join(app.getPath('userData'), 'business') : path.join(root, '.data')));
app.setPath('userData', process.env.CAIDAN_PROFILE || path.join(dataDir, 'desktop-profile'));
const home = 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm';
// 淘宝对高频打开订单/物流/发票页面非常敏感：限制每轮访问量、跳过近期已同步的订单、页面之间
// 加随机间隔，遇到登录或验证跳转立即停手，避免连续访问加重风控。
const TRACKING_REFRESH_HOURS = 6;    // 物流未终结的订单 6 小时刷新一次
const TRACKING_RETRY_HOURS = 1;      // 上次物流同步失败的订单 1 小时后重试
const TRACKING_PER_RUN = 15;         // 每轮最多刷新 15 笔订单物流
const INVOICE_DETAILS_PER_RUN = 10;  // 每轮最多打开 10 个发票详情页
const INVOICE_LIST_PAGES = 40;       // 发票列表硬上限；正常会按开票日期自动提前停止
const AUTO_INVOICE_PER_RUN = 10;     // 每轮自动申请开票的订单数上限
// 按业务要求：只有「交易成功」的订单才自动申请开票／进入催票流程。
const INVOICE_APPLY_STATUSES = ['交易成功'];
const SYNC_DELAY_MIN = 3000;         // 页面之间随机等待 3～6 秒
const SYNC_DELAY_MAX = 6000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const syncDelay = () => sleep(SYNC_DELAY_MIN + Math.floor(Math.random() * (SYNC_DELAY_MAX - SYNC_DELAY_MIN)));
const shellURL = pathToFileURL(path.join(__dirname, 'shell.html')).href;
let win, business, taobao, syncView, syncTimer, syncing = false, backgroundSyncDone, finishBackgroundSync, manualInvoicePending = false, manualRequestPending = false, child, origin, pending, active = 'business', closing = false, exitConfirmed = false;
let tray;
const startupFile = path.join(app.getPath('userData'), 'startup.json');
function setStartup(enabled) {
  app.setLoginItemSettings({openAtLogin:enabled, path:process.execPath, args:['--startup']});
  fs.mkdirSync(path.dirname(startupFile), {recursive:true});
  fs.writeFileSync(startupFile, JSON.stringify({enabled}));
  return {enabled:app.getLoginItemSettings().openAtLogin};
}
ipcMain.handle('app:startup', (event, enabled) => {
  verify(event,business?.webContents,origin + '/');
  if (typeof enabled === 'boolean') return setStartup(enabled);
  return {enabled:app.getLoginItemSettings().openAtLogin};
});
const showMainWindow = () => { if (win) { win.show(); if (win.isMinimized()) win.restore(); win.focus(); } };
const internalToken = crypto.randomBytes(32).toString('hex');
let lastMessage = '正在启动本机服务…';
let invoiceDownload = null;

function state(message = lastMessage, error = false) {
  lastMessage = message;
  if (win && !win.isDestroyed()) win.webContents.send('shell:state', {active, message, error, url:taobao?.webContents.getURL() || ''});
}
function fit() {
  const [width, height] = win.getContentSize();
  for (const view of [business, taobao, syncView]) view?.setBounds({x:0, y:82, width, height:Math.max(0,height-82)});
}
function show(name) {
  active = name;
  business?.setVisible(name === 'business');
  taobao?.setVisible(name === 'taobao');
  fit();
  state(name === 'taobao' ? '登录淘宝，打开订单详情后点击“提取当前订单”。' : '采购信息保存在本机；提取结果需核对后保存。');
}
function verify(event, contents, url) {
  if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame || (url && event.senderFrame.url.split('#')[0] !== url)) throw new Error('页面来源不受信任');
}
async function openTaobao() {
  show('taobao');
  if (!taobao.webContents.getURL()) await taobao.webContents.loadURL(home);
}
function python() {
  const choices = [process.env.CAIDAN_PYTHON, path.join(root,'.venv','Scripts','python.exe'), path.join(process.env.USERPROFILE || '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe')];
  return choices.find(p => p && fs.existsSync(p)) || 'python';
}
function startServer() {
  return new Promise((resolve, reject) => {
    let settled = false, output = '';
    const executable = app.isPackaged ? path.join(process.resourcesPath,'caidan-server','caidan-server.exe') : python();
    const args = app.isPackaged ? ['--port','0'] : ['-u','-m','server.app','--port','0'];
    child = spawn(executable, args, {cwd:app.isPackaged ? path.dirname(executable) : root, env:{...process.env, CAIDAN_DATA:dataDir, CAIDAN_INTERNAL_TOKEN:internalToken, PYTHONUTF8:'1'}, windowsHide:true, stdio:['ignore','pipe','pipe']});
    const fail = error => { clearTimeout(timer); if (!settled) { settled = true; reject(error); } };
    const timer = setTimeout(() => fail(new Error('本机服务启动超时，请检查 Python 或打包的服务文件。')),45000);
    child.on('error', error => fail(new Error('本机服务无法启动：' + error.message)));
    child.stdout.on('data', data => {
      output = (output + data.toString()).slice(-4000);
      const match = output.match(/Caidan running at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match && !settled) { settled = true; clearTimeout(timer); resolve(match[1]); }
    });
    child.stderr.on('data', () => {}); // Request logs can contain business identifiers; do not persist them.
    child.on('exit', code => {
      if (!settled) fail(new Error(`本机服务启动失败（${code}）。请检查依赖和数据目录权限。`));
      else if (!closing) state('本机服务已停止，请关闭客户端后重新启动。', true);
    });
  });
}
function restrictTaobao(contents) {
  for (const event of ['will-navigate','will-redirect']) contents.on(event,(e,url) => {
    if (contents === syncView?.webContents && invoiceDownload) { e.preventDefault(); invoiceDownload(url); return; }
    if (!isTaobaoURL(url)) { e.preventDefault(); state('该链接不属于淘宝登录或订单网站，已停止跳转。',true); }
  });
  contents.setWindowOpenHandler(({url}) => {
    if (contents === syncView?.webContents && invoiceDownload) { invoiceDownload(url); return {action:'deny'}; }
    if (isTaobaoURL(url)) contents.loadURL(url).catch(() => state('页面打开失败，请重试。',true));
    else state('该链接不属于淘宝登录或订单网站。',true);
    return {action:'deny'};
  });
  contents.on('did-navigate', () => { if(active === 'taobao') state(); });
  contents.on('did-fail-load', (_,code,description,_url,mainFrame) => { if (mainFrame && code !== -3) state('淘宝页面加载失败：' + description + '，可点击刷新重试。',true); });
}

let lastAutoSync = 0;
let checkingSyncSettings = false;
async function checkAutoSync() {
  if (checkingSyncSettings || manualInvoicePending || closing || !origin) return;
  checkingSyncSettings = true;
  try {
    const response = await fetch(origin + '/api/sync-settings', {headers:{'X-Caidan-Internal':internalToken}});
    if (!response.ok) return;
    const config = await response.json();
    const request = config.manual_sync;
    // 网页点了“立即同步”时，让正在跑的自动轮次尽快收尾，别让用户干等。
    manualRequestPending = Boolean(request && request.status === 'pending');
    if (syncing) return;
    if (request && (request.status === 'pending' || request.status === 'running' && Date.now() - Date.parse(request.updated_at) > 120000)) {
      manualRequestPending = false;
      const post = async (action, body = {}) => {
        const response = await fetch(origin + '/api/sync-now/' + action, {method:'POST',headers:{'Content-Type':'application/json','X-Caidan-Internal':internalToken},body:JSON.stringify({request_id:request.request_id,...body})});
        if (!response.ok) throw new Error('同步任务状态保存失败');
        return response.json();
      };
      if (!(await post('start')).claimed) return;
      const heartbeat = setInterval(() => post('heartbeat').catch(() => {}), 15000);
      let error = '';
      try { lastAutoSync = Date.now(); error = (await syncTaobaoBackground({manual:true}))?.error || ''; }
      catch { error = '同步失败，请检查客户端和淘宝登录状态'; }
      finally { clearInterval(heartbeat); await post('finish', {error:closing ? '客户端已关闭，请重新同步' : error}); }
      return;
    }
    // 自动同步只跑在“同步时段”内；手动点立即同步不受限制。
    if (!config.enabled || !inSyncWindow(config) || Date.now() - lastAutoSync < config.interval_minutes * 60000) return;
    lastAutoSync = Date.now();
    const outcome = await syncTaobaoBackground();
    if (outcome?.error) state('自动同步：' + outcome.error, true);
  } catch { /* Retry settings on the next local check. */ }
  finally { checkingSyncSettings = false; }
}

// 同步时段（最多 3 段）：只在时段内自动同步；一段都没填表示全天可同步。
function inSyncWindow(config) {
  const slots = Array.isArray(config?.sync_windows) ? config.sync_windows : [];
  if (!slots.length) return true;
  const toMinutes = value => {
    const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const current = new Date();
  const minutes = current.getHours() * 60 + current.getMinutes();
  return slots.some(slot => {
    const from = Array.isArray(slot) ? slot[0] : slot?.from, to = Array.isArray(slot) ? slot[1] : slot?.to;
    const start = toMinutes(from), end = toMinutes(to);
    if (start === null || end === null) return false;
    return start <= end ? minutes >= start && minutes <= end : minutes >= start || minutes <= end;
  });
}

// 交易成功、需要发票、还没有任何发票记录，且 7 天内没有申请过的订单 → 可以自动申请开票。
function autoInvoiceEligible(purchase, recentApply) {
  if (purchase.platform !== '淘宝' || purchase.invoice_stage === '不需开票') return false;
  if (recentApply.has(purchase.id)) return false;
  const source = purchase.taobao_source || {};
  if (!INVOICE_APPLY_STATUSES.includes(source.transaction_status)) return false;
  if (purchase.received_cents > 0 || (source.invoice_details || []).length) return false;
  if ((source.invoice_entries || []).some(item => ['已开票', '申请中', '商家拒绝'].includes(item?.status))) return false;
  if (['已开票', '开票中'].includes(source.invoice_info?.status)) return false;
  return true;
}

function trackingCandidates(data, forceInvoice = false) {
  const nowMs = Date.now();
  const invoiceWaiting = purchase => {
    const source = purchase.taobao_source || {};
    if (purchase.invoice_stage === '不需开票') return false;
    if (purchase.received_cents > 0 || (source.invoice_details || []).length || (source.invoice_entries || []).length) return false;
    if (['已开票', '开票中'].includes(source.invoice_info?.status)) return false;
    // 手动同步时把“还有开票可能”的订单都带上：顺便刷新交易状态（很多单会从已发货变成交易成功）。
    return !['交易关闭', '交易取消'].includes(source.transaction_status);
  };
  const candidates = [];
  for (const purchase of data.purchases) {
    if (purchase.platform !== '淘宝') continue;
    const url = purchase.taobao_source?.source_url;
    if (!isOrderURL(url)) continue;
    const parsed = new URL(url);
    if ((parsed.searchParams.get('biz_order_id') || parsed.searchParams.get('bizOrderId')) !== purchase.platform_order) continue;
    const linkedLines = new Set(data.purchase_lines.filter(line => line.purchase_id === purchase.id).map(line => line.id));
    const linkedPackages = new Set(data.package_lines.filter(line => linkedLines.has(line.purchase_line_id)).map(line => line.package_id));
    const knownPackages = new Map((purchase.taobao_source?.packages || []).filter(p => p.tracking).map(p => [p.tracking, p]));
    for (const p of data.packages.filter(p => linkedPackages.has(p.id) && p.tracking)) {
      if (!knownPackages.has(p.tracking)) knownPackages.set(p.tracking, p);
    }
    // 已签收的订单不再刷新；其余按时间决定是否到期。
    if (knownPackages.size && [...knownPackages.values()].every(p => p.status === '已签收')) continue;
    const failed = Boolean(purchase.taobao_source?.sync_error);
    const stamp = Date.parse(purchase.taobao_source?.sync_checked_at || '') || 0;
    const ageHours = stamp ? (nowMs - stamp) / 3600000 : Infinity;
    const due = failed ? ageHours >= TRACKING_RETRY_HOURS : ageHours >= TRACKING_REFRESH_HOURS;
    // 手动点“立即同步”时，把还没开票的订单强制带上，保证每次手动同步都能推进发票。
    const waiting = invoiceWaiting(purchase);
    if (!due && !(forceInvoice && waiting)) continue;
    candidates.push({purchase, url, ageHours, waiting, stamp});
  }
  // 先看“还没开票”的订单，其次优先刷新最久没同步过的（stamp 为 0 表示从未同步，排最前）。
  return candidates.sort((a, b) => (b.waiting - a.waiting) || (a.stamp - b.stamp));
}

async function syncTaobaoTracking(data, forceInvoice = false) {
  const candidates = trackingCandidates(data, forceInvoice);
  const result = {candidates:candidates.length, attempted:0, saved:0, failed:[], deferred:0, stopped:'', url:''};
  // 这一轮已排队但还没执行的“申请开票”任务：订单页本来就要打开，顺手点掉。
  const applyRequests = new Map();
  try {
    const queued = await fetch(`${origin}/api/invoice-apply/pending`, {headers:{'X-Caidan-Internal':internalToken}});
    for (const request of (queued.ok ? ((await queued.json()).requests || []) : [])) applyRequests.set(request.purchase_id, request);
  } catch { /* 申请任务读取失败不影响物流同步 */ }
  // 自动申请开票：最近 7 天申请过的订单不再重复申请。
  const recentApply = new Set();
  const recentApplySince = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  for (const request of (data.invoice_apply_requests || [])) {
    if (request.created_at && request.created_at > recentApplySince) recentApply.add(request.purchase_id);
  }
  let autoApplyLeft = AUTO_INVOICE_PER_RUN;
  let autoApplied = 0;
  for (const item of candidates.slice(0, TRACKING_PER_RUN)) {
    if (closing || manualInvoicePending || manualRequestPending) { result.stopped = '本轮同步被中断'; break; }
    const purchase = item.purchase;
    result.attempted++;
    try {
      try {
        await Promise.race([syncView.webContents.loadURL(item.url), new Promise((_, reject) => setTimeout(() => reject(new Error('页面加载超时')), 20000))]);
      } catch (error) {
        // 淘宝用自身跳转替换我们发起的导航时会报 ERR_ABORTED，页面仍在继续加载，按最终页面继续读。
        if (!(error?.code === 'ERR_ABORTED' || error?.errno === -3 || /ERR_ABORTED/.test(error?.message || ''))) throw error;
      }
      await waitTaobaoRedirectSettle(syncView.webContents);
      let found;
      for (let attempt = 0; attempt < 3; attempt++) {
        await sleep(1800);
        try { found = await syncView.webContents.executeJavaScriptInIsolatedWorld(1001, [{code:`(${extractOrder.toString()})()`}]); break; }
        catch { /* 订单详情可能仍在渲染 */ }
      }
      if (found?.platform_order !== purchase.platform_order || !Array.isArray(found.packages)) throw new Error('订单页面未能识别');
      const purchaseLineIds = new Set(data.purchase_lines.filter(line => line.purchase_id === purchase.id).map(line => line.id));
      const packageIds = new Set(data.package_lines.filter(line => purchaseLineIds.has(line.purchase_line_id)).map(line => line.package_id));
      const known = new Set([...(purchase.taobao_source.packages || []).map(p => p.tracking), ...data.packages.filter(p => packageIds.has(p.id)).map(p => p.tracking)]);
      const packages = found.packages.filter(p => p.tracking && (!known.size || known.has(p.tracking)));
      if (known.size && !packages.length) throw new Error('已有运单在页面中未识别');
      // 服务端只接受固定的交易状态集合，先把页面读到的值归一化（顺便让状态跟上淘宝）。
      const transactionStatus = ['买家已付款', '卖家已发货', '交易成功', '交易关闭', '交易取消', '退款中的订单'].includes(found.transaction_status) ? found.transaction_status : '';
      // 订单详情页同时能读到发票状态（已开票／申请中／未开票），随物流一起回传，
      // 采购列表的开票状态就不再只能依赖发票列表匹配。
      const saved = await fetch(`${origin}/api/purchases/${purchase.id}/taobao`, {method:'POST', headers:{'Content-Type':'application/json','X-Caidan-Internal':internalToken}, body:JSON.stringify({platform_order:purchase.platform_order, source_url:item.url, packages, invoice_info:found.invoice_info || null, transaction_status:transactionStatus, background:true})});
      if (!saved.ok) throw new Error('物流保存失败');
      result.saved++;
      if (business && !business.webContents.isDestroyed()) business.webContents.send('app:sync');
      let applyRequest = applyRequests.get(purchase.id) || null;
      if (!applyRequest && autoApplyLeft > 0 && autoInvoiceEligible(purchase, recentApply)) {
        try {
          const created = await fetch(`${origin}/api/purchases/${purchase.id}/apply-invoice`, {method:'POST',
            headers:{'Content-Type':'application/json','X-Caidan-Internal':internalToken}, body:'{}'});
          if (created.ok) {
            applyRequest = await created.json();
            autoApplyLeft--;
            autoApplied++;
            recentApply.add(purchase.id);
          }
        } catch { /* 登记失败就下一轮再试 */ }
      }
      if (applyRequest) {
        let outcome = null;
        for (let attempt = 0; attempt < 15; attempt++) {
          try {
            outcome = await syncView.webContents.executeJavaScriptInIsolatedWorld(1001, [{code:`(${applyInvoiceInPage.toString()})('${purchase.platform_order}')`}]);
          } catch { outcome = null; }
          if (outcome?.clicked) break;
          await sleep(1200);
        }
        // 点击后若是申请表单：自动填写（默认专用发票，无则普票）并保存；否则尝试读取发票结果。
        let submitted = null;
        if (outcome?.clicked) {
          await sleep(2200);
          submitted = await submitApplicationForm(data.company || {});
        }
        const captured = outcome?.clicked ? await captureInvoiceSummary(purchase.platform_order) : false;
        const payload = submitted?.saved
          ? {status:'done', message:`已提交申请开票（${submitted.chosenType || '发票'}）`}
          : captured
            ? {status:'done', message:'已在订单详情页申请开票，并读取到发票详情'}
            : outcome?.clicked
              ? {status:'manual', message:'已点击「申请开票」，请在淘宝页面确认提交申请'}
              : {status:'manual', message:outcome?.message || '订单详情页没有找到「申请开票」入口'};
        await fetch(`${origin}/api/invoice-apply/${applyRequest.id}/result`, {method:'POST',
          headers:{'Content-Type':'application/json','X-Caidan-Internal':internalToken}, body:JSON.stringify(payload)}).catch(() => {});
        applyRequests.delete(purchase.id);
        if (payload.status === 'done') state(`申请开票：${purchase.platform_order} 已提交平台申请`);
        else state(`申请开票：${purchase.platform_order} 需要手动处理`, true);
        if (business && !business.webContents.isDestroyed()) business.webContents.send('app:sync');
      }
    } catch (error) {
      const current = await waitTaobaoRedirectSettle(syncView.webContents);
      if (isTaobaoVerifyURL(current) || isTaobaoLoginRedirect(null, current) || /验证|滑块|登录/.test(error?.message || '')) {
        result.stopped = '淘宝要求登录或验证';
        result.url = current.split('?')[0];
        await reportVerificationShot();
        break;
      }
      const reason = /^[\u4e00-\u9fff]/.test(error?.message || '') ? String(error.message).slice(0, 80)
        : /ERR_ABORTED/.test(error?.message || '') ? '页面被重定向' : '页面未能识别';
      result.failed.push({order:purchase.platform_order, reason});
      await fetch(`${origin}/api/purchases/${purchase.id}/taobao-sync-failed`, {method:'POST', headers:{'Content-Type':'application/json','X-Caidan-Internal':internalToken}, body:'{}'}).catch(() => {});
      if (business && !business.webContents.isDestroyed()) business.webContents.send('app:sync');
    }
    await syncDelay();
  }
  result.deferred = Math.max(0, candidates.length - result.attempted);
  result.invoice_applied = autoApplied;
  return result;
}

async function syncTaobaoBackground(options = {}) {
  if (syncing || manualInvoicePending || closing || !origin || !syncView) return;
  const manualRun = options.manual === true;
  syncing = true;
  const syncErrors = [];
  const report = {startedAt:new Date().toISOString(), draft:null, invoice:null, tracking:null, errors:syncErrors};
  backgroundSyncDone = new Promise(resolve => { finishBackgroundSync = resolve; });
  try {
    const response = await fetch(origin + '/api/state', {headers:{'X-Caidan-Internal':internalToken}});
    if (!response.ok) throw new Error('采购数据读取失败');
    const data = await response.json();
    if (!manualInvoicePending && !manualRequestPending && !closing) {
      try {
        const draftResult = await syncPurchaseDrafts({contents:syncView.webContents, shouldStop:() => manualInvoicePending || manualRequestPending || closing,
          onProgress:report => fs.writeFileSync(path.join(dataDir, 'purchase-draft-scan.json'), JSON.stringify(report, null, 2)),
          api:async (route, body) => {
            const result = await fetch(origin + '/api' + route, {method:body ? 'POST' : 'GET', headers:{'Content-Type':'application/json','X-Caidan-Internal':internalToken}, ...(body ? {body:JSON.stringify(body)} : {})});
            if (!result.ok) throw new Error('采购草稿同步失败');
            return result.json();
          }});
        report.draft = {created:draftResult.created, error:draftResult.error || '', stats:draftResult.stats || null};
        if (draftResult.error) syncErrors.push('采购草稿：' + draftResult.error);
        if (/验证|滑块|登录/.test(draftResult.error || '')) await reportVerificationShot();
        if (draftResult.created) state(`已自动获取 ${draftResult.created} 笔采购草稿，可在网页端关联料品。`);
        if (business && !business.webContents.isDestroyed()) business.webContents.send('app:sync');
      } catch { syncErrors.push('采购草稿同步失败'); }
    }
    // 订单、发票、物流分成三段并留出间隔：连续密集访问淘宝最容易触发验证。
    await sleep(8000);
    // 发票任务包含：已登记的采购 + 还没登记但发票中心已经有票的淘宝订单（草稿）。
    const draftInvoiceFileTargets = (data.purchase_drafts || []).filter(item => {
      if (item.status !== 'active') return false;
      const payload = item.payload || {};
      const details = payload.invoice_details || [];
      const entries = payload.invoice_entries || [];
      if (details.some(detail => !detail.attachment_id)) return true;
      return entries.some(entry => entry.status === '已开票') || payload.invoice_info?.status === '已开票';
    }).map(item => ({platform_order:item.platform_order, shop:item.payload?.shop || '', amount_cents:0,
      purchased_date:item.payload?.purchased_date || '', taobao_source:item.payload || {}}));
    const invoicePurchases = [...data.purchases.filter(needsInvoiceFile), ...draftInvoiceFileTargets];
    try {
      const queued = await fetch(origin + '/api/invoice-apply/pending', {headers:{'X-Caidan-Internal':internalToken}});
      const requests = queued.ok ? ((await queued.json()).requests || []) : [];
      for (const request of requests) {
        if (closing || manualInvoicePending) break;
        let outcome;
        try { outcome = await applyInvoiceForPurchase(request.purchase_id, request.platform_order); }
        catch (error) { outcome = {status:'failed', message:error.message}; }
        if (outcome.status === 'deferred') {
          // 留给同一轮的订单详情页再试（那里同样有「申请开票」按钮）。
          state(`申请开票：${request.platform_order} 在发票中心没有入口，稍后在订单页重试。`);
          continue;
        }
        await fetch(`${origin}/api/invoice-apply/${request.id}/result`, {method:'POST',
          headers:{'Content-Type':'application/json','X-Caidan-Internal':internalToken}, body:JSON.stringify(outcome)}).catch(() => {});
        if (outcome.status === 'done') state(`发票申请：${request.shop || request.platform_order} ${outcome.message || '已提交平台申请'}`);
        if (business && !business.webContents.isDestroyed()) business.webContents.send('app:sync');
      }
    } catch { syncErrors.push('申请开票任务执行失败'); }
    if (invoicePurchases.length && !manualInvoicePending && !manualRequestPending && !closing) {
      try {
        const result = await syncTaobaoInvoices(invoicePurchases, () => manualInvoicePending || manualRequestPending, INVOICE_LIST_PAGES, false);
        report.invoice = {...result, downloadErrors:(result.downloadErrors || []).slice(0, 10)};
        // 翻页到上限只说明本轮没查完（列表很长），算正常节奏，不算失败。
        if (result.downloadFailed) {
          syncErrors.push(`发票：${result.downloadFailed} 份文件下载失败，请先完成淘宝验证后在采购记录重试`);
          state(`发票定时获取：新增下载 ${result.downloaded || 0} 份，${result.downloadFailed} 份下载失败，可在采购记录中重试。`, true);
        } else if (result.downloaded) state(`发票已自动下载 ${result.downloaded} 份，请在采购记录中确认收票。`);
        else if (result.truncated) state(`发票：本轮已检查前 ${INVOICE_LIST_PAGES} 页，下一轮自动继续。`);
      } catch (error) {
        report.invoice = {error:error.message, code:error.code || '', url:error.url || '', detail:error.detail || ''};
        state(error.code === 'TAOBAO_LOGIN_REQUIRED' ? '发票定时获取需要淘宝登录或验证，请在“淘宝订单”完成后重试；登录恢复后会继续定时检查。' : '发票定时获取失败，已获取的信息已保留，将在下次检查时重试。', true);
        syncErrors.push('发票：' + error.message);
        if (error.code === 'TAOBAO_LOGIN_REQUIRED') await reportVerificationShot();
        // 发票页面要求验证不代表订单页面失效（实测订单采集仍正常），因此只记录错误，
        // 继续跑这一轮的物流同步；物流侧遇到验证会自行停手。
      }
    }
    // 淘宝订单（还没登记成采购的草稿）里“交易成功、还没开票”的也自动申请开票：
    // 打开订单页 → 点申请开票 → 读回发票详情 → 把“申请中”写回草稿，7 天内不重复。
    const draftApplyTargets = (data.purchase_drafts || []).filter(item => {
      if (item.status !== 'active') return false;
      const payload = item.payload || {};
      if (payload.transaction_status !== '交易成功') return false;
      if ((payload.invoice_entries || []).length || (payload.invoice_details || []).length) return false;
      if (['已开票', '开票中', '申请中'].includes(payload.invoice_info?.status)) return false;
      const stamp = Date.parse(payload.invoice_apply_at || '') || 0;
      return !stamp || Date.now() - stamp > 7 * 24 * 3600 * 1000;
    }).slice(0, AUTO_INVOICE_PER_RUN);
    const draftInvoices = {candidates:draftApplyTargets.length, applied:0};
    for (const draft of draftApplyTargets) {
      if (closing || manualInvoicePending || manualRequestPending) break;
      const url = draft.payload?.source_url;
      if (!isOrderURL(url)) continue;
      try {
        try {
          await Promise.race([syncView.webContents.loadURL(url), new Promise((_, reject) => setTimeout(() => reject(new Error('页面加载超时')), 20000))]);
        } catch (error) {
          const aborted = error?.code === 'ERR_ABORTED' || error?.errno === -3 || /ERR_ABORTED/.test(error?.message || '');
          if (!aborted) throw error;
        }
        await waitTaobaoRedirectSettle(syncView.webContents);
        // 订单页内容与按钮都是异步渲染的：轮询等待，最多约 18 秒。
        let outcome = null;
        for (let attempt = 0; attempt < 15; attempt++) {
          try { outcome = await syncView.webContents.executeJavaScriptInIsolatedWorld(1001, [{code:`(${applyInvoiceInPage.toString()})('${draft.platform_order}')`}]); } catch { outcome = null; }
          if (outcome?.clicked) break;
          await sleep(1200);
        }
        if (outcome?.clicked) {
          // 点击后可能打开申请表单：按公司信息填写（默认专用发票，无则普票）并保存。
          await sleep(2200);
          const submitted = await submitApplicationForm(data.company || {});
          if (submitted?.saved) {
            // 这里只记录“已点击保存”；是否真的申请成功以发票中心扫描结果为准，不自行写状态。
            draftInvoices.submitted = (draftInvoices.submitted || 0) + 1;
          } else {
            await captureInvoiceSummary(draft.platform_order);
          }
          draftInvoices.applied++;
          if (business && !business.webContents.isDestroyed()) business.webContents.send('app:sync');
        }
        if (!draftInvoices.sample) draftInvoices.sample = [];
        if (draftInvoices.sample.length < 3) draftInvoices.sample.push({order:draft.platform_order, clicked:!!outcome?.clicked, ready:outcome?.ready !== false, message:String(outcome?.message || '').slice(0, 80), labels:(outcome?.labels || []).slice(0, 8), url:(syncView.webContents.getURL?.() || '').split('?')[0]});
      } catch { /* 单个订单失败不影响其他 */ }
      await syncDelay();
    }
    report.invoice_drafts = draftInvoices;
    const tracking = await syncTaobaoTracking(data, manualRun);
    report.tracking = tracking;
    // 一两笔订单偶发读不到属于正常波动，只做普通提示；同轮 3 笔以上才算同步失败。
    if (tracking.failed.length >= 3) syncErrors.push(`物流：${tracking.failed.length} 笔订单读取失败，下一轮自动重试`);
    else if (tracking.failed.length) state(`物流：${tracking.failed.length} 笔订单暂时读不到，下一轮自动重试。`);
    if (tracking.stopped) syncErrors.push(`物流：${tracking.stopped}，本轮剩余 ${tracking.deferred} 笔已跳到下一轮`);
  } catch { syncErrors.push('本机服务连接失败'); }
  finally {
    syncing = false;
    report.finishedAt = new Date().toISOString();
    try { fs.writeFileSync(path.join(dataDir, 'taobao-sync-result.json'), JSON.stringify(report, null, 2)); } catch { /* 诊断报告写失败不影响同步 */ }
    try {
      await fetch(`${origin}/api/sync-report`, {method:'POST', headers:{'Content-Type':'application/json','X-Caidan-Internal':internalToken}, body:JSON.stringify({report})});
    } catch { /* 上报失败不影响同步 */ }
    finishBackgroundSync(); backgroundSyncDone = null; finishBackgroundSync = null;
  }
  return {error:manualInvoicePending ? '同步已让位于手动发票获取，请稍后重试' : syncErrors.join('；')};
}

// 遇到淘宝验证：把验证页截图上传到服务端，网页端直接可见（人不用进客户端）。
async function reportVerificationShot() {
  try {
    if (!origin || !taobao || !syncView) return;
    const target = syncView.webContents.getURL?.() || '';
    if (target && isTaobaoURL(target)) {
      show('taobao');
      await taobao.webContents.loadURL(target).catch(() => {});
      await sleep(2500);
    }
    const image = await taobao.webContents.capturePage();
    const png = image?.toPNG?.();
    if (!png?.length || png.length > 4 * 1024 * 1024) return;
    const uploaded = await fetch(`${origin}/api/attachments`, {method:'POST',
      headers:{'Content-Type':'application/json','X-Caidan-Internal':internalToken},
      body: JSON.stringify({name:'淘宝验证截图.png', content: png.toString('base64')})});
    if (!uploaded.ok) return;
    const saved = await uploaded.json();
    await fetch(`${origin}/api/verification-shot`, {method:'POST',
      headers:{'Content-Type':'application/json','X-Caidan-Internal':internalToken},
      body: JSON.stringify({attachment_id: saved.id})}).catch(() => {});
    state('淘宝要求验证：已把验证页截图发到网页端，请在“淘宝订单”窗口完成后重试。', true);
  } catch { /* 截图失败不影响同步 */ }
}

function taobaoLoginRequired(interactive) {
  if (interactive) {
    show('taobao');
    taobao.webContents.loadURL(home).catch(() => {});
    state('淘宝要求登录或验证，请在“淘宝订单”页面完成后返回采购记录重试获取发票。', true);
  }
  const error = new Error('淘宝要求登录或验证，请在“淘宝订单”页面完成后重试获取发票。');
  error.code = 'TAOBAO_LOGIN_REQUIRED';
  error.url = (syncView?.webContents?.getURL?.() || '').split('?')[0];
  return error;
}

// 淘宝的 UMID 中转页会自动跳回目标页；等它跳完再判断是不是真的需要人工登录。
async function waitTaobaoRedirectSettle(contents, timeoutMs = 12000) {
  const started = Date.now();
  for (let attempt = 0; attempt < 10; attempt++) {
    const url = contents?.getURL?.() || '';
    if (!isTaobaoTransientRedirect(url) || Date.now() - started >= timeoutMs) return url;
    await sleep(1200);
  }
  return contents?.getURL?.() || '';
}

async function loadInvoicePage(url, label, interactive) {
  let timer;
  try {
    await Promise.race([syncView.webContents.loadURL(url),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('加载超时')), 20000); })]);
  } catch (error) {
    // 淘宝经常用自身跳转替换我们发起的导航（ERR_ABORTED）：页面其实还在继续加载，
    // 等跳转结束后按最终页面判断，不能据此判失败；跳到登录页才算需要登录。
    const aborted = error?.code === 'ERR_ABORTED' || error?.errno === -3 || /ERR_ABORTED/.test(error?.message || '');
    const settled = await waitTaobaoRedirectSettle(syncView.webContents);
    if (isTaobaoLoginRedirect(null, settled)) throw taobaoLoginRequired(interactive);
    if (aborted && settled && !/^about:blank/.test(settled)) return;
    const failure = new Error(`${label}加载失败，请检查淘宝登录状态后重试。`);
    failure.code = 'PAGE_LOAD_FAILED';
    failure.detail = String(error?.message || '').slice(0, 120).replace(/https?:\/\/\S+/g, '[url]');
    throw failure;
  } finally { clearTimeout(timer); }
}

// 点完「申请开票」如果打开的是申请表单：按公司信息填写（默认专用发票，无则普票）并保存。
async function submitApplicationForm(company) {
  try {
    const isForm = await syncView.webContents.executeJavaScriptInIsolatedWorld(1001, [{code:`(() => ({form: /纳税人识别号|发票抬头/.test(document.body.innerText) && !!document.querySelector('input')}))()`}]);
    if (!isForm?.form) return null;
    return await syncView.webContents.executeJavaScriptInIsolatedWorld(1001, [{code:`(${submitInvoiceForm.toString()})(${JSON.stringify(company || {})})`}]);
  } catch { return null; }
}

// 点完「申请开票」后淘宝会打开发票详情页：有发票时把发票代码/号码/金额/日期取回来入库。
async function captureInvoiceSummary(order) {
  await sleep(2500);
  let summary = null;
  // 跳到 invoice-ua 发票详情页时用专用解析；否则按“我的淘宝”发票详情解析。
  const detailPage = (syncView.webContents.getURL?.() || '').startsWith('https://invoice-ua.taobao.com/detail/pc');
  try {
    summary = await syncView.webContents.executeJavaScriptInIsolatedWorld(1001, [{code: detailPage
      ? `(${extractInvoiceDetail.toString()})('${order}')`
      : `(${extractInvoiceSummary.toString()})()`}]);
  } catch { return false; }
  if (Array.isArray(summary?.invoices)) {
    const invoices = summary.invoices.filter(item => item?.number);
    if (!invoices.length) return false;
    const first = invoices[0];
    try {
      const saved = await fetch(`${origin}/api/taobao/invoices`, {method:'POST',
        headers:{'Content-Type':'application/json','X-Caidan-Internal':internalToken},
        body:JSON.stringify({entries:[{platform_order:order, status:'已开票', amount:first.amount, date:first.date || ''}], details:[{platform_order:order, invoices}]})});
      if (!saved.ok) return false;
      if (business && !business.webContents.isDestroyed()) business.webContents.send('app:sync');
      return true;
    } catch { return false; }
  }
  if (!summary?.number || !/^[A-Za-z0-9-]+$/.test(summary.number)) return false;
  const amount = Number(summary.amount);
  const invoice = {number: summary.number, code: summary.code || '', amount: Number.isFinite(amount) && amount > 0 ? amount.toFixed(2) : '', date: /^\d{4}-\d{2}-\d{2}$/.test(summary.date) ? summary.date : '', invoice_type: summary.invoice_type || '', title: summary.title || '', buyer_tax_id: summary.buyer_tax_id || ''};
  if (!invoice.amount || !invoice.date) return false;
  try {
    const saved = await fetch(`${origin}/api/taobao/invoices`, {method:'POST',
      headers:{'Content-Type':'application/json','X-Caidan-Internal':internalToken},
      body:JSON.stringify({entries:[{platform_order:order, status:'已开票', amount:invoice.amount, date:invoice.date}], details:[{platform_order:order, invoices:[invoice]}]})});
    if (!saved.ok) return false;
    if (business && !business.webContents.isDestroyed()) business.webContents.send('app:sync');
    return true;
  } catch { return false; }
}

async function readInvoiceDetail(order, purchase, shouldStop, interactive) {
  // Taobao puts the order ID in the hash. A hash-only load can leave the previous
  // invoice's DOM in place, so start with a fresh document for each order.
  if (syncView.webContents.getURL().startsWith('https://invoice-ua.taobao.com/detail/pc')) await syncView.webContents.loadURL('about:blank');
  await loadInvoicePage(`https://invoice-ua.taobao.com/detail/pc#/?orderId=${order}`, '淘宝发票详情', interactive);
  await waitTaobaoRedirectSettle(syncView.webContents);
  let result;
  for (let attempt = 0; attempt < 12; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 700));
    try { result = await syncView.webContents.executeJavaScriptInIsolatedWorld(1001, [{code:`(${extractInvoiceDetail.toString()})('${order}')`}]); break; }
    catch { /* Wait for the invoice numbers to render. */ }
  }
  if (result?.platform_order !== order) {
    if (isTaobaoLoginRedirect(null, await waitTaobaoRedirectSettle(syncView.webContents))) throw taobaoLoginRequired(interactive);
    throw new Error('发票详情未能识别');
  }
  let downloaded = 0, downloadFailed = 0;
  const downloadErrors = [];
  for (const invoice of result.invoices) {
    if (shouldStop() || closing) break;
    const saved = purchase?.taobao_source?.invoice_details?.find(item => item.number === invoice.number);
    if (saved?.attachment_id) { invoice.attachment_id = saved.attachment_id; continue; }
    try {
      const file = await downloadInvoiceFile(syncView.webContents, order, invoice.number, app.getPath('temp'), handler => { invoiceDownload = handler; });
      const uploaded = await fetch(`${origin}/api/attachments`, {method:'POST',
        headers:{'Content-Type':'application/json','X-Caidan-Internal':internalToken},
        body:JSON.stringify({name:file.name,content:file.content.toString('base64')})});
      if (!uploaded.ok) throw new Error('发票文件保存失败');
      invoice.attachment_id = (await uploaded.json()).id;
      downloaded++;
    } catch (error) {
      downloadFailed++;
      // Only our own messages are shown; Electron errors can contain signed URLs.
      downloadErrors.push({order, number:invoice.number, message:/^[\u4e00-\u9fff]/.test(error.message) ? error.message : '发票下载失败，请检查淘宝登录状态后重试。'});
    }
  }
  return {result, downloaded, downloadFailed, downloadErrors};
}

async function applyInvoiceForPurchase(purchaseId, platformOrder = '') {
  if (closing) throw new Error('客户端正在退出');
  let order = String(platformOrder || '').trim();
  if (!order) {
    const response = await fetch(origin + '/api/state', {headers:{'X-Caidan-Internal':internalToken}});
    if (!response.ok) throw new Error('采购记录读取失败');
    const snapshot = await response.json();
    const purchase = (snapshot.purchases || []).find(p => p.id === Number(purchaseId));
    if (!purchase) throw new Error('采购记录不存在');
    if (purchase.platform !== '淘宝') throw new Error('目前仅支持淘宝平台内申请开票');
    order = purchase.platform_order;
  }
  manualInvoicePending = true;
  try {
    await loadInvoicePage('https://i.taobao.com/my_itaobao/invoice', '淘宝发票中心', true);
    let outcome = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 800));
      try { outcome = await syncView.webContents.executeJavaScriptInIsolatedWorld(1001, [{code:`(${applyInvoiceInPage.toString()})('${order}')`}]); }
      catch { continue; }
      if (outcome?.clicked || outcome?.error) break;
    }
    if (outcome?.error) throw new Error(outcome.error);
    if (outcome?.clicked) {
      const captured = await captureInvoiceSummary(order);
      if (captured) return {status:'done', message:'已点击「申请开票」并读取到发票详情'};
      return {status:'done', message:`已在平台点击「${outcome.label || '申请开票'}」，稍后同步即可看到最新状态`};
    }
    // 发票中心没有入口时先不结案：同一轮稍后打开订单详情页时会再试一次。
    return {status:'deferred', message:outcome?.message || '发票中心没有可点击的申请入口'};
  } finally { manualInvoicePending = false; }
}

async function syncTaobaoInvoices(purchases, shouldStop = () => false, pageLimit = 100, interactive = false) {
  const known = new Set(purchases.filter(p => p.platform === '淘宝').map(p => p.platform_order));
  if (!known.size || closing) return {checked:known.size, matched:0};
  const remaining = new Set(known);
  const entries = [];
  const details = [];
  const downloadErrors = [];
  const lists = {};
  // 发票列表按开票日期倒序；一直翻到比“最早一张待开票采购”更早为止，避免固定页数漏掉旧发票。
  const oldestPending = purchases.map(item => String(item.purchased_date || '')).filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value)).sort()[0] || '';
  let truncated = false, pages = 0, downloaded = 0, downloadFailed = 0, detailLoads = 0, deferred = 0;
  try {
    for (const purchase of purchases.filter(p => p.taobao_source?.invoice_details?.length || p.taobao_source?.invoice_entries?.some(item => item.status === '已开票'))) {
      if (closing || shouldStop()) break;
      if (detailLoads >= INVOICE_DETAILS_PER_RUN) { deferred++; continue; }
      try {
        const found = await readInvoiceDetail(purchase.platform_order, purchase, shouldStop, interactive);
        detailLoads++;
        details.push(found.result);
        downloaded += found.downloaded;
        downloadFailed += found.downloadFailed;
        downloadErrors.push(...found.downloadErrors);
        const savedEntries = (purchase.taobao_source.invoice_entries || []).filter(item => item.status === '已开票');
        entries.push(...savedEntries.map(item => ({...item, platform_order:purchase.platform_order, amount:item.amount_cents / 100})));
        if (!savedEntries.length) entries.push({platform_order:purchase.platform_order, status:'已开票', amount:found.result.invoices[0].amount, date:found.result.invoices[0].date});
        remaining.delete(purchase.platform_order);
      } catch (error) {
        if (error.code === 'TAOBAO_LOGIN_REQUIRED') throw error;
        /* Fall back to the invoice list when direct detail access is unavailable. */
      }
      await syncDelay();
    }
    for (const mode of ['already', 'application']) {
      if (!remaining.size || shouldStop()) break;
      await loadInvoicePage(`https://i.taobao.com/my_itaobao/invoice?active=${mode}`, '淘宝发票列表', interactive);
      await waitTaobaoRedirectSettle(syncView.webContents);
      const list = lists[mode] = {pages:0, rows:0, matched:0, sample:[]};
      let expectedPage = 1;
      while (!closing && !shouldStop()) {
        let result;
        for (let attempt = 0; attempt < 15; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 700));
          try {
            result = await syncView.webContents.executeJavaScriptInIsolatedWorld(1001, [{code:`(${extractInvoicePage.toString()})('${mode}')`}]);
            if (result.page === expectedPage) break;
          } catch { /* Wait for Taobao's invoice table to render. */ }
        }
        if (result?.page !== expectedPage) {
          if (isTaobaoLoginRedirect(null, await waitTaobaoRedirectSettle(syncView.webContents))) throw taobaoLoginRequired(interactive);
          throw new Error('发票列表未能识别，请刷新淘宝登录状态后重试。');
        }
        pages++;
        list.pages++;
        list.rows += result.entries.length;
        if (list.sample.length < 4) {
          list.sample.push(...result.entries.slice(0, 4 - list.sample.length).map(item => ({
            order: String(item.platform_order || '').slice(0, 30), status: String(item.status || '').slice(0, 20),
            date: String(item.date || '').slice(0, 20), amount: String(item.amount || '').slice(0, 20)})));
        }
        for (const item of result.entries) if (remaining.has(item.platform_order)) { entries.push(item); remaining.delete(item.platform_order); list.matched++; }
        if (!result.has_next || !remaining.size) break;
        if (mode === 'already' && oldestPending) {
          const dates = result.entries.map(item => String(item.date || '')).filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value));
          if (dates.length && dates.every(value => value < oldestPending)) { list.stopped = 'date'; break; }
        }
        if (expectedPage === pageLimit) { truncated = true; break; }
        await syncView.webContents.executeJavaScriptInIsolatedWorld(1001, [{code:`document.querySelector('button.next-pagination-item.next-next')?.click()`}]);
        expectedPage++;
      }
    }
    const detailOrders = [...new Set(entries.filter(item => item.status === '已开票' && !details.some(detail => detail.platform_order === item.platform_order)).map(item => item.platform_order))];
    const detailBatch = detailOrders.slice(0, Math.max(0, INVOICE_DETAILS_PER_RUN - detailLoads));
    deferred += detailOrders.length - detailBatch.length;
    for (const order of detailBatch) {
      if (closing || shouldStop()) break;
      try {
        const found = await readInvoiceDetail(order, purchases.find(p => p.platform_order === order), shouldStop, interactive);
        detailLoads++;
        details.push(found.result);
        downloaded += found.downloaded;
        downloadFailed += found.downloadFailed;
        downloadErrors.push(...found.downloadErrors);
      } catch (error) {
        if (error.code === 'TAOBAO_LOGIN_REQUIRED') throw error;
        /* Keep list status when a detail page needs verification. */
      }
      await syncDelay();
    }
  } finally {
    // Persist completed downloads before yielding to a manual request or reporting
    // a later page failure, so the next run does not download those files again.
    if (entries.length && !closing) {
      const saved = await fetch(`${origin}/api/taobao/invoices`, {method:'POST',
        headers:{'Content-Type':'application/json','X-Caidan-Internal':internalToken}, body:JSON.stringify({entries, details})});
      if (!saved.ok) throw new Error('发票进度保存失败');
      if (business && !business.webContents.isDestroyed()) business.webContents.send('app:sync');
    }
  }
  return {checked:known.size, matched:new Set(entries.map(item => item.platform_order)).size, pages, truncated, downloaded, downloadFailed, downloadErrors, deferred, lists};
}

ipcMain.handle('shell:command', async (event, action, value) => {
  verify(event, win.webContents, shellURL);
  if (!origin) throw new Error('本机服务尚未准备好。');
  if (action === 'business') return show('business');
  if (action === 'taobao') return openTaobao();
  if (action === 'home') { show('taobao'); return taobao.webContents.loadURL(home); }
  if (action === 'navigate') {
    if (typeof value !== 'string' || !isTaobaoURL(value)) throw new Error('请输入 HTTPS 淘宝、天猫或支付宝链接。');
    show('taobao'); return taobao.webContents.loadURL(value);
  }
  if (action === 'reload') return (active === 'taobao' ? taobao : business).webContents.reload();
  if (action === 'back') { const history = (active === 'taobao' ? taobao : business).webContents.navigationHistory; if(history.canGoBack()) history.goBack(); return; }
  if (action === 'extract') {
    if (!isOrderURL(taobao.webContents.getURL())) throw new Error('请先打开一笔淘宝或天猫订单详情。');
    if (pending) {
      const result = await dialog.showMessageBox(win,{type:'question',buttons:['保留待核对订单','替换为当前订单'],defaultId:0,cancelId:0,message:'已有一笔提取结果尚未保存，是否替换？'});
      if(result.response !== 1) return;
    }
    state('正在提取当前订单…');
    const result = await taobao.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:`(${extractOrder.toString()})()`}]);
    // Validate and retain only the extractor's documented fields before crossing into the local UI.
    const fields = ['platform_order','source_url','shop','amount','purchased_date','purchased_at','transaction_status','remark'];
    if (!result || typeof result.platform_order !== 'string' || !/^\d{8,30}$/.test(result.platform_order)) throw new Error('提取结果无效，请刷新淘宝订单页后重试。');
    pending = {id:require('node:crypto').randomUUID(),platform:'淘宝'};
    for (const key of fields) pending[key] = String(result[key] || '').slice(0,500);
    pending.invoice_info = {status:String(result.invoice_info?.status || '未提取').slice(0,30),text:String(result.invoice_info?.text || '').slice(0,500)};
    pending.packages = (result.packages || []).slice(0,100).map(p => ({carrier:String(p.carrier || '').slice(0,80),tracking:String(p.tracking || '').slice(0,80),status:['待揽收','运输中','派送中','已签收','异常','退回'].includes(p.status) ? p.status : '',events:(p.events || []).slice(0,50).map(e => ({occurred_at:String(e.occurred_at || '').slice(0,40),description:String(e.description || '').slice(0,200)}))}));
    pending.products = (result.products || []).slice(0,100).map(p => ({name:String(p.name || '').slice(0,500),spec:String(p.spec || '').slice(0,500),quantity:String(p.quantity || '').slice(0,40),amount:/^\d+(?:\.\d{1,2})?$/.test(String(p.amount || '')) ? String(p.amount) : '',link:isTaobaoURL(p.link) ? p.link : ''}));
    pending.warnings = (result.warnings || []).slice(0,10).map(v => String(v).slice(0,200));
    business.webContents.send('app:order', pending);
    show('business');
    state('订单已提取，可保存为草稿，或关联料品后登记采购。');
    return;
  }
  throw new Error('未知操作');
});
ipcMain.handle('app:taobao', event => { verify(event,business?.webContents,origin + '/'); return openTaobao(); });
ipcMain.handle('app:pending', event => { verify(event,business?.webContents,origin + '/'); return pending || null; });
ipcMain.handle('app:ack', (event,id) => { verify(event,business?.webContents,origin + '/'); if (pending?.id === id) pending = null; });
// 催发票：打开该订单的淘宝页面 → 点「联系卖家」→ 把模板话术填进聊天输入框（发送由人工确认）。
function invoiceRemindScript(company, purchase) {
  const amount = Number(purchase.amount_cents || 0) / 100;
  const billing = [['公司名称', company?.name], ['税号', company?.tax_number], ['地址', company?.address], ['电话', company?.phone],
    ['开户行', company?.bank_name], ['账号', company?.bank_account], ['收票邮箱', company?.email]]
    .map(([label, value]) => [label, String(value || '').trim()]).filter(([, value]) => value);
  return [
    `您好，订单号 ${purchase.platform_order}（${purchase.shop || ''}${amount > 0 ? `，实付 ¥${amount.toFixed(2)}` : ''}）已交易成功，麻烦帮忙开一下发票，谢谢！`,
    billing.length ? `开票信息：\n${billing.map(([label, value]) => `${label}：${value}`).join('\n')}` : ''
  ].filter(Boolean).join('\n');
}

ipcMain.handle('app:remind-invoice', async (event, purchaseId) => {
  verify(event, business?.webContents, origin + '/');
  if (!origin || !taobao) throw new Error('本机服务尚未准备好。');
  const response = await fetch(origin + '/api/state', {headers:{'X-Caidan-Internal':internalToken}});
  if (!response.ok) throw new Error('采购记录读取失败');
  const snapshot = await response.json();
  // 采购记录和淘宝订单（草稿）都支持一键催发票。
  const purchase = (snapshot.purchases || []).find(item => item.id === Number(purchaseId))
    || (snapshot.purchase_drafts || []).find(item => item.id === Number(purchaseId) ? item : null);
  if (!purchase) throw new Error('订单记录不存在');
  const record = purchase.platform ? purchase : {shop:purchase.payload?.shop || '', amount_cents:0, platform_order:purchase.platform_order, taobao_source:purchase.payload || {}};
  const script = invoiceRemindScript(snapshot.company, record);
  const url = record.taobao_source?.source_url || `https://trade.taobao.com/trade/detail/trade_order_detail.htm?bizOrderId=${record.platform_order}`;
  show('taobao');
  try { await taobao.webContents.loadURL(url); } catch { /* 页面可能仍在跳转 */ }
  await sleep(2600);
  const opened = await taobao.webContents.executeJavaScriptInIsolatedWorld(1001, [{code:`(${clickSellerChat.toString()})()`}]).catch(() => null);
  await sleep(4200);
  const filled = await taobao.webContents.executeJavaScriptInIsolatedWorld(1001, [{code:`(${fillSellerChat.toString()})(${JSON.stringify(script)})`}]).catch(() => null);
  return {script, opened: !!opened?.clicked, filled: !!filled?.filled, message: opened?.message || filled?.message || ''};
});
ipcMain.handle('app:apply-invoice', async (event, purchaseId) => {
  verify(event,business?.webContents,origin + '/');
  if (backgroundSyncDone) { manualInvoicePending = true; await backgroundSyncDone; }
  if (!origin || !syncView) throw new Error('本机服务尚未准备好。');
  try { return await applyInvoiceForPurchase(purchaseId); }
  finally { manualInvoicePending = false; if (business && !business.webContents.isDestroyed()) business.webContents.send('app:sync'); }
});
ipcMain.handle('app:sync-invoices', async (event, purchaseIds) => {
  verify(event,business?.webContents,origin + '/');
  if (backgroundSyncDone) { manualInvoicePending = true; await backgroundSyncDone; }
  if (syncing) throw new Error('发票获取正在进行，请稍后重试。');
  if (!origin || !syncView) throw new Error('本机服务尚未准备好。');
  syncing = true;
  try {
    const response = await fetch(origin + '/api/state', {headers:{'X-Caidan-Internal':internalToken}});
    if (!response.ok) throw new Error('采购订单读取失败。');
    const {purchases} = await response.json();
    const selected = selectInvoicePurchases(purchases, purchaseIds);
    if (!selected.length) throw new Error('所选订单的发票文件已全部获取，或无需获取淘宝发票。');
    return await syncTaobaoInvoices(selected, () => false, 30, true);
  } finally { syncing = false; manualInvoicePending = false; }
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showMainWindow);
  app.whenReady().then(async () => {
    if (!fs.existsSync(startupFile)) setStartup(true);
    Menu.setApplicationMenu(null);
    win = new BrowserWindow({width:1440,height:940,minWidth:1050,minHeight:700,title:'采单 · 采购协同',icon:path.join(__dirname,'assets','caidan-icon.ico'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
    win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
    tray = new Tray(path.join(__dirname, 'assets', 'caidan-icon.ico'));
    tray.setToolTip('采单 · 采购协同');
    const refreshTrayMenu = () => tray.setContextMenu(Menu.buildFromTemplate([
      {label:'打开采单', click:showMainWindow},
      {label:'开机自启', type:'checkbox', checked:app.getLoginItemSettings().openAtLogin, click:item => {
        setStartup(item.checked); refreshTrayMenu();
      }},
      {type:'separator'},
      {label:'退出采单', click:async () => {
        if (pending) {
          showMainWindow();
          const result = await dialog.showMessageBox(win,{type:'question',buttons:['返回核对','放弃提取结果并退出'],defaultId:0,cancelId:0,message:'提取的订单尚未保存，是否退出？'});
          if (result.response !== 1) return;
        }
        exitConfirmed = true; app.quit();
      }}
    ]));
    refreshTrayMenu();
    tray.on('double-click', showMainWindow);
    win.webContents.on('will-navigate', e => e.preventDefault());
    win.on('resize',fit);
    win.on('close', event => {
      if (!closing && !exitConfirmed) { event.preventDefault(); win.hide(); return; }
    });
    win.on('closed', () => { closing = true; clearInterval(syncTimer); child?.kill(); });
    await win.loadURL(shellURL);
    try {
      origin = await startServer();
      const localSession = session.fromPartition('persist:caidan-local');
      localSession.setPermissionRequestHandler((_,__,callback) => callback(false));
      business = new WebContentsView({webPreferences:{preload:path.join(__dirname,'app-preload.cjs'),session:localSession,nodeIntegration:false,contextIsolation:true,sandbox:true}});
      win.contentView.addChildView(business);
      business.webContents.on('will-navigate', (e,url) => { if(new URL(url).origin !== origin) e.preventDefault(); });
      business.webContents.setWindowOpenHandler(({url}) => {
        if (new URL(url).origin === origin) {
          const preview = new BrowserWindow({parent:win,width:1000,height:800,icon:path.join(__dirname,'assets','caidan-icon.ico'),webPreferences:{session:localSession,nodeIntegration:false,contextIsolation:true,sandbox:true}});
          preview.webContents.setWindowOpenHandler(() => ({action:'deny'}));
          preview.webContents.on('will-navigate',(e,next) => { if(new URL(next).origin !== origin) e.preventDefault(); });
          preview.loadURL(url);
        } else if(isTaobaoURL(url)) { show('taobao'); taobao.webContents.loadURL(url); }
        return {action:'deny'};
      });
      const taobaoSession = session.fromPartition('persist:taobao');
      taobaoSession.setPermissionRequestHandler((_,__,callback) => callback(false));
      taobaoSession.setPermissionCheckHandler(() => false);
      // Keep remote pages away from local services and local network addresses.
      taobaoSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']}, (details,callback) => {
        const host = new URL(details.url).hostname;
        const local = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.includes(':') || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host);
        callback({cancel:local});
      });
      taobao = new WebContentsView({webPreferences:{session:taobaoSession,nodeIntegration:false,contextIsolation:true,sandbox:true}});
      restrictTaobao(taobao.webContents);
      win.contentView.addChildView(taobao);
      syncView = new WebContentsView({webPreferences:{session:taobaoSession,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
      restrictTaobao(syncView.webContents);
      win.contentView.addChildView(syncView);
      syncView.setVisible(false);
      fit();
      show('business');
      await business.webContents.loadURL(origin + '/#purchases');
      setTimeout(checkAutoSync, 10000);
      syncTimer = setInterval(checkAutoSync, 15000);
    } catch(error) { state(error.message,true); dialog.showErrorBox('客户端启动失败',error.message); }
  });
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { closing = true; tray?.destroy(); child?.kill(); });
