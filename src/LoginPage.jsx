import React, { useState } from 'react';
import { ArrowRight, Eye, EyeOff } from 'lucide-react';
import { api } from './api';
import companyLogo from './assets/splc-logo.png';

function Characters({ typing, hidden }) {
  return <div className={`login-characters ${typing ? 'typing' : ''} ${hidden ? 'hiding' : ''}`} aria-hidden="true">
    <div className="login-character purple"><span className="eyes"><i/><i/></span></div>
    <div className="login-character charcoal"><span className="eyes"><i/><i/></span></div>
    <div className="login-character orange"><span className="eyes"><i/><i/></span></div>
    <div className="login-character yellow"><span className="eyes"><i/><i/></span><span className="mouth"/></div>
  </div>;
}

export default function LoginPage({ setupRequired, onSuccess }) {
  const [form, setForm] = useState({ username: '', display_name: '', password: '' });
  const [remember, setRemember] = useState(!!window.caidanDesktop);
  const [showPassword, setShowPassword] = useState(false);
  const [typing, setTyping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const change = (key, value) => setForm(current => ({ ...current, [key]: value }));
  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const result = await api(setupRequired ? '/auth/setup' : '/auth/login', { ...form, remember });
      onSuccess(result.user);
    } catch (ex) { setError(ex.message); }
    finally { setBusy(false); }
  }
  return <main className="login-screen"><div className="login-layout"><aside className="login-visual" aria-label="卡通登录插画"><div className="login-brand"><img className="login-logo" src={companyLogo} width="2172" height="724" alt="思品利诚 · 上海思品利诚智能科技有限公司"/></div><div className="login-character-stage"><Characters typing={typing} hidden={!!form.password && !showPassword}/></div></aside><section className="login-content"><div className="login-form-wrap"><div className="login-mobile-brand"><img className="login-logo" src={companyLogo} width="2172" height="724" alt="思品利诚 · 上海思品利诚智能科技有限公司"/></div><header className="login-heading"><h1>{setupRequired ? '创建首个账号' : '登录'}</h1><p>{setupRequired ? '设置账号后即可开始使用' : '请输入账号与密码'}</p></header><form className="login-form" onSubmit={submit}>
    <label><span>账号</span><input required autoComplete="username" maxLength={40} placeholder="请输入账号" value={form.username} onFocus={() => setTyping(true)} onBlur={() => setTyping(false)} onChange={e => change('username', e.target.value)}/></label>
    {setupRequired ? <label><span>姓名</span><input required autoComplete="name" maxLength={80} placeholder="用于操作记录" value={form.display_name} onChange={e => change('display_name', e.target.value)}/></label> : null}
    <label><span>密码</span><div className="login-password"><input required minLength={setupRequired ? 8 : undefined} maxLength={128} type={showPassword ? 'text' : 'password'} autoComplete={setupRequired ? 'new-password' : 'current-password'} placeholder="请输入密码" value={form.password} onChange={e => change('password', e.target.value)}/><button type="button" aria-label={showPassword ? '隐藏密码' : '显示密码'} onClick={() => setShowPassword(value => !value)}>{showPassword ? <EyeOff size={18}/> : <Eye size={18}/>}</button></div></label>
    <label className="login-remember"><input type="checkbox" aria-label="记住密码，自动登录" checked={remember} onChange={e => setRemember(e.target.checked)}/><span>记住密码（自动登录）</span></label>
    <p className="login-remember-note">只保存登录会话，不保存明文密码。</p>
    {error ? <p className="login-error" role="alert">{error}</p> : null}
    <button className="login-submit" type="submit" disabled={busy}><span>{busy ? '请稍候…' : setupRequired ? '创建并进入' : '登录'}</span><span className="login-submit-hover" aria-hidden="true">{setupRequired ? '创建并进入' : '登录'} <ArrowRight size={16}/></span></button>
  </form></div></section></div></main>;
}
