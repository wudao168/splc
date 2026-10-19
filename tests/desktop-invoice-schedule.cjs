const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const {createRequire} = require('node:module');

const mainPath = path.resolve(process.env.CAIDAN_MAIN || path.join(__dirname, '../desktop/main.cjs'));
const requireDesktop = createRequire(mainPath);
const purchase = (id, extra = {}) => ({id, platform:'淘宝', platform_order:String(100000000 + id),
  invoice_stage:'待申请', remaining_cents:2650, received_cents:0, invoice_expected_cents:2650,
  taobao_source:{invoice_entries:[{status:'已开票', amount_cents:2650, date:'2026-10-03'}]}, ...extra});
const drain = () => new Promise(resolve => setImmediate(resolve));

// Exercise the actual main-process timer and IPC handlers using an isolated
// clock, server, and remote pages. No user database or Taobao session is opened.
async function desktop(purchases, drafts = []) {
  const handlers = new Map(), timers = [], views = [], windows = [], loads = [], downloads = [], notices = [], saved = [];
  const data = {purchases, purchase_drafts:drafts, purchase_lines:[], package_lines:[], packages:[]};
  const hooks = {};
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caidan-invoice-'));
  let ready, attachment = 0, clock = 10000000;
  class Contents extends EventEmitter {
    constructor() { super(); this.mainFrame = {url:''}; }
    setWindowOpenHandler() {}
    getURL() { return hooks.getURL ? hooks.getURL(this) : this.mainFrame.url; }
    isDestroyed() { return false; }
    send(channel, payload) { if (channel === 'shell:state') notices.push(payload); }
    async loadURL(url) {
      this.mainFrame.url = url;
      if (url.startsWith('https:')) loads.push(url);
      if (hooks.load) await hooks.load(url, this);
    }
    async executeJavaScriptInIsolatedWorld(_, scripts) {
      const code = scripts[0].code;
      if (code.includes('function extractInvoiceDetail')) {
        const order = new URLSearchParams(this.getURL().split('?')[1]).get('orderId');
        return {platform_order:order, invoices:[{number:'INV-' + order, amount:'26.50', date:'2026-10-03'}]};
      }
      if (code.includes('function extractInvoicePage')) {
        if (hooks.invoicePage) return hooks.invoicePage(code.includes("('application')") ? 'application' : 'already');
        return {page:1, has_next:false, entries:hooks.entries || []};
      }
      if (code.includes('function extractOrder')) {
        if (hooks.extractOrder) return hooks.extractOrder(this);
        return {platform_order:new URL(this.getURL()).searchParams.get('bizOrderId'), packages:[]};
      }
      if (code.includes('function applyInvoiceInPage')) {
        return hooks.applyInvoice ? hooks.applyInvoice(this) : {clicked:false, message:'页面没有申请开票入口'};
      }
      if (code.includes('next-next')) return true;
      throw new Error('Unexpected page script');
    }
  }
  class Window extends EventEmitter {
    constructor() { super(); this.webContents = new Contents(); this.contentView = {addChildView(){}}; windows.push(this); }
    getContentSize() { return [1440, 940]; }
    isDestroyed() { return false; }
    loadURL(url) { return this.webContents.loadURL(url); }
  }
  class View {
    constructor() { this.webContents = new Contents(); views.push(this); }
    setBounds() {}
    setVisible() {}
  }
  const app = Object.assign(new EventEmitter(), {isPackaged:false, commandLine:{appendSwitch(){}}, getLoginItemSettings:() => ({openAtLogin:false}), getPath:() => __dirname, setPath(){},
    requestSingleInstanceLock:() => true, whenReady:() => ({then(fn){ ready = fn(); }}), quit(){}});
  const remoteSession = {setPermissionRequestHandler(){}, setPermissionCheckHandler(){}, webRequest:{onBeforeRequest(){}}};
  const electron = {app, BrowserWindow:Window, WebContentsView:View, ipcMain:{handle:(name, fn) => handlers.set(name, fn)},
    session:{fromPartition:() => remoteSession}, Tray:class extends EventEmitter {setToolTip(){} setContextMenu(){}}, Menu:{setApplicationMenu(){},buildFromTemplate:items=>items}, dialog:{showErrorBox(_, message){throw new Error(message);}}};
  const schedule = (callback, ms, repeat = false) => {
    const timer = {callback, ms, repeat, cleared:false}; timers.push(timer);
    // 采集节奏里的等待（700/1800 渲染等待、3000～8000 反验证间隔）在测试里直接放行。
    if (ms < 10000) queueMicrotask(callback);
    return timer;
  };
  const context = {
    __dirname:path.dirname(mainPath), Date:class FakeDate extends Date { static now() { return clock; } }, process:{env:{CAIDAN_DATA:dataDir}}, URL, Buffer,
    setTimeout:schedule, setInterval:(fn, ms) => schedule(fn, ms, true),
    clearTimeout:timer => { if (timer) timer.cleared = true; }, clearInterval:timer => { if (timer) timer.cleared = true; },
    require(name) {
      if (name === 'electron') return electron;
      if (name === 'node:fs') return {...fs, existsSync:file => path.basename(file) === 'startup.json' || fs.existsSync(file)};
      if (name === 'node:child_process') return {spawn(){
        const child = Object.assign(new EventEmitter(), {stdout:new EventEmitter(), stderr:new EventEmitter(), kill(){}});
        queueMicrotask(() => child.stdout.emit('data', Buffer.from('Caidan running at http://127.0.0.1:9999')));
        return child;
      }};
      if (name === './sync-purchase-drafts.cjs') return {syncPurchaseDrafts:async () => ({created:0,error:hooks.draftError || ''})};
      if (name === './download-invoice.cjs') return {async downloadInvoiceFile(_, order) {
        downloads.push(order);
        if (hooks.download) await hooks.download(order);
        return {name:'invoice.pdf', content:Buffer.from('%PDF-1.4 test')};
      }};
      return requireDesktop(name);
    },
    async fetch(url, options = {}) {
      let result = {};
      if (url.endsWith('/api/sync-settings')) result = hooks.config || {enabled:true, interval_minutes:30};
      else if (url.endsWith('/api/state')) result = structuredClone(data);
      else if (url.includes('/api/sync-now/')) {
        const action = url.split('/').pop();
        (hooks.manualUpdates ||= []).push({action,...JSON.parse(options.body)});
        if (action === 'start') {hooks.config.manual_sync.status='running';result={claimed:true};}
        if (action === 'finish') hooks.config.manual_sync.status=JSON.parse(options.body).error ? 'failed' : 'done';
      }
      else if (url.endsWith('/api/invoice-apply/pending')) result = {requests:hooks.invoiceApply || []};
      else if (/\/api\/invoice-apply\/(\d+)\/result$/.test(url)) {
        const id = Number(url.match(/\/api\/invoice-apply\/(\d+)\/result$/)[1]);
        (hooks.invoiceResults ||= []).push({id, ...JSON.parse(options.body)});
        result = {ok:true};
      }
      else if (url.endsWith('/api/sync-report')) {
        (hooks.reports ||= []).push(JSON.parse(options.body).report);
        result = {ok:true};
      }
      else if (/\/api\/purchases\/\d+\/taobao$/.test(url)) {
        (hooks.taobaoSaves ||= []).push(JSON.parse(options.body));
        result = {ok:true};
      }
      else if (/\/api\/purchases\/(\d+)\/apply-invoice$/.test(url)) {
        const purchaseId = Number(url.match(/\/api\/purchases\/(\d+)\/apply-invoice$/)[1]);
        (hooks.invoiceQueues ||= []).push(purchaseId);
        result = {id:100 + purchaseId, status:'pending'};
      }
      else if (url.endsWith('/api/attachments')) result = {id:'file-' + ++attachment};
      else if (url.endsWith('/api/taobao/invoices')) {
        const snapshot = JSON.parse(options.body); saved.push(snapshot);
        (hooks.invoices ||= []).push(snapshot);
        for (const entry of snapshot.entries) {
          const target = purchases.find(p => p.platform_order === entry.platform_order);
          target.taobao_source = {...target.taobao_source, invoice_entries:[{...entry, amount_cents:2650}]};
        }
        for (const detail of snapshot.details) {
          const target = purchases.find(p => p.platform_order === detail.platform_order);
          target.taobao_source.invoice_details = detail.invoices.map(i => ({...i, amount_cents:2650}));
        }
      } else if (!/\/taobao(?:-sync-failed)?$/.test(url)) throw new Error('Unexpected local request');
      return {ok:true, json:async () => result};
    }
  };
  vm.runInNewContext(fs.readFileSync(mainPath, 'utf8'), context, {filename:mainPath});
  await ready;
  const startup = timers.find(t => t.ms === 10000), interval = timers.find(t => t.repeat);
  return {data, hooks, loads, downloads, notices, saved, startup, interval, advance:minutes => {clock += minutes * 60000;},
    close:() => windows[0].emit('closed'),
    manual:ids => handlers.get('app:sync-invoices')({sender:views[0].webContents, senderFrame:views[0].webContents.mainFrame}, ids)};
}

