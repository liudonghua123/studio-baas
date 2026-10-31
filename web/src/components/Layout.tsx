import React, { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Database, FolderOpen, Boxes, Globe2, Users, Send, Sparkles,
  ScrollText, Settings2, BookOpen, Search, Bell, ChevronDown, HelpCircle, Activity,
  Layers, Check, Plus,
} from 'lucide-react';
import { api, currentProjectId, setProject } from '../api';
import type { Project } from '../types';

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
  logs: 'Logs', settings: 'Settings', docs: 'Analysis', projects: 'Projects', members: 'Members',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  const nav2 = useNavigate();
  const [project, setProjectState] = useState<Project | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [menu, setMenu] = useState(false);
  const [aiMode, setAiMode] = useState<'demo' | 'deepseek'>('demo');
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.projects().then((r) => {
      setProjects(r.projects);
      const current = r.projects.find((p) => p.id === (currentProjectId() || r.currentProjectId));
      setProjectState(current || r.projects[0] || null);
      if (!currentProjectId() && r.currentProjectId) setProject(r.currentProjectId);
    }).catch(() => {});
    api.project().then((p) => setProjectState(p as any)).catch(() => {});
    api.aiStatus().then((s) => setAiMode(s.mode)).catch(() => {});
  }, []);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const segs = loc.pathname.split('/').filter(Boolean);
  const root = segs[0] || '';
  const title = titles[root] || root;

  const switchProject = (id: string) => {
    if (id === project?.id) { setMenu(false); return; }
    setProject(id);
    window.location.href = '/';
  };

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

        <div className="proj-wrap" ref={menuRef}>
          <div className="project-pill pointer" onClick={() => setMenu((v) => !v)}>
            <div className="project-avatar" style={{ background: project?.color || undefined }}>
              {(project?.name || 'A').slice(0, 1)}
            </div>
            <div className="project-meta">
              <b>{project?.name || 'Loading…'}</b>
              <small>{project ? `${project.region.toUpperCase()} · ${project.plan}` : '—'}</small>
            </div>
            <ChevronDown size={13} style={{ transform: menu ? 'rotate(180deg)' : undefined, transition: 'transform .15s' }} />
          </div>

          {menu && (
            <div className="proj-menu">
              <div className="proj-menu-label">Switch project</div>
              {projects.map((p) => (
                <button key={p.id} className="proj-item" onClick={() => switchProject(p.id)}>
                  <span className="proj-dot" style={{ background: p.color }} />
                  <span className="proj-item-text">
                    <b>{p.name}</b>
                    <small>{p.stats ? `${p.stats.collections} collections · ${p.stats.functions} functions` : p.key}</small>
                  </span>
                  {p.id === project?.id && <Check size={13} color="#fd366e" />}
                </button>
              ))}
              <div className="proj-menu-sep" />
              <button className="proj-item" onClick={() => { setMenu(false); nav2('/projects'); }}>
                <Layers size={13} />
                <span className="proj-item-text"><b>All projects</b><small>Create, rename, delete</small></span>
              </button>
              <button className="proj-item" onClick={() => { setMenu(false); nav2('/projects?new=1'); }}>
                <Plus size={13} />
                <span className="proj-item-text"><b>New project</b><small>Isolated resources</small></span>
              </button>
            </div>
          )}
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
          <NavLink to="/projects" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <Layers /><span>Projects</span>
          </NavLink>
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
