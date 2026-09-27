/**
 * Тип виртуального модуля `virtual:bybit-dev-keys` — ключи Bybit из `.env`,
 * которые отдаёт локальный dev-сервер (плагин `devBybitKeys` в `vite.config.ts`).
 * В прод-сборке модуль содержит пустые значения, поэтому секретов в `dist/` нет.
 */
declare module 'virtual:bybit-dev-keys' {
  const devKeys: { key: string; secret: string; testnet: boolean };
  export default devKeys;
}
