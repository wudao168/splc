const {test}=require('node:test');
const assert=require('node:assert/strict');
const {syncPurchaseDrafts}=require('../desktop/sync-purchase-drafts.cjs');
test('Taobao redirect abort does not skip the resulting list',async()=>{
 let saved=0;
 const r=await syncPurchaseDrafts({contents:{loadURL:async()=>{throw Object.assign(new Error('ERR_ABORTED'),{errno:-3});},executeJavaScriptInIsolatedWorld:async(_,scripts)=>scripts[0].code.includes('scrollOrderList')?false:scripts[0].code.includes('extractOrderList')?{orders:[{platform_order:'123456789',date:'2026-10-06',source_url:'https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=123456789'}],hasNext:false,lastPage:true,currentPage:1}:{platform_order:'123456789',transaction_status:'卖家已发货',purchased_date:'2026-10-06'}},shouldStop:()=>false,wait:async()=>{},api:async(route)=>{
 if(route.endsWith('sync-state'))return {since:'2026-09-30',first_date:'2026-09-30',through:'2026-10-06',known:[],drafts:[]};
 if(route==='/purchase-drafts')saved++;
 return {created:true};
 }});
 assert.equal(r.error,'');assert.equal(saved,1);
});
