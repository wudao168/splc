const {test} = require('node:test');
const assert = require('node:assert/strict');
const {syncPurchaseDrafts} = require('../desktop/sync-purchase-drafts.cjs');
const source = (id,date='2026-10-06') => ({platform_order:id,transaction_status:'卖家已发货',purchased_date:date,source_url:`https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=${id}`,products:[{name:'物料'}],packages:[{tracking:'TRACK123',status:'运输中'}]});
function setup({fail=false,stop=false}={}) {
  const records=[], results=[], loaded=[];
  let current='';
  const contents={async loadURL(url){current=url;loaded.push(url);},async executeJavaScriptInIsolatedWorld(_,scripts){
    if(scripts[0].code.includes('function scrollOrderList')) return false;
    if(scripts[0].code.includes('function extractOrderList')) return {orders:[{platform_order:'100000001',date:'2026-10-06',source_url:source('100000001').source_url},{platform_order:'100000002',date:'2026-10-06',source_url:source('100000002').source_url},{platform_order:'100000003',date:'2026-09-01',source_url:source('100000003').source_url}],hasNext:false,lastPage:true};
    if(fail) throw new Error('页面未加载');
    return source(new URL(current).searchParams.get('biz_order_id'));
  }};
  const api=async(route,data)=>{
    if(route.endsWith('sync-state'))return {since:'2026-09-30',first_date:'2026-09-30',through:'2026-10-06',known:['100000002'],drafts:[]};
    if(route.endsWith('sync-result')){results.push(data);return {ok:true};}
    records.push(data);return {created:true};
  };
  return {records,results,loaded,run:()=>syncPurchaseDrafts({contents,api,shouldStop:()=>stop,wait:async()=>{}})};
}
test('imports only missing recent orders and includes logistics on first capture',async()=>{
 const app=setup();const result=await app.run();assert.equal(result.created,1);assert.equal(app.records[0].packages[0].tracking,'TRACK123');assert.equal(app.records[0].products.length,1);assert.equal(app.results[0].error,'');assert.equal(app.loaded.length,2);
});
test('failed detail remains retryable without advancing scan checkpoint',async()=>{
 const app=setup({fail:true});await app.run();assert.equal(app.records.length,0);assert.ok(app.results[0].error);
});

test('waits for complete rendering, follows pages and revisits missed recent orders',async()=>{
 const saved=[],finished=[];let page=0,reads=0,current='';
 const ids=['3316455627262026198','3316469486279026198','100000009'];
 const order=(id,date='2026-10-06')=>({platform_order:id,date,source_url:source(id).source_url});
 const contents={async loadURL(url){current=url;},async executeJavaScriptInIsolatedWorld(_,scripts){
  if(scripts[0].code.includes('function scrollOrderList')) return false;
    if(scripts[0].code.includes('function extractOrderList')){
   if(scripts[0].code.endsWith('(true)')){page++;reads=0;return true;}
   reads++;return page===0?{orders:reads<3?[order(ids[0])]:[order(ids[0]),order(ids[1])],hasNext:reads>=3}:{orders:[order(ids[2],'2026-10-04')],hasNext:false,lastPage:true};
  }
  const id=new URL(current).searchParams.get('biz_order_id');return source(id,id===ids[2]?'2026-10-04':'2026-10-06');
 }};
 await syncPurchaseDrafts({contents,shouldStop:()=>false,wait:async()=>{},api:async(route,body)=>{
  if(route.endsWith('sync-state'))return {since:'2026-10-05',first_date:'2026-09-30',through:'2026-10-06',known:[],drafts:[]};
  if(route.endsWith('sync-result')){finished.push(body);return {};}
  saved.push(body.platform_order);return {created:true};
 }});
 assert.deepEqual(saved,ids);assert.equal(finished[0].error,'');
});

test('saves discovered orders even when a later page fails without claiming completion',async()=>{
 let page=0,current='';const saved=[],finished=[];
 const contents={async loadURL(url){current=url;},async executeJavaScriptInIsolatedWorld(_,scripts){
  if(scripts[0].code.includes('function scrollOrderList')) return false;
    if(scripts[0].code.includes('function extractOrderList')){
   if(scripts[0].code.endsWith('(true)')){page++;return true;}
   if(page)throw new Error('verification');
   return {orders:[{platform_order:'100000001',date:'2026-10-06',source_url:source('100000001').source_url}],hasNext:true};
  }return source(new URL(current).searchParams.get('biz_order_id'));
 }};
 await syncPurchaseDrafts({contents,shouldStop:()=>false,wait:async()=>{},api:async(route,body)=>{
  if(route.endsWith('sync-state'))return {since:'2026-09-30',first_date:'2026-09-30',through:'2026-10-06',known:[],drafts:[]};
  if(route.endsWith('sync-result')){finished.push(body);return {};}
  saved.push(body);return {created:true};
 }});
 assert.equal(saved.length,1);assert.ok(finished[0].error);
});

test('collects virtualized rows while scrolling before looking for the next page',async()=>{
 let segment=0,page=0,current='';const saved=[],finished=[];
 const ids=['100000021','100000022','100000023'];
 const contents={async loadURL(url){current=url;},async executeJavaScriptInIsolatedWorld(_,scripts){
  const code=scripts[0].code;
  if(code.includes('function scrollOrderList')){
   if(code.endsWith('(true)')){segment=0;return true;}
   if(page===0 && segment===0){segment++;return true;}return false;
  }
  if(code.includes('function extractOrderList')){
   if(code.endsWith('(true)')){page++;return true;}
   const id=page?ids[2]:ids[segment];return {orders:[{platform_order:id,date:'2026-10-06',source_url:source(id).source_url}],hasNext:page===0 && segment===1,lastPage:page===1};
  }
  return source(new URL(current).searchParams.get('biz_order_id'));
 }};
 await syncPurchaseDrafts({contents,shouldStop:()=>false,wait:async()=>{},api:async(route,body)=>{
  if(route.endsWith('sync-state'))return {since:'2026-10-05',first_date:'2026-09-30',through:'2026-10-06',known:[],drafts:[]};
  if(route.endsWith('sync-result')){finished.push(body);return {};}
  saved.push(body.platform_order);return {created:true};
 }});
 assert.deepEqual(saved,ids);assert.equal(finished[0].error,'');
});


test('unknown pagination cannot report a completed scan', async () => {
 // The previous extractor treated a missing next control as a final page.
 let result;
 const order={platform_order:'100000099',date:'2026-10-06',source_url:source('100000099').source_url};
 await syncPurchaseDrafts({contents:{loadURL:async()=>{},executeJavaScriptInIsolatedWorld:async(_,scripts)=>scripts[0].code.includes('scrollOrderList')?false:scripts[0].code.includes('extractOrderList')?{orders:[order],hasNext:false,lastPage:false}:source(order.platform_order)},shouldStop:()=>false,wait:async()=>{},api:async(route,body)=>{
  if(route.endsWith('sync-state'))return {since:'2026-09-30',first_date:'2026-09-30',through:'2026-10-06',known:[],drafts:[]};
  if(route.endsWith('sync-result'))result=body;
  return {created:true};
 }});
 assert.match(result.error,/未识别到下一页/);
});
