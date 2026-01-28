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

// -------------------- MyMemory translate --------------------
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

// защита “кодовых” токенов типа print/console.log/document.getElementById
const CODE_WORDS = [
  'print', 'printf', 'echo',
  'console', 'console.log',
  'document', 'window',
  'getElementById', 'querySelector',
  'function', 'return', 'let', 'const', 'var',
  'class', 'new', 'import', 'from', 'export',
  'async', 'await', 'def'
];

function protectCodeTokens(text) {
  const src = String(text || '');
  if (!src) return { protectedText: src, replacements: [] };

  const found = [];
  const add = (v) => { if (v && !found.includes(v)) found.push(v); };

  for (const m of src.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\b/g)) add(m[0]);
  for (const m of src.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) add(m[1]);
  for (const w of CODE_WORDS) {
    const re = new RegExp(`\\b${w.replace('.', '\\.')}\\b`, 'g');
    if (re.test(src)) add(w);
  }

  if (!found.length) return { protectedText: src, replacements: [] };

  let out = src;
  const replacements = [];
  found.forEach((token, idx) => {
    const ph = `@@CODE_${idx}@@`;
    replacements.push([ph, token]);
    const re = new RegExp(`\\b${token.replace('.', '\\.')}\\b`, 'g');
    out = out.replace(re, ph);
  });

  return { protectedText: out, replacements };
}

function restoreCodeTokens(text, replacements) {
  let out = String(text || '');
  for (const [ph, token] of replacements) out = out.replaceAll(ph, token);
  return out;
}

async function toRuIfNeeded(text) {
  const t = String(text || '').trim();
  if (!t) return t;
  if (!looksEnglish(t)) return t;

  const { protectedText, replacements } = protectCodeTokens(t);
  const tr = await translateLong(protectedText, 'en', 'ru');
  return restoreCodeTokens(tr, replacements);
}

// -------------------- Helpers --------------------
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

function removeOnAttributes($root) {
  $root.find('*').each((_, el) => {
    const attrs = el.attribs || {};
    for (const k of Object.keys(attrs)) {
      if (k.toLowerCase().startsWith('on')) delete el.attribs[k];
    }
  });
}

// -------------------- Image proxy (for OCR + CORS) --------------------
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

// -------------------- Translate URL (returns HTML) --------------------
function pickMainScope($, url) {
  const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();

  if (host.includes('wikipedia.org')) {
    const w = $('#mw-content-text').first();
    if (w.length) return w;
  }
  if (host.includes('w3schools.com')) {
    const w3 = $('.w3-main').first();
    if (w3.length) return w3;
  }

  for (const sel of ['article', 'main', '#content', '.content', 'body']) {
    const el = $(sel).first();
    if (el.length) return el;
  }
  return $('body');
}

function cleanupScope($scope) {
  $scope.find('script,style,noscript,iframe').remove();
  $scope.find('nav,footer,header,aside,#leftmenu,#sidemenu,#topnav,.sidebar,.menu,.navigation').remove();
  $scope.find('.reflist,.reference,.mw-references-wrap,ol.references,.navbox,.infobox').remove();
}

