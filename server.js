const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const translator = require('./translator');

// -------------------- Translate (MyMemory) --------------------
// MyMemory: GET https://api.mymemory.translated.net/get?q=...&langpair=en|ru [page:0]
const translateCache = new Map(); // key -> translated

async function translateChunkMyMemory(text, from = 'en', to = 'ru') {
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

function splitByMaxLen(text, maxLen = 450) {
  const s = String(text || '');
  if (s.length <= maxLen) return [s];

  const parts = [];
  let i = 0;

  while (i < s.length) {
    let end = Math.min(i + maxLen, s.length);

    // пытаемся резать по пробелу, чтобы не ломать слова
    const slice = s.slice(i, end);
    const lastSpace = slice.lastIndexOf(' ');
    if (lastSpace > 200) end = i + lastSpace;

    parts.push(s.slice(i, end));
    i = end;
  }
  return parts;
}

async function translateLongText(text, from = 'en', to = 'ru') {
  const chunks = splitByMaxLen(text, 450);
  let out = '';
  for (const ch of chunks) {
    // MyMemory может капризничать на очень “кодовых” строках — оставим как есть
    const translated = await translateChunkMyMemory(ch, from, to).catch(() => ch);
    out += translated;
  }
  return out;
}

function pickMainScope($) {
  const candidates = [
    '#main',
    '.w3-main',
    'article',
    'main',
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

function cleanupDom($scope) {
  $scope.find('script,style,noscript').remove();

  // типичные меню/сайдбары (особенно для w3schools)
  $scope.find(
    'nav,footer,header,aside,' +
    '#leftmenu,#right,#sidemenu,#topnav,#nav,' +
    '.sidebar,.side-bar,.nav,.navigation,.menu'
  ).remove();
}

async function translateUrlToHtml(url) {
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
  cleanupDom($scope);

  // соберём блоки (ограничим, чтобы не переводить километры текста)
  const blocks = [];
  let totalChars = 0;

  const MAX_BLOCKS = 80;
  const MAX_CHARS = 20000;

  $scope.find('h1,h2,h3,p,li,pre,blockquote').each((_, el) => {
    if (blocks.length >= MAX_BLOCKS) return;

    const $el = $(el);
    const tag = (el.name || '').toLowerCase();

    // пропускаем всё, что внутри <pre> (кроме самого pre)
    if (tag !== 'pre' && $el.parents('pre').length) return;

    if (tag === 'pre') {
      const html = $el.toString();
      blocks.push({ type: 'pre', html });
      return;
    }

    let text = $el.text().replace(/\s+/g, ' ').trim();
    if (!text) return;

    // слишком короткие куски (меню/кнопки) — выкидываем
    if ((tag === 'p' || tag === 'li') && text.length < 25) return;

    totalChars += text.length;
    if (totalChars > MAX_CHARS) return;

    if (tag === 'li') text = `• ${text}`;

    blocks.push({ type: tag, text });
  });

  const translatedTitle = await translateLongText(rawTitle, 'en', 'ru');

  // переводим блоки
  const htmlParts = [];
  for (const b of blocks) {
    if (b.type === 'pre') {
      htmlParts.push(b.html);
      continue;
    }
    const tr = await translateLongText(b.text, 'en', 'ru');

    if (b.type === 'h1' || b.type === 'h2' || b.type === 'h3') htmlParts.push(`<${b.type}>${escapeHtml(tr)}</${b.type}>`);
    else if (b.type === 'blockquote') htmlParts.push(`<blockquote>${escapeHtml(tr)}</blockquote>`);
    else htmlParts.push(`<p>${escapeHtml(tr)}</p>`);
  }

  return { title: translatedTitle, contentHtml: htmlParts.join('\n') || '<p>Не удалось извлечь контент.</p>' };
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

// -------------------- API --------------------

app.post('/api/translate-url', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ success: false, error: 'URL не предоставлен' });

    const result = await translateUrlToHtml(url);
    res.json({ success: true, title: result.title, contentHtml: result.contentHtml, sourceUrl: url });
  } catch (e) {
    res.status(500).json({ success: false, error: `Ошибка при переводе: ${e.message || 'unknown'}` });
  }
});

app.post('/api/translate-text', async (req, res) => {
  try {
    const { text, from = 'en', to = 'ru' } = req.body || {};
    if (!text) return res.status(400).json({ success: false, error: 'Текст не предоставлен' });

    const translated = await translateLongText(text, from, to);
    res.json({ success: true, translated });
  } catch (e) {
    res.status(500).json({ success: false, error: `Ошибка перевода: ${e.message || 'unknown'}` });
  }
});

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

// wttr: можно задавать язык через ?lang=ru [page:1]
app.get('/api/weather', async (req, res) => {
  try {
    const city = String(req.query.city || 'Moscow');
    const { data } = await axios.get(`https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=ru`, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Render; Node.js)', 'Accept-Language': 'ru' }
    });

    const current = data?.current_condition?.[0];
    const area = data?.nearest_area?.[0];

    res.json({
      success: true,
      tempC: current?.temp_C,
      desc: current?.weatherDesc?.[0]?.value || '—',
      humidity: current?.humidity,
      windKmph: current?.windspeedKmph,
      location: area?.areaName?.[0]?.value || city,
      country: area?.country?.[0]?.value || ''
    });
  } catch (e) {
    res.json({ success: false, error: e.message || 'weather error' });
  }
});

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
