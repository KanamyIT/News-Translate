const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '6mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// для вкладки "Слово" (локально)
const translator = require('./translator');

// =====================
// MyMemory translate
// =====================
// GET: https://api.mymemory.translated.net/get?q=...&langpair=en|ru [page:0]
const translateCache = new Map();

async function myMemoryTranslate(text, from = 'en', to = 'ru') {
  const clean = String(text || '').trim();
  if (!clean) return clean;

  const key = `${from}|${to}|${clean}`;
  if (translateCache.has(key)) return translateCache.get(key);

  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(clean)}&langpair=${from}|${to}`;
  const { data } = await axios.get(url, { timeout: 20000 });

  const translated = data?.responseData?.translatedText || clean;
  translateCache.set(key, translated);
  return translated;
}

function splitText(text, maxLen = 450) {
  const s = String(text || '');
  if (s.length <= maxLen) return [s];

  const parts = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(i + maxLen, s.length);
    const slice = s.slice(i, end);
    const lastSpace = slice.lastIndexOf(' ');
    if (lastSpace > 200) end = i + lastSpace;
    parts.push(s.slice(i, end));
    i = end;
  }
  return parts;
}

async function translateLong(text, from = 'en', to = 'ru') {
  const chunks = splitText(text, 450);
  let out = '';
  for (const ch of chunks) {
    out += await myMemoryTranslate(ch, from, to).catch(() => ch);
  }
  return out;
}

function hasCyrillic(s) {
  return /[А-Яа-яЁё]/.test(String(s || ''));
}

function seemsEnglish(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (hasCyrillic(t)) return false;
  return /[A-Za-z]/.test(t);
}

async function toRuIfNeeded(text) {
  const t = String(text || '').trim();
  if (!t) return t;
  if (hasCyrillic(t)) return t;
  if (!seemsEnglish(t)) return t;
  return translateLong(t, 'en', 'ru');
}

// =====================
// Translate URL with images
// =====================
function pickMainScope($) {
  const candidates = [
    'article',
    'main',
    '#main',
    '.w3-main',
    '#content',
    '.content',
    'body'
  ];
  for (const sel of candidates) {
    const $el = $(sel).first();
    if ($el && $el.length) return $el;
  }
  return $('body');
}

function cleanupScope($scope) {
  $scope.find('script,style,noscript').remove();
  $scope.find(
    'nav,footer,header,aside,' +
    '#leftmenu,#right,#sidemenu,#topnav,#nav,' +
    '.sidebar,.side-bar,.nav,.navigation,.menu'
  ).remove();
}

function absolutizeUrl(src, baseUrl) {
  try {
    if (!src) return src;
    const s = String(src).trim();
    if (!s) return s;
    if (s.startsWith('data:')) return s;
    return new URL(s, baseUrl).toString();
  } catch {
    return src;
  }
}

async function translateTextNodesCheerio($, $root, baseUrl) {
  const SKIP = new Set(['script', 'style', 'noscript', 'pre', 'code', 'kbd', 'samp', 'var']);

  // 1) Абсолютные src для картинок
  $root.find('img').each((_, el) => {
    const $img = $(el);
    const src = $img.attr('src') || $img.attr('data-src') || $img.attr('data-original');
    if (src) $img.attr('src', absolutizeUrl(src, baseUrl));
    $img.removeAttr('data-src');
    $img.removeAttr('data-original');

    // переводим alt/title, если есть
    const alt = $img.attr('alt');
    const title = $img.attr('title');
    if (alt && seemsEnglish(alt)) {
      // async позже: пометим
      $img.attr('data-alt-en', alt);
    }
    if (title && seemsEnglish(title)) {
      $img.attr('data-title-en', title);
    }
  });

  // 2) Перевод текстовых узлов (кроме code/pre)
  const nodes = $root.find('*').addBack().contents();

  // соберём тексты для перевода (уникально)
  const texts = [];
  nodes.each((_, node) => {
    if (node.type !== 'text') return;
    const parentTag = node.parent && node.parent.name ? String(node.parent.name).toLowerCase() : '';
    if (SKIP.has(parentTag)) return;

    const raw = node.data;
    if (!raw || !raw.trim()) return;

    const trimmed = raw.replace(/\s+/g, ' ').trim();
    if (!trimmed) return;

    // слишком мелкие куски типа "Next" лучше не переводить, чтобы не ломать навигацию
    if (trimmed.length < 3) return;

    texts.push(trimmed);
  });

  const uniq = Array.from(new Set(texts)).slice(0, 180); // ограничение, чтобы не уйти в вечность

  const map = new Map();
  for (const t of uniq) {
    // если уже русский — оставляем
    if (hasCyrillic(t)) {
      map.set(t, t);
      continue;
    }
    // если похоже на код/сниппет — не трогаем
    if (/[{}()[\];<>]|=>|::|->|==|!=|===|\/\*|\*\//.test(t)) {
      map.set(t, t);
      continue;
    }
    map.set(t, await toRuIfNeeded(t));
  }

  nodes.each((_, node) => {
    if (node.type !== 'text') return;
    const parentTag = node.parent && node.parent.name ? String(node.parent.name).toLowerCase() : '';
    if (SKIP.has(parentTag)) return;

    const raw = node.data;
    if (!raw || !raw.trim()) return;

    const trimmed = raw.replace(/\s+/g, ' ').trim();
    if (!trimmed) return;

    if (map.has(trimmed)) {
      // сохраняем немного исходных пробелов
      const lead = raw.match(/^\s*/)?.[0] || '';
      const trail = raw.match(/\s*$/)?.[0] || '';
      node.data = lead + map.get(trimmed) + trail;
    }
  });

  // 3) Перевод alt/title (если помечали)
  const imgs = $root.find('img');
  for (let i = 0; i < imgs.length; i++) {
    const el = imgs[i];
    const $img = $(el);

    const altEn = $img.attr('data-alt-en');
    const titleEn = $img.attr('data-title-en');

    if (altEn) {
      $img.attr('alt', await toRuIfNeeded(altEn));
      $img.removeAttr('data-alt-en');
    }
    if (titleEn) {
      $img.attr('title', await toRuIfNeeded(titleEn));
      $img.removeAttr('data-title-en');
    }
  }
}

app.post('/api/translate-url', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ success: false, error: 'URL не предоставлен' });

    const response = await axios.get(url, {
      timeout: 25000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Render; Node.js)',
        'Accept-Language': 'ru,en;q=0.8'
      }
    });

    const $ = cheerio.load(response.data);

    const rawTitle =
      $('meta[property="og:title"]').attr('content') ||
      $('h1').first().text().trim() ||
      $('title').text().trim() ||
      'Статья';

    const $scope = pickMainScope($);
    cleanupScope($scope);

    // Сохраняем структуру + картинки: берём "контентные" элементы
    const $out = $('<div class="translated-article"></div>');

    const elements = $scope.find('h1,h2,h3,p,ul,ol,pre,blockquote,figure,img').toArray();

    let added = 0;
    let charBudget = 0;
    const MAX_ELEMS = 120;
    const MAX_CHARS = 25000;

    for (const el of elements) {
      if (added >= MAX_ELEMS || charBudget >= MAX_CHARS) break;

      const tag = (el.name || '').toLowerCase();
      const $el = $(el);

      // пропускаем элементы, которые внутри nav/aside и т.п. (на всякий)
      if ($el.parents('nav,header,footer,aside').length) continue;

      if (tag === 'p') {
        const t = $el.text().replace(/\s+/g, ' ').trim();
        if (t.length < 25) continue;
        charBudget += t.length;
      }

      // figure/img могут быть важны, даже если текста мало
      const clone = $el.clone();

      // делаем картинки адаптивными
      if (tag === 'img') {
        clone.attr('style', (clone.attr('style') || '') + ';max-width:100%;height:auto;border-radius:12px;');
        clone.attr('loading', 'lazy');
      }

      $out.append(clone);
      added++;
    }

    // Переводим текстовые узлы, сохраняя HTML и картинки
    await translateTextNodesCheerio($, $out, url);

    const titleRu = await toRuIfNeeded(rawTitle);

    res.json({
      success: true,
      title: titleRu,
      contentHtml: $out.html() || '<p>Не удалось извлечь контент.</p>',
      sourceUrl: url
    });
  } catch (e) {
    res.status(500).json({ success: false, error: `Ошибка при переводе: ${e.message || 'unknown'}` });
  }
});

// Перевод текста (используем и для OCR с картинок)
app.post('/api/translate-text', async (req, res) => {
  try {
    const { text, from = 'en', to = 'ru' } = req.body || {};
    if (!text) return res.status(400).json({ success: false, error: 'Текст не предоставлен' });

    const translated = await translateLong(text, from, to);
    res.json({ success: true, translated });
  } catch (e) {
    res.status(500).json({ success: false, error: `Ошибка перевода: ${e.message || 'unknown'}` });
  }
});

// Слово — локальный словарь
app.post('/api/translate-word', (req, res) => {
  try {
    const { word, direction } = req.body || {};
    if (!word) return res.status(400).json({ success: false, error: 'Слово не предоставлено' });

    const t = translator.translateWord(word, direction);
    res.json({ success: !!t, translation: t || 'Не найдено' });
  } catch (e) {
    res.status(500).json({ success: false, error: `Ошибка: ${e.message || 'unknown'}` });
  }
});

// =====================
// Weather (current + next 3 days)
// =====================
// wttr поддерживает локализацию через ?lang=ru и Accept-Language [page:1]
app.get('/api/weather', async (req, res) => {
  try {
    const city = String(req.query.city || 'Moscow');
    const { data } = await axios.get(`https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=ru`, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Render; Node.js)', 'Accept-Language': 'ru' }
    });

    const current = data?.current_condition?.[0];
    const area = data?.nearest_area?.[0];

    let desc =
      current?.lang_ru?.[0]?.value ||
      current?.weatherDesc?.[0]?.value ||
      '—';

    // если всё равно пришло по-английски (Heavy snow) — переводим
    desc = await toRuIfNeeded(desc);

    const forecast = (data?.weather || []).slice(0, 3).map((d) => {
      const mid = (d.hourly || []).find(h => String(h.time) === '1200') || (d.hourly || [])[0] || null;
      const rawDayDesc =
        mid?.lang_ru?.[0]?.value ||
        mid?.weatherDesc?.[0]?.value ||
        d?.hourly?.[0]?.weatherDesc?.[0]?.value ||
        '—';

      return {
        date: d.date,
        minC: d.mintempC,
        maxC: d.maxtempC,
        avgC: d.avgtempC,
        desc: rawDayDesc
      };
    });

    // переводим описания прогнозов (если вдруг английские)
    for (const f of forecast) f.desc = await toRuIfNeeded(f.desc);

    res.json({
      success: true,
      location: area?.areaName?.[0]?.value || city,
      country: area?.country?.[0]?.value || '',
      current: {
        tempC: current?.temp_C,
        humidity: current?.humidity,
        windKmph: current?.windspeedKmph,
        desc
      },
      forecast
    });
  } catch (e) {
    res.json({ success: false, error: e.message || 'weather error' });
  }
});

// Articles
app.get('/api/articles/:category', (req, res) => {
  const { category } = req.params;

  const articles = {
    programming: [
      { title: 'JavaScript для начинающих', url: 'https://www.w3schools.com/js/' },
      { title: 'Python основы', url: 'https://www.w3schools.com/python/' },
      { title: 'HTML и CSS', url: 'https://www.w3schools.com/html/' },
      { title: 'React документация', url: 'https://react.dev/' },
      { title: 'Node.js документация', url: 'https://nodejs.org/en/docs/' }
    ],
    history: [
      { title: 'Древний Рим', url: 'https://en.wikipedia.org/wiki/Ancient_Rome' },
      { title: 'Средние века', url: 'https://en.wikipedia.org/wiki/Middle_Ages' }
    ],
    games: [
      { title: 'История видеоигр', url: 'https://en.wikipedia.org/wiki/Video_game' },
      { title: 'Game Programming Patterns', url: 'https://gameprogrammingpatterns.com/' }
    ],
    cinema: [
      { title: 'История кино', url: 'https://en.wikipedia.org/wiki/History_of_film' },
      { title: 'Режиссура', url: 'https://en.wikipedia.org/wiki/Film_directing' }
    ]
  };

  res.json({ success: true, articles: articles[category] || [] });
});

app.get('/api/health', (req, res) => res.json({ success: true }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`✅ Server on :${PORT}`));
