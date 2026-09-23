# Bybit Screener

Небольшое FE-приложение: скрининг монет Bybit по волатильности и тренду + страница торгового плана по символу.

## Стек

- Bun, Vite, React 19, TypeScript (strict), React Router (HashRouter), TanStack React Query
- Без UI-фреймворков: стили в `src/index.css`, график стратегии — чистый SVG (`StrategyChart`)
- Данные: публичный API Bybit V5 (без ключа): `tickers` + `kline`

## Команды (bun)

```sh
bun install       # установка зависимостей
bun run dev       # локальный dev-сервер (HMR, CORS-прокси /bybit)
bun run build     # проверка типов (tsc) + прод-сборка в dist/
bun run preview   # предпросмотр сборки
```

## Структура

```
src/
  api/bybit.ts            # Bybit V5: категории, таймфреймы, fetchTickers/fetchKlines, CORS-fallback, bybitTradeUrl
  lib/metrics.ts          # метрики свечей: волатильность, тренд (slope/R²), RSI, streak
  lib/tradePlan.ts        # движок плана: EMA20/50, ATR(14), Donchian-20 → направление/вход/стоп/тейки/риски
  lib/screener.ts         # модель таблицы: Row, buildRows, sortRows, filterByConfidence, COLUMNS
  lib/format.ts           # fmt / fmtPct / fmtCompact
  lib/paper.ts            # бумажные позиции: типы, evaluatePosition, settleOpen, pnlOf
  hooks/usePaper.ts       # позиции в localStorage (add/closeManual/settle/remove + межвкладочный sync)
  hooks/useLivePrices.ts  # живые цены тикеров батчами по категориям
  lib/options.ts          # опции селектов (обновление, уверенность, категории)
  lib/glossary.ts         # русские объяснения терминов для тултипов
  lib/ui.ts               # numCls / setupText / setupCls
  hooks/useMarket.ts      # useTickers + useKlines (батч kline через useQueries)
  hooks/useSessionState.ts  # useState с персистом значений в sessionStorage
  components/Term.tsx     # иконка-термин с кастомным тултипом (fixed, z-index 9999, без title)
  components/TermList.tsx # список с автоподбором иконок по ключевым словам
  components/icons.tsx      # SVG-иконки (External, Plus) — эмодзи не используем
  components/QuickTrade.tsx    # быстрый вход в 1 клик: чипы ставки/плеча, липкая панель над графиком
  components/StrategyChart.tsx  # SVG: свечи + EMA + зона входа + стоп + тейки
  pages/ScreenerPage.tsx  # таблица-ранжирование, фильтры (селекты персистятся в sessionStorage)
  pages/SymbolPage.tsx    # /s/:category/:symbol?interval= — торговый план + расклады по всем таймфреймам + вход в бумажную позицию
  pages/PaperPage.tsx       # /paper — портфель: суммарный P&L, таблица позиций
  pages/PaperDetailPage.tsx # /paper/:id — разбор позиции: уровни, MFE/MAE, лента событий
  components/PaperHeader.tsx # верхняя плашка с общим P&L (клик — в портфель)
  App.tsx                 # HashRouter (выбран ради GitHub Pages: диплинки без 404)
```

## Соглашения

- Весь UI — на русском. Каждый трейдерский термин сопровождается `<Term t="ключ">` (ключ из `glossary.ts`).
- Тултип один — кастомный (`Term.tsx`); нативный `title` не использовать, чтобы не было двойных подсказок.
- Дефолты: таймфрейм 5 мин, фильтр уверенности от 80%.
- Все селекты скринера и параметры страницы символа (интервал, депозит, риск) синхронизируются
  в sessionStorage через `useSessionState` — переживают перезагрузку вкладки.
- План считается локально по 200 свечам (нужен минимум 55). Стоп 1,8×ATR, цели 1R/2R/3R. Для спота только лонг.
- Бумажные позиции живут в localStorage (`paper:positions:v1`). Выход лесенкой: TP1 фиксирует 70%,
  TP2 — ещё 20%, раннер 10% идёт до TP3; после TP1 стоп переносится в безубыток. Стоп, безубыток
  и TP3 закрывают остаток (материализация в PaperPage/Detail). Открытые переоцениваются по живым тикерам.
- Вход — лимитно по середине зоны (`entryMid`), размер из риска (`riskMoney / riskDist`), маржа проверяется
  до открытия. Дубли по символу/направлению, >5 открытых позиций и дневной убыток ниже −150 $ блокируют вход.
- Шортам планка выше (`SHORT_MIN_SCORE = 5`): на бэктесте (`bun scripts/backtest.mjs`, walk-forward по 5m)
  шорты систематически хуже лонгов. Лесенка 70/20/10 даёт ≈+0,21R против −0,25R у схемы «TP3-или-стоп».
- Состояние фильтров скринера локальное (useState), интервал страницы символа — в query (`?interval=`).

## Деплой (GitHub Pages)

Workflow: `.github/workflows/deploy.yml` (bun → build → upload-pages-artifact → deploy-pages).
`vite.config.ts` сам выставляет `base` из `GITHUB_REPOSITORY` (для project site `/repo/`, для user site `/`).

```sh
git add -A; git commit -m "bybit screener"; git push -u origin main
# Settings → Pages → Source: GitHub Actions
```

## Проверки

- `bun run build` — обязательно перед коммитом.
- Живая проверка в браузере через chrome-devtools: клик по строке → страница плана без ошибок в консоли.
- Осторожно с лимитами Bybit: анализ ограничен топ-N по обороту, kline батчами, кеш React Query 30–60 с.
