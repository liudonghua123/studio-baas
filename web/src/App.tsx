import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Layout from './components/Layout';
import { ToastProvider } from './components/ui';
import { AuthProvider, useAuth } from './lib/auth';
import { LocaleProvider } from './lib/locale';
import { ThemeProvider } from './lib/theme';
import Overview from './pages/Overview';
import Databases from './pages/Databases';
import Storage from './pages/Storage';
import Functions from './pages/Functions';
import FunctionDetail from './pages/FunctionDetail';
import Sites from './pages/Sites';
import SiteDetail from './pages/SiteDetail';
import Auth from './pages/Auth';
import Messaging from './pages/Messaging';
import Logs from './pages/Logs';
import Settings from './pages/Settings';
import Docs from './pages/Docs';
import AI from './pages/AI';
import Projects from './pages/Projects';
import Members from './pages/Members';
import Webhooks from './pages/Webhooks';
import Login from './pages/Login';

/**
 * 半登录状态（策略要求第二因素但还没绑定）只能待在安全设置页。
 *
 * 服务端已经用 403 拦住了所有业务接口，这里再拦一次是为了给出「为什么」：
 * 否则用户点侧栏只会看到一串 toast 报错，不知道自己被卡在哪。
 */
function MfaGate({ children }: { children: React.ReactNode }) {
  const { me } = useAuth();
  const loc = useLocation();
  if (me?.principal?.mfaPending && loc.pathname !== '/settings') {
    return <Navigate to="/settings?focus=mfa" replace />;
  }
  return <>{children}</>;
}

/** 控制台外壳：侧栏 + 顶栏 + 页面 */
function Console() {
  return (
    <Layout>
      <MfaGate>
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="/databases" element={<Databases />} />
        <Route path="/databases/:id" element={<Databases />} />
        <Route path="/storage" element={<Storage />} />
        <Route path="/functions" element={<Functions />} />
        <Route path="/functions/:id" element={<FunctionDetail />} />
        <Route path="/sites" element={<Sites />} />
        <Route path="/sites/:id" element={<SiteDetail />} />
        <Route path="/auth" element={<Auth />} />
        <Route path="/messaging" element={<Messaging />} />
        <Route path="/logs" element={<Logs />} />
        <Route path="/webhooks" element={<Webhooks />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/members" element={<Members />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/docs" element={<Docs />} />
        <Route path="/ai" element={<AI />} />
        <Route path="*" element={<Overview />} />
      </Routes>
      </MfaGate>
    </Layout>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
      <LocaleProvider>
      <ToastProvider>
        <AuthProvider>
        <Routes>
          {/* 登录页不套控制台外壳：SSO 回调从这里落地，地址栏里只有 fragment */}
          <Route path="/login" element={<Login />} />
          <Route path="*" element={<Console />} />
        </Routes>
        </AuthProvider>
      </ToastProvider>
      </LocaleProvider>
      </ThemeProvider>
    </BrowserRouter>
  );
}
