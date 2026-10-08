import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './inventory.css';

class ErrorBoundary extends React.Component {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() { return this.state.error ? <main><h1>页面加载遇到问题</h1><p>业务数据保存在本机数据库中。请刷新页面，或查看服务日志。</p><button onClick={() => location.reload()}>刷新</button></main> : this.props.children; }
}
createRoot(document.getElementById('root')).render(<React.StrictMode><ErrorBoundary><App/></ErrorBoundary></React.StrictMode>);
