import { describe, expect, it } from 'vitest';
import { STEPS, WALKTHROUGH_KEY, markSeen, shouldAutoOpen } from '../src/lib/guide';

describe('walkthrough', () => {
  it('steps: содержательные и с уникальными заголовками', () => {
    // 7 шагов: скринер, фильтры, план символа, вход, портфель, подключение API, реальная торговля.
    expect(STEPS.length).toBeGreaterThanOrEqual(7);
    const titles = STEPS.map((s) => s.title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const s of STEPS) {
      expect(s.text.length).toBeGreaterThan(60);
    }
  });

  it('маршруты шагов ведут на существующие страницы', () => {
    const routes = STEPS.map((s) => s.route).filter((r): r is string => r != null);
    expect(new Set(routes)).toEqual(new Set(['/', '/paper', '/api', '/live']));
  });

  it('shouldAutoOpen: без сохранённого флага — да, markSeen безопасен', () => {
    expect(shouldAutoOpen()).toBe(true);
    expect(() => markSeen()).not.toThrow();
    expect(WALKTHROUGH_KEY.length).toBeGreaterThan(0);
  });
});