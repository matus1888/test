import { describe, expect, it } from 'vitest';
import {
  candleKey,
  describeRefresh,
  effectiveCycleMs,
  INTERVAL_MS,
  msToNextCandle,
  perCycleFor,
  planRefresh,
  REFRESH_BUDGET,
  sweepCycles,
} from '../src/lib/klinePlan';

describe('INTERVAL_MS', () => {
  it('таймфреймы упорядочены по длительности и совпадают с подписями', () => {
    expect(INTERVAL_MS['1']).toBe(60_000);
    expect(INTERVAL_MS['5']).toBe(300_000);
    expect(INTERVAL_MS['60']).toBe(3_600_000);
    expect(INTERVAL_MS.D).toBe(86_400_000);
    expect(INTERVAL_MS['60'] / INTERVAL_MS['15']).toBe(4);
    expect(INTERVAL_MS['120'] / INTERVAL_MS['240']).toBeCloseTo(0.5, 6);
  });
});

describe('msToNextCandle', () => {
  it('ждём остаток текущей свечи плюс запас на выгрузку биржи', () => {
    // 5 мин: 90 000 мс прошло, осталось 210 000 + 400 запас.
    const now = 90_000;
    expect(msToNextCandle('5', now)).toBe(INTERVAL_MS['5'] - now + 400);
  });

  it('ровно на границе свечи ждём целый интервал', () => {
    expect(msToNextCandle('1', 300_000)).toBe(60_400);
  });
});

describe('effectiveCycleMs', () => {
  it('выключенный авторефреш остаётся выключенным', () => {
    expect(effectiveCycleMs('5', false)).toBe(false);
  });

  it('на 5 мин цикл не короче 75 с: чаще свеча не меняется', () => {
    expect(effectiveCycleMs('5', 15_000)).toBe(75_000);
    expect(effectiveCycleMs('5', 30_000)).toBe(75_000);
  });

  it('просьба пользователя длиннее минимума сохраняется', () => {
    expect(effectiveCycleMs('5', 120_000)).toBe(120_000);
  });

  it('на 1 мин минимум 15 с', () => {
    expect(effectiveCycleMs('1', 5_000)).toBe(15_000);
    expect(effectiveCycleMs('1', 60_000)).toBe(60_000);
  });

  it('цикл не короче 75 с на 5 мин и старше: защита от 429', () => {
    // На часовых и суточных остаётся тот же предохранитель 75 с — он ограничивает
    // частоту запросов, а не привязан к закрытию свечи.
    expect(effectiveCycleMs('60', 60_000)).toBe(75_000);
    expect(effectiveCycleMs('D', 15_000)).toBe(75_000);
  });

  it('цикл всегда не меньше четверти свечи и не меньше 15 с', () => {
    for (const [iv, ms] of Object.entries(INTERVAL_MS)) {
      const cycle = effectiveCycleMs(iv as keyof typeof INTERVAL_MS, 1);
      expect(cycle).toBeGreaterThanOrEqual(Math.min(ms / 4, 75_000));
      expect(cycle).toBeGreaterThanOrEqual(15_000);
    }
  });
});

describe('perCycleFor', () => {
  it('пустая выборка — ноль запросов', () => {
    expect(perCycleFor(0, 75_000)).toBe(0);
  });

  it('делим выборку на 12 обходов, считая повторы «горячих»', () => {
    // 89 символов: 6 горячих + ceil(83/12) = 7 холодных ⇒ 13 за цикл, обход ~15 мин.
    expect(perCycleFor(89, 75_000)).toBe(13);
    // 200 символов: 6 + 17 = 23, но потолок в минуту (18 при 75 с) режет сильнее.
    expect(perCycleFor(200, 75_000)).toBe(18);
    expect(perCycleFor(50, 75_000)).toBe(10);
  });

  it('короткий цикл ограничен потолком запросов в минуту', () => {
    // 15 с при 200 символах: без ограничения было бы 13 запросов каждые 15 с = 52/мин.
    expect(perCycleFor(200, 15_000)).toBe(3);
  });

  it('потолок за цикл не даёт упереться в 429 даже на длинном цикле', () => {
    const v = perCycleFor(1000, 300_000);
    expect(v).toBeLessThanOrEqual(REFRESH_BUDGET.maxPerCycle);
  });

  it('на маленькой выборке обновляем всё — это и дёшево, и полезно', () => {
    expect(perCycleFor(3, 75_000)).toBe(3);
    expect(perCycleFor(1, 75_000)).toBe(1);
    expect(perCycleFor(6, 75_000)).toBe(6);
  });

  it('бюджет всегда не больше выборки и не меньше единицы', () => {
    for (const n of [1, 2, 7, 25, 50, 89, 200, 784]) {
      for (const cycleMs of [15_000, 60_000, 75_000, 300_000]) {
        const v = perCycleFor(n, cycleMs);
        expect(v).toBeGreaterThanOrEqual(1);
        expect(v).toBeLessThanOrEqual(n);
      }
    }
  });

  it('переопределение бюджета уважается', () => {
    // sweeps: 4 ⇒ 6 + ceil(94/4) = 30 за цикл, если не режут потолки.
    expect(perCycleFor(100, 75_000, { sweeps: 4, maxPerMinute: 120, maxPerCycle: 40 })).toBe(30);
    expect(perCycleFor(100, 75_000, { maxPerCycle: 3 })).toBe(3);
    expect(perCycleFor(100, 75_000, { maxPerMinute: 2 })).toBe(2);
  });
});

