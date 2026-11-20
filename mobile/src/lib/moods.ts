import type { IconName } from '../components/Icon';

export const MOODS: { q: string; icon: IconName; ru: string; en: string; hue: number }[] = [
  { q: 'lofi beats', icon: 'coffee', ru: 'Кофе и фокус', en: 'Coffee & focus', hue: 40 },
  { q: 'synthwave', icon: 'rocket_launch', ru: 'Синтвейв', en: 'Synthwave', hue: 310 },
  { q: 'ambient chill', icon: 'self_improvement', ru: 'Спокойствие', en: 'Calm', hue: 180 },
  { q: 'workout edm', icon: 'bolt', ru: 'Энергия', en: 'Energy', hue: 70 },
  { q: 'dance hits', icon: 'nightlife', ru: 'Вечеринка', en: 'Party', hue: 340 },
  { q: 'love songs', icon: 'favorite', ru: 'Романтика', en: 'Romance', hue: 10 },
  { q: 'classical piano', icon: 'piano', ru: 'Классика', en: 'Classical', hue: 260 },
  { q: 'indie folk', icon: 'park', ru: 'Инди', en: 'Indie', hue: 130 },
  { q: 'sleep ambient', icon: 'bedtime', ru: 'Для сна', en: 'Sleep', hue: 230 },
  { q: 'top hits', icon: 'local_fire_department', ru: 'Хиты', en: 'Hits', hue: 20 },
];
