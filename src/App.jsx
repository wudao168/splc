import React, { useCallback, useEffect, useState } from 'react';
import { LayoutDashboard, FileInput, Files, ShoppingCart, X, LoaderCircle, Settings2, Palette, UserRound, LogOut, Check, Warehouse, Package, Users, Archive, Trash2 } from 'lucide-react';
import { api } from './api';
import Dashboard from './Dashboard';
import ImportPage from './ImportPage';
import Orders from './Orders';
import SalesInvoices from './SalesInvoices';
import Purchases from './Purchases';
import Inventory from './Inventory';
import Products from './Products';
import Customers from './Customers';
import Settings from './Settings';
import LoginPage from './LoginPage';
import companyLogo from './assets/splc-logo.png';
import VersionInfo, { BUILD_ID } from './VersionInfo';
import { handleDatePickerClick } from './datePicker';
import { primeTableWidths } from './tableWidths';

const nav = [['dashboard','报表',LayoutDashboard],['import','导入',FileInput],['orders','订单',Files],['products','产品',Package],['purchases','采购',ShoppingCart],['inventory','库存',Warehouse],['sales-invoices','发票',Files]];
const themes = [['a', '青蓝平衡'], ['c', '石墨青绿'], ['o', '暖橙活力']];
const mergedRoute = route => ({ invoices: 'purchases', deliveries: 'orders' }[route] || route);
const routeFromHash = () => {
  const route = location.hash.slice(1).split('?')[0];
  if (['invoices','deliveries'].includes(route)) return mergedRoute(route);
  return nav.some(x => x[0] === route) || ['logistics','customers','settings'].includes(route) ? route : 'dashboard';
};
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad2 = value => String(value).padStart(2, '0');
const isoWeek = value => {
  const day = new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const start = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  return Math.ceil(((day - start) / 86400000 + 1) / 7);
};
const clockText = value => `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())} ${WEEKDAYS[value.getDay()]} ${pad2(value.getHours())}:${pad2(value.getMinutes())}:${pad2(value.getSeconds())} 第${isoWeek(value)}周`;

/** 顶栏时钟单独成组件：每秒只刷新时钟本身，整个页面树不再跟着每秒重渲染。 */
function TopbarClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(timer); }, []);
  return <div className="topbar-clock" title="当前时间">{clockText(now)}</div>;
}