test('startup and 30-minute checks acquire only missing files, leave confirmation to the user', async () => {
  const p = purchase(1, {taobao_source:{}});
  const app = await desktop([p,
    purchase(2, {taobao_source:{invoice_details:[{amount_cents:2650, attachment_id:'existing'}]}}),
    purchase(3, {platform:'京东'}), purchase(4, {invoice_stage:'不需开票'}), purchase(5, {remaining_cents:0})]);
  app.hooks.entries = [{platform_order:p.platform_order, status:'已开票', amount:'26.50'},
    {platform_order:'999999999', status:'已开票', amount:'100.00'}];
  assert.equal(app.startup.ms, 10000);
  assert.equal(app.interval.ms, 15000);
  await app.startup.callback();
  assert.deepEqual(app.downloads, [p.platform_order]);
  assert.ok(p.taobao_source.invoice_details[0].attachment_id);
  assert.equal(p.received_cents, 0);
  assert.ok(app.notices.some(n => n.message.includes('请在采购记录中确认收票')));
  assert.ok(app.hooks.reports?.length, '同步报告已上报给服务端');
  assert.equal(app.hooks.reports[0].invoice.downloaded, 1);
  const count = app.loads.length;
  app.advance(30);
  await app.interval.callback();
  assert.equal(app.loads.length, count, 'no remote query/download while all files await confirmation');
  app.close();
  assert.equal(app.interval.cleared, true);
  app.advance(30);
  await app.interval.callback();
  assert.equal(app.loads.length, count);
});

