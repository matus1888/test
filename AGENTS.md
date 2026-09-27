# Bybit Screener

FE-приложение для скрининга Bybit и торговли: ранжирование монет по качеству входа, торговый план по символу,
бумажный портфель с лесенкой, подключение реального API (тестнет/мейннет) и интерфейс реальной торговли.
Всё работает клиентски, без своего сервера (CORS Bybit V5 разрешает приватные запросы).

## Стек

- Bun, Vite, React 19, TypeScript (strict), React Router (HashRouter), TanStack React Query
- Без UI-фреймворков: стили в `src/index.css`, график стратегии — чистый SVG (`StrategyChart`)
- Bybit V5: публично без ключа (`tickers` + `kline`); приватно через HMAC-SHA256 подпись прямо в браузере
  (мейннет/тестнет). Свой сервер не нужен.

## Команды (bun)

```sh
bun install         # установка зависимостей
bun run dev         # локальный dev-сервер (HMR, CORS-прокси /bybit для публичных запросов)
bun run build       # проверка типов (tsc) + прод-сборка в dist/
bun run lint        # oxlint (react + typescript + oxc)
bun run test        # vitest run — юнит-тесты из tests/ (node-окружение)
bun run test:watch  # vitest в watch-режиме
bun run preview     # предпросмотр сборки
bun scripts/backtest.mjs  # walk-forward бэктест стратегии по истории (5m)
```

⚠️ Тесты запускаются именно через `bun run test` (это `vitest run`). Голая команда `bun test`
запускает встроенный runner Bun, под которым vitest-овый `vi` не работает
(`vi.stubGlobal is not a function`) — bybit.test.ts падает.

Ключи Bybit для локальной работы лежат в `.env` (шаблон — `.env.example`, сам `.env` в `.gitignore`):

```sh
cp .env.example .env   # вписать API_KEY и API_SECRET; API_TESTNET=1 — тестнет
bun run dev            # ключи подставляются автоматически (виртуальный модуль), в build — нет
```

## Маршруты

- `/` — скринер-ранжирование по «Приоритету»
- `/s/:category/:symbol?interval=` — торговый план символа (вход, стоп, тейки, расклады по ТФ)
- `/paper` — бумажный портфель (P&L, кнопка «Закрыть по рынку» в таблице)
- `/paper/:id` — разбор позиции: уровни, MFE/MAE, лента событий
- `/real` — портфель реального счёта из API: капитал, маржа, позиции, активные ордера
- `/api` — подключение ключа Bybit (форма, статус, баланс); локально ключи берутся из `.env`
- `/live` — реальная торговля: план → ордер, позиции, активные ордера
- `/account` — личный кабинет: быстрый доступ к разделам, статус портфеля, управление обучением

## Структура

