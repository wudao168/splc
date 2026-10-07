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
const { downloadInvoiceFile } = require('./download-invoice.cjs');
const { needsInvoiceFile, selectInvoicePurchases } = require('./invoice-targets.cjs');
const { isTaobaoURL, isOrderURL, isTaobaoLoginRedirect } = require('./policy.cjs');

const root = path.resolve(__dirname, '..');
const dataDir = path.resolve(process.env.CAIDAN_DATA || (app.isPackaged ? path.join(app.getPath('userData'), 'business') : path.join(root, '.data')));
app.setPath('userData', process.env.CAIDAN_PROFILE || path.join(dataDir, 'desktop-profile'));
const home = 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm';
const shellURL = pathToFileURL(path.join(__dirname, 'shell.html')).href;
let win, business, taobao, syncView, syncTimer, syncing = false, backgroundSyncDone, finishBackgroundSync, manualInvoicePending = false, child, origin, pending, active = 'business', closing = false, exitConfirmed = false;
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
  if (checkingSyncSettings || syncing || manualInvoicePending || closing || !origin) return;
  checkingSyncSettings = true;
  try {
    const response = await fetch(origin + '/api/sync-settings', {headers:{'X-Caidan-Internal':internalToken}});
    if (!response.ok) return;
    const config = await response.json();
    const request = config.manual_sync;
    if (request && (request.status === 'pending' || request.status === 'running' && Date.now() - Date.parse(request.updated_at) > 120000)) {
      const post = async (action, body = {}) => {
        const response = await fetch(origin + '/api/sync-now/' + action, {method:'POST',headers:{'Content-Type':'application/json','X-Caidan-Internal':internalToken},body:JSON.stringify({request_id:request.request_id,...body})});
        if (!response.ok) throw new Error('同步任务状态保存失败');
        return response.json();
      };
      if (!(await post('start')).claimed) return;
      const heartbeat = setInterval(() => post('heartbeat').catch(() => {}), 15000);
      let error = '';
      try { lastAutoSync = Date.now(); error = (await syncTaobaoBackground())?.error || ''; }
      catch { error = '同步失败，请检查客户端和淘宝登录状态'; }
      finally { clearInterval(heartbeat); await post('finish', {error:closing ? '客户端已关闭，请重新同步' : error}); }
      return;
    }
    if (!config.enabled || Date.now() - lastAutoSync < config.interval_minutes * 60000) return;
    lastAutoSync = Date.now();
    await syncTaobaoBackground();
  } catch { /* Retry settings on the next local check. */ }
  finally { checkingSyncSettings = false; }
}

