import type { Category } from '../api/bybit';

export const REFRESH_OPTIONS = [
  { label: 'Выкл', value: 0 },
  { label: '15 с', value: 15 },
  { label: '30 с', value: 30 },
  { label: '1 мин', value: 60 },
  { label: '2 мин', value: 120 },
  { label: '5 мин', value: 300 },
];

export const CONF_OPTIONS = [
  { label: 'Выкл', value: 0 },
  { label: '50%', value: 50 },
  { label: '60%', value: 60 },
  { label: '70%', value: 70 },
  { label: '80%', value: 80 },
  { label: '90%', value: 90 },
];

export const CAT_GLOSS: Record<Category, string> = {
  linear: 'catLinear',
  spot: 'catSpot',
  inverse: 'catInverse',
  option: 'catOption',
};
