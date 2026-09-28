import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { MarketDataProvider } from './market/store.tsx'
import { ScanProvider } from './scanner/ScanContext.tsx'
import { AuthProvider } from './supabase/auth.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* HashRouter: works on static hosts (GitHub Pages) with no server rewrites. */}
    <HashRouter>
      <AuthProvider>
        <MarketDataProvider>
          <ScanProvider>
            <App />
          </ScanProvider>
        </MarketDataProvider>
      </AuthProvider>
    </HashRouter>
  </StrictMode>,
)

// PWA: register the service worker in production builds only (dev stays
// uncached). BASE_URL-aware so it works at "/" and "/crypto-paper/".
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch(() => {
        // Offline shell is a progressive enhancement — app works without it.
      });
  });
}
