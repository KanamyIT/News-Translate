// --- FIX for Node 18 + undici: define global Blob/File if missing ---
try {
  const { Blob, File } = require('buffer');
  if (typeof globalThis.Blob === 'undefined') globalThis.Blob = Blob;
  if (typeof globalThis.File === 'undefined') globalThis.File = File;
} catch { /* ignore */ }

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ===================== utils =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

const FROM = 'en';
const TO = 'ru';

// ===================== cache + limiter =====================
const trCache = new Map();
const TR_CACHE_MAX = 6000;

function cacheGet(k) { return trCache.get(k); }
function cacheSet(k, v) {
  trCache.set(k, v);
  if (trCache.size > TR_CACHE_MAX) {
    const first = trCache.keys().next().value;
    trCache.delete(first);
  }
}

// protect external API from spikes
const TR_CONCURRENCY = 2;
const TR_MIN_INTERVAL_MS = 120;
let trActive = 0;
let trLastStart = 0;
const trQueue = [];

function pumpTranslateQueue() {
  if (trActive >= TR_CONCURRENCY) return;
  const item = trQueue.shift();
  if (!item) return;

  trActive++;
  (async () => {
    try {
      const now = Date.now();
      const wait = Math.max(0, trLastStart + TR_MIN_INTERVAL_MS - now);
      if (wait) await sleep(wait);
      trLastStart = Date.now();

      const result = await item.task();
      item.resolve(result);
    } catch (e) {
      item.reject(e);
    } finally {
      trActive--;
      pumpTranslateQueue();
    }
  })();
}

function limitTranslate(task) {
  return new Promise((resolve, reject) => {
    trQueue.push({ task, resolve, reject });
    pumpTranslateQueue();
  });
}

// ===================== language heuristics =====================
function hasCyrillic(s) { return /[А-Яа-яЁё]/.test(String(s || '')); }
function looksEnglish(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (hasCyrillic(t)) return false;
  return /[A-Za-z]/.test(t);
}
function looksCodey(t) {
  const s = String(t || '');
  // явные операторы/скобки/синтаксис
  if (/[{};<>]|=>|::|->|===|!==/.test(s)) return true;
  // много символов без пробелов (часто код/идентификатор)
  const noSpaces = s.replace(/\s+/g, '');
  if (noSpaces.length >= 20 && !/\s/.test(s)) return true;
  return false;
}

// ===================== protect code tokens =====================
const CODE_WORDS = [
  'print', 'printf', 'console', 'console.log', 'document', 'window',
  'getElementById', 'querySelector',
  'function', 'return', 'let', 'const', 'var', 'class', 'new',
  'import', 'from', 'export', 'async', 'await',
  'def', 'None', 'True', 'False',
  'list', 'dict', 'tuple', 'set', 'str', 'int', 'float', 'bool',
  'HTTP', 'URL', 'JSON', 'API', 'Node.js', 'React', 'CSS', 'HTML', 'JS'
];

function protectCodeTokens(text) {
  const src = String(text || '');
  if (!src) return { protectedText: src, replacements: [] };

  const found = [];
  const add = (v) => { if (v && !found.includes(v)) found.push(v); };

  for (const m of src.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\b/g)) add(m[0]);
  for (const m of src.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) add(m[1]);

  for (const w of CODE_WORDS) {
    const re = new RegExp(`\\b${String(w).replace('.', '\\.')}\\b`, 'g');
    if (re.test(src)) add(w);
  }

  if (!found.length) return { protectedText: src, replacements: [] };

  found.sort((a, b) => b.length - a.length);

  let out = src;
  const replacements = [];
  found.forEach((token, idx) => {
    const ph = `@@CODE_${idx}@@`;
    replacements.push([ph, token]);
    const re = new RegExp(`\\b${String(token).replace('.', '\\.')}\\b`, 'g');
    out = out.replace(re, ph);
  });

  return { protectedText: out, replacements };
}