describe('planRefresh', () => {
  it('пустая выборка — пустой план', () => {
    expect(planRefresh(0, 0, { perCycle: 5 })).toEqual([]);
  });

  it('бюджет не меньше выборки — обновляем всё', () => {
    expect(planRefresh(4, 3, { perCycle: 4 })).toEqual([0, 1, 2, 3]);
    expect(planRefresh(4, 3, { perCycle: 9 })).toEqual([0, 1, 2, 3]);
  });

  it('без бюджета — тоже вся выборка', () => {
    expect(planRefresh(3, 0, { perCycle: 0 })).toEqual([0, 1, 2]);
  });

  it('в каждом цикле ровно perCycle символов, без повторов', () => {
    for (let cycle = 0; cycle < 40; cycle += 1) {
      const plan = planRefresh(89, cycle, { perCycle: 8 });
      expect(plan).toHaveLength(8);
      expect(new Set(plan).size).toBe(8);
      expect([...plan].sort((a, b) => a - b)).toEqual(plan);
    }
  });

  it('горячие символы (первые по обороту) обновляются каждый цикл', () => {
    for (let cycle = 0; cycle < 12; cycle += 1) {
      const plan = planRefresh(89, cycle, { perCycle: 8 });
      for (const hot of [0, 1, 2, 3, 4, 5]) expect(plan).toContain(hot);
    }
  });

  it('за 12 циклов проходим всю выборку целиком', () => {
    const perCycle = perCycleFor(89, 75_000);
    const seen = new Set<number>();
    for (let cycle = 0; cycle < REFRESH_BUDGET.sweeps; cycle += 1) {
      for (const i of planRefresh(89, cycle, { perCycle })) seen.add(i);
    }
    expect(seen.size).toBe(89);
  });

  it('обход ровно в sweeps циклов, если потолки не мешают', () => {
    for (const total of [20, 50, 89, 200]) {
      const perCycle = perCycleFor(total, 75_000, { maxPerMinute: 120, maxPerCycle: 60 });
      expect(sweepCycles(total, perCycle)).toBeLessThanOrEqual(REFRESH_BUDGET.sweeps);
    }
  });

  it('потолок запросов в минуту честно удлиняет обход (об этом говорит подпись)', () => {
    // 200 символов на 75 с: нужно 23 за цикл для обхода за 12 циклов, но потолок
    // в минуту (18) режет — обход растягивается до 17 циклов, и UI это показывает.
    const perCycle = perCycleFor(200, 75_000);
    expect(perCycle).toBe(18);
    expect(sweepCycles(200, perCycle)).toBe(17);
    expect(describeRefresh(200, perCycle, 75_000)).toContain('полный обход ~21 мин');
  });

  it('чётный шаг не съедает половину выборки (взаимно простой сдвиг)', () => {
    // Наивный шаг 2 по кругу длины 10 обновлял бы только чётные индексы.
    const seen = new Set<number>();
    for (let cycle = 0; cycle < 10; cycle += 1) {
      for (const i of planRefresh(10, cycle, { perCycle: 4, hot: 2 })) seen.add(i);
    }
    expect(seen.size).toBe(10);
  });

  it('горячие символы не съедают весь бюджет', () => {
    // Бюджет 3, а «горячих» по умолчанию 6 — в план попадают только 3.
    const plan = planRefresh(50, 0, { perCycle: 3 });
    expect(plan).toEqual([0, 1, 2]);
  });

  it('на выборке меньше бюджета — один проход', () => {
    expect(planRefresh(2, 5, { perCycle: 5 })).toEqual([0, 1]);
  });

  it('выборка из одного символа не ломает очередь', () => {
    expect(planRefresh(1, 7, { perCycle: 1 })).toEqual([0]);
  });
});

describe('describeRefresh', () => {
  it('пустая выборка — пустая строка', () => {
    expect(describeRefresh(0, 5, 75_000)).toBe('');
  });

  it('показывает бюджет, цикл и время полного обхода', () => {
    // 89 символов: 13 за цикл = 6 горячих + 7 холодных ⇒ 12 циклов по 75 с ≈ 15 мин.
    expect(describeRefresh(89, 13, 75_000)).toBe('13 из 89 за цикл · цикл 75 с · полный обход ~15 мин');
  });

  it('когда всё влезает в цикл — обход один', () => {
    expect(describeRefresh(10, 10, 60_000)).toContain('полный обход ~1 мин');
  });
});

describe('candleKey', () => {
  it('одинаковые символ с одним ТФ дают один ключ, разные — разные', () => {
    expect(candleKey('linear', 'BTCUSDT', '5')).toBe(candleKey('linear', 'BTCUSDT', '5'));
    expect(candleKey('linear', 'BTCUSDT', '5')).not.toBe(candleKey('linear', 'BTCUSDT', '15'));
    expect(candleKey('linear', 'BTCUSDT', '5')).not.toBe(candleKey('inverse', 'BTCUSDT', '5'));
  });
});
