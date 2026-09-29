import { useEffect, useReducer, useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  ArrowUpFromDot,
  Bell,
  Briefcase,
  CandlestickChart,
  FlaskConical,
  History,
  LayoutDashboard,
  Menu,
  Radar,
  Settings,
  Star,
  TrendingUp,
  X,
  Zap,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { APP_NAME } from "../../types";
import { useMarkets } from "../../market/store";
import { ConnectionBadge, ConnectionLine } from "../ConnectionBadge";
import { AccountChip } from "../AccountChip";
import { InstallAppButton } from "../InstallApp";
import { DiagnosticsPanel, isDevDiagnosticsEnabled } from "../DiagnosticsPanel";
import {
  alertCoinNavigation,
  eventMessage,
  loadAlertSettings,
  markAlertRead,
  markAllAlertsRead,
  subscribeAlerts,
  subscribeAlertSettings,
  type SignalEvent,
} from "../../alerts";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/scanner", label: "Market Scanner", icon: Radar, end: false },
  { to: "/markets", label: "Markets", icon: TrendingUp, end: false },
  { to: "/coin/OP", label: "Coin Analysis", icon: CandlestickChart, end: false },
  { to: "/bounce", label: "Best Bounce", icon: ArrowUpFromDot, end: false },
  { to: "/alerts", label: "Alerts", icon: Bell, end: false },
  { to: "/watchlist", label: "Watchlist", icon: Star, end: false },
  { to: "/history", label: "Signal History", icon: History, end: false },
  { to: "/backtest", label: "Backtest", icon: FlaskConical, end: false },
  { to: "/paper", label: "Paper Trading", icon: Briefcase, end: false },
  { to: "/settings", label: "Settings", icon: Settings, end: false },
];

const BOTTOM_NAV = [
  { to: "/", label: "Home", icon: LayoutDashboard, end: true },
  { to: "/scanner", label: "Scan", icon: Radar, end: false },
  { to: "/markets", label: "Markets", icon: TrendingUp, end: false },
  { to: "/bounce", label: "Bounce", icon: ArrowUpFromDot, end: false },
  { to: "/paper", label: "Paper", icon: Briefcase, end: false },
  { to: "/settings", label: "Setup", icon: Settings, end: false },
];

function Logo({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <Link to="/" className="flex items-center gap-2.5 px-1">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-400 to-violet-600 shadow-lg shadow-cyan-500/20">
        <Zap className="h-5 w-5 text-white" strokeWidth={2.5} />
      </span>
      {!collapsed && (
        <span className="leading-tight">
          <span className="block text-[15px] font-extrabold tracking-tight text-white">
            {APP_NAME}
          </span>
          <span className="block text-[10px] font-semibold tracking-[0.18em] text-cyan-300/80 uppercase">
            Phase 2 · Live
          </span>
        </span>
      )}
    </Link>
  );
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="space-y-1">
      {NAV.map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            key={item.to + item.label}
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13.5px] font-medium transition",
                isActive
                  ? "border border-slate-700/60 bg-slate-800/90 text-white shadow"
                  : "border border-transparent text-slate-400 hover:border-slate-800 hover:bg-slate-900 hover:text-slate-100"
              )
            }
          >
            {({ isActive }) => (
              <>
                <Icon
                  className={cn(
                    "h-[18px] w-[18px] shrink-0",
                    isActive ? "text-cyan-300" : "text-slate-500 group-hover:text-slate-300"
                  )}
                />
                {item.label}
                {item.label === "Best Bounce" && (
                  <span className="ml-auto rounded-full bg-cyan-400/10 px-2 py-0.5 text-[10px] font-bold text-cyan-300">
                    NEW
                  </span>
                )}
              </>
            )}
          </NavLink>
        );
      })}
    </nav>
  );
}

