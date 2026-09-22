import { HashRouter, Route, Routes } from 'react-router-dom';
import ScreenerPage from './pages/ScreenerPage';
import SymbolPage from './pages/SymbolPage';
import PaperPage from './pages/PaperPage';
import PaperDetailPage from './pages/PaperDetailPage';
import PaperHeader from './components/PaperHeader';

export default function App() {
  return (
    <HashRouter>
      <PaperHeader />
      <Routes>
        <Route path="/" element={<ScreenerPage />} />
        <Route path="/s/:category/:symbol" element={<SymbolPage />} />
        <Route path="/paper" element={<PaperPage />} />
        <Route path="/paper/:id" element={<PaperDetailPage />} />
        <Route path="*" element={<ScreenerPage />} />
      </Routes>
    </HashRouter>
  );
}