test('manual request waits for current download, retains it and takes priority without duplicate work', async () => {
  const app = await desktop([purchase(1), purchase(2)]);
  let release;
  app.hooks.download = order => order === app.data.purchases[0].platform_order ? new Promise(resolve => {release = resolve;}) : undefined;
  const background = app.startup.callback();
  while (!release) await drain();
  const manual = app.manual([1, 2]);
  app.advance(30);
  await app.interval.callback();
  assert.equal(app.downloads.length, 1, 'overlapping timer is skipped');
  release();
  await background;
  const result = await manual;
  assert.equal(result.checked, 1, 'manual request re-reads newly saved files');
  assert.deepEqual(app.downloads, app.data.purchases.map(p => p.platform_order));
  assert.ok(app.data.purchases.every(p => p.taobao_source.invoice_details[0].attachment_id));
});

test('login failure keeps completed files, switches to the Taobao window for verification, and releases the queue', async () => {
  const app = await desktop([purchase(1), purchase(2, {taobao_source:{}})]);
  app.hooks.load = (url, contents) => {
    if (url.startsWith('https://i.taobao.com/')) {
      contents.mainFrame.url = 'https://login.taobao.com/member/login.jhtml';
      throw new Error('ERR_ABORTED (-3)');
    }
  };
  await app.startup.callback();
  assert.ok(app.data.purchases[0].taobao_source.invoice_details[0].attachment_id);
  assert.ok(app.notices.some(n => n.error && n.message.includes('登录或验证')));
  // 现在遇到验证会主动切到“淘宝订单”窗口，方便远程查看验证页并完成验证
  assert.ok(app.notices.some(n => n.active === 'taobao'));
  delete app.hooks.load;
  app.hooks.entries = [{platform_order:app.data.purchases[1].platform_order, status:'已开票', amount:'26.50'}];
  app.advance(30);
  await app.interval.callback();
  assert.deepEqual(app.downloads, app.data.purchases.map(p => p.platform_order));
});

