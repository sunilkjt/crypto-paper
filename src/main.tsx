import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { MarketDataProvider } from './market/store.tsx'
import { ScanProvider } from './scanner/ScanContext.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* HashRouter: works on static hosts (GitHub Pages) with no server rewrites. */}
    <HashRouter>
      <MarketDataProvider>
        <ScanProvider>
          <App />
        </ScanProvider>
      </MarketDataProvider>
    </HashRouter>
  </StrictMode>,
)
