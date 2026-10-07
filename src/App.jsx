import React, { useCallback, useEffect, useState } from 'react';
import { LayoutDashboard, FileInput, Files, ShoppingCart, X, LoaderCircle, Settings2, Palette, UserRound, LogOut, Check } from 'lucide-react';
import { api } from './api';
import Dashboard from './Dashboard';
import ImportPage from './ImportPage';
import Orders from './Orders';
import SalesInvoices from './SalesInvoices';
import Purchases from './Purchases';
import Customers from './Customers';
import Settings from './Settings';
import LoginPage from './LoginPage';
import companyLogo from './assets/splc-logo.png';

const nav = [['dashboard','工作台',LayoutDashboard],['import','询价导入',FileInput],['orders','客户订单',Files],['purchases','采购记录',ShoppingCart],['sales-invoices','发票详情',Files]];
const themes = [['a', '青蓝平衡'], ['c', '石墨青绿'], ['o', '暖橙活力']];
const mergedRoute = route => ({ invoices: 'purchases', deliveries: 'orders' }[route] || route);
const routeFromHash = () => {
  const route = location.hash.slice(1).split('?')[0];
  if (['invoices','deliveries'].includes(route)) return mergedRoute(route);
  return nav.some(x => x[0] === route) || ['logistics','customers','settings'].includes(route) ? route : 'dashboard';
};

export default function App() {
  const [route, setRoute] = useState(routeFromHash), [data, setData] = useState(null), [busy, setBusy] = useState(false), [message, setMessage] = useState(null), [loadError, setLoadError] = useState('');
  const [editId, setEditId] = useState(null), [resumeDraftId, setResumeDraftId] = useState(null);
  const [desktopOrder, setDesktopOrder] = useState(null);
  const [auth, setAuth] = useState(null);
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
  const navigate = (route, id = null, draftId = null) => { route = mergedRoute(route); setEditId(id); setResumeDraftId(draftId); location.hash = route; setRoute(route); };
  const run = async (fn, success) => { if (busy) return; setBusy(true); setMessage(null); try { const result = await fn(); await reload(); if (success) { const notice = typeof success === 'function' ? success(result) : success; setMessage(typeof notice === 'string' ? {text:notice} : notice); } } catch(e) { setMessage({ text: e.message, error: true }); } finally { setBusy(false); } };
  const props = { data, run, busy, refresh: () => run(async () => {}, '列表已刷新'), navigate, desktopOrder, dismissDesktopOrder, user: auth?.user };
  const logout = async () => { try { await api('/auth/logout', {}); } catch (e) { setMessage({ text: e.message, error: true }); return; } setAuth(current => ({ ...current, user: null })); setData(null); location.hash = 'dashboard'; };
  const selectTheme = async theme => { try { await api('/users/me/theme', { theme }); setAuth(current => ({ ...current, user: { ...current.user, theme } })); } catch (e) { setMessage({ text: e.message, error: true }); } };
  if (!auth?.user) return auth ? <LoginPage setupRequired={auth.setup_required} onSuccess={user => setAuth({ setup_required: false, user })}/> : <div className="loading"><LoaderCircle className="spin"/>{loadError ? `无法连接服务器：${loadError}` : '正在连接服务器…'}</div>;
  return <div className="app"><aside className="sidebar"><a className="brand" href="#dashboard"><img className="brand-logo" src={companyLogo} width="2172" height="724" alt="思品利诚 · 上海思品利诚智能科技有限公司"/></a><nav aria-label="主导航">{nav.map(([key, label, Icon]) => <button key={key} className={route === key || route === 'customers' && key === 'orders' || route === 'logistics' && key === 'purchases' ? 'active' : ''} aria-current={route === key || route === 'customers' && key === 'orders' || route === 'logistics' && key === 'purchases' ? 'page' : undefined} onClick={() => navigate(key)}><Icon size={21} strokeWidth={1.8}/><span>{label}</span></button>)}</nav><div className="sidebar-bottom"><button className={`settings-link ${route === 'settings' ? 'active' : ''}`} aria-current={route === 'settings' ? 'page' : undefined} onClick={() => navigate('settings')}><Settings2 size={20}/><span>设置</span></button></div></aside>
    <main>
      <header className="app-topbar" aria-label="公司与用户"><strong className="app-company-name" title={data?.company?.name || '未设置公司信息'}>{data?.company?.name || '未设置公司信息'}</strong><div className="app-topbar-actions"><details className="theme-picker"><summary><Palette size={16}/><span>主题</span></summary><div className="theme-menu" aria-label="选择界面主题">{themes.map(([key, label]) => <button key={key} type="button" aria-label={label} aria-pressed={auth.user.theme === key} onClick={event => { event.currentTarget.closest('details').open = false; selectTheme(key); }}><i className={`theme-swatch theme-${key}`}/><span>{label}</span>{auth.user.theme === key ? <Check size={14}/> : null}</button>)}</div></details><button className="topbar-user" type="button" title={auth.user.display_name} onClick={() => navigate('settings')}><UserRound size={16}/><span>{auth.user.display_name}</span></button><button className="topbar-logout" type="button" onClick={logout}><LogOut size={16}/><span>退出</span></button></div></header>
      {loadError ? <div className="notice error">无法连接服务器：{loadError}。请检查服务器连接后刷新。</div> : null}
      {!data ? <div className="loading"><LoaderCircle className="spin"/>正在连接服务器…</div> : <div className="page-content"><div hidden={route !== 'import'}><ImportPage key={editId ? `order-${editId}` : resumeDraftId ? `intake-${resumeDraftId}` : 'new'} editing={data.orders.find(o => o.id === editId)} draftToResume={data.intake_drafts.find(d => d.id === resumeDraftId)} {...props}/></div>{route === 'orders' || route === 'customers' ? <div className="tabs"><button className={route === 'orders' ? 'active' : ''} onClick={() => navigate('orders')}>客户订单</button><button className={route === 'customers' ? 'active' : ''} onClick={() => navigate('customers')}>客户列表</button></div> : null}{route === 'dashboard' ? <Dashboard {...props}/> : route === 'import' ? null : route === 'customers' ? <Customers {...props}/> : route === 'orders' ? <Orders {...props}/> : route === 'purchases' || route === 'logistics' ? <Purchases key={route} {...props}/> : route === 'sales-invoices' ? <SalesInvoices {...props}/> : route === 'settings' ? <Settings data={data} run={run} busy={busy} user={auth.user} onThemeChange={selectTheme}/> : null}</div>}
    </main>{message ? <div role={message.error ? 'alert' : 'status'} className={`toast ${message.error ? 'toast-error' : ''}`}><span>{message.text}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setMessage(null)}><X size={17}/></button></div> : null}
  </div>;
}
