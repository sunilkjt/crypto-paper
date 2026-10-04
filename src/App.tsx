import { Suspense, lazy } from "react";
import { Link, Route, Routes, Navigate } from "react-router-dom";
import AppLayout from "./components/layout/AppLayout";
import Dashboard from "./pages/Dashboard";
import Scanner from "./pages/Scanner";

// Code-split: the Markets scanner (HIP-3 equities/commodities) loads only
// when the user visits #/markets — never on initial boot.
const Markets = lazy(() => import("./pages/Markets"));
import CoinAnalysis from "./pages/CoinAnalysis";
import BestBounce from "./pages/BestBounce";
import Alerts from "./pages/Alerts";
import Watchlist from "./pages/Watchlist";
import History from "./pages/History";
import Backtest from "./pages/Backtest";
import Performance from "./pages/Performance";
import PaperTrading from "./pages/PaperTrading";
import Settings from "./pages/Settings";

function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <p className="text-sm font-bold tracking-widest text-slate-500 uppercase">404</p>
      <h1 className="mt-2 text-2xl font-bold text-white">Page not found</h1>
      <p className="mt-1 text-sm text-slate-400">
        This route is not part of the Phase 1 foundation.
      </p>
      <Link to="/" className="mt-4 rounded-xl bg-cyan-500 px-4 py-2 text-sm font-bold text-slate-950 hover:bg-cyan-400">
        Back to Dashboard
      </Link>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="scanner" element={<Scanner />} />
        <Route
          path="markets"
          element={
            <Suspense
              fallback={
                <div role="status" aria-label="Loading markets page" className="py-10 text-center text-sm text-slate-400">
                  Loading markets…
                </div>
              }
            >
              <Markets />
            </Suspense>
          }
        />
        <Route path="coin" element={<Navigate to="/coin/OP" replace />} />
        <Route path="coin/:symbol" element={<CoinAnalysis />} />
        <Route path="bounce" element={<BestBounce />} />
        <Route path="alerts" element={<Alerts />} />
        <Route path="watchlist" element={<Watchlist />} />
        <Route path="history" element={<History />} />
        <Route path="backtest" element={<Backtest />} />
        <Route path="performance" element={<Performance />} />
        <Route path="paper" element={<PaperTrading />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
