import Term from './Term';

// Подбор иконок-подсказок к пунктам списков по ключевым словам
const TERM_KEYS: [string, RegExp][] = [
  ['atr', /ATR/],
  ['rsi', /RSI/],
  ['r2', /R²/],
  ['ema', /EMA/],
  ['funding', /фандинг/i],
  ['volumeRatio', /объём/i],
  ['stop', /стоп/i],
  ['risk', /риск/i],
  ['breakeven', /безубыт/i],
  ['streak', /сери|подряд/i],
  ['range20', /20 свечей/],
];

export function iconsFor(text: string): string[] {
  const out: string[] = [];
  for (const [k, re] of TERM_KEYS) {
    if (re.test(text) && !out.includes(k)) out.push(k);
    if (out.length >= 3) break;
  }
  return out;
}

/** Маркированный список, где к каждому пункту добавляются иконки-подсказки по смыслу. */
export default function TermList({ items }: { items: string[] }) {
  return (
    <ul>
      {items.map((r, i) => (
        <li key={i}>
          {r}{' '}
          {iconsFor(r).map((k) => (
            <Term key={k} t={k} />
          ))}
        </li>
      ))}
    </ul>
  );
}
