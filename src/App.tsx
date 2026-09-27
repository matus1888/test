import { useEffect, useState } from 'react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import ScreenerPage from './pages/ScreenerPage';
import SymbolPage from './pages/SymbolPage';
import PaperPage from './pages/PaperPage';
import PaperDetailPage from './pages/PaperDetailPage';
import AccountPage from './pages/AccountPage';
import PaperHeader from './components/PaperHeader';
import Walkthrough from './components/Walkthrough';
import BlockedFeature from './components/BlockedFeature';
import { shouldAutoOpen } from './lib/guide';

// /api, /live, /bot отключены из-за региональных ограничений: ключи тестнета не выдаются,
// мейннет не проверен, Telegram-бот не работает. Страницы ApiPage/LivePage/BotPage и модули
// api/privateApi.ts, api/live.ts остались в репозитории — вернуть их в роуты достаточно снять
// блокировку (заглушка — components/BlockedFeature.tsx).

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
        <Route path="/api" element={<BlockedFeature kind="api" />} />
        <Route path="/live" element={<BlockedFeature kind="live" />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="/bot" element={<BlockedFeature kind="bot" />} />
        <Route path="*" element={<ScreenerPage />} />
      </Routes>
      <Walkthrough key={tourOpen ? 'on' : 'off'} open={tourOpen} onClose={() => setTourOpen(false)} />
    </HashRouter>
  );
}
