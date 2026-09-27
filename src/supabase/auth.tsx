import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { getSupabase, isSupabaseConfigured } from "./client";

interface AuthState {
  configured: boolean;
  loading: boolean;
  user: User | null;
  session: Session | null;
  error: string | null;
  signUp: (email: string, password: string) => Promise<boolean>;
  signIn: (email: string, password: string) => Promise<boolean>;
  signOut: () => Promise<void>;
  clearError: () => void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const configured = isSupabaseConfigured();
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Persistent session + restoration after refresh.
  useEffect(() => {
    if (!configured) {
      setLoading(false);
      return;
    }
    const sb = getSupabase();
    if (!sb) {
      setLoading(false);
      return;
    }
    let alive = true;
    sb.auth.getSession().then(({ data, error: e }) => {
      if (!alive) return;
      if (e) setError(e.message);
      setSession(data.session ?? null);
      setUser(data.session?.user ?? null);
      setLoading(false);
    });
    const { data: sub } = sb.auth.onAuthStateChange((_event, next) => {
      setSession(next ?? null);
      setUser(next?.user ?? null);
      setLoading(false);
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, [configured]);

  const signUp = useCallback(async (email: string, password: string) => {
    const sb = getSupabase();
    if (!sb) {
      setError("Cloud sync is not configured.");
      return false;
    }
    setError(null);
    const { data, error: e } = await sb.auth.signUp({ email: email.trim(), password });
    if (e) {
      setError(e.message);
      return false;
    }
    // With email confirmation ON, there is no session yet — tell the user to check mail.
    if (!data.session) {
      setError("Check your email to confirm your account, then log in.");
      return false;
    }
    return true;
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const sb = getSupabase();
    if (!sb) {
      setError("Cloud sync is not configured.");
      return false;
    }
    setError(null);
    const { error: e } = await sb.auth.signInWithPassword({ email: email.trim(), password });
    if (e) {
      setError(e.message);
      return false;
    }
    return true;
  }, []);

  const signOut = useCallback(async () => {
    const sb = getSupabase();
    setError(null);
    if (sb) await sb.auth.signOut();
    setSession(null);
    setUser(null);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const value = useMemo<AuthState>(
    () => ({ configured, loading, user, session, error, signUp, signIn, signOut, clearError }),
    [configured, loading, user, session, error, signUp, signIn, signOut, clearError],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used inside <AuthProvider>");
  return v;
}