test('failed file download is retried on the next interval without marking it acquired', async () => {
  const app = await desktop([purchase(1)]);
  app.hooks.download = () => {throw new Error('发票下载超时');};
  await app.startup.callback();
  assert.equal(app.data.purchases[0].taobao_source.invoice_details[0].attachment_id, undefined);
  assert.ok(app.notices.some(n => n.error && n.message.includes('下载失败')));
  delete app.hooks.download;
  app.advance(30);
  await app.interval.callback();
  assert.ok(app.data.purchases[0].taobao_source.invoice_details[0].attachment_id);
  assert.equal(app.downloads.length, 2);
});


test('settings disable remote work and changed intervals take effect without restarting', async () => {
  const app = await desktop([purchase(1)]);
  app.hooks.config = {enabled:false, interval_minutes:5};
  await app.startup.callback();
  assert.equal(app.loads.length, 0);
  app.hooks.config.enabled = true;
  await app.interval.callback();
  assert.equal(app.downloads.length, 1);
  app.data.purchases.push(purchase(2));
  app.advance(4);
  await app.interval.callback();
  assert.equal(app.downloads.length, 1);
  app.advance(1);
  await app.interval.callback();
  assert.equal(app.downloads.length, 2);
});

test('all signed packages skip logistics but incomplete and unknown packages continue', async () => {
  const items = [purchase(1), purchase(2), purchase(3)];
  items.forEach((p,i) => {
    p.invoice_stage = '不需开票';
    p.taobao_source = {source_url:'https://trade.taobao.com/trade/detail/trade_order_detail.htm?bizOrderId=' + p.platform_order,
      packages:i === 0 ? [{tracking:'A',status:'已签收'}] : i === 1 ? [{tracking:'B',status:'已签收'}, {tracking:'C',status:'运输中'}] : []};
  });
  const app = await desktop(items);
  await app.startup.callback();
  assert.ok(!app.loads.some(url => url.includes(items[0].platform_order)));
  assert.ok(app.loads.some(url => url.includes(items[1].platform_order)));
  assert.ok(app.loads.some(url => url.includes(items[2].platform_order)));
});

test('logistics refresh stops at the first verification page and defers the rest', async () => {
  const items = [purchase(1), purchase(2), purchase(3)];
  items.forEach(p => {
    p.invoice_stage = '不需开票';
    p.taobao_source = {source_url:'https://trade.taobao.com/trade/detail/trade_order_detail.htm?bizOrderId=' + p.platform_order, packages:[{tracking:'T' + p.id, status:'运输中'}]};
  });
  const app = await desktop(items);
  app.hooks.load = (url, contents) => {
    if (url.includes(items[1].platform_order)) {
      contents.mainFrame.url = 'https://login.taobao.com/member/login.jhtml';
      throw new Error('ERR_ABORTED (-3)');
    }
  };
  await app.startup.callback();
  const loaded = order => app.loads.filter(url => url.includes(order)).length;
  assert.equal(loaded(items[0].platform_order), 1, '验证之前的订单正常读取');
  assert.equal(loaded(items[1].platform_order), 1, '触发验证的订单只打开一次');
  assert.equal(loaded(items[2].platform_order), 0, '验证后不再继续打开订单页');
  assert.ok(app.notices.some(n => n.error && n.message.includes('登录或验证')));
});

test('logistics refresh skips orders checked within the refresh window', async () => {
  const items = [purchase(1), purchase(2)];
  items.forEach(p => {
    p.invoice_stage = '不需开票';
    p.taobao_source = {source_url:'https://trade.taobao.com/trade/detail/trade_order_detail.htm?bizOrderId=' + p.platform_order,
      packages:[{tracking:'T' + p.id, status:'运输中'}], sync_checked_at:new Date(10000000 - 7 * 3600000).toISOString()};
  });
  items[1].taobao_source.sync_checked_at = new Date(10000000).toISOString();
  const app = await desktop(items);
  await app.startup.callback();
  assert.ok(app.loads.some(url => url.includes(items[0].platform_order)), '超过 6 小时的订单继续刷新');
  assert.ok(!app.loads.some(url => url.includes(items[1].platform_order)), '刚同步过的订单本轮跳过');
});