async function syncTaobaoBackground() {
  if (syncing || manualInvoicePending || closing || !origin || !syncView) return;
  syncing = true;
  const syncErrors = [];
  backgroundSyncDone = new Promise(resolve => { finishBackgroundSync = resolve; });
  try {
    const response = await fetch(origin + '/api/state', {headers:{'X-Caidan-Internal':internalToken}});
    if (!response.ok) throw new Error('采购数据读取失败');
    const data = await response.json();
    if (!manualInvoicePending && !closing) {
      try {
        const draftResult = await syncPurchaseDrafts({contents:syncView.webContents, shouldStop:() => manualInvoicePending || closing,
          onProgress:report => fs.writeFileSync(path.join(dataDir, 'purchase-draft-scan.json'), JSON.stringify(report, null, 2)),
          api:async (route, body) => {
            const result = await fetch(origin + '/api' + route, {method:body ? 'POST' : 'GET', headers:{'Content-Type':'application/json','X-Caidan-Internal':internalToken}, ...(body ? {body:JSON.stringify(body)} : {})});
            if (!result.ok) throw new Error('采购草稿同步失败');
            return result.json();
          }});
        if (draftResult.error) syncErrors.push('采购草稿：' + draftResult.error);
        if (draftResult.created) state(`已自动获取 ${draftResult.created} 笔采购草稿，可在网页端关联料品。`);
        if (business && !business.webContents.isDestroyed()) business.webContents.send('app:sync');
      } catch { syncErrors.push('采购草稿同步失败'); }
    }
    const invoicePurchases = data.purchases.filter(needsInvoiceFile);
    if (invoicePurchases.length && !manualInvoicePending && !closing) {
      try {
        const result = await syncTaobaoInvoices(invoicePurchases, () => manualInvoicePending, 100, false);
        if (result.downloadFailed || result.truncated) syncErrors.push('发票获取未完成，请检查登录状态后重试');
        if (result.downloadFailed) state(`发票定时获取：新增下载 ${result.downloaded || 0} 份，${result.downloadFailed} 份下载失败，可在采购记录中重试。`, true);
        else if (result.downloaded) state(`发票已自动下载 ${result.downloaded} 份，请在采购记录中确认收票。`);
        else if (result.truncated) state('发票定时检查尚未完成，可选中采购单手动获取。', true);
      } catch (error) {
        state(error.code === 'TAOBAO_LOGIN_REQUIRED' ? '发票定时获取需要淘宝登录或验证，请在“淘宝订单”完成后重试；登录恢复后会继续定时检查。' : '发票定时获取失败，已获取的信息已保留，将在下次检查时重试。', true);
        syncErrors.push('发票：' + error.message);
        if (error.code === 'TAOBAO_LOGIN_REQUIRED') return {error:syncErrors.join('；')};
      }
    }
    for (const purchase of data.purchases) {
      if (closing || manualInvoicePending) break;
      const linkedLines = new Set(data.purchase_lines.filter(line => line.purchase_id === purchase.id).map(line => line.id));
      const linkedPackages = new Set(data.package_lines.filter(line => linkedLines.has(line.purchase_line_id)).map(line => line.package_id));
      const knownPackages = new Map((purchase.taobao_source?.packages || []).filter(p => p.tracking).map(p => [p.tracking, p]));
      for (const p of data.packages.filter(p => linkedPackages.has(p.id) && p.tracking)) {
        if (!knownPackages.has(p.tracking)) knownPackages.set(p.tracking, p);
      }
      if (knownPackages.size && [...knownPackages.values()].every(p => p.status === '已签收')) continue;
      const url = purchase.taobao_source?.source_url;
      if (purchase.platform !== '淘宝' || !isOrderURL(url)) continue;
      const parsed = new URL(url);
      if ((parsed.searchParams.get('biz_order_id') || parsed.searchParams.get('bizOrderId')) !== purchase.platform_order) continue;
      try {
        await Promise.race([syncView.webContents.loadURL(url), new Promise((_, reject) => setTimeout(() => reject(new Error('页面加载超时')), 20000))]);
        let result;
        for (let attempt = 0; attempt < 3; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 1800));
          try { result = await syncView.webContents.executeJavaScriptInIsolatedWorld(1001, [{code:`(${extractOrder.toString()})()`}]); break; }
          catch { /* Order details may still be rendering. */ }
        }
        if (result?.platform_order !== purchase.platform_order || !Array.isArray(result.packages)) throw new Error('订单页面未能识别');
        const purchaseLineIds = new Set(data.purchase_lines.filter(line => line.purchase_id === purchase.id).map(line => line.id));
        const packageIds = new Set(data.package_lines.filter(line => purchaseLineIds.has(line.purchase_line_id)).map(line => line.package_id));
        const known = new Set([...(purchase.taobao_source.packages || []).map(p => p.tracking), ...data.packages.filter(p => packageIds.has(p.id)).map(p => p.tracking)]);
        const packages = result.packages.filter(p => p.tracking && (!known.size || known.has(p.tracking)));
        if (known.size && !packages.length) throw new Error('已有运单在页面中未识别');
        const saved = await fetch(`${origin}/api/purchases/${purchase.id}/taobao`, {method:'POST', headers:{'Content-Type':'application/json','X-Caidan-Internal':internalToken}, body:JSON.stringify({platform_order:purchase.platform_order, source_url:url, packages, background:true})});
        if (!saved.ok) throw new Error('物流保存失败');
        if (business && !business.webContents.isDestroyed()) business.webContents.send('app:sync');
      } catch {
        syncErrors.push('订单 ' + purchase.platform_order + ' 物流同步失败');
        await fetch(`${origin}/api/purchases/${purchase.id}/taobao-sync-failed`, {method:'POST', headers:{'Content-Type':'application/json','X-Caidan-Internal':internalToken}, body:'{}'}).catch(() => {});
        if (business && !business.webContents.isDestroyed()) business.webContents.send('app:sync');
      }
    }
  } catch { syncErrors.push('本机服务连接失败'); }
  finally { syncing = false; finishBackgroundSync(); backgroundSyncDone = null; finishBackgroundSync = null; }
  return {error:manualInvoicePending ? '同步已让位于手动发票获取，请稍后重试' : syncErrors.join('；')};
}