function restoreCodeTokens(text, replacements) {
  let out = String(text || '');
  for (const [ph, token] of replacements) out = out.replaceAll(ph, token);
  return out;
}

// ===================== translators =====================
async function translateWithRetry(fn, label) {
  const tries = 3;
  let last = null;

  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const base = [300, 800, 1500][i] || 1500;
      await sleep(base + rand(0, 250));
    }
  }

  const err = new Error(`${label} failed: ${last?.message || 'unknown'}`);
  err.cause = last;
  throw err;
}

async function myMemoryTranslateRaw(text) {
  const clean = String(text || '').trim();
  if (!clean) return clean;

  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(clean)}&langpair=${FROM}|${TO}`;
  const { data } = await axios.get(url, {
    timeout: 25000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Render; Node.js)' }
  });

  const status = Number(data?.responseStatus);
  const translated = String(data?.responseData?.translatedText || '').trim();

  if ((status && status !== 200) || !translated) {
    throw new Error(`MyMemory status=${status || 'unknown'}`);
  }

  return translated;
}

async function libreTranslateRaw(text) {
  const endpoint = String(process.env.LIBRETRANSLATE_URL || '').trim();
  if (!endpoint) throw new Error('LibreTranslate not configured');

  const payload = {
    q: String(text || ''),
    source: FROM,
    target: TO,
    format: 'text'
  };

  const apiKey = String(process.env.LIBRETRANSLATE_API_KEY || '').trim();
  if (apiKey) payload.api_key = apiKey;

  const { data } = await axios.post(endpoint, payload, {
    timeout: 30000,
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Render; Node.js)' }
  });

  const translated = String(data?.translatedText || '').trim();
  if (!translated) throw new Error('LibreTranslate empty');
  return translated;
}

async function translateShort(text) {
  const clean = String(text || '').trim();
  if (!clean) return clean;

  const cacheKey = `${FROM}|${TO}|${clean}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // MyMemory -> LibreTranslate -> original
  let tr = null;

  try {
    tr = await limitTranslate(() => translateWithRetry(() => myMemoryTranslateRaw(clean), 'MyMemory'));
  } catch {
    try {
      tr = await limitTranslate(() => translateWithRetry(() => libreTranslateRaw(clean), 'LibreTranslate'));
    } catch {
      tr = clean;
    }
  }

  cacheSet(cacheKey, tr);
  return tr;
}

// ===================== batching (HUGE speedup) =====================
const SEP = '\n@@@SPLIT@@@\n';
const SEP_RE = /\n@@@SPLIT@@@\n/g;

function normalizeText(t) {
  return String(t || '').replace(/\s+/g, ' ').trim();
}

