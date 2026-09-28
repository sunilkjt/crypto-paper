import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { getSupabase, isSupabaseConfigured } from "./client";

interface AuthState {
  configured: boolean;
  loading: boolean;
  user: User | null;
  session: Session | null;
  error: string | null;
  /** Error carried by an email-link redirect (e.g. expired confirmation link). */
  urlAuthError: string | null;
  signUp: (email: string, password: string) => Promise<boolean>;
  signIn: (email: string, password: string) => Promise<boolean>;
  signOut: () => Promise<void>;
  resendConfirmation: (email: string) => Promise<boolean>;
  clearError: () => void;
  clearUrlAuthError: () => void;
}

/**
 * Read a Supabase auth error out of the URL fragment.
 * The app uses HashRouter (routes look like `#/paper`), so any fragment NOT
 * starting with `#/` is a Supabase email-link payload (`#error=...`).
 */
function parseHashAuthError(): string | null {
  try {
    const h = window.location.hash;
    if (!h || h.startsWith("#/")) return null;
    const params = new URLSearchParams(h.slice(1));
    return params.get("error_description") || params.get("error");
  } catch {
    return null;
  }
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const configured = isSupabaseConfigured();
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [urlAuthError, setUrlAuthError] = useState<string | null>(null);

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
    // Surface email-link failures (expired/used confirmation links) instead of
    // leaving a dead error fragment in the address bar.
    const hashErr = parseHashAuthError();
    if (hashErr) {
      setUrlAuthError(hashErr);
      window.location.hash = "/paper";
    }
    const { data: sub } = sb.auth.onAuthStateChange((event, next) => {
      setSession(next ?? null);
      setUser(next?.user ?? null);
      setLoading(false);
      // A valid email link signs in but leaves a non-route fragment behind
      // (HashRouter would show 404) — land on the Paper page instead.
      // Safe: this only runs when the hash is NOT an app route, and only
      // after Supabase has already consumed the fragment.
      try {
        const h = window.location.hash;
        if ((event === "SIGNED_IN" || event === "TOKEN_REFRESHED") && h && !h.startsWith("#/")) {
          window.location.hash = "/paper";
        }
      } catch {
        // ignore
      }
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

  const resendConfirmation = useCallback(async (email: string) => {
    const sb = getSupabase();
    if (!sb) {
      setError("Cloud sync is not configured.");
      return false;
    }
    setError(null);
    const { error: e } = await sb.auth.resend({ type: "signup", email: email.trim() });
    if (e) {
      setError(e.message);
      return false;
    }
    return true;
  }, []);

  const clearError = useCallback(() => setError(null), []);
  const clearUrlAuthError = useCallback(() => setUrlAuthError(null), []);

  const value = useMemo<AuthState>(
    () => ({ configured, loading, user, session, error, urlAuthError, signUp, signIn, signOut, resendConfirmation, clearError, clearUrlAuthError }),
    [configured, loading, user, session, error, urlAuthError, signUp, signIn, signOut, resendConfirmation, clearError, clearUrlAuthError],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used inside <AuthProvider>");
  return v;
}
