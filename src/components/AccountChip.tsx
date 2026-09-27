import { Link } from "react-router-dom";
import { useAuth } from "../supabase/auth";

/** Minimal topbar account control: email initial when in, Login link when out. */
export function AccountChip() {
  const { configured, loading, user } = useAuth();
  if (!configured || loading) return null;
  if (!user) {
    return (
      <Link
        to="/paper"
        className="rounded-lg border border-slate-800 px-2.5 py-1.5 text-[11px] font-bold text-slate-300 hover:bg-slate-900"
        title="Login to synchronize your paper account across devices."
      >
        Login
      </Link>
    );
  }
  const initial = (user.email ?? "U").trim().charAt(0).toUpperCase() || "U";
  return (
    <Link
      to="/paper"
      className="flex h-8 w-8 items-center justify-center rounded-full border border-cyan-400/40 bg-cyan-400/10 text-xs font-extrabold text-cyan-200"
      title={user.email ?? "Paper account"}
    >
      {initial}
    </Link>
  );
}