test('web request runs immediately while automatic sync is off and reports completion',async()=>{
 const app=await desktop([purchase(1)]);
 app.hooks.config={enabled:false,interval_minutes:30,manual_sync:{request_id:'web-request',status:'pending'}};
 await app.startup.callback();
 assert.equal(app.downloads.length,1);
 assert.deepEqual(app.hooks.manualUpdates.map(x=>x.action),['start','finish']);
 assert.equal(app.hooks.manualUpdates.at(-1).error,'');
 await app.interval.callback();
 assert.equal(app.downloads.length,1);
});
test('web request reports partial failure instead of a successful sync',async()=>{
 const app=await desktop([]);
 app.hooks.config={enabled:false,interval_minutes:30,manual_sync:{request_id:'web-request',status:'pending'}};
 app.hooks.draftError='淘宝需要验证';
 await app.startup.callback();
 assert.match(app.hooks.manualUpdates.at(-1).error,/淘宝需要验证/);
 assert.equal(app.hooks.config.manual_sync.status,'failed');
});

test('UMID 中转页等待自动跳回后继续，不误判为需要登录', async () => {
  const target = 'https://i.taobao.com/my_itaobao/invoice?active=already';
  const transientURL = 'https://login.taobao.com/havanaone/render_get_umid.htm';
  const app = await desktop([purchase(1, {taobao_source:{}})]);
  let transient = false;
  app.hooks.entries = [{platform_order:'100000001', status:'已开票', amount:'26.50'}];
  app.hooks.load = url => { if (url === target) transient = true; };
  app.hooks.getURL = contents => {
    if (transient) {
      transient = false;
      contents.mainFrame.url = transientURL;
    } else if (contents.mainFrame.url === transientURL) {
      contents.mainFrame.url = target;
    }
    return contents.mainFrame.url;
  };
  await app.startup.callback();
  assert.deepEqual(app.downloads, ['100000001'], '中转页跳回后继续取发票');
  assert.ok(!app.notices.some(n => n.error && n.message.includes('登录或验证')), '不把中转页当成登录失效');
});

test('导航被淘宝自身跳转替换（ERR_ABORTED）时继续读取最终页面', async () => {
  const app = await desktop([purchase(1, {taobao_source:{}})]);
  app.hooks.entries = [{platform_order:'100000001', status:'已开票', amount:'26.50'}];
  app.hooks.load = url => {
    if (url.startsWith('https://i.taobao.com/')) {
      const error = new Error("ERR_ABORTED (-3) loading 'https://login.taobao.com/havanaone/render_get_umid.htm'");
      error.code = 'ERR_ABORTED';
      error.errno = -3;
      throw error;
    }
  };
  await app.startup.callback();
  assert.deepEqual(app.downloads, ['100000001'], '跳转替换后仍能取到发票');
  assert.ok(!app.notices.some(n => n.error && n.message.includes('发票列表加载失败')));
});

test('发票列表翻到比最早的待开票采购更早时自动停止', async () => {
  const app = await desktop([purchase(1, {taobao_source:{}, purchased_date:'2026-10-05'})]);
  const alreadyPages = [];
  const alreadyDates = {1:['2026-10-12','2026-10-11'], 2:['2026-10-08','2026-10-07'], 3:['2026-09-30','2026-09-29']};
  app.hooks.invoicePage = mode => {
    if (mode !== 'already') return {page:1, has_next:false, entries:[]};
    const page = alreadyPages.length + 1;
    alreadyPages.push(page);
    return {page, has_next:true, entries:(alreadyDates[page] || []).map((date, index) => ({platform_order:'999000000' + page + index, status:'已开票', amount:'1.00', date}))};
  };
  await app.startup.callback();
  assert.deepEqual(alreadyPages, [1, 2, 3], '第三页全部早于最早待开票采购日期后停止翻页');
});