function splitByBudget(items, maxChars = 1800) {
  const batches = [];
  let cur = [];
  let len = 0;

  for (const s of items) {
    const add = s.length + (cur.length ? SEP.length : 0);
    if (cur.length && len + add > maxChars) {
      batches.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(s);
    len += add;
  }

  if (cur.length) batches.push(cur);
  return batches;
}

async function translateBatch(list) {
  // protect tokens per line, then translate combined
  const protectedLines = [];
  const replPerLine = [];

  for (const line of list) {
    const { protectedText, replacements } = protectCodeTokens(line);
    protectedLines.push(protectedText);
    replPerLine.push(replacements);
  }

  const joined = protectedLines.join(SEP);
  const translatedJoined = await translateShort(joined);

  // if translator returned original joined (rate-limit), bail out as original
  if (!translatedJoined || translatedJoined === joined) {
    return list.slice();
  }

  // Split back; if split mismatch, fallback line-by-line to be safe
  const parts = translatedJoined.split(SEP_RE);
  if (parts.length !== list.length) {
    const out = [];
    for (let i = 0; i < list.length; i++) out.push(await translateShort(protectedLines[i]));
    return out.map((t, i) => restoreCodeTokens(t, replPerLine[i]));
  }

  return parts.map((t, i) => restoreCodeTokens(t, replPerLine[i]));
}

async function toRuIfNeeded(text) {
  const t = normalizeText(text);
  if (!t) return t;
  if (!looksEnglish(t)) return t;
  if (looksCodey(t)) return t;
  return await translateShort(t);
}

// ===================== HTML helpers =====================
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

function pickMainScope($, url) {
  const host = (() => {
    try { return new URL(url).hostname; } catch { return ''; }
  })();

  if (host.includes('wikipedia.org')) {
    const w = $('#mw-content-text').first();
    if (w.length) return w;
  }

  if (host.includes('w3schools.com')) {
    const main = $('#main').first();
    if (main.length) return main;
    const w3 = $('.w3-main').first();
    if (w3.length) return w3;
  }

  for (const sel of ['article', 'main', '#content', '#main', '.content', 'body']) {
    const el = $(sel).first();
    if (el.length) return el;
  }
  return $('body');
}

function cleanupScope($scope) {
  $scope.find('script,style,noscript,iframe').remove();
  $scope.find('nav,footer,header,aside,#leftmenu,#sidemenu,#topnav,.sidebar,.menu,.navigation').remove();
  $scope.find('.reflist,.reference,.mw-references-wrap,ol.references,.navbox,.infobox').remove();
  // often heavy tables
  $scope.find('table').slice(0, 6).remove(); // мягко: убираем первые большие таблицы (infobox и т.п.)
}

// Translate DOM text nodes with batching
async function translateTextNodesCheerio($, $root, baseUrl) {
  // Skip interactive/menu stuff to reduce segments drastically
  const SKIP = new Set([
    'script', 'style', 'noscript', 'pre', 'code', 'kbd', 'samp', 'var',
    'a', 'button', 'label', 'input', 'select', 'option', 'nav'
  ]);

  // images -> proxy (keep them)
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
  const uniq = new Map(); // normalized -> original sample

  nodes.each((_, node) => {
    if (node.type !== 'text') return;

    const parentTag = node.parent?.name ? String(node.parent.name).toLowerCase() : '';
    if (SKIP.has(parentTag)) return;

    const raw = node.data;
    if (!raw || !raw.trim()) return;

    const t = normalizeText(raw);
    if (!t) return;

    // Drop tiny pieces (big speed win)
    if (t.length < 20) return;

    if (!looksEnglish(t)) return;
    if (looksCodey(t)) return;

    if (!uniq.has(t)) uniq.set(t, t);
  });

  // Hard limit: translate only top N segments
  const keys = Array.from(uniq.keys()).slice(0, 180);

  const batches = splitByBudget(keys, 1800);
  const map = new Map();

  let translatedSegments = 0;
  for (const batch of batches) {
    const trs = await translateBatch(batch);
    for (let i = 0; i < batch.length; i++) {
      const src = batch[i];
      const tr = normalizeText(trs[i]);
      map.set(src, tr);
      if (tr && tr !== src) translatedSegments++;
    }
  }

  // replace
  nodes.each((_, node) => {
    if (node.type !== 'text') return;
    const parentTag = node.parent?.name ? String(node.parent.name).toLowerCase() : '';
    if (SKIP.has(parentTag)) return;

    const raw = node.data;
    if (!raw || !raw.trim()) return;

    const t = normalizeText(raw);
    if (!map.has(t)) return;

    const lead = raw.match(/^\s*/)?.[0] || '';
    const trail = raw.match(/\s*$/)?.[0] || '';
    node.data = lead + map.get(t) + trail;
  });

  // alt/title (translate short, but keep cheap)
  const imgs = $root.find('img');
  for (let i = 0; i < imgs.length; i++) {
    const $img = $(imgs[i]);
    const alt = $img.attr('alt');
    const title = $img.attr('title');
    if (alt) {
      const a = normalizeText(alt);
      if (a.length >= 6 && looksEnglish(a) && !looksCodey(a)) $img.attr('alt', await translateShort(a));
    }
    if (title) {
      const tt = normalizeText(title);
      if (tt.length >= 6 && looksEnglish(tt) && !looksCodey(tt)) $img.attr('title', await translateShort(tt));
    }
  }

  return { totalSegments: keys.length, translatedSegments, batches: batches.length };
}

// ===================== API =====================

// image proxy (keeps images visible, avoids CORS/hotlink)
app.get('/api/image', async (req, res) => {
  try {
    const url = String(req.query.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return res.status(400).end('bad url');

    const r = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Render; Node.js)' },
      maxContentLength: 5 * 1024 * 1024,
      maxBodyLength: 5 * 1024 * 1024
    });

    res.setHeader('Content-Type', r.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(r.data));
  } catch {
    res.status(404).end('image fetch failed');
  }
});

