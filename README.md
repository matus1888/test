# Скринер Bybit

Скрининг монет Bybit по волатильности и тренду + торговые планы с уровнями входа/стопа/тейков + бумажный портфель.

- Данные: публичный API Bybit V5 (без ключа)
- Стек: Bun, Vite, React 19, TypeScript, React Router, TanStack Query
- Интерфейс на русском, тултипы-подсказки к терминам

```sh
bun install
bun run dev      # локально
bun run build    # сборка в dist/
```

Деплой: GitHub Pages через Actions (`.github/workflows/deploy.yml`). После пуша включи
Settings → Pages → Source: GitHub Actions.