```
src/
  api/bybit.ts            # Bybit V5: категории, таймфреймы, fetchTickers/fetchKlines,
                          #   FIFO-очередь kline (≤10 одновременно), CORS-fallback только в dev, bybitTradeUrl
  api/privateApi.ts       # приватный API: креды в localStorage → .env, HMAC-SHA256 подпись, requestPrivate,
                          #   wallet (с маржой и uP&L)/positions/leverage/placeOrder/cancelOrder/cancelAll,
                          #   позиционный TP/SL, scopeParams (symbol | settleCoin | baseCoin), CREDENTIALS_EVENT
  api/live.ts             # реальный движок: instruments (tick/qtyStep), округление,
                          #   openReal (плечо→вход+SL→лесенка TP1/TP2/TP3), closeReal, moveStopToBreakeven
  lib/metrics.ts          # метрики свечей: волатильность, тренд (slope/R²), RSI, streak
  lib/tradePlan.ts        # движок плана: EMA20/50, ATR(14), Donchian-20 → направление/уровни;
                          #   фильтры качества MIN_TREND_R2/MIN_VOLUME_RATIO/MAX_ATR_PCT; confidence (0..96)
  lib/screener.ts         # модель таблицы: Row, buildRows, priorityOf (приоритет входа), sortRows, filterByConfidence, COLUMNS
  lib/paper.ts            # бумажные позиции: evaluatePosition/settleOpen (+ событие ликвидации), pnlOf/totalPnlOf
                          #   (r, % к ставке и к марже, номинал/маржа), feeOf, liquidationPrice, liqToStopRatio/maxSafeLeverage/LIQ_SAFETY,
                          #   entryBlockReason/makePaperPosition (общий вход), totalEngagedMargin (портфельный лимит)
  hooks/usePaper.ts       # позиции в localStorage (add с проверкой дублей/лимитов, closeManual/settle/remove,
                          #   sync между вкладками и компонентами одной вкладки)
  hooks/useApiAccount.ts  # снимок реального счёта: кошелёк + позиции + активные ордера одним useQuery;
                          #   ключи перечитываются по CREDENTIALS_EVENT, stale 15 с / рефетч 30 с / при фокусе
  env.d.ts                # декларация типа виртуального модуля virtual:bybit-dev-keys (ключи .env)
  hooks/useLivePrices.ts  # живые цены тикеров батчами по категориям
  hooks/useMarket.ts      # useTickers + useKlines (батч kline через useQueries)
  hooks/useSessionState.ts# useState с персистом значений в sessionStorage
  lib/options.ts          # опции селектов (обновление, уверенность, категории)
  lib/glossary.ts         # русские объяснения терминов для тултипов
  lib/ui.ts               # numCls / setupText / setupCls / rowKeyProps (доступность кликабельных строк)
  lib/format.ts           # fmt / fmtPct / fmtCompact
  components/Term.tsx     # иконка-термин с кастомным тултипом (fixed, z-index 9999, без title)
  components/TermList.tsx # список с автоподбором иконок по ключевым словам
  components/icons.tsx    # SVG-иконки (External, Plus) — эмодзи не используем
  components/QuickTrade.tsx   # быстрый бумажный вход: чипы ставки/плеча, липкая панель
  components/StrategyChart.tsx# SVG: свечи + EMA + зона входа + стоп + тейки + LIQ + маркеры
  components/RealAccountView.tsx # портфель по API: карточки капитала/маржи/P&L, таблицы позиций и ордеров
  components/PaperHeader.tsx  # верхняя плашка: реальный счёт из API (если подключён), иначе бумажный P&L;
                             #   ссылки Счёт/Live/API/Кабинет/?
  components/Walkthrough.tsx  # модальный обзор по шагам; авто-показ при первом визите, «?» в хедере — повторно
  lib/guide.ts           # контент шагов walkthrough + флаг guide:seen:v1 (shouldAutoOpen/markSeen)
  pages/ScreenerPage.tsx  # таблица-ранжирование, фильтры, кнопка «Вход» (быстрый вход) в строке сетапа
  pages/SymbolPage.tsx    # торговый план + расклады по ТФ + вход в бумажную позицию
  pages/PaperPage.tsx     # бумажный портфель: P&L, «занято из депозита», таблица с колонкой
                          #   «Из депозита в сделке», «Закрыть по рынку»
  pages/PaperDetailPage.tsx# разбор позиции: уровни, MFE/MAE, лента событий
  pages/RealPortfolioPage.tsx # /real: заголовок, переключатель Реальный/Бумажный, кнопка «Обновить»
  pages/AccountPage.tsx   # личный кабинет: дашборд-ссылки, статусы бумажного и реального счёта, обучение
  pages/ApiPage.tsx       # подключение API: форма ключей (предзаполнена из .env), статус, баланс, позиции
  pages/LivePage.tsx      # реальная торговля: план→ордер, позиции, активные ордера
  App.tsx                 # HashRouter (GitHub Pages: диплинки без 404)
scripts/backtest.mjs      # walk-forward бэктест: сигналы по 5m → бумажный движок → статистика
tests/
  helpers/candles.ts      # генераторы рядов свечей (up/down/flat/random)
  format.test.ts          # fmt / fmtPct / fmtCompact + ui-хелперы
  metrics.test.ts         # computeMetrics: инварианты, тренд/R², RSI, streak, ATR, score
  paper.test.ts           # evaluatePosition, settleOpen, pnlOf/margin, лимиты, лесенка, вход
  screener.test.ts        # buildRows / sortRows / priorityOf / filterByConfidence / COLUMNS
  tradePlan.test.ts       # buildTradePlan, htfRisk, фильтры качества, инварианты, горизонты
  bybit.test.ts           # fetchKlines/fetchTickers (mock fetch), bybitTradeUrl, валидаторы
  privateApi.test.ts      # HMAC-подпись (сверка с node:crypto), buildQuery, ошибки API, wallet parsing,
                          #   parseDevCredentials, scopeParams (order/realtime и cancel-all без symbol)
  live.test.ts            # округление qty/tick, openReal (плечо→вход+SL→лесенка TP)
  walkthrough.test.ts     # шаги обзора: уникальные заголовки, маршруты страниц
  helpers/devKeys.ts      # заглушка virtual:bybit-dev-keys для vitest (алиас в vitest.config.ts)
vitest.config.ts          # vitest run: node-окружение, include tests/**/*.test.ts, алиас virtual:bybit-dev-keys
.env.example              # шаблон локальных ключей (API_KEY/API_SECRET/API_TESTNET)
.oxlintrc.json            # oxlint: плагины react/typescript/oxc, правила хуков
```

