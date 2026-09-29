import { useTelegramConnection } from "../supabase/telegram";
import type { AlertSettings } from "../alerts";
import { cn } from "../lib/cn";

/**
 * Telegram pairing + test UI for Settings → Notifications. The bot token
 * never appears here: pairing runs through one-time server tokens, delivery
 * through the authenticated edge endpoint.
 */
export function TelegramPanel({ alerts }: { alerts: AlertSettings }) {
  const { state, busy, connect, disconnect, sendTest } = useTelegramConnection();

  if (state.phase === "signed-out") {
    return (
      <p className="px-5 py-4 text-xs leading-relaxed text-slate-500">
        Log in to Paper Trading first — Telegram pairing is bound to your cloud account.
      </p>
    );
  }

  if (state.phase === "loading") {
    return <p className="px-5 py-4 text-xs text-slate-500">Checking Telegram connection…</p>;
  }

  if (state.phase === "error") {
    return (
      <div className="space-y-2 px-5 py-4">
        <p className="text-xs font-semibold text-amber-300">Telegram status unavailable: {state.message}</p>
        <p className="text-[11px] leading-relaxed text-slate-600">
          The edge functions may not be deployed yet — pairing, testing and delivery all need them.
        </p>
      </div>
    );
  }

  const { status } = state;

  const onConnect = async () => {
    const out = await connect();
    if (out) {
      try {
        window.open(out.deepLink, "_blank", "noopener");
      } catch {
        // popup blocked — the deep link is one-time; user can retry
      }
    }
  };

  const onTest = () =>
    void sendTest({
      crypto: alerts.categories.crypto,
      stocks: alerts.categories.stocks,
      commodities: alerts.categories.commodities,
    });

  return (
    <div className="space-y-2.5 p-5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-bold",
            status.connected
              ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
              : "border-slate-700 text-slate-400",
          )}
        >
          <span aria-hidden="true">{status.connected ? "●" : "○"}</span>
          {status.connected ? `Connected${status.username ? ` @${status.username}` : ""}` : "Not connected"}
        </span>
        {!status.botConfigured && (
          <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 text-[11px] font-bold text-amber-300">
            ⚠ Bot not configured on server
          </span>
        )}
      </div>

      {!status.connected ? (
        <div>
          <button
            onClick={() => void onConnect()}
            disabled={busy || !status.botConfigured}
            className="min-h-[44px] rounded-xl bg-cyan-500 px-4 text-xs font-bold text-slate-950 hover:bg-cyan-400 disabled:opacity-40"
          >
            {busy ? "Creating link…" : "Connect Telegram"}
          </button>
          <p className="mt-1.5 text-[11px] leading-relaxed text-slate-600">
            Opens the bot with a one-time link (15 min). Press Start in Telegram — no tokens or chat IDs to copy.
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={onTest}
            disabled={busy}
            className="min-h-[44px] rounded-xl border border-slate-700 px-4 text-xs font-bold text-slate-200 hover:bg-slate-800 disabled:opacity-40"
          >
            {busy ? "Sending…" : "Send Test Telegram"}
          </button>
          <button
            onClick={() => void disconnect()}
            disabled={busy}
            className="min-h-[44px] rounded-xl border border-rose-400/40 px-4 text-xs font-bold text-rose-300 disabled:opacity-40"
          >
            Disconnect
          </button>
        </div>
      )}
      <p className="text-[11px] leading-relaxed text-slate-600">
        Delivery honors the shared gate below (categories, LONG/SHORT, minimum score, cooldown). History always records.
      </p>
    </div>
  );
}
