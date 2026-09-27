import { useEffect, useState } from 'react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import ScreenerPage from './pages/ScreenerPage';
import SymbolPage from './pages/SymbolPage';
import PaperPage from './pages/PaperPage';
import PaperDetailPage from './pages/PaperDetailPage';
import ApiPage from './pages/ApiPage';
import LivePage from './pages/LivePage';
import AccountPage from './pages/AccountPage';
import RealPortfolioPage from './pages/RealPortfolioPage';
import PaperHeader from './components/PaperHeader';
import Walkthrough from './components/Walkthrough';
import { shouldAutoOpen } from './lib/guide';

// /api и /live открыты: блокировка из-за региональных ограничений снята по решению владельца.
// Ключи для локальной работы подхватываются из .env (см. vite.config.ts, devBybitKeys) —
// ввод руками на /api остаётся рабочим запасным вариантом. Сценарий проверки:
// SESSION-MAINNET.md (локальный файл, в репозиторий не коммитится) + раздел в AGENTS.md.

export default function App() {
  const [tourOpen, setTourOpen] = useState(() => shouldAutoOpen());

  useEffect(() => {
    const open = () => setTourOpen(true);
    window.addEventListener('open-walkthrough', open);
    return () => window.removeEventListener('open-walkthrough', open);
  }, []);

  return (
    <HashRouter>
      <PaperHeader />
      <Routes>
        <Route path="/" element={<ScreenerPage />} />
        <Route path="/s/:category/:symbol" element={<SymbolPage />} />
        <Route path="/paper" element={<PaperPage />} />
        <Route path="/paper/:id" element={<PaperDetailPage />} />
        <Route path="/real" element={<RealPortfolioPage />} />
        <Route path="/api" element={<ApiPage />} />
        <Route path="/live" element={<LivePage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="*" element={<ScreenerPage />} />
      </Routes>
      <Walkthrough key={tourOpen ? 'on' : 'off'} open={tourOpen} onClose={() => setTourOpen(false)} />
    </HashRouter>
  );
}