## Соглашения

- Весь UI — на русском. Каждый трейдерский термин сопровождается `<Term t="ключ">` (ключ из `glossary.ts`).
- Тултип один — кастомный (`Term.tsx`); нативный `title` не использовать, чтобы не было двойных подсказок.
- Дефолты: таймфрейм 5 мин, фильтр уверенности от 80%.
- Селекты скринера и параметры входа (интервал, депозит, риск) — sessionStorage через `useSessionState`;
  их же читает быстрый вход и страница символа.
- План считается локально по 200 свечам (нужен минимум 55). Стоп 1,8×ATR, цели 1R/2R/3R, вход лимитно по
  середине зоны (`entryMid`), размер из риска (`riskMoney / riskDist`). Для спота только лонг.
- Фильтры качества — жёсткие ворота направленного сетапа: `MIN_TREND_R2 = 0.5`, `MIN_VOLUME_RATIO = 0.9`,
  `MAX_ATR_PCT = 7`. Перегрев RSI (rsiFar) и растянутость серии — штрафы в confidence (не вето, чтобы
  не выбивать сильные тренды). Confidence непрерывная: очки сетапа × (R²/наклон/объём), диапазон 8..96.
- Шортам планка выше (`SHORT_MIN_SCORE = 5`, лонги — от `LONG_MIN_SCORE = 4`): на бэктесте шорты хуже.
- Скринер по умолчанию сортируется по «Приоритету» (`priorityOf`): уверенность + чистота/сила тренда +
  участие объёма минус штрафы (перегрев RSI, растянутая серия, слабый объём, шорты).
- Ставка (`paper:stake`) — потолок суммарной маржи, а не деньги одной позиции. Деньги депозита в
  сделке = маржа = номинал/плечо; это показывают колонка «Из депозита в сделке» в `/paper`, карточка
  «Занято из депозита» + «Торговый номинал», и первая цифра в панели быстрого входа.
  «Ставка 1000 $ × плечо 20» в интерфейсе — это лимит и множитель, а не 20 000 $ в сделке.
- Бумажные позиции живут в localStorage (`paper:positions:v1`). Выход лесенкой: TP1 фиксирует 70%,
  TP2 — ещё 20%, раннер 10% идёт до TP3; после TP1 стоп переносится в безубыток. Стоп, безубыток
  и TP3 закрывают остаток (материализация в PaperPage/Detail). Открытые переоцениваются по живым тикерам.
- Вход блокируют: дубли по символу/направлению, дневной убыток ниже −150 $, недостаток ставки под маржу,
  опасное плечо (`LIQ_SAFETY = 0.7`: стоп занимает ≤70% пути до ликвидации, подсказка `maxSafeLeverage`),
  и портфельный лимит — суммарная маржа открытых (`totalEngagedMargin`) не превышает депозит.
  Лимита на количество открытых позиций нет (`maxOpen = Infinity`).
- P&L в $ = движение цены × количество и НЕ зависит от плеча; % показан к ставке и к марже (номинал/плечо) —
  маржинальный % отражает реальную доходность при плече (см. `positionMetrics` и поля `Pnl`).
- Единая логика входа — `entryBlockReason`/`makePaperPosition` (страница символа, кнопки «Вход» в таблицах,
  реальный `/live`). Кнопки «Вход»/«Закрыть по рынку» не открывают страницу разбора (stopPropagation).
- Старшие таймфреймы против позиции — мягкий сигнал (`htfRisk`, ≥2 из {60,120,240}), не ворота.
- ✅ Блокировка `/api` и `/live` снята по решению владельца (региональные заглушки `BlockedFeature.tsx`
  удалены, в `STEPS` 7 шагов, в шапке и кабинете есть ссылки). Побочный эффект: на опубликованном
  GitHub Pages форма ключей и кнопки реальной торговли видны всем; ключи остаются в localStorage
  посетителя, чужих ключей приложение не видит.