async function translateTextNodesCheerio($, $root, baseUrl) {
  const SKIP = new Set(['script', 'style', 'noscript', 'pre', 'code', 'kbd', 'samp', 'var']);

  // images: absolute + proxy + alt/title translate
  $root.find('img').each((_, el) => {
    const $img = $(el);
    const srcRaw = $img.attr('src') || $img.attr('data-src') || $img.attr('data-original');
    const abs = absolutizeUrl(srcRaw, baseUrl);

    if (abs && /^https?:\/\//i.test(abs)) $img.attr('src', `/api/image?url=${encodeURIComponent(abs)}`);
    else $img.attr('src', abs || '');

    $img.attr('loading', 'lazy');
    $img.attr('style', (String($img.attr('style') || '') + ';max-width:100%;height:auto;border-radius:12px;').trim());
  });

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

    // не трогаем явный код
    if (/[{}()[\];<>]|=>|::|->|==|!=|===/.test(t)) return;

    uniq.add(t);
  });

  const list = Array.from(uniq).slice(0, 5000);
  const map = new Map();
  const CONCURRENCY = 6;

  for (let i = 0; i < list.length; i += CONCURRENCY) {
    const batch = list.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async (t) => {
      if (hasCyrillic(t)) return [t, t];
      return [t, await toRuIfNeeded(t)];
    }));
    results.forEach(([k, v]) => map.set(k, v));
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

    const selector =
      'h1,h2,h3,h4,h5,h6,p,ul,ol,li,pre,blockquote,figure,img,figcaption,' +
      'div.w3-panel,div.w3-note,div.w3-example,div.w3-info,div.w3-warning';

    const els = $scope.find(selector).toArray();

    let added = 0;
    let charBudget = 0;
    const MAX_ELEMS = 520;
    const MAX_CHARS = 120000;

    for (const el of els) {
      if (added >= MAX_ELEMS || charBudget >= MAX_CHARS) break;

      const $el = $(el);
      const tag = (el.name || '').toLowerCase();

      if ($el.parents('nav,header,footer,aside').length) continue;

      if (tag === 'p' || tag === 'li' || tag === 'div') {
        const t = $el.text().replace(/\s+/g, ' ').trim();
        if (!t) continue;
        if (tag === 'div' && t.length < 30) continue;
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

// translate-text for OCR / text tab
app.post('/api/translate-text', async (req, res) => {
  try {
    const { text, from = 'en', to = 'ru' } = req.body || {};
    if (!text) return res.status(400).json({ success: false, error: 'Текст не предоставлен' });
    res.json({ success: true, translated: await translateLong(text, from, to) });
  } catch (e) {
    res.status(500).json({ success: false, error: `Ошибка перевода: ${e.message || 'unknown'}` });
  }
});

// weather (как у тебя было можно оставить/доработать позже)
app.get('/api/weather', async (req, res) => {
  try {
    const city = String(req.query.city || 'Moscow');
    const { data } = await axios.get(`https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=ru`, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Render; Node.js)', 'Accept-Language': 'ru' }
    });

    const current = data?.current_condition?.[0];
    const area = data?.nearest_area?.[0];

    const desc =
      current?.lang_ru?.[0]?.value ||
      current?.weatherDesc?.[0]?.value ||
      '—';

    const forecast = (data?.weather || []).slice(0, 3).map((d) => {
      const mid = (d.hourly || []).find(h => String(h.time) === '1200') || (d.hourly || [])[0] || null;
      const raw = mid?.lang_ru?.[0]?.value || mid?.weatherDesc?.[0]?.value || '—';
      return { date: d.date, minC: d.mintempC, maxC: d.maxtempC, desc: raw };
    });

    res.json({
      success: true,
      location: area?.areaName?.[0]?.value || city,
      current: { tempC: current?.temp_C, humidity: current?.humidity, windKmph: current?.windspeedKmph, desc },
      forecast
    });
  } catch (e) {
    res.json({ success: false, error: e.message || 'weather error' });
  }
});

// articles (переводим заголовки карточек)
const ARTICLES = {
  programming: [
    { title: 'JavaScript Tutorial (W3Schools)', url: 'https://www.w3schools.com/js/' },
    { title: 'Python Tutorial (W3Schools)', url: 'https://www.w3schools.com/python/' },
    { title: 'HTML Tutorial (W3Schools)', url: 'https://www.w3schools.com/html/' },
    { title: 'CSS Tutorial (W3Schools)', url: 'https://www.w3schools.com/css/' },
    { title: 'React Docs', url: 'https://react.dev/' },
    { title: 'Node.js Docs', url: 'https://nodejs.org/en/docs/' }
  ],
  history: [
    { title: 'Ancient Rome', url: 'https://en.wikipedia.org/wiki/Ancient_Rome' },
    { title: 'Middle Ages', url: 'https://en.wikipedia.org/wiki/Middle_Ages' },
    { title: 'Renaissance', url: 'https://en.wikipedia.org/wiki/Renaissance' },
    { title: 'French Revolution', url: 'https://en.wikipedia.org/wiki/French_Revolution' },
    { title: 'World War I', url: 'https://en.wikipedia.org/wiki/World_War_I' },
    { title: 'World War II', url: 'https://en.wikipedia.org/wiki/World_War_II' }
  ],
  games: [
    { title: 'Video game', url: 'https://en.wikipedia.org/wiki/Video_game' },
    { title: 'Game design', url: 'https://en.wikipedia.org/wiki/Game_design' },
    { title: 'Game Programming Patterns', url: 'https://gameprogrammingpatterns.com/' }
  ],
  cinema: [
    { title: 'History of film', url: 'https://en.wikipedia.org/wiki/History_of_film' },
    { title: 'Cinematography', url: 'https://en.wikipedia.org/wiki/Cinematography' },
    { title: 'Film directing', url: 'https://en.wikipedia.org/wiki/Film_directing' }
  ]
};

const articleTitleCache = new Map();

app.get('/api/articles/:category', async (req, res) => {
  try {
    const { category } = req.params;
    const list = ARTICLES[category] || [];

    const out = await Promise.all(list.map(async (a) => {
      if (articleTitleCache.has(a.title)) return { ...a, title: articleTitleCache.get(a.title) };
      const tr = await toRuIfNeeded(a.title);
      articleTitleCache.set(a.title, tr);
      return { ...a, title: tr };
    }));

    res.json({ success: true, articles: out });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message || 'articles error' });
  }
});

app.get('/api/health', (req, res) => res.json({ success: true }));

// routes: cards page and translate page
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/translate', (req, res) => res.sendFile(path.join(__dirname, 'public', 'translate.html')));

app.listen(PORT, () => console.log(`✅ Server on :${PORT}`));
