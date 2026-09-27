import { useState } from "react";
import { supabaseEnvStatus } from "../supabase/client";
import { useAuth } from "../supabase/auth";
import type { CloudSyncStatus } from "../supabase/types";
import { Card, CardHeader } from "./ui";
import { cn } from "../lib/cn";

const SYNC_META: Record<CloudSyncStatus, { dot: string; emoji: string; label: string }> = {
  disabled: { dot: "bg-slate-500", emoji: "⚪", label: "Local only" },
  "signed-out": { dot: "bg-slate-500", emoji: "⚪", label: "Local only" },
  loading: { dot: "bg-amber-400", emoji: "🟡", label: "Syncing" },
  syncing: { dot: "bg-amber-400", emoji: "🟡", label: "Syncing" },
  synced: { dot: "bg-emerald-400", emoji: "🟢", label: "Cloud Synced" },
  offline: { dot: "bg-rose-500", emoji: "🔴", label: "Offline" },
  error: { dot: "bg-rose-500", emoji: "🔴", label: "Sync error" },
};

export function CloudSyncBadge({ status }: { status: CloudSyncStatus }) {
  const meta = SYNC_META[status];
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900 px-3 py-1 text-[11px] font-bold text-slate-300"
      title={status === "synced" ? "Paper account synchronized across devices" : `Cloud status: ${status}`}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} />
      <span aria-hidden="true">{meta.emoji}</span>
      {meta.label}
    </span>
  );
}

/**
 * Minimal account control. Logged out: prompt + email/password form.
 * Logged in: email + sync status + logout (+ migration slot rendered by parent).
 */
export function AuthPanel({
  syncStatus,
  needsMigration,
  migrated,
  lastError,
  onMigrate,
  migrating,
}: {
  syncStatus: CloudSyncStatus;
  needsMigration: boolean;
  migrated: boolean;
  lastError: string | null;
  onMigrate: () => void;
  migrating: boolean;
}) {
  const { configured, loading, user, error, signUp, signIn, signOut, clearError } = useAuth();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  if (!configured) {
    // Show which variable is missing (presence only, never values) so a bad
    // deploy/secret can be diagnosed straight from the live site.
    const env = supabaseEnvStatus();
    return (
      <Card>
        <CardHeader title="Account" subtitle="Cloud sync not configured" />
        <div className="space-y-1.5 px-5 py-4 text-xs leading-relaxed text-slate-500">
          <p>
            Paper Trading works locally. Set <span className="font-mono text-slate-300">VITE_SUPABASE_URL</span>{" "}
            and <span className="font-mono text-slate-300">VITE_SUPABASE_PUBLISHABLE_KEY</span> as GitHub Actions
            secrets, then rebuild, to synchronize across devices.
          </p>
          <p className="font-mono">
            URL: {env.url ? <span className="font-bold text-emerald-300">set ✓</span> : <span className="font-bold text-rose-300">missing ✗</span>}
            {" · "}
            Key: {env.key ? <span className="font-bold text-emerald-300">set ✓</span> : <span className="font-bold text-rose-300">missing ✗</span>}
          </p>
        </div>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card>
        <CardHeader title="Account" subtitle="Restoring session…" />
        <p className="px-5 py-4 text-xs text-slate-500">Checking saved login…</p>
      </Card>
    );
  }

  if (!user) {
    const submit = async () => {
      if (!email.includes("@") || password.length < 6) return;
      setBusy(true);
      try {
        if (mode === "login") await signIn(email, password);
        else await signUp(email, password);
      } finally {
        setBusy(false);
      }
    };
    return (
      <Card>
        <CardHeader title="Paper Trading" subtitle="Login to synchronize your paper account across devices." />
        <div className="space-y-2.5 p-5 text-sm">
          <div className="flex gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1 text-xs font-bold">
            {(["login", "signup"] as const).map((m) => (
              <button
                key={m}
                onClick={() => {
                  setMode(m);
                  clearError();
                }}
                className={cn(
                  "flex-1 rounded-md px-3 py-1.5",
                  mode === m ? "bg-slate-800 text-white" : "text-slate-500 hover:text-slate-300",
                )}
              >
                {m === "login" ? "Login" : "Sign up"}
              </button>
            ))}
          </div>
          <label className="block">
            <span className="mb-1 block text-[11px] font-bold tracking-widest text-slate-500 uppercase">Email</span>
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-white"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-bold tracking-widest text-slate-500 uppercase">
              Password (min 6)
            </span>
            <input
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
              placeholder="••••••••"
              className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-white"
            />
          </label>
          {error && <p className="text-xs font-semibold text-amber-300">{error}</p>}
          <button
            onClick={() => void submit()}
            disabled={busy || !email.includes("@") || password.length < 6}
            className="w-full rounded-xl bg-cyan-500 px-4 py-2.5 text-sm font-bold text-slate-950 hover:bg-cyan-400 disabled:opacity-40"
          >
            {busy ? "Please wait…" : mode === "login" ? "Login" : "Create account"}
          </button>
          <p className="text-[11px] leading-relaxed text-slate-600">
            Same login on laptop + phone shares one $ paper account. Simulation only — no real orders.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Account"
        subtitle={user.email ?? "Signed in"}
        right={<CloudSyncBadge status={syncStatus} />}
      />
      <div className="space-y-2.5 p-5 text-sm">
        <p className="truncate font-mono text-xs text-slate-400" title={user.email ?? ""}>
          {user.email}
        </p>
        {needsMigration && (
          <div className="rounded-xl border border-amber-400/30 bg-amber-400/[0.07] p-3">
            <p className="text-xs font-bold text-amber-200">Existing local paper-trading data found.</p>
            <p className="mt-0.5 text-[11px] text-slate-400">
              Import it to the cloud once. Original local data is preserved until verification succeeds.
            </p>
            <button
              onClick={onMigrate}
              disabled={migrating}
              className="mt-2 w-full rounded-xl bg-amber-400 px-4 py-2 text-xs font-bold text-slate-950 hover:bg-amber-300 disabled:opacity-40"
            >
              {migrating ? "Importing…" : "Import to Cloud"}
            </button>
          </div>
        )}
        {migrated && !needsMigration && (
          <p className="text-[11px] text-emerald-300/80">● Local data imported to cloud.</p>
        )}
        {lastError && <p className="text-xs font-semibold text-rose-300">{lastError}</p>}
        <button
          onClick={() => void signOut()}
          className="w-full rounded-xl border border-slate-700 px-4 py-2 text-xs font-bold text-slate-300 hover:bg-slate-800"
        >
          Logout
        </button>
      </div>
    </Card>
  );
}
