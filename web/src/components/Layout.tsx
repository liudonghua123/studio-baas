import React, { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Database, FolderOpen, Boxes, Globe2, Users, Send, Sparkles,
  ScrollText, Settings2, BookOpen, Search, Bell, ChevronDown, HelpCircle, Activity,
  Layers, Check, Plus, ShieldCheck, UserRound, Sun, Moon,
} from 'lucide-react';
import { api, currentProjectId, setProject } from '../api';
import { useAuth } from '../lib/auth';
import { ROLE_META, roleColor, roleLabel } from '../lib/roles';
import { useI18n } from '../lib/locale';
import { useTheme } from '../lib/theme';
import type { Project } from '../types';

const navGroups = [
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
  const [acct, setAcct] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const acctRef = useRef<HTMLDivElement>(null);
  const { me, role, actAs, setActAs } = useAuth();
  const { t, lang, toggleLang } = useI18n();
  const { resolved, toggle } = useTheme();
  const initials = (me?.principal?.name || 'Studio BaaS')
    .split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

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
      if (acctRef.current && !acctRef.current.contains(e.target as Node)) setAcct(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const segs = loc.pathname.split('/').filter(Boolean);
  const root = segs[0] || '';
  const title = t(titles[root] || root);

  const switchProject = (id: string) => {
    if (id === project?.id) { setMenu(false); return; }
    setProject(id);
    window.location.href = '/';
  };

  const themeLabel = resolved === 'light' ? t('Switch to dark theme') : t('Switch to light theme');

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="logo-mark" />
          <div>
            <div className="brand-name">Studio <span>BaaS</span></div>
            <div className="brand-sub">{t('Console')}</div>
          </div>
        </div>

        <div className="proj-wrap" ref={menuRef}>
          <div className="project-pill pointer" onClick={() => setMenu((v) => !v)}>
            <div className="project-avatar" style={{ background: project?.color || undefined }}>
              {(project?.name || 'A').slice(0, 1)}
            </div>
            <div className="project-meta">
              <b>{project?.name || t('Loading…')}</b>
              <small>{project ? `${project.region.toUpperCase()} · ${project.plan}` : '—'}</small>
            </div>
            <ChevronDown size={13} style={{ transform: menu ? 'rotate(180deg)' : undefined, transition: 'transform .15s' }} />
          </div>

          {menu && (
            <div className="proj-menu">
              <div className="proj-menu-label">{t('Switch project')}</div>
              {projects.map((p) => (
                <button key={p.id} className="proj-item" onClick={() => switchProject(p.id)}>
                  <span className="proj-dot" style={{ background: p.color }} />
                  <span className="proj-item-text">
                    <b>{p.name}</b>
                    <small>
                      {p.stats
                        ? t('{collections} collections · {functions} functions', { collections: p.stats.collections, functions: p.stats.functions })
                        : p.key}
                    </small>
                  </span>
                  {p.id === project?.id && <Check size={13} color="var(--pink)" />}
                </button>
              ))}
              <div className="proj-menu-sep" />
              <button className="proj-item" onClick={() => { setMenu(false); nav2('/projects'); }}>
                <Layers size={13} />
                <span className="proj-item-text"><b>{t('All projects')}</b><small>{t('Create, rename, delete')}</small></span>
              </button>
              <button className="proj-item" onClick={() => { setMenu(false); nav2('/projects?new=1'); }}>
                <Plus size={13} />
                <span className="proj-item-text"><b>{t('New project')}</b><small>{t('Isolated resources')}</small></span>
              </button>
            </div>
          )}
        </div>

        {navGroups.map((g) => (
          <div className="nav-group" key={g.label}>
            <div className="nav-label">{t(g.label)}</div>
            {g.items.map((it) => (
              <NavLink key={it.to} to={it.to} end={(it as any).end} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                <it.icon />
                <span>{t(it.label)}</span>
              </NavLink>
            ))}
          </div>
        ))}

        <div className="nav-group">
          <div className="nav-label">{t('Project')}</div>
          <NavLink to="/projects" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <Layers /><span>{t('Projects')}</span>
          </NavLink>
          <NavLink to="/members" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <ShieldCheck /><span>{t('Members')}</span>
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <Settings2 /><span>{t('Settings')}</span>
          </NavLink>
        </div>

        <div className="sidebar-foot">
          <NavLink to="/ai" className="ai-entry">
            <Sparkles size={16} />
            <span>
              {t('AI Assistant')}
              <small>{aiMode === 'deepseek' ? t('DeepSeek · online') : t('DeepSeek · demo mode')}</small>
            </span>
          </NavLink>
          <div className="flex tiny dim" style={{ padding: '12px 10px 2px', gap: 7 }}>
            <span className="status-dot" /> {t('All systems operational')}
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="crumbs">
            <span>{project?.name || t('Project')}</span>
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
              <span>{t('Search resources…')}</span>
              <kbd>⌘K</kbd>
            </div>
            <button
              className="theme-toggle"
              onClick={toggle}
              title={themeLabel}
              aria-label={themeLabel}
            >
              {resolved === 'light' ? <Sun size={14} /> : <Moon size={14} />}
            </button>
            <button
              className="lang-toggle"
              onClick={toggleLang}
              title={lang === 'zh' ? 'Switch to English' : '切换到中文'}
              aria-label={lang === 'zh' ? 'Switch to English' : '切换到中文'}
            >
              {lang === 'zh' ? '中' : 'EN'}
            </button>
            <NavLink to="/logs" className="icon-btn" title={t('Activity')}><Activity size={14} /></NavLink>
            <button className="icon-btn" title={t('Notifications')}><Bell size={14} /></button>
            <button className="icon-btn" title={t('Help')}><HelpCircle size={14} /></button>
            <div className="acct-wrap" ref={acctRef}>
              <button className="acct-btn" onClick={() => setAcct((v) => !v)} title={t('Switch identity / role')}>
                <span className="avatar">{initials}</span>
                <span className="acct-meta">
                  <b>{me?.principal?.name || t('Demo Owner')}</b>
                  <small><i className="role-dot" style={{ background: roleColor(role) }} />{t(roleLabel(role))}</small>
                </span>
                <ChevronDown size={12} />
              </button>
              {acct && (
                <div className="proj-menu acct-menu">
                  <div className="acct-head">
                    <div className="acct-avatar" style={{ background: roleColor(role) }}>{initials}</div>
                    <div style={{ minWidth: 0 }}>
                      <b>{me?.principal?.name}</b>
                      <small>{me?.principal?.type === 'key' ? t('API key') : t('Console session')} · {t(roleLabel(role))}</small>
                    </div>
                  </div>
                  <div className="proj-menu-label">{t('View as role')}</div>
                  {ROLE_META.map((r) => (
                    <button key={r.id} className="proj-item" onClick={() => { setAcct(false); setActAs(r.id); }}>
                      <span className="proj-dot" style={{ background: r.color }} />
                      <span className="proj-item-text">
                        <b>{t(r.label)}</b>
                        <small>{t(r.description)}</small>
                      </span>
                      {actAs === r.id && <Check size={13} color="var(--pink)" />}
                    </button>
                  ))}
                  <div className="proj-menu-sep" />
                  <button className="proj-item" onClick={() => { setAcct(false); nav2('/members'); }}>
                    <UserRound size={13} />
                    <span className="proj-item-text"><b>{t('Manage members')}</b><small>{t('Invite people and change roles')}</small></span>
                  </button>
                  <div className="acct-note">{t('Local demo: switching role only changes the console’s own requests.')}</div>
                </div>
              )}
            </div>
          </div>
        </header>
        <div className="page-scroll">
          {actAs !== 'owner' && (
            <div className="act-as-banner">
              <ShieldCheck size={13} />
              <span>
                {t('Viewing as {role} — write actions are blocked by RBAC. Switch back in the account menu.', { role: t(roleLabel(actAs)) })}
              </span>
              <button onClick={() => setActAs('owner')}>{t('Reset to owner')}</button>
            </div>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}
