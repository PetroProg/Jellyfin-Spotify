import { create } from 'zustand';

export type AppLanguage = 'en' | 'ru';

const LANG_STORAGE_KEY = 'jellyfy_lang';
const USER_LANG_INIT_PREFIX = 'jellyfy_lang_init_';

function getInitialLang(): AppLanguage {
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY);
    if (saved === 'en' || saved === 'ru') {
      return saved;
    }
    localStorage.setItem(LANG_STORAGE_KEY, 'en');
  } catch (_) {}
  return 'en';
}

const CATEGORY_MAP_RU_TO_EN: Record<string, string> = {
  'Фонк и Wave': 'Phonk & Wave',
  'Электроника и Дэнс': 'Electronic & Dance',
  'Рок и Альтернатива': 'Rock & Alternative',
  'Классический Рок': 'Classic Rock',
  'Русский Рэп и Хип-Хоп': 'RU Rap & Hip-Hop',
  'Зарубежный Хип-Хоп': 'Hip-Hop & Trap',
  'Поп и Ретро': 'Pop & Retro',
  'Инди и Lo-Fi': 'Indie & Lo-Fi',
  'Разное': 'Variety',
  'Персональный микс': 'Personal Mix',
};

const EXACT_DYNAMIC_RU_TO_EN: Record<string, string> = {
  'Любимые треки': 'Liked Songs',
  'Ваша медиатека сохраненных композиций': 'Your library of saved tracks',
  'Плейлист из Spotify': 'Spotify Playlist',
  'Список треков, импортированный пользователем': 'Track list imported by user',
  'Любимые треки из вашего аккаунта Spotify': 'Liked songs from your Spotify account',
  'Все любимые треки из Spotify уже есть в вашей медиатеке! Все ваши треки на сайте сохранены.':
    'All your Spotify Liked Songs are already in your library! All your tracks on the site are preserved.',
  'Отсутствует подключение к сети': 'No network connection',
  'Таймаут запроса к серверу': 'Server request timed out',
  'Ошибка сети': 'Network error',
  'Сессия истекла, авторизуйтесь снова': 'Session expired, please log in again',
  'Неверный логин/email или пароль': 'Invalid username/email or password',
  'Пользователь с таким именем или email уже существует': 'A user with this username or email already exists',
  'Неверный текущий пароль': 'Incorrect current password',
  'Плейлист не найден': 'Playlist not found',
  'Плейлист дня не найден': 'Daily Mix not found',
  'Аккаунт Spotify не привязан. Подключите его в Настройках.':
    'Spotify account is not connected. Connect it in Settings.',
};

const EXACT_DYNAMIC_EN_TO_RU: Record<string, string> = {
  'Liked Songs': 'Любимые треки',
  'Your library of saved tracks': 'Ваша медиатека сохраненных композиций',
  'Spotify Playlist': 'Плейлист из Spotify',
  'Track list imported by user': 'Список треков, импортированный пользователем',
  'Liked songs from your Spotify account': 'Любимые треки из вашего аккаунта Spotify',
};

export function translateDynamicString(text: string | null | undefined, lang: AppLanguage): string {
  if (!text) return '';
  const trimmed = text.trim();
  if (!trimmed) return '';

  if (lang === 'ru') {
    if (EXACT_DYNAMIC_EN_TO_RU[trimmed]) return EXACT_DYNAMIC_EN_TO_RU[trimmed];
    return text;
  }

  // English ('en') translation of dynamic Russian strings from DB / Backend
  if (EXACT_DYNAMIC_RU_TO_EN[trimmed]) {
    return EXACT_DYNAMIC_RU_TO_EN[trimmed];
  }
  if (CATEGORY_MAP_RU_TO_EN[trimmed]) {
    return CATEGORY_MAP_RU_TO_EN[trimmed];
  }

  let res = text;

  // Daily Mix name: "Микс дня #1 • Фонк и Wave" -> "Daily Mix #1 • Phonk & Wave"
  res = res.replace(/Микс дня #(\d+)/gi, 'Daily Mix #$1');
  res = res.replace(/МИКС ДНЯ #(\d+)/g, 'DAILY MIX #$1');

  // Replace category titles inside strings
  for (const [ruCat, enCat] of Object.entries(CATEGORY_MAP_RU_TO_EN)) {
    if (res.includes(ruCat)) {
      res = res.split(ruCat).join(enCat);
    }
  }

  // Daily Mix description: "... • На основе X, Y и новых исполнителей"
  res = res.replace(/На основе (.+?) и новых исполнителей/gi, 'Based on $1 and new artists');

  // Imported playlist messages
  res = res.replace(
    /Плейлист «(.+?)» создан \((\d+) треков\)\. Скачивание запущено в фоне!/g,
    'Playlist "$1" created ($2 tracks). Background download started!'
  );
  res = res.replace(
    /Начата догрузка (\d+) новых любимых треков из Spotify\. Все ваши существующие треки на сайте сохранены!/g,
    'Started downloading $1 new liked tracks from Spotify. All your existing tracks are preserved!'
  );
  res = res.replace(
    /Добавлено (\d+) треков в «(.+?)»\. Скачивание запущено!/g,
    'Added $1 tracks to "$2". Download started!'
  );
  res = res.replace(/Импорт (\d+) треков/g, 'Import of $1 tracks');
  res = res.replace(/Список из (\d+) треков/g, 'List of $1 tracks');

  return res;
}

interface I18nState {
  lang: AppLanguage;
  setLang: (lang: AppLanguage) => void;
  initFirstLoginLang: (userId?: number | string) => void;
  t: (en: string, ru: string) => string;
  td: (text?: string | null) => string;
}

export const useI18nStore = create<I18nState>((set, get) => {
  const initial = getInitialLang();
  if (typeof document !== 'undefined') {
    document.documentElement.lang = initial;
  }

  return {
    lang: initial,

    setLang: (newLang: AppLanguage) => {
      try {
        localStorage.setItem(LANG_STORAGE_KEY, newLang);
      } catch (_) {}
      if (typeof document !== 'undefined') {
        document.documentElement.lang = newLang;
      }
      set({ lang: newLang });
    },

    initFirstLoginLang: (userId?: number | string) => {
      const key = `${USER_LANG_INIT_PREFIX}${userId ?? 'default'}`;
      try {
        const alreadyInit = localStorage.getItem(key);
        if (!alreadyInit) {
          localStorage.setItem(key, '1');
          localStorage.setItem(LANG_STORAGE_KEY, 'en');
          if (typeof document !== 'undefined') {
            document.documentElement.lang = 'en';
          }
          set({ lang: 'en' });
        }
      } catch (_) {
        set({ lang: 'en' });
      }
    },

    t: (en: string, ru: string) => {
      return get().lang === 'en' ? en : ru;
    },

    td: (text?: string | null) => {
      return translateDynamicString(text, get().lang);
    },
  };
});

export function tr(en: string, ru: string): string {
  return useI18nStore.getState().lang === 'en' ? en : ru;
}

export function td(text?: string | null): string {
  return translateDynamicString(text, useI18nStore.getState().lang);
}

export function formatTrackCount(count: number, lang?: AppLanguage): string {
  const currentLang = lang || useI18nStore.getState().lang;
  if (currentLang === 'en') {
    return count === 1 ? '1 track' : `${count} tracks`;
  }
  if (count % 10 === 1 && count % 100 !== 11) return `${count} трек`;
  if ([2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100)) return `${count} трека`;
  return `${count} треков`;
}