export default function AppLayout() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [notes, setNotes] = useState<SignalEvent[]>([]);
  const { markets } = useMarkets();
  const navigate = useNavigate();
  const [, bumpSettings] = useReducer((x: number) => x + 1, 0);

  useEffect(() => subscribeAlerts(setNotes), []);
  useEffect(() => subscribeAlertSettings(bumpSettings), [bumpSettings]);
  const showBell = loadAlertSettings().inAppNotifications;
  const unread = notes.filter((n) => !n.read).length;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 lg:flex">
      {/* Desktop sidebar */}
      <aside className="hidden w-[264px] shrink-0 flex-col border-r border-slate-800/80 bg-slate-900/40 backdrop-blur lg:flex">
        <div className="px-4 pt-5 pb-4">
          <Logo />
        </div>
        <div className="mx-4 mb-3 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.06] px-3 py-2.5">
          <p className="text-[11px] font-bold tracking-widest text-emerald-300 uppercase">
            Live market data
          </p>
          <p className="mt-0.5 text-[11px] leading-snug text-slate-400">
            Public Hyperliquid feed. No real-money trading.
          </p>
        </div>
        <div className="flex-1 overflow-y-auto px-3 pb-4">
          <NavList />
        </div>
        <div className="border-t border-slate-800/80 p-4 text-[11px] leading-relaxed text-slate-500">
          <p className="font-semibold text-slate-400">Phase 2 · Live data</p>
          <p>React · TS · Vite · Tailwind · Hyperliquid</p>
          <p className="mt-1">Paper only. Educational use.</p>
        </div>
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="absolute top-0 left-0 flex h-full w-[280px] flex-col border-r border-slate-800 bg-slate-900 p-4 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <Logo />
              <button
                aria-label="Close menu"
                onClick={() => setDrawerOpen(false)}
                className="rounded-lg border border-slate-800 p-2 text-slate-400 hover:bg-slate-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <NavList onNavigate={() => setDrawerOpen(false)} />
            </div>
            <p className="pt-3 text-[11px] text-slate-500">
              Live Hyperliquid data · No real-money trading
            </p>
          </div>
        </div>
      )}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Topbar */}
        <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-slate-950/85 backdrop-blur">
          <div className="mx-auto flex max-w-[1200px] items-center gap-3 px-4 py-3 sm:px-6">
            <button
              className="rounded-lg border border-slate-800 p-2 text-slate-300 hover:bg-slate-900 lg:hidden"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open menu"
            >
              <Menu className="h-4 w-4" />
            </button>
            <div className="lg:hidden">
              <Logo />
            </div>
            <div className="ml-auto flex items-center gap-2">
              {markets.length > 0 && (
                <span className="hidden text-[11px] text-slate-500 md:inline">
                  {markets.length} markets
                </span>
              )}
              <span className="hidden sm:inline">
                <ConnectionLine />
              </span>
              <ConnectionBadge />
              <AccountChip />
              <InstallAppButton />
              {showBell && (
              <div className="relative">
                <button
                  aria-label="Signal notifications"
                  onClick={() => {
                    setNotesOpen((o) => !o);
                    if (!notesOpen) markAllAlertsRead();
                  }}
                  className="relative rounded-lg border border-slate-800 p-2 text-slate-300 hover:bg-slate-900"
                >
                  <Bell className="h-4 w-4" />
                  {unread > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-cyan-400 px-1 text-[10px] font-bold text-slate-950">
                      {unread}
                    </span>
                  )}
                </button>
                {notesOpen && (
                  <div className="absolute right-0 z-50 mt-2 max-h-80 w-80 overflow-y-auto rounded-xl border border-slate-800 bg-slate-900 p-2 shadow-2xl">
                    <p className="px-2 py-1 text-[11px] font-bold tracking-widest text-slate-500 uppercase">
                      Signal events (in-app only)
                    </p>
                    {notes.length === 0 ? (
                      <p className="px-2 py-4 text-center text-xs text-slate-500">
                        No alert events yet. The monitor emits here on NEW setups and material changes — never per refresh.
                      </p>
                    ) : (
                      notes.slice(0, 20).map((n) => {
                        const nav = alertCoinNavigation(n);
                        const clickable = nav.path !== null;
                        return (
                          <button
                            key={n.id}
                            disabled={!clickable}
                            onClick={() => {
                              if (!clickable || !nav.path) return;
                              if (!n.read) markAlertRead(n.id);
                              setNotesOpen(false);
                              navigate(nav.path, nav.state ? { state: nav.state } : undefined);
                            }}
                            title={clickable ? `Open ${n.symbol} analysis` : "Alert has no valid market reference"}
                            className={cn(
                              "block w-full rounded-lg px-2 py-1.5 text-left hover:bg-slate-800/60",
                              clickable ? "cursor-pointer" : "cursor-default opacity-60",
                            )}
                          >
                            <p className="text-xs text-slate-200">{eventMessage(n)}</p>
                            <p className="text-[10px] text-slate-500">
                              {n.type.replace(/_/g, " ")} · {n.status} · {new Date(n.timestamp).toLocaleTimeString()}
                            </p>
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
              )}
            </div>
          </div>
        </header>

        {/* Page */}
        <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 pt-6 pb-24 sm:px-6 lg:pb-10">
          <Outlet />
          <footer className="mt-10 border-t border-slate-800/70 pt-4 pb-2 text-[11px] text-slate-600">
            CryptoIn AI Signal · Phase 2 live Hyperliquid data · Educational demo. Not financial
            advice. No real-money trading.
          </footer>
          {isDevDiagnosticsEnabled() && (
            <div className="mt-3">
              <DiagnosticsPanel />
            </div>
          )}
        </main>

        {/* Mobile bottom nav */}
        <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-800 bg-slate-950/95 backdrop-blur lg:hidden" aria-label="Primary">
          <div className="grid grid-cols-6">
            {BOTTOM_NAV.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to + item.label}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    cn(
                      "flex flex-col items-center gap-1 py-2.5 text-[10px] font-semibold",
                      isActive ? "text-cyan-300" : "text-slate-500"
                    )
                  }
                >
                  <Icon className="h-5 w-5" />
                  {item.label}
                </NavLink>
              );
            })}
          </div>
        </nav>
      </div>
    </div>
  );
}
