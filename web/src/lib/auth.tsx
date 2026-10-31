import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { Me } from '../types';

export const ACT_AS_KEY = 'studio.actAs';

interface AuthState {
  me: Me | null;
  loading: boolean;
  role: string;
  can: (permission: string) => boolean;
  actAs: string;
  setActAs: (role: string) => void;
  reload: () => void;
}

const Ctx = createContext<AuthState>({
  me: null, loading: true, role: 'viewer', can: () => false,
  actAs: 'owner', setActAs: () => {}, reload: () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [actAs, setActAsState] = useState(() => localStorage.getItem(ACT_AS_KEY) || 'owner');

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

  const value = useMemo<AuthState>(() => ({
    me,
    loading,
    role: me?.role || 'viewer',
    can: (permission: string) => !!me?.permissions?.includes(permission),
    actAs,
    setActAs,
    reload,
  }), [me, loading, actAs, setActAs, reload]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
