import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import { ToastProvider } from './components/ui';
import { AuthProvider } from './lib/auth';
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

/** 控制台外壳：侧栏 + 顶栏 + 页面 */
function Console() {
  return (
    <Layout>
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