test('物流同步时把订单页读到的发票状态一起回传', async () => {
  const items = [purchase(1)];
  items[0].taobao_source = {source_url:'https://trade.taobao.com/trade/detail/trade_order_detail.htm?bizOrderId=' + items[0].platform_order,
    packages:[{tracking:'T1', status:'运输中'}]};
  const app = await desktop(items);
  app.hooks.extractOrder = page => ({
    platform_order:new URL(page.getURL()).searchParams.get('bizOrderId'),
    packages:[{carrier:'圆通速递', tracking:'T1', status:'派送中'}],
    invoice_info:{status:'已开票', text:'电子发票 已开票'},
    transaction_status:'交易成功',
  });
  await app.startup.callback();
  const saved = (app.hooks.taobaoSaves || []).find(item => item.invoice_info);
  assert.ok(saved, '回传了发票状态');
  assert.equal(saved.invoice_info.status, '已开票');
  assert.equal(saved.transaction_status, '交易成功', '交易状态也随订单页刷新');
  assert.equal(saved.background, true);
});

test('订单页顺带执行已排队的申请开票', async () => {
  const items = [purchase(1)];
  items[0].taobao_source = {source_url:'https://trade.taobao.com/trade/detail/trade_order_detail.htm?bizOrderId=' + items[0].platform_order,
    packages:[{tracking:'T1', status:'运输中'}]};
  const app = await desktop(items);
  app.hooks.invoiceApply = [{id:7, purchase_id:1, platform_order:items[0].platform_order, status:'pending'}];
  app.hooks.extractOrder = page => ({
    platform_order:new URL(page.getURL()).searchParams.get('bizOrderId'),
    packages:[{carrier:'圆通速递', tracking:'T1', status:'派送中'}],
    invoice_info:{status:'未开票', text:'申请开票'},
  });
  app.hooks.applyInvoice = () => ({clicked:true, label:'申请开票', scope:'order-page'});
  await app.startup.callback();
  const posted = (app.hooks.invoiceResults || []).find(item => item.id === 7);
  assert.ok(posted, '申请开票结果已回传');
  assert.equal(posted.status, 'done');
});

test('交易成功且没有发票记录的订单会自动申请开票', async () => {
  const items = [purchase(1)];
  items[0].taobao_source = {source_url:'https://trade.taobao.com/trade/detail/trade_order_detail.htm?bizOrderId=' + items[0].platform_order,
    packages:[{tracking:'T1', status:'运输中'}], transaction_status:'交易成功'};
  const app = await desktop(items);
  app.hooks.extractOrder = page => ({
    platform_order:new URL(page.getURL()).searchParams.get('bizOrderId'),
    packages:[{carrier:'圆通速递', tracking:'T1', status:'已签收'}],
    invoice_info:{status:'未提取', text:''},
  });
  app.hooks.applyInvoice = () => ({clicked:true, label:'申请开票', scope:'order-page'});
  await app.startup.callback();
  assert.deepEqual(app.hooks.invoiceQueues, [1], '自动登记了申请任务');
  const posted = (app.hooks.invoiceResults || []).find(item => item.id === 101);
  assert.ok(posted, '申请结果已回传');
  assert.equal(posted.status, 'done');
});

test('未交易成功或已开票的订单不会自动申请', async () => {
  const pending = purchase(1);
  pending.taobao_source = {source_url:'https://trade.taobao.com/trade/detail/trade_order_detail.htm?bizOrderId=' + pending.platform_order,
    packages:[{tracking:'T1', status:'运输中'}], transaction_status:'等待买家付款'};
  const invoiced = purchase(2);
  invoiced.taobao_source = {source_url:'https://trade.taobao.com/trade/detail/trade_order_detail.htm?bizOrderId=' + invoiced.platform_order,
    packages:[{tracking:'T2', status:'运输中'}], transaction_status:'交易成功', invoice_info:{status:'已开票', text:''}};
  const app = await desktop([pending, invoiced]);
  app.hooks.extractOrder = page => ({
    platform_order:new URL(page.getURL()).searchParams.get('bizOrderId'),
    packages:[],
    invoice_info:{status:'未提取', text:''},
  });
  await app.startup.callback();
  assert.deepEqual(app.hooks.invoiceQueues, undefined, '都不符合自动申请条件');
});