app.post('/api/translate-url', async (req, res) => {
  const t0 = Date.now();
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ success: false, error: 'URL не предоставлен' });

    // fetch
    const tFetch0 = Date.now();
    const response = await axios.get(url, {
      timeout: 35000,
      maxContentLength: 7 * 1024 * 1024,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      }
    });
    const fetchMs = Date.now() - tFetch0;

    // parse/extract
    const tExt0 = Date.now();
    const $ = cheerio.load(response.data);

    const rawTitle =
      $('meta[property="og:title"]').attr('content') ||
      $('h1').first().text().trim() ||
      $('title').text().trim() ||
      'Статья';

    const $scope = pickMainScope($, url);
    cleanupScope($scope);

    const $out = $('<div id="extracted"></div>');

    // smaller selector set to keep only relevant blocks
    const selector =
      'h1,h2,h3,h4,h5,h6,p,ul,ol,li,pre,code,blockquote,figure,img,figcaption,' +
      'div.w3-panel,div.w3-note,div.w3-example,div.w3-info,div.w3-warning';

    const els = $scope.find(selector).toArray();

    let added = 0;
    let charBudget = 0;

    const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
    const isWiki = host.includes('wikipedia.org');

    const MAX_ELEMS = isWiki ? 420 : 520;
    const MAX_CHARS = isWiki ? 65000 : 110000;

    for (const el of els) {
      if (added >= MAX_ELEMS || charBudget >= MAX_CHARS) break;

      const $el = $(el);
      const tag = (el.name || '').toLowerCase();

      if ($el.parents('nav,header,footer,aside').length) continue;

      // remove tiny divs (often UI)
      if (tag === 'div') {
        const tt = normalizeText($el.text());
        if (tt.length < 30) continue;
      }

      if (tag === 'p' || tag === 'li' || tag === 'div' || tag === 'pre') {
        const tt = normalizeText($el.text());
        if (!tt) continue;
        charBudget += tt.length;
      }

      $out.append($el.clone());
      added++;
    }

    $out.find('script,style,noscript,iframe').remove();
    removeOnAttributes($out);

    const htmlBefore = $out.html() || '';
    if (!htmlBefore || htmlBefore.trim().length < 120) {
      return res.status(500).json({
        success: false,
        error: 'Не удалось извлечь контент (страница пустая/защищена/селекторы не совпали).',
        debug: { extractedChars: htmlBefore.length, url }
      });
    }

    const extractMs = Date.now() - tExt0;

    // translate
    const tTr0 = Date.now();
    const segInfo = await translateTextNodesCheerio($, $out, url);
    const translateMs = Date.now() - tTr0;

    const titleRu = await toRuIfNeeded(rawTitle);

    res.json({
      success: true,
      title: titleRu,
      contentHtml: $out.html() || '',
      sourceUrl: url,
      debug: {
        ...segInfo,
        fetchMs,
        extractMs,
        translateMs,
        totalMs: Date.now() - t0
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: `Ошибка при переводе: ${e.message || 'unknown'}` });
  }
});

