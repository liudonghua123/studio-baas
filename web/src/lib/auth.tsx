import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { Me } from '../types';

export const ACT_AS_KEY = 'studio.actAs';
export const SESSION_KEY = 'studio.session';

interface AuthState {
  me: Me | null;
  loading: boolean;
  role: string;
  can: (permission: string) => boolean;
  actAs: string;
  setActAs: (role: string) => void;
  reload: () => void;
  /** 当前控制台会话票据；空字符串 = 未登录（走 demo 身份） */
  session: string;
  signIn: (secret: string) => void;
  signOut: () => void;
}

const Ctx = createContext<AuthState>({
  me: null, loading: true, role: 'viewer', can: () => false,
  actAs: 'owner', setActAs: () => {}, reload: () => {},
  session: '', signIn: () => {}, signOut: () => {},
});

const readSession = () => {
  try { return localStorage.getItem(SESSION_KEY) || ''; } catch { return ''; }
};

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [actAs, setActAsState] = useState(() => localStorage.getItem(ACT_AS_KEY) || 'owner');
  const [session, setSession] = useState(readSession);

  const reload = useCallback(() => {
    setLoading(true);
    api.me()
      .then((m) => setMe(m))
      .catch(() => setMe(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // 切项目时身份可能不同（同一个人在不同项目里角色不一样），重新拉一次
  useEffect(() => {
    const onStorage = () => reload();
    window.addEventListener('studio:project-changed', onStorage);
    return () => window.removeEventListener('studio:project-changed', onStorage);
  }, [reload]);

  const setActAs = useCallback((role: string) => {
    if (role === 'owner') localStorage.removeItem(ACT_AS_KEY);
    else localStorage.setItem(ACT_AS_KEY, role);
    setActAsState(role);
    reload();
  }, [reload]);

  const signIn = useCallback((secret: string) => {
    localStorage.setItem(SESSION_KEY, secret);
    // 「以角色查看」是给未登录的演示用的；真登录之后必须清掉，
    // 否则它会在每个请求里跟会话一起发出去，把真实角色盖掉
    localStorage.removeItem(ACT_AS_KEY);
    setActAsState('owner');
    setSession(secret);
    reload();
  }, [reload]);

  const signOut = useCallback(() => {
    // 先让服务端作废会话（失败也无所谓，本地票据已经要删了）
    void api.logout().catch(() => {});
    localStorage.removeItem(SESSION_KEY);
    setSession('');
    setMe(null);
    reload();
  }, [reload]);

  const value = useMemo<AuthState>(() => ({
    me,
    loading,
    role: me?.role || 'viewer',
    can: (permission: string) => !!me?.permissions?.includes(permission),
    actAs,
    setActAs,
    reload,
    session,
    signIn,
    signOut,
  }), [me, loading, actAs, setActAs, reload, session, signIn, signOut]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
