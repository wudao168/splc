const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const {createRequire} = require('node:module');

const mainPath = path.resolve(__dirname, '../desktop/main.cjs');
const requireDesktop = createRequire(mainPath);
const purchase = (id, extra = {}) => ({id, platform:'淘宝', platform_order:String(100000000 + id),
  invoice_stage:'待申请', remaining_cents:2650, received_cents:0, invoice_expected_cents:2650,
  taobao_source:{invoice_entries:[{status:'已开票', amount_cents:2650, date:'2026-10-03'}]}, ...extra});
const drain = () => new Promise(resolve => setImmediate(resolve));

// Exercise the actual main-process timer and IPC handlers using an isolated
// clock, server, and remote pages. No user database or Taobao session is opened.
async function desktop(purchases) {
  const handlers = new Map(), timers = [], views = [], windows = [], loads = [], downloads = [], notices = [], saved = [];
  const data = {purchases, purchase_lines:[], package_lines:[], packages:[]};
  const hooks = {};
  let ready, attachment = 0, clock = 10000000;
  class Contents extends EventEmitter {
    constructor() { super(); this.mainFrame = {url:''}; }
    setWindowOpenHandler() {}
    getURL() { return this.mainFrame.url; }
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
      if (code.includes('function extractInvoicePage')) return {page:1, has_next:false, entries:hooks.entries || []};
      if (code.includes('function extractOrder')) return {platform_order:new URL(this.getURL()).searchParams.get('bizOrderId'), packages:[]};
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
    if ([700, 1800].includes(ms)) queueMicrotask(callback);
    return timer;
  };
  const context = {
    __dirname:path.dirname(mainPath), Date:{now:() => clock}, process:{env:{}}, URL, Buffer,
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
      else if (url.endsWith('/api/attachments')) result = {id:'file-' + ++attachment};
      else if (url.endsWith('/api/taobao/invoices')) {
        const snapshot = JSON.parse(options.body); saved.push(snapshot);
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

test('login failure keeps completed files, avoids opening a visible page, and releases the queue', async () => {
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
  assert.ok(app.notices.every(n => n.active === 'business'));
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
