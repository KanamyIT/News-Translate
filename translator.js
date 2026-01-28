/* translator.js — mini dictionary translator (EN<->RU) */

const dictionary = {
  hello: 'привет',
  world: 'мир',
  code: 'код',
  programming: 'программирование',
  function: 'функция',
  variable: 'переменная',
  server: 'сервер',
  client: 'клиент',
  weather: 'погода'
};

// ---- internals ----
const escReg = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function preserveCase(srcWord, translated) {
  if (!translated) return translated;
  const s = String(srcWord || '');
  if (!s) return translated;

  // HELLO -> ПРИВЕТ
  if (s.toUpperCase() === s && /[A-Za-zА-Яа-яЁё]/.test(s)) return translated.toUpperCase();

  // Hello -> Привет
  const first = s[0];
  if (first && first.toUpperCase() === first) {
    return translated[0].toUpperCase() + translated.slice(1);
  }

  // hello -> привет
  return translated;
}

function buildReverseMap(dict) {
  const rev = Object.create(null);
  for (const [en, ru] of Object.entries(dict)) {
    rev[String(ru).toLowerCase()] = en;
  }
  return rev;
}

const reverseDictionary = buildReverseMap(dictionary);

// ---- public API ----
function translateWord(word, direction = 'en-ru') {
  const w = String(word || '').trim();
  if (!w) return null;

  const low = w.toLowerCase();

  if (direction === 'en-ru') {
    const tr = dictionary[low];
    return tr ? preserveCase(w, tr) : null;
  }

  if (direction === 'ru-en') {
    const tr = reverseDictionary[low];
    return tr ? preserveCase(w, tr) : null;
  }

  return null;
}

function translateText(text, direction = 'en-ru') {
  const src = String(text ?? '');
  if (!src.trim()) return src;

  const dict = direction === 'ru-en' ? reverseDictionary : dictionary;

  // Длинные слова сначала (чтобы не ломать замены)
  const keys = Object.keys(dict).sort((a, b) => b.length - a.length);
  if (!keys.length) return src;

  // \b для латиницы работает хорошо; для кириллицы часто тоже ок в современных движках.
  // Если где-то будут проблемы — можно заменить на "не-буква/цифра" границы.
  const re = new RegExp(`\\b(${keys.map(escReg).join('|')})\\b`, 'gi');

  return src.replace(re, (m) => {
    const tr = dict[m.toLowerCase()];
    return tr ? preserveCase(m, tr) : m;
  });
}

// Node.js + Browser support
const api = { translateWord, translateText, dictionary };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  // eslint-disable-next-line no-undef
  window.Translator = api;
}
