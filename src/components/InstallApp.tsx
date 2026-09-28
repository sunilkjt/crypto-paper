import { useEffect, useState } from "react";

/** Minimal surface for beforeinstallprompt (Chrome/Edge/Samsung Internet). */
interface DeferredPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * Compact "Install app" chip for the topbar. Renders nothing unless the
 * browser fires beforeinstallprompt (PWA criteria met) and the app isn't
 * already installed / running standalone.
 */
export function InstallAppButton() {
  const [deferred, setDeferred] = useState<DeferredPrompt | null>(null);

  useEffect(() => {
    try {
      if (window.matchMedia("(display-mode: standalone)").matches) return;
      if ((window.navigator as { standalone?: boolean }).standalone) return;
    } catch {
      // ignore — fall through to prompt capture
    }
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as DeferredPrompt);
    };
    const onInstalled = () => setDeferred(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!deferred) return null;
  return (
    <button
      onClick={() => {
        const d = deferred;
        setDeferred(null);
        void d.prompt().catch(() => {});
      }}
      className="rounded-lg border border-cyan-400/40 bg-cyan-400/10 px-2.5 py-1.5 text-[11px] font-bold text-cyan-200 hover:bg-cyan-400/20"
      title="Install CryptoIn as an app on this device"
    >
      Install app
    </button>
  );
}
