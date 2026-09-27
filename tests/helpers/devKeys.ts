/**
 * Заглушка виртуального модуля для vitest: в тестах ключей из `.env` нет
 * (dev-сервер не запущен), поэтому значения пустые — см. алиас в vitest.config.ts.
 */
const devKeys = { key: '', secret: '', testnet: false };

export default devKeys;
