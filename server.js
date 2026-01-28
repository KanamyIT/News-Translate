const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const translator = require('./translator');

// ===================== MyMemory translate =====================
// MyMemory GET: /get?q=...&langpair=en|ru, translatedText in responseData [page:0]
const trCache = new Map();

async function myMemoryTranslate(text, from = 'en', to = 'ru') {
  const clean = String(text || '').trim();
  if (!clean) return clean;

  const key = `${from}|${to}|${clean}`;
  if (trCache.has(key)) return trCache.get(key);

  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(clean)}&langpair=${from}|${to}`;
  const { data } = await axios.get(url, { timeout: 20000 });

  const translated = data?.responseData?.translatedText || clean;
  trCache.set(key, translated);
  return translated;
}

function splitText(text, maxLen = 480) {
  const s = String(text || '');
  if (s.length <= maxLen) return [s];

  const parts = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(i + maxLen, s.length);
    const slice = s.slice(i, end);
    const lastSpace = slice.lastIndexOf(' ');
    if (lastSpace > 220) end = i + lastSpace;
    parts.push(s.slice(i, end));
    i = end;
  }
  return parts;
}

async function translateLong(text, from = 'en', to = 'ru') {
  const chunks = splitText(text, 480);
  let out = '';
  for (const ch of chunks) out += await myMemoryTranslate(ch, from, to).catch(() => ch);
  return out;
}

function hasCyrillic(s) { return /[А-Яа-яЁё]/.test(String(s || '')); }
function looksEnglish(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (hasCyrillic(t)) return false;
  return /[A-Za-z]/.test(t);
}

async function toRuIfNeeded(text) {
  const t = String(text || '').trim();
  if (!t) return t;
  if (!looksEnglish(t)) return t;
  return translateLong(t, 'en', 'ru');
}

// ===================== Helpers =====================
function removeOnAttributes($root) {
  $root.find('*').each((_, el) => {
    const attrs = el.attribs || {};
    for (const k of Object.keys(attrs)) {
      if (k.toLowerCase().startsWith('on')) delete el.attribs[k];
    }
  });
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

// Proxy images (needed for OCR + some sites CORS)
app.get('/api/image', async (req, res) => {
  try {
    const url = String(req.query.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return res.status(400).end('bad url');

    const r = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Render; Node.js)' },
      maxContentLength: 3 * 1024 * 1024,
      maxBodyLength: 3 * 1024 * 1024
    });

    res.setHeader('Content-Type', r.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(r.data));
  } catch {
    res.status(404).end('image fetch failed');
  }
});

// ===================== Translate URL =====================
function pickMainScope($, url) {
  const host = (() => {
    try { return new URL(url).hostname; } catch { return ''; }
  })();

  // Wikipedia: берём основной контент, иначе много мусора/меню/сайдбаров
  if (host.includes('wikipedia.org')) {
    const w = $('#mw-content-text').first();
    if (w.length) return w;
  }

  const candidates = ['article', 'main', '#main', '.w3-main', '#content', '.content', 'body'];
  for (const sel of candidates) {
    const $el = $(sel).first();
    if ($el && $el.length) return $el;
  }
  return $('body');
}

function cleanupScope($scope) {
  $scope.find('script,style,noscript,iframe').remove();
  $scope.find(
    'nav,footer,header,aside,' +
    '#leftmenu,#right,#sidemenu,#topnav,#nav,' +
    '.sidebar,.side-bar,.nav,.navigation,.menu'
  ).remove();

  // Wikipedia: уберём блоки “References/External links” и т.п.
  $scope.find('.reflist,.reference,.mw-references-wrap,ol.references,.navbox,.infobox').remove();
}

async function translateTextNodesCheerio($, $root, baseUrl) {
  const SKIP = new Set(['script', 'style', 'noscript', 'pre', 'code', 'kbd', 'samp', 'var']);

  // 1) images => absolute + through /api/image
  $root.find('img').each((_, el) => {
    const $img = $(el);
    const srcRaw = $img.attr('src') || $img.attr('data-src') || $img.attr('data-original');
    const abs = absolutizeUrl(srcRaw, baseUrl);

    if (abs && /^https?:\/\//i.test(abs)) {
      $img.attr('src', `/api/image?url=${encodeURIComponent(abs)}`);
    } else {
      $img.attr('src', abs || '');
    }

    $img.attr('loading', 'lazy');
    $img.attr('style', (String($img.attr('style') || '') + ';max-width:100%;height:auto;border-radius:12px;').trim());

    const alt = $img.attr('alt');
    const title = $img.attr('title');
    if (alt && looksEnglish(alt)) $img.attr('alt', alt);
    if (title && looksEnglish(title)) $img.attr('title', title);
  });

  // 2) collect texts (BIGGER LIMITS so pages are translated more fully)
  const nodes = $root.find('*').addBack().contents();
  const uniq = new Set();

  nodes.each((_, node) => {
    if (node.type !== 'text') return;

    const parentTag = node.parent && node.parent.name ? String(node.parent.name).toLowerCase() : '';
    if (SKIP.has(parentTag)) return;

    const raw = node.data;
    if (!raw || !raw.trim()) return;

    const t = raw.replace(/\s+/g, ' ').trim();
    if (!t) return;

    // не переводим очевидный код
    if (/[{}()[\];<>]|=>|::|->|==|!=|===/.test(t)) return;

    uniq.add(t);
  });

  // Было мало => было “половина страницы англ.”
  const list = Array.from(uniq).slice(0, 1200);

  const map = new Map();
  for (const t of list) {
    if (hasCyrillic(t)) { map.set(t, t); continue; }
    map.set(t, await toRuIfNeeded(t));
  }

  nodes.each((_, node) => {
    if (node.type !== 'text') return;

    const parentTag = node.parent && node.parent.name ? String(node.parent.name).toLowerCase() : '';
    if (SKIP.has(parentTag)) return;

    const raw = node.data;
    if (!raw || !raw.trim()) return;

    const t = raw.replace(/\s+/g, ' ').trim();
    if (!map.has(t)) return;

    const lead = raw.match(/^\s*/)?.[0] || '';
    const trail = raw.match(/\s*$/)?.[0] || '';
    node.data = lead + map.get(t) + trail;
  });

  // 3) translate img alt/title after
  const imgs = $root.find('img');
  for (let i = 0; i < imgs.length; i++) {
    const $img = $(imgs[i]);
    const alt = $img.attr('alt');
    const title = $img.attr('title');
    if (alt && looksEnglish(alt)) $img.attr('alt', await toRuIfNeeded(alt));
    if (title && looksEnglish(title)) $img.attr('title', await toRuIfNeeded(title));
  }
}

app.post('/api/translate-url', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ success: false, error: 'URL не предоставлен' });

    const response = await axios.get(url, {
      timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Render; Node.js)', 'Accept-Language': 'ru,en;q=0.8' }
    });

    const $ = cheerio.load(response.data);

    const rawTitle =
      $('meta[property="og:title"]').attr('content') ||
      $('h1').first().text().trim() ||
      $('title').text().trim() ||
      'Статья';

    const $scope = pickMainScope($, url);
    cleanupScope($scope);

    const $out = $('<div class="translated-article"></div>');

    const els = $scope.find('h1,h2,h3,h4,p,ul,ol,li,pre,blockquote,figure,img,figcaption').toArray();

    // Раньше было “пол-страницы” из‑за слишком маленьких лимитов
    let added = 0;
    let charBudget = 0;
    const MAX_ELEMS = 420;
    const MAX_CHARS = 90000;

    for (const el of els) {
      if (added >= MAX_ELEMS || charBudget >= MAX_CHARS) break;

      const $el = $(el);
      const tag = (el.name || '').toLowerCase();

      if ($el.parents('nav,header,footer,aside').length) continue;

      if (tag === 'p' || tag === 'li') {
        const t = $el.text().replace(/\s+/g, ' ').trim();
        if (!t) continue;
        charBudget += t.length;
      }

      $out.append($el.clone());
      added++;
    }

    $out.find('script,style,noscript,iframe').remove();
    removeOnAttributes($out);

    await translateTextNodesCheerio($, $out, url);

    res.json({
      success: true,
      title: await toRuIfNeeded(rawTitle),
      contentHtml: $out.html() || '<p>Не удалось извлечь контент.</p>',
      sourceUrl: url
    });
  } catch (e) {
    res.status(500).json({ success: false, error: `Ошибка при переводе: ${e.message || 'unknown'}` });
  }
});

// translate-text for OCR / tab text
app.post('/api/translate-text', async (req, res) => {
  try {
    const { text, from = 'en', to = 'ru' } = req.body || {};
    if (!text) return res.status(400).json({ success: false, error: 'Текст не предоставлен' });
    res.json({ success: true, translated: await translateLong(text, from, to) });
  } catch (e) {
    res.status(500).json({ success: false, error: `Ошибка перевода: ${e.message || 'unknown'}` });
  }
});

// word (local dictionary)
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

// ===================== Weather current + 3 days =====================
// wttr supports lang=ru via query/header [page:2]
const conditionMapRu = {
  'Heavy snow': 'Сильный снегопад',
  'Moderate snow': 'Умеренный снег',
  'Light snow': 'Небольшой снег',
  'Snow': 'Снег',
  'Snow shower': 'Снегопад',
  'Light snow showers': 'Небольшие снегопады',
  'Heavy snow showers': 'Сильные снегопады',
  'Blizzard': 'Метель',
  'Heavy rain': 'Сильный дождь',
  'Light rain': 'Небольшой дождь',
  'Rain': 'Дождь',
  'Partly cloudy': 'Переменная облачность',
  'Cloudy': 'Облачно',
  'Overcast': 'Пасмурно',
  'Mist': 'Туман',
  'Fog': 'Туман'
};

async function normalizeWeatherDesc(desc) {
  const d = String(desc || '').trim();
  if (!d) return '—';
  if (hasCyrillic(d)) return d;
  if (conditionMapRu[d]) return conditionMapRu[d];
  return toRuIfNeeded(d);
}

app.get('/api/weather', async (req, res) => {
  try {
    const city = String(req.query.city || 'Moscow');
    const { data } = await axios.get(`https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=ru`, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Render; Node.js)', 'Accept-Language': 'ru' }
    });

    const current = data?.current_condition?.[0];
    const area = data?.nearest_area?.[0];

    const currentDescRaw =
      current?.lang_ru?.[0]?.value ||
      current?.weatherDesc?.[0]?.value ||
      '—';

    const forecast = (data?.weather || []).slice(0, 3).map((d) => {
      const mid = (d.hourly || []).find(h => String(h.time) === '1200') || (d.hourly || [])[0] || null;
      const raw =
        mid?.lang_ru?.[0]?.value ||
        mid?.weatherDesc?.[0]?.value ||
        '—';

      return {
        date: d.date,
        minC: d.mintempC,
        maxC: d.maxtempC,
        desc: raw
      };
    });

    for (const f of forecast) f.desc = await normalizeWeatherDesc(f.desc);

    res.json({
      success: true,
      location: area?.areaName?.[0]?.value || city,
      country: area?.country?.[0]?.value || '',
      current: {
        tempC: current?.temp_C,
        humidity: current?.humidity,
        windKmph: current?.windspeedKmph,
        desc: await normalizeWeatherDesc(currentDescRaw)
      },
      forecast
    });
  } catch (e) {
    res.json({ success: false, error: e.message || 'weather error' });
  }
});

// ===================== Articles (MORE links) =====================
app.get('/api/articles/:category', (req, res) => {
  const { category } = req.params;

  const articles = {
    programming: [
      { title: 'JavaScript Tutorial (W3Schools)', url: 'https://www.w3schools.com/js/' },
      { title: 'Python Tutorial (W3Schools)', url: 'https://www.w3schools.com/python/' },
      { title: 'HTML Tutorial (W3Schools)', url: 'https://www.w3schools.com/html/' },
      { title: 'CSS Tutorial (W3Schools)', url: 'https://www.w3schools.com/css/' },
      { title: 'React Docs', url: 'https://react.dev/' },
      { title: 'Node.js Docs', url: 'https://nodejs.org/en/docs/' },
      { title: 'MDN JavaScript Guide', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide' },
      { title: 'MDN CSS', url: 'https://developer.mozilla.org/en-US/docs/Web/CSS' },
      { title: 'Git Handbook', url: 'https://guides.github.com/introduction/git-handbook/' },
      { title: 'HTTP overview (MDN)', url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Overview' }
    ],
    history: [
      { title: 'Ancient Rome', url: 'https://en.wikipedia.org/wiki/Ancient_Rome' },
      { title: 'Middle Ages', url: 'https://en.wikipedia.org/wiki/Middle_Ages' },
      { title: 'Renaissance', url: 'https://en.wikipedia.org/wiki/Renaissance' },
      { title: 'French Revolution', url: 'https://en.wikipedia.org/wiki/French_Revolution' },
      { title: 'World War I', url: 'https://en.wikipedia.org/wiki/World_War_I' },
      { title: 'World War II', url: 'https://en.wikipedia.org/wiki/World_War_II' },
      { title: 'Industrial Revolution', url: 'https://en.wikipedia.org/wiki/Industrial_Revolution' },
      { title: 'History of China', url: 'https://en.wikipedia.org/wiki/History_of_China' }
    ],
    games: [
      { title: 'Video game (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Video_game' },
      { title: 'Game design (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Game_design' },
      { title: 'Game Programming Patterns', url: 'https://gameprogrammingpatterns.com/' },
      { title: 'Unity Manual', url: 'https://docs.unity3d.com/Manual/index.html' },
      { title: 'Unreal Engine', url: 'https://www.unrealengine.com/' },
      { title: 'Esports (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Esports' },
      { title: 'Level design', url: 'https://en.wikipedia.org/wiki/Level_design' }
    ],
    cinema: [
      { title: 'History of film', url: 'https://en.wikipedia.org/wiki/History_of_film' },
      { title: 'Cinematography', url: 'https://en.wikipedia.org/wiki/Cinematography' },
      { title: 'Film directing', url: 'https://en.wikipedia.org/wiki/Film_directing' },
      { title: 'Screenwriting', url: 'https://en.wikipedia.org/wiki/Screenwriting' },
      { title: 'Animation', url: 'https://en.wikipedia.org/wiki/Animation' },
      { title: 'Film editing', url: 'https://en.wikipedia.org/wiki/Film_editing' }
    ]
  };

  res.json({ success: true, articles: articles[category] || [] });
});

app.get('/api/health', (req, res) => res.json({ success: true }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`✅ Server on :${PORT}`));