app.post('/api/translate-text', async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ success: false, error: 'Текст не предоставлен' });

    const t = normalizeText(text);
    if (!t) return res.json({ success: true, translated: '' });

    const translated = await translateShort(t);
    res.json({ success: true, translated });
  } catch (e) {
    res.status(500).json({ success: false, error: `Ошибка перевода: ${e.message || 'unknown'}` });
  }
});

// Weather (как было)
app.get('/api/weather', async (req, res) => {
  try {
    const city = String(req.query.city || 'Moscow');
    const { data } = await axios.get(
      `https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=ru`,
      { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 (Render; Node.js)', 'Accept-Language': 'ru' } }
    );

    const current = data?.current_condition?.[0];
    const area = data?.nearest_area?.[0];
    const desc = current?.lang_ru?.[0]?.value || current?.weatherDesc?.[0]?.value || '—';

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

// Articles
const ARTICLES = {
  programming: [
    { title: 'JavaScript Tutorial', url: 'https://www.w3schools.com/js/', titleRu: 'Учебник JavaScript' },
    { title: 'Python Tutorial', url: 'https://www.w3schools.com/python/', titleRu: 'Учебник Python' },
    { title: 'HTML Tutorial', url: 'https://www.w3schools.com/html/', titleRu: 'Учебник HTML' },
    { title: 'CSS Tutorial', url: 'https://www.w3schools.com/css/', titleRu: 'Учебник CSS' },
    { title: 'React Docs', url: 'https://react.dev/', titleRu: 'Документация React' },
    { title: 'Node.js Docs', url: 'https://nodejs.org/en/docs/', titleRu: 'Документация Node.js' }
  ],
  history: [
    { title: 'Ancient Rome', url: 'https://en.wikipedia.org/wiki/Ancient_Rome', titleRu: 'Древний Рим' },
    { title: 'Middle Ages', url: 'https://en.wikipedia.org/wiki/Middle_Ages', titleRu: 'Средние века' },
    { title: 'Renaissance', url: 'https://en.wikipedia.org/wiki/Renaissance', titleRu: 'Ренессанс' },
    { title: 'French Revolution', url: 'https://en.wikipedia.org/wiki/French_Revolution', titleRu: 'Французская революция' },
    { title: 'World War I', url: 'https://en.wikipedia.org/wiki/World_War_I', titleRu: 'Первая мировая война' },
    { title: 'World War II', url: 'https://en.wikipedia.org/wiki/World_War_II', titleRu: 'Вторая мировая война' }
  ],
  games: [
    { title: 'Video game', url: 'https://en.wikipedia.org/wiki/Video_game', titleRu: 'Видеоигра' },
    { title: 'Game design', url: 'https://en.wikipedia.org/wiki/Game_design', titleRu: 'Дизайн игры' },
    { title: 'Game Programming Patterns', url: 'https://gameprogrammingpatterns.com/', titleRu: 'Паттерны программирования игр' }
  ],
  cinema: [
    { title: 'History of film', url: 'https://en.wikipedia.org/wiki/History_of_film', titleRu: 'История кинематографа' },
    { title: 'Cinematography', url: 'https://en.wikipedia.org/wiki/Cinematography', titleRu: 'Кинематография' },
    { title: 'Film directing', url: 'https://en.wikipedia.org/wiki/Film_directing', titleRu: 'Режиссура фильма' }
  ]
};

app.get('/api/articles/:category', async (req, res) => {
  try {
    const { category } = req.params;
    const list = ARTICLES[category] || [];
    res.json({ success: true, articles: list.map(a => ({ ...a, title: a.titleRu || a.title })) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message || 'articles error' });
  }
});

app.get('/api/health', (req, res) => res.json({ success: true }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/translate', (req, res) => res.sendFile(path.join(__dirname, 'public', 'translate.html')));

app.use((req, res) => res.status(404).json({ success: false, error: 'Endpoint не найден' }));

app.listen(PORT, HOST, () => {
  console.log(`✅ Сервер запущен на http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`📡 API доступен на http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/api`);
});
