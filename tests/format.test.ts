import { describe, expect, it } from 'vitest';
import { fmt, fmtCompact, fmtPct } from '../src/lib/format';
import { numCls, setupCls, setupText } from '../src/lib/ui';

describe('fmt', () => {
  it('невалидные значения → «—»', () => {
    expect(fmt(null)).toBe('—');
    expect(fmt(undefined)).toBe('—');
    expect(fmt(NaN)).toBe('—');
    expect(fmt(Number.POSITIVE_INFINITY)).toBe('—');
    expect(fmt(Number.NEGATIVE_INFINITY)).toBe('—');
  });

  it('числа с заданным числом знаков', () => {
    expect(fmt(1.23456, 2)).toBe('1.23');
    expect(fmt(1.235, 2)).toBe('1.24');
    expect(fmt(1, 2)).toBe('1.00');
    expect(fmt(-0.5, 1)).toBe('-0.5');
  });
});

describe('fmtPct', () => {
  it('невалидные → «—»', () => {
    expect(fmtPct(null)).toBe('—');
    expect(fmtPct(NaN)).toBe('—');
  });

  it('знак «+» для положительных, минус для отрицательных, 0 без знака', () => {
    expect(fmtPct(0.5, 2)).toBe('+0.50%');
    expect(fmtPct(-0.5, 2)).toBe('-0.50%');
    expect(fmtPct(0, 2)).toBe('0.00%');
    expect(fmtPct(0.05, 1)).toBe('+0.1%');
  });
});

describe('fmtCompact', () => {
  it('невалидные → «—»', () => {
    expect(fmtCompact(undefined)).toBe('—');
    expect(fmtCompact(NaN)).toBe('—');
  });

  it('компактная нотация', () => {
    expect(fmtCompact(1234)).toBe('1.23K');
    expect(fmtCompact(1_000_000)).toBe('1M');
    expect(fmtCompact(1_500_000)).toBe('1.5M');
    expect(fmtCompact(-2500)).toBe('-2.5K');
  });
});

describe('ui: numCls', () => {
  it('классы по знаку', () => {
    expect(numCls(1)).toBe('pos');
    expect(numCls(-1)).toBe('neg');
    expect(numCls(0)).toBe('');
    expect(numCls(null)).toBe('');
    expect(numCls(undefined)).toBe('');
  });
});

describe('ui: setupText / setupCls', () => {
  it('подписи направлений', () => {
    expect(setupText('long')).toBe('ЛОНГ');
    expect(setupText('short')).toBe('ШОРТ');
    expect(setupText(null)).toBe('—');
    expect(setupText('wait')).toBe('—');
  });

  it('классы направлений', () => {
    expect(setupCls('long')).toBe('setup-long');
    expect(setupCls('short')).toBe('setup-short');
    expect(setupCls(null)).toBe('setup-wait');
    expect(setupCls('wait')).toBe('setup-wait');
  });
});