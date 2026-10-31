import React, { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Database, FolderOpen, Boxes, Globe2, Users, Send, Sparkles,
  ScrollText, Settings2, BookOpen, Search, Bell, ChevronDown, HelpCircle, Activity,
} from 'lucide-react';
import { api } from '../api';

const nav = [
  {
    label: 'Overview',
    items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true }],
  },
  {
    label: 'Build',
    items: [
      { to: '/databases', label: 'Databases', icon: Database },
      { to: '/storage', label: 'Storage', icon: FolderOpen },
      { to: '/functions', label: 'Functions', icon: Boxes },
      { to: '/sites', label: 'Sites', icon: Globe2 },
      { to: '/auth', label: 'Auth', icon: Users },
      { to: '/messaging', label: 'Messaging', icon: Send },
    ],
  },
  {
    label: 'Observe',
    items: [
      { to: '/logs', label: 'Logs', icon: ScrollText },
      { to: '/docs', label: 'Analysis', icon: BookOpen },
    ],
  },
];

const titles: Record<string, string> = {
  '': 'Dashboard', databases: 'Databases', storage: 'Storage', functions: 'Functions',
  sites: 'Sites', auth: 'Auth', messaging: 'Messaging', ai: 'AI Assistant',
  logs: 'Logs', settings: 'Settings', docs: 'Analysis',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  const nav2 = useNavigate();
  const [project, setProject] = useState<{ name: string; region: string; plan: string; id: string } | null>(null);
  const [aiMode, setAiMode] = useState<'demo' | 'deepseek'>('demo');

  useEffect(() => {
    api.project().then((p) => setProject(p as any)).catch(() => {});
    api.aiStatus().then((s) => setAiMode(s.mode)).catch(() => {});
  }, []);

  const segs = loc.pathname.split('/').filter(Boolean);
  const root = segs[0] || '';
  const title = titles[root] || root;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="logo-mark" />
          <div>
            <div className="brand-name">Studio <span>BaaS</span></div>
            <div className="brand-sub">Console</div>
          </div>
        </div>

        <div className="project-pill pointer" onClick={() => nav2('/settings')}>
          <div className="project-avatar">{(project?.name || 'A').slice(0, 1)}</div>
          <div className="project-meta">
            <b>{project?.name || 'Loading…'}</b>
            <small>{project ? `${project.region.toUpperCase()} · ${project.plan}` : '—'}</small>
          </div>
          <ChevronDown size={13} />
        </div>

        {nav.map((g) => (
          <div className="nav-group" key={g.label}>
            <div className="nav-label">{g.label}</div>
            {g.items.map((it) => (
              <NavLink key={it.to} to={it.to} end={(it as any).end} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                <it.icon />
                <span>{it.label}</span>
              </NavLink>
            ))}
          </div>
        ))}

        <div className="nav-group">
          <div className="nav-label">Project</div>
          <NavLink to="/settings" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <Settings2 /><span>Settings</span>
          </NavLink>
        </div>

        <div className="sidebar-foot">
          <NavLink to="/ai" className="ai-entry">
            <Sparkles size={16} />
            <span>
              AI Assistant
              <small>{aiMode === 'deepseek' ? 'DeepSeek · online' : 'DeepSeek · demo mode'}</small>
            </span>
          </NavLink>
          <div className="flex tiny dim" style={{ padding: '12px 10px 2px', gap: 7 }}>
            <span className="status-dot" /> All systems operational
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="crumbs">
            <span>{project?.name || 'Project'}</span>
            <span className="sep">/</span>
            <b>{title}</b>
            {segs[1] && (
              <>
                <span className="sep">/</span>
                <span className="mono" style={{ fontSize: 11 }}>{segs[1].slice(0, 18)}</span>
              </>
            )}
          </div>

          <div className="top-actions">
            <div className="searchbox pointer" onClick={() => nav2('/databases')}>
              <Search size={13} />
              <span>Search resources…</span>
              <kbd>⌘K</kbd>
            </div>
            <NavLink to="/logs" className="icon-btn" title="Activity"><Activity size={14} /></NavLink>
            <button className="icon-btn" title="Notifications"><Bell size={14} /></button>
            <button className="icon-btn" title="Help"><HelpCircle size={14} /></button>
            <div className="avatar">AF</div>
          </div>
        </header>
        <div className="page-scroll">{children}</div>
      </div>
    </div>
  );
}