- Реальный API: креды в localStorage (`bybit:api:credentials:v1`), при локальной работе — из `.env`;
  подпись HMAC-SHA256 клиентски (Web Crypto), CORS Bybit V5 разрешает приватные запросы — сервер не нужен.
  `openReal` = установка плеча → лимитный вход со столом (SL, trigger MarkPrice) → reduce-only лимитки
  TP1/TP2/TP3 (PostOnly). Закрытие — отмена ордеров + маркет reduceOnly (`qty: 0` + `closeOnTrigger`).
  Стоп в безубыток — `/v5/position/trading-stop`.
- Ключи из `.env` подхватывает **только dev-сервер** (плагин `devBybitKeys` в `vite.config.ts` отдаёт
  виртуальный модуль `virtual:bybit-dev-keys`; тип — в `src/env.d.ts`, заглушка для vitest — в
  `tests/helpers/devKeys.ts`). В `bun run build` значения пустые, секреты в `dist/` не попадают.
  ⚠️ `define` в Vite 8 не подставляется в клиентские модули при `serve` — виртуальный модуль обязателен.
- «Широкие» приватные запросы (`order/realtime`, `order/cancel-all`) без `symbol` обязаны шлют
  `settleCoin` (для spot — `baseCoin`), иначе биржа отвечает `10001`. Единая точка — `scopeParams`.
- Смена ключей (`saveCredentials`/`clearCredentials`) шлёт `CREDENTIALS_EVENT`: шапка, `/api`, `/real`,
  `/account` перечитывают ключи и сразу переходят на реальный счёт.
- Когда API подключён, портфель берётся из счёта: шапка и `/real` показывают equity, uP&L, позиции и
  занятую маржу Bybit (`/real` → `RealAccountView`), бумажный портфель остаётся на `/paper` и в кабинете.
  Ошибка запроса не молчаливка: показывается текст биржи + ссылка на `/api`.
- Проверка реального API: сценарий и журнал retCode — в `SESSION-MAINNET.md` (локальный файл, в
  репозиторий не коммитится; правила безопасности продублированы здесь). Ключевое: проверка без
  внесения денег (баланс 0 ⇒ биржа отклоняет вход `110007`), секреты не печатать, плечо после
  `set-leverage` возвращать к дефолту, коммит только по явной просьбе.
- Тестнет-first: страницы `/api`/`/live` поддерживают мейннет/тестнет из кредов; на мейннете торговые действия
  требуют подтверждения «реальные деньги». Для мейннета — ключ без права вывода + IP-allowlist.
  Движок /live работает, пока вкладка открыта.
- Telegram-бот (Go) и роут `/bot` удалены: в этом регионе бот не работал, чинить и проверять негде.
  Не resurrect'ить без рабочего Telegram-эндпоинта.
- Поведение движков закреплено тестами в `tests/`: при изменении правил (пороги, лесенка, лимиты, ордера)
  тесты обновляются вместе с логикой.

## Деплой (GitHub Pages)

Workflow: `.github/workflows/deploy.yml` (bun → build → upload-pages-artifact → deploy-pages).
`vite.config.ts` сам выставляет `base` из `GITHUB_REPOSITORY` (project site `/repo/`, user site `/`).

```sh
git add -A; git commit -m "bybit screener"; git push -u origin main
# Settings → Pages → Source: GitHub Actions
```

## Проверки

- `bun run build` — обязательно перед коммитом.
- `bun run test` (не `bun test`!) и `bun run lint` — перед коммитом. Тесты не зависят от сети
  (fetch мокается; приватные подписи сверяются с node:crypto).
- Живая проверка в браузере через chrome-devtools: скринер → клик по строке → страница плана без ошибок
  в консоли; при подключённом API — `/api`, `/real`, `/live` (счёт, маржа, позиции, ордера).
  После долгого набора HMR-правок, если браузер держит старый модуль, — перезапустить dev-сервер.
  Предупреждение React Query «Duplicate Queries found» на `/paper` — от дублей ключей kline при
  нескольких позициях по одному символу/ТФ, не ошибка.
- Перед коммитом проверить, что секреты не утёкли в сборку: собрать и сравнить значения `.env`
  с `dist/assets/*`; `git check-ignore -v .env` должен показывать правило из `.gitignore`.
- Осторожно с лимитами Bybit: kline-запросы — FIFO-очередь (≤10 одновременно), CORS-fallback `/bybit`
  только в dev; кеш React Query: тикеры stale 15 с / рефетч 60 с, kline stale 30 с / рефетч 120 с.
- Кликабельные строки таблиц доступны с клавиатуры (Enter/Space) — через `rowKeyProps`.