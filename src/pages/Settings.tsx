import { useState } from "react";
import { Card, CardHeader, PageHeader } from "../components/ui";
import { ConnectionBadge } from "../components/ConnectionBadge";
import {
  COOLDOWN_OPTIONS,
  DEFAULT_ALERT_SETTINGS,
  loadAlertSettings,
  saveAlertSettings,
  type AlertSettings,
} from "../alerts";
import { BrowserNotificationProvider } from "../alerts/providers";
import { TelegramPanel } from "../components/TelegramPanel";
import { AI_AUTO_MIN_STRENGTH, setAiMode, useAiMode, type AiMode } from "../ai";
import { useScan, REFRESH_OPTIONS } from "../scanner";
import { cn } from "../lib/cn";

function Row({ label, desc, control }: { label: string; desc: string; control: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/70 px-5 py-4 last:border-0">
      <div className="min-w-[200px] flex-1">
        <p className="text-sm font-semibold text-slate-100">{label}</p>
        <p className="mt-0.5 text-xs text-slate-500">{desc}</p>
      </div>
      {control}
    </div>
  );
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className={cn("relative h-6 w-11 shrink-0 rounded-full transition", on ? "bg-cyan-500" : "bg-slate-700")}
    >
      <span className={cn("absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all", on ? "left-[22px]" : "left-0.5")} />
    </button>
  );
}