function taobaoLoginRequired(interactive) {
  if (interactive) {
    show('taobao');
    taobao.webContents.loadURL(home).catch(() => {});
    state('淘宝要求登录或验证，请在“淘宝订单”页面完成后返回采购记录重试获取发票。', true);
  }
  const error = new Error('淘宝要求登录或验证，请在“淘宝订单”页面完成后重试获取发票。');
  error.code = 'TAOBAO_LOGIN_REQUIRED';
  return error;
}

async function loadInvoicePage(url, label, interactive) {
  let timer;
  try {
    await Promise.race([syncView.webContents.loadURL(url),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('加载超时')), 20000); })]);
  } catch (error) {
    if (isTaobaoLoginRedirect(error, syncView.webContents.getURL())) throw taobaoLoginRequired(interactive);
    throw new Error(`${label}加载失败，请检查淘宝登录状态后重试。`);
  } finally { clearTimeout(timer); }
}

async function readInvoiceDetail(order, purchase, shouldStop, interactive) {
  // Taobao puts the order ID in the hash. A hash-only load can leave the previous
  // invoice's DOM in place, so start with a fresh document for each order.
  if (syncView.webContents.getURL().startsWith('https://invoice-ua.taobao.com/detail/pc')) await syncView.webContents.loadURL('about:blank');
  await loadInvoicePage(`https://invoice-ua.taobao.com/detail/pc#/?orderId=${order}`, '淘宝发票详情', interactive);
  let result;
  for (let attempt = 0; attempt < 12; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 700));
    try { result = await syncView.webContents.executeJavaScriptInIsolatedWorld(1001, [{code:`(${extractInvoiceDetail.toString()})('${order}')`}]); break; }
    catch { /* Wait for the invoice numbers to render. */ }
  }
  if (result?.platform_order !== order) {
    if (isTaobaoLoginRedirect(null, syncView.webContents.getURL())) throw taobaoLoginRequired(interactive);
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

async function syncTaobaoInvoices(purchases, shouldStop = () => false, pageLimit = 100, interactive = false) {
  const known = new Set(purchases.filter(p => p.platform === '淘宝').map(p => p.platform_order));
  if (!known.size || closing) return {checked:known.size, matched:0};
  const remaining = new Set(known);
  const entries = [];
  const details = [];
  const downloadErrors = [];
  let truncated = false, pages = 0, downloaded = 0, downloadFailed = 0;
  try {
    for (const purchase of purchases.filter(p => p.taobao_source?.invoice_details?.length || p.taobao_source?.invoice_entries?.some(item => item.status === '已开票'))) {
      if (closing || shouldStop()) break;
      try {
        const found = await readInvoiceDetail(purchase.platform_order, purchase, shouldStop, interactive);
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
    }
    for (const mode of ['already', 'application']) {
      if (!remaining.size || shouldStop()) break;
      await loadInvoicePage(`https://i.taobao.com/my_itaobao/invoice?active=${mode}`, '淘宝发票列表', interactive);
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
          if (isTaobaoLoginRedirect(null, syncView.webContents.getURL())) throw taobaoLoginRequired(interactive);
          throw new Error('发票列表未能识别，请刷新淘宝登录状态后重试。');
        }
        pages++;
        for (const item of result.entries) if (remaining.has(item.platform_order)) { entries.push(item); remaining.delete(item.platform_order); }
        if (!result.has_next || !remaining.size) break;
        if (expectedPage === pageLimit) { truncated = true; break; }
        await syncView.webContents.executeJavaScriptInIsolatedWorld(1001, [{code:`document.querySelector('button.next-pagination-item.next-next')?.click()`}]);
        expectedPage++;
      }
    }
    for (const order of new Set(entries.filter(item => item.status === '已开票' && !details.some(detail => detail.platform_order === item.platform_order)).map(item => item.platform_order))) {
      if (closing || shouldStop()) break;
      try {
        const found = await readInvoiceDetail(order, purchases.find(p => p.platform_order === order), shouldStop, interactive);
        details.push(found.result);
        downloaded += found.downloaded;
        downloadFailed += found.downloadFailed;
        downloadErrors.push(...found.downloadErrors);
      } catch (error) {
        if (error.code === 'TAOBAO_LOGIN_REQUIRED') throw error;
        /* Keep list status when a detail page needs verification. */
      }
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
  return {checked:known.size, matched:new Set(entries.map(item => item.platform_order)).size, pages, truncated, downloaded, downloadFailed, downloadErrors};
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
    const fields = ['platform_order','source_url','shop','amount','purchased_date','remark'];
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
    return await syncTaobaoInvoices(selected, () => false, 100, true);
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