export default function App() {
  const [route, setRoute] = useState(routeFromHash), [data, setData] = useState(null), [busy, setBusy] = useState(false), [message, setMessage] = useState(null), [loadError, setLoadError] = useState('');
  const [auth, setAuth] = useState(null);
  primeTableWidths(auth?.user);
  const [versionOpen, setVersionOpen] = useState(false);
  const [editId, setEditId] = useState(null), [resumeDraftId, setResumeDraftId] = useState(null);
  const [orderView, setOrderView] = useState('active');
  const [desktopOrder, setDesktopOrder] = useState(null);
  // 访问过的页面保持挂载（切页只隐藏），切回时保留各自的页签、筛选与分页状态。
  const [mountedPages, setMountedPages] = useState(() => new Set([routeFromHash()]));
  const [status, setStatus] = useState(null);
  useEffect(() => {
    if (!window.caidanDesktop) return;
    const receive = order => { if (order) { setDesktopOrder(order); location.hash = 'purchases'; setRoute('purchases'); } };
    const unsubscribe = window.caidanDesktop.onOrder(receive);
    window.caidanDesktop.pendingOrder().then(receive).catch(e => setMessage({text:e.message,error:true}));
    return unsubscribe;
  }, []);
  const dismissDesktopOrder = () => { if (desktopOrder) window.caidanDesktop?.acknowledge(desktopOrder.id); setDesktopOrder(null); };
  const reload = useCallback(async () => { try { const r = await api('/state'); setData(r); setLoadError(''); } catch (e) { if (e.message === '请先登录') { setAuth(current => ({ ...current, user: null })); setData(null); } throw e; } }, []);
  useEffect(() => { api('/auth/status').then(setAuth).catch(e => setLoadError(e.message)); const changed = () => setRoute(routeFromHash()); window.addEventListener('hashchange',changed); return () => window.removeEventListener('hashchange',changed); }, []);
  useEffect(() => { if (auth?.user) reload().catch(e => setLoadError(e.message)); }, [auth?.user?.id, reload]);
  useEffect(() => window.caidanDesktop?.onSync(() => { if (auth?.user) reload().catch(() => {}); }), [auth?.user?.id, reload]);
  useEffect(() => { if (!message || message.error) return; const id = setTimeout(() => setMessage(null),4500); return () => clearTimeout(id); }, [message]);
  useEffect(() => { if (!auth?.user) return; const onFocus = () => reload().catch(() => {}); const timer = setInterval(() => { if (document.visibilityState === 'visible') onFocus(); }, route === 'purchases' || route === 'settings' ? 15000 : 60000); window.addEventListener('focus',onFocus); return () => { clearInterval(timer); window.removeEventListener('focus',onFocus); }; }, [auth?.user?.id, reload, route]);
  useEffect(() => { if (auth?.user) api('/activity', { route: route === 'logistics' ? 'purchases' : route }).catch(() => {}); }, [route, auth?.user?.id]);
  useEffect(() => { document.documentElement.dataset.caidanTheme = auth?.user?.theme || 'c'; }, [auth?.user?.theme]);
  useEffect(() => { document.addEventListener('click', handleDatePickerClick); return () => document.removeEventListener('click', handleDatePickerClick); }, []);
  useEffect(() => { setMountedPages(current => current.has(route) ? current : new Set([...current, route])); }, [route]);
  useEffect(() => {
    if (!auth?.user) { setStatus(null); return; }
    let alive = true;
    const load = () => api('/status-messages').then(result => { if (alive) setStatus(result); }).catch(() => {});
    load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 15000);
    return () => { alive = false; clearInterval(timer); };
  }, [auth?.user?.id]);
  useEffect(() => {
    const close = event => document.querySelectorAll('details.status-center[open]').forEach(node => { if (!node.contains(event.target)) node.open = false; });
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);
  const navigate = (route, id = null, draftId = null) => { route = mergedRoute(route); setEditId(id); setResumeDraftId(draftId); location.hash = route; setRoute(route); };
  const run = async (fn, success) => { if (busy) return; setBusy(true); setMessage(null); try { const result = await fn(); await reload(); if (success) { const notice = typeof success === 'function' ? success(result) : success; setMessage(typeof notice === 'string' ? {text:notice} : notice); } } catch(e) { setMessage({ text: e.message, error: true }); } finally { setBusy(false); } };
  const props = { data, run, busy, refresh: () => run(async () => {}, '列表已刷新'), navigate, desktopOrder, dismissDesktopOrder, user: auth?.user };
  const logout = async () => { try { await api('/auth/logout', {}); } catch (e) { setMessage({ text: e.message, error: true }); return; } setAuth(current => ({ ...current, user: null })); setData(null); location.hash = 'dashboard'; };
  const selectTheme = async theme => { try { await api('/users/me/theme', { theme }); setAuth(current => ({ ...current, user: { ...current.user, theme } })); } catch (e) { setMessage({ text: e.message, error: true }); } };
  const topMessage = status?.messages?.[0];
  const statusLevel = topMessage?.level || 'ok';
  const statusText = topMessage?.text || '系统运行正常';
  if (!auth?.user) return auth ? <LoginPage setupRequired={auth.setup_required} onSuccess={user => setAuth({ setup_required: false, user })}/> : <div className="loading"><LoaderCircle className="spin"/>{loadError ? `无法连接服务器：${loadError}` : '正在连接服务器…'}</div>;
  return <div className="app"><aside className="sidebar"><a className="brand" href="#dashboard"><img className="brand-logo" src={companyLogo} width="2134" height="595" alt="思品利诚 · 上海思品利诚智能科技有限公司"/></a><nav aria-label="主导航">{nav.map(([key, label, Icon]) => <button key={key} className={route === key || route === 'customers' && key === 'orders' || route === 'logistics' && key === 'purchases' ? 'active' : ''} aria-current={route === key || route === 'customers' && key === 'orders' || route === 'logistics' && key === 'purchases' ? 'page' : undefined} onClick={() => navigate(key)}><Icon size={21} strokeWidth={1.8}/><span>{label}</span></button>)}</nav><div className="sidebar-bottom"><button type="button" className="sidebar-version" title="查看版本信息" onClick={() => setVersionOpen(true)}>{BUILD_ID}</button><button className={`settings-link ${route === 'settings' ? 'active' : ''}`} aria-current={route === 'settings' ? 'page' : undefined} onClick={() => navigate('settings')}><Settings2 size={20}/><span>设置</span></button></div></aside>
    <main>
      <header className="app-topbar" aria-label="公司与用户"><strong className="app-company-name" title={data?.company?.name || '未设置公司信息'}>{data?.company?.name || '未设置公司信息'}</strong><div className="app-topbar-actions"><details className={`status-center ${statusLevel}`}><summary title={statusText}><i className="status-dot"/><span className="status-text">{statusText}</span></summary><div className="status-menu" aria-label="系统提示消息">{status?.messages?.length ? status.messages.slice(0, 10).map((item, index) => <button key={`${item.at}-${index}`} type="button" className={`status-item ${item.level}`} title={item.text} onClick={event => { event.currentTarget.closest('details').open = false; navigate('purchases'); }}><i className="status-dot"/><span className="status-item-text">{item.text}</span>{item.image ? <img className="status-shot" src={`/api/files/${item.image}`} alt="淘宝验证截图" title="点击查看大图" onClick={event => { event.stopPropagation(); window.open(`/api/files/${item.image}`, '_blank'); }}/> : null}<time>{(item.at || '').replace('T', ' ').slice(5, 16)}</time></button>) : <p className="status-empty muted">暂无提示，系统运行正常。</p>}</div></details><TopbarClock/><details className="theme-picker"><summary><Palette size={16}/><span>主题</span></summary><div className="theme-menu" aria-label="选择界面主题">{themes.map(([key, label]) => <button key={key} type="button" aria-label={label} aria-pressed={auth.user.theme === key} onClick={event => { event.currentTarget.closest('details').open = false; selectTheme(key); }}><i className={`theme-swatch theme-${key}`}/><span>{label}</span>{auth.user.theme === key ? <Check size={14}/> : null}</button>)}</div></details><button className="topbar-user" type="button" title={auth.user.display_name} onClick={() => navigate('settings')}><UserRound size={16}/><span>{auth.user.display_name}</span></button><button className="topbar-logout" type="button" onClick={logout}><LogOut size={16}/><span>退出</span></button></div></header>
      {loadError ? <div className="notice error">无法连接服务器：{loadError}。请检查服务器连接后刷新。</div> : null}
      {!data ? <div className="loading"><LoaderCircle className="spin"/>正在连接服务器…</div> : <div className="page-content"><div hidden={route !== 'import'}><ImportPage key={editId ? `order-${editId}` : resumeDraftId ? `intake-${resumeDraftId}` : 'new'} editing={data.orders.find(o => o.id === editId)} draftToResume={data.intake_drafts.find(d => d.id === resumeDraftId)} {...props}/></div>{route === 'orders' || route === 'customers' ? <div className="tabs">{[["active", "客户订单", Files], ["archived", "已归档", Archive], ["trash", "回收站", Trash2]].map(([key, label, Icon]) => <button key={key} className={route === 'orders' && orderView === key ? 'active' : ''} onClick={() => { navigate('orders'); setOrderView(key); }}><Icon size={18}/>{label}</button>)}<button className={route === 'customers' ? 'active' : ''} onClick={() => navigate('customers')}><Users size={18}/>客户列表</button></div> : null}{[['dashboard', <Dashboard {...props}/>], ['customers', <Customers {...props}/>], ['products', <Products {...props}/>], ['orders', <Orders {...props} view={orderView} onViewChange={setOrderView}/>], ['purchases', <Purchases {...props}/>], ['logistics', <Purchases key="logistics" {...props}/>], ['inventory', <Inventory {...props}/>], ['sales-invoices', <SalesInvoices {...props}/>], ['settings', <Settings data={data} run={run} busy={busy} user={auth.user} onThemeChange={selectTheme}/>]].filter(([key]) => mountedPages.has(key) || key === route).map(([key, page]) => <div key={key} className="page-pane" hidden={route !== key}>{page}</div>)}</div>}
    </main>{versionOpen ? <VersionInfo onClose={() => setVersionOpen(false)}/> : null}{message ? <div role={message.error ? 'alert' : 'status'} className={`toast ${message.error ? 'toast-error' : ''}`}><span>{message.text}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setMessage(null)}><X size={17}/></button></div> : null}
  </div>;
}