function AiModeRow() {
  const mode = useAiMode();
  const options: { value: AiMode; label: string; desc: string }[] = [
    { value: "off", label: "Off", desc: "No AI calls anywhere" },
    { value: "manual", label: "Manual", desc: "✨ buttons only (default)" },
    { value: "auto", label: `Auto ≥${AI_AUTO_MIN_STRENGTH}`, desc: "Strong signals explained automatically" },
  ];
  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1" role="group" aria-label="AI explanation mode">
        {options.map((o) => (
          <button
            key={o.value}
            onClick={() => setAiMode(o.value)}
            aria-pressed={mode === o.value}
            title={o.desc}
            className={cn("min-h-[44px] flex-1 rounded-md px-3 py-1.5 text-xs font-bold whitespace-nowrap", mode === o.value ? "bg-slate-800 text-white" : "text-slate-500 hover:text-slate-300")}
          >
            {o.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-slate-500">
        Explanations are cached per signal fingerprint, throttled (10s), max 2 concurrent —
        price ticks never trigger calls. The key lives server-side only.
      </p>
    </div>
  );
}

function Seg<T extends string | number>({ options, value, onPick }: { options: readonly T[]; value: T; onPick: (v: T) => void }) {
  return (
    <div className="flex flex-wrap gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1">
      {options.map((v) => (
        <button
          key={String(v)}
          onClick={() => onPick(v)}
          className={cn("rounded-md px-3 py-1.5 text-xs font-bold", value === v ? "bg-slate-800 text-white" : "text-slate-500 hover:text-slate-300")}
        >
          {String(v)}
        </button>
      ))}
    </div>
  );
}

export default function Settings() {
  const [alerts, setAlerts] = useState<AlertSettings>(() => loadAlertSettings());
  const [browserState, setBrowserState] = useState<string>(() => {
    try {
      return typeof Notification !== "undefined" ? Notification.permission : "unsupported";
    } catch {
      return "unsupported";
    }
  });
  const { refreshMs, setRefreshMs } = useScan();

  const patch = (p: Partial<AlertSettings>) => {
    setAlerts((prev) => {
      const next = { ...prev, ...p };
      saveAlertSettings(next);
      return next;
    });
  };

  const enableBrowser = async () => {
    // Permission is requested ONLY here — never on page load.
    const ok = await new BrowserNotificationProvider().requestPermission();
    try {
      setBrowserState(typeof Notification !== "undefined" ? Notification.permission : "unsupported");
    } catch {
      setBrowserState("unsupported");
    }
    patch({ browserNotifications: ok });
    if (!ok) patch({ browserNotifications: false });
  };

  const toggleDir = (d: "LONG" | "SHORT") => {
    const has = alerts.directions.includes(d);
    const next = has ? alerts.directions.filter((x) => x !== d) : [...alerts.directions, d];
    if (next.length > 0) patch({ directions: next });
  };

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Notifications, alert filters, monitoring, and safeguards. Persisted locally."
        right={<ConnectionBadge showLabel={false} />}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Notifications" subtitle="Browser/sound on explicit enable · delivery never alters signals" />
          <Row
            label="Browser notifications"
            desc={`Permission: ${browserState} — asked only when enabling`}
            control={
              <Toggle
                label="Toggle browser notifications"
                on={alerts.browserNotifications}
                onClick={() => {
                  if (!alerts.browserNotifications) void enableBrowser();
                  else patch({ browserNotifications: false });
                }}
              />
            }
          />
          <Row
            label="Sound alerts"
            desc="Short beep on new alert events"
            control={<Toggle label="Toggle sound alerts" on={alerts.soundAlerts} onClick={() => patch({ soundAlerts: !alerts.soundAlerts })} />}
          />
          <Row
            label="In-app notifications"
            desc="Topbar bell (alert history always stays on the Alerts page)"
            control={<Toggle label="Toggle in-app notifications bell" on={alerts.inAppNotifications} onClick={() => patch({ inAppNotifications: !alerts.inAppNotifications })} />}
          />
          <Row
            label="Telegram"
            desc="Secure edge-function delivery — no token ever lives here"
            control={<Toggle label="Toggle Telegram notifications" on={alerts.telegramNotifications} onClick={() => patch({ telegramNotifications: !alerts.telegramNotifications })} />}
          />
        </Card>

        <Card>
          <CardHeader title="Telegram Pairing" subtitle="One-time link, bound to your cloud account" />
          <TelegramPanel alerts={alerts} />
        </Card>

        <Card>
          <CardHeader title="Alert Filters" subtitle="Gate what the monitor may surface" />
          <Row
            label="Minimum signal strength"
            desc="Events below this never alert"
            control={<Seg options={[60, 70, 80, 90] as const} value={alerts.minStrength} onPick={(v) => patch({ minStrength: v })} />}
          />
          <Row
            label="Directions"
            desc="LONG / SHORT / both"
            control={
              <div className="flex gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1">
                {(["LONG", "SHORT"] as const).map((d) => (
                  <button
                    key={d}
                    onClick={() => toggleDir(d)}
                    className={cn("rounded-md px-3 py-1.5 text-xs font-bold", alerts.directions.includes(d) ? "bg-slate-800 text-white" : "text-slate-500 hover:text-slate-300")}
                  >
                    {d}
                  </button>
                ))}
              </div>
            }
          />
          <Row
            label="Market categories"
            desc="Crypto / stocks / commodities delivery (history always records)"
            control={
              <div className="flex flex-wrap gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1">
                {(["crypto", "stocks", "commodities"] as const).map((c) => {
                  const on = alerts.categories[c];
                  const othersOn = (["crypto", "stocks", "commodities"] as const).some((k) => k !== c && alerts.categories[k]);
                  return (
                    <button
                      key={c}
                      onClick={() => {
                        if (on && !othersOn) return;
                        patch({ categories: { ...alerts.categories, [c]: !on } });
                      }}
                      aria-pressed={on}
                      className={cn("rounded-md px-3 py-1.5 text-xs font-bold", on ? "bg-slate-800 text-white" : "text-slate-500 hover:text-slate-300")}
                    >
                      {c === "crypto" ? "Crypto" : c === "stocks" ? "Stocks" : "Commodities"}
                    </button>
                  );
                })}
              </div>
            }
          />
          <Row
            label="Notification cooldown"
            desc="Suppress repeat facts (delivery only, history unaffected)"
            control={
              <div className="flex flex-wrap gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1">
                {COOLDOWN_OPTIONS.map((o) => (
                  <button
                    key={o.label}
                    onClick={() => patch({ cooldownMs: o.value })}
                    aria-pressed={alerts.cooldownMs === o.value}
                    className={cn("rounded-md px-3 py-1.5 text-xs font-bold", alerts.cooldownMs === o.value ? "bg-slate-800 text-white" : "text-slate-500 hover:text-slate-300")}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            }
          />
          <Row
            label="Setups"
            desc="Bounce / breakout / pullback / reversal / all"
            control={
              <div className="flex flex-wrap gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1">
                {(["ALL", "BOUNCE", "BREAKOUT", "PULLBACK", "REVERSAL"] as const).map((s) => {
                  const on = alerts.setups.includes(s);
                  return (
                    <button
                      key={s}
                      onClick={() => {
                        if (s === "ALL") patch({ setups: ["ALL"] });
                        else {
                          const without = alerts.setups.filter((x) => x !== "ALL" && x !== s);
                          const next = on ? without : [...without, s];
                          patch({ setups: next.length > 0 ? next : (["ALL"] as AlertSettings["setups"]) });
                        }
                      }}
                      className={cn("rounded-md px-3 py-1.5 text-xs font-bold", on ? "bg-slate-800 text-white" : "text-slate-500 hover:text-slate-300")}
                    >
                      {s === "ALL" ? "All" : s.charAt(0) + s.slice(1).toLowerCase()}
                    </button>
                  );
                })}
              </div>
            }
          />
          <Row
            label="Timeframes"
            desc="Setup timeframes eligible for alerts"
            control={
              <div className="flex gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1">
                {(["5m", "15m", "1h", "4h"] as const).map((t) => {
                  const on = alerts.timeframes.includes(t);
                  return (
                    <button
                      key={t}
                      onClick={() => {
                        const next = on ? alerts.timeframes.filter((x) => x !== t) : [...alerts.timeframes, t];
                        if (next.length > 0) patch({ timeframes: next });
                      }}
                      className={cn("rounded-md px-3 py-1.5 text-xs font-bold", on ? "bg-slate-800 text-white" : "text-slate-500 hover:text-slate-300")}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
            }
          />
          <Row
            label="Watchlist-only mode"
            desc="Alert only watched coins (scanner unaffected)"
            control={<Toggle label="Toggle watchlist-only mode" on={alerts.watchlistOnly} onClick={() => patch({ watchlistOnly: !alerts.watchlistOnly })} />}
          />
        </Card>

        <Card>
          <CardHeader title="Monitoring" subtitle="Shared scan cadence (Scanner/Bounce/Dashboard)" />
          <Row
            label="Monitoring interval"
            desc="Default 1 minute · OFF pauses background scans"
            control={
              <div className="flex gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1">
                {REFRESH_OPTIONS.map((o) => (
                  <button
                    key={o.label}
                    onClick={() => setRefreshMs(o.ms)}
                    className={cn("rounded-md px-3 py-1.5 text-xs font-bold", refreshMs === o.ms ? "bg-slate-800 text-white" : "text-slate-500 hover:text-slate-300")}
                  >
                    {o.label === "OFF" ? "OFF" : o.label}
                  </button>
                ))}
              </div>
            }
          />
          <Row
            label="Reset alert preferences"
            desc="Restore defaults (does not touch journal)"
            control={
              <button
                onClick={() => {
                  saveAlertSettings({ ...DEFAULT_ALERT_SETTINGS });
                  setAlerts({ ...DEFAULT_ALERT_SETTINGS });
                }}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-bold text-slate-300 hover:bg-slate-800"
              >
                Reset
              </button>
            }
          />
        </Card>

        <Card>
          <CardHeader title="AI Explanations" subtitle="Gemini/Groq explains signals on demand — the engine always decides" />
          <AiModeRow />
        </Card>

        <Card>
          <CardHeader title="Risk & Trading" subtitle="Simulation-only safeguards" />
          <Row
            label="Real-money trading"
            desc="Permanently absent from this UI — no order APIs exist"
            control={
              <span className="rounded-full border border-rose-400/30 bg-rose-400/10 px-3 py-1 text-[11px] font-bold text-rose-300">
                DISABLED
              </span>
            }
          />
          <Row
            label="Private keys / API keys"
            desc="Never requested, never stored, never needed"
            control={
              <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-[11px] font-bold text-emerald-300">
                NONE HELD
              </span>
            }
          />
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader title="About" subtitle="Build info & scope" />
        <div className="px-5 py-4 text-xs leading-relaxed text-slate-500">
          <p>
            <span className="font-bold text-slate-300">CryptoIn AI Signal · Phase 7 monitoring.</span>{" "}
            Deterministic engine + local alerts on public Hyperliquid data.
          </p>
          <p className="mt-1">
            Educational demo only — not financial advice. No real-money trading, no orders, no private keys.
          </p>
        </div>
      </Card>
    </div>
  );
}