test('手动「立即同步」会强制带上刚同步过、还没开票的订单', async () => {
  const items = [purchase(1)];
  items[0].taobao_source = {source_url:'https://trade.taobao.com/trade/detail/trade_order_detail.htm?bizOrderId=' + items[0].platform_order,
    packages:[{tracking:'T1', status:'运输中'}], transaction_status:'交易成功',
    sync_checked_at:new Date(10000000).toISOString()};
  const app = await desktop(items);
  app.hooks.config = {enabled:false, interval_minutes:30, manual_sync:{request_id:'web-request', status:'pending'}};
  app.hooks.extractOrder = page => ({
    platform_order:new URL(page.getURL()).searchParams.get('bizOrderId'),
    packages:[{carrier:'圆通速递', tracking:'T1', status:'派送中'}],
    invoice_info:{status:'未提取', text:''},
  });
  app.hooks.applyInvoice = () => ({clicked:true, label:'申请开票', scope:'order-page'});
  await app.startup.callback();
  assert.deepEqual(app.hooks.invoiceQueues, [1], '刚同步过的待开票订单也会被带上');
});

test('手动同步优先刷新最久没同步的待开票订单', async () => {
  const older = purchase(1);
  older.taobao_source = {source_url:'https://trade.taobao.com/trade/detail/trade_order_detail.htm?bizOrderId=' + older.platform_order,
    packages:[{tracking:'T1', status:'运输中'}], transaction_status:'卖家已发货'};
  const newer = purchase(2);
  newer.taobao_source = {source_url:'https://trade.taobao.com/trade/detail/trade_order_detail.htm?bizOrderId=' + newer.platform_order,
    packages:[{tracking:'T2', status:'运输中'}], transaction_status:'卖家已发货', sync_checked_at:new Date(10000000).toISOString()};
  const app = await desktop([newer, older]);
  app.hooks.config = {enabled:false, interval_minutes:30, manual_sync:{request_id:'web-request', status:'pending'}};
  const visited = [];
  app.hooks.extractOrder = page => {
    const order = new URL(page.getURL()).searchParams.get('bizOrderId');
    visited.push(order);
    return {platform_order:order, packages:[], invoice_info:{status:'未提取', text:''}};
  };
  await app.startup.callback();
  assert.equal(visited[0], older.platform_order, '从未同步过的订单应排在最前');
});

test('同步时段之外不自动同步，进入时段后恢复', async () => {
  const app = await desktop([purchase(1)]);
  // 用一个肯定不含当前真实时刻的时段（客户端按本机真实时间判断时段）
  const hour = new Date().getHours();
  const pad = value => String(value % 24).padStart(2, '0');
  app.hooks.config = {enabled: true, interval_minutes: 5, active_from: `${pad(hour + 2)}:00`, active_to: `${pad(hour + 3)}:59`};
  await app.startup.callback();
  assert.equal(app.downloads.length, 0, '时段外不执行自动同步');
  app.hooks.config = {...app.hooks.config, active_from: '00:00', active_to: '23:59'};
  app.advance(10);
  await app.interval.callback();
  assert.equal(app.downloads.length, 1, '进入同步时段后恢复自动同步');
});

test('淘宝订单里交易成功的订单会自动申请开票并写回申请中', async () => {
  const draft = {id:9, status:'active', platform_order:'3317000000000000009', payload:{
    source_url:'https://trade.taobao.com/trade/detail/trade_order_detail.htm?bizOrderId=3317000000000000009',
    transaction_status:'交易成功', amount:'19.00', shop:'测试店铺'}};
  const app = await desktop([], [draft]);
  app.hooks.applyInvoice = () => ({clicked:true, label:'申请开票', scope:'order-page'});
  await app.startup.callback();
  const posted = (app.hooks.invoices || []).find(item => (item.entries || []).some(entry => entry.platform_order === draft.platform_order));
  assert.ok(posted, '草稿的申请中状态已写回服务端');
  assert.equal(posted.entries[0].status, '申请中');
  assert.equal(posted.entries[0].amount, '19.00');
});
