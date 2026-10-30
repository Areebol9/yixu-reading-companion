import { t } from './i18n.ts';
import { workbenchErrorLabel } from './copy.ts';
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { connectWorkbenchHost } from './remote-client.ts';
import { Workbench } from './Workbench.tsx';
import './workbench.css';

class WorkbenchBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  componentDidCatch(error: Error, _info: ErrorInfo) { console.error('Workbench UI:', error); }
  render() {
    if (this.state.error) return <div className="error-boundary"><h1>{t("工作台暂时需要重新打开")}</h1><p>{workbenchErrorLabel(this.state.error)}</p><button className="btn btn-primary" onClick={() => location.reload()}>{t("重新打开")}</button></div>;
    return this.props.children;
  }
}
const root = createRoot(document.getElementById('root')!);
root.render(<div className="reader-empty" style={{ minHeight: '100dvh' }}><div className="empty-illustration">{t("宜序")}</div><h3>{t("正在打开共读工作台")}</h3><p>{t("加载本机保存的阅读记录…")}</p></div>);
void connectWorkbenchHost(message => {const element=document.querySelector('.reader-empty p');if(element)element.textContent=t(message);}).then(client => {
  root.render(<WorkbenchBoundary><Workbench client={client} /></WorkbenchBoundary>);
}).catch(error => {
  root.render(<div className="error-boundary"><h1>{t("工作台打开失败")}</h1><p>{workbenchErrorLabel(error instanceof Error ? error.message : t("请重新打开页面后重试。"))}</p><button className="btn btn-primary" onClick={() => location.reload()}>{t("重新打开")}</button></div>);
});
