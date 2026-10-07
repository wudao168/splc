const {chromium}=require('../node_modules/playwright');
const assert=require('node:assert/strict');
const {syncPurchaseDrafts}=require('../desktop/sync-purchase-drafts.cjs');
const {extractOrderList}=require('../desktop/extract-order-list.cjs');
(async()=>{
 const b=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 try {
  const p=await b.newPage();
  const ids=['3316455627262026198','3316469486279026198','3316469162280008552'];
  let broken=false;
  await p.route('https://buyertrade.taobao.com/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:`<div id="rows"></div><div class="next-pagination"><button class="next-prev" disabled>上一页</button><span aria-current="page" id="page"></span><button class="next-next" id="next">下一页</button><span>共 3 页</span></div><script>let n=0;const ids=${JSON.stringify(ids)};function draw(){document.querySelector('#rows').innerHTML='<div>2026-10-06 订单号: '+ids[n]+'</div>';document.querySelector('#page').textContent=n+1;document.querySelector('#next').disabled=n===2;}document.querySelector('#next').onclick=()=>{${broken?'':'n++;draw();'}};draw();</script>`}));
  for (const fail of [false,true]) {
   broken=fail;const saved=[],reports=[];let current='';
   const result=await syncPurchaseDrafts({contents:{loadURL:async url=>{current=url;if(url.includes('buyertrade'))await p.goto(url);},executeJavaScriptInIsolatedWorld:async(_,scripts)=>scripts[0].code.includes('function extractOrder(')?{platform_order:new URL(current).searchParams.get('biz_order_id'),transaction_status:'卖家已发货',purchased_date:'2026-10-06'}:p.evaluate(code=>eval(code),scripts[0].code)},api:async(route,body)=>{
    if(route.endsWith('sync-state'))return {since:'2026-10-06',first_date:'2026-09-30',through:'2026-10-06',known:[],drafts:[]};
    if(route==='/purchase-drafts')saved.push(body.platform_order);
    return {created:true};
   },shouldStop:()=>false,wait:async()=>{},onProgress:r=>reports.push(structuredClone(r))});
   if(fail){assert.match(result.error,/第 2 页未加载新订单/);assert.deepEqual(saved,[ids[0]]);}
   else {assert.equal(result.error,'');assert.deepEqual(saved,ids);assert.equal(reports.at(-1).pages.length,3);}
   console.log('PASS actual DOM pagination',fail?'stalled click detected':'all three pages imported');
  }
  await p.setContent('<div>2026-10-06 订单号: 3316455627262026198</div><div class="next-pagination"><button disabled>上一页</button><span aria-current="page">1</span><button>2</button><span>共 2 页</span></div>');
  const numeric=await p.evaluate(extractOrderList);assert.equal(numeric.hasNext,true);assert.equal(numeric.lastPage,false);
  console.log('PASS numeric page fallback');
 } finally {await b.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
