import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Виртуальный модуль с ключами .env живёт только в dev-сервере; в тестах — пустая заглушка.
  resolve: {
    alias: {
      'virtual:bybit-dev-keys': fileURLToPath(new URL('./tests/helpers/devKeys.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
