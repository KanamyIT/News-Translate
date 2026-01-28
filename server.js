// --- FIX for Node 18 + undici: define global Blob/File if missing ---
try {
  const { Blob, File } = require('buffer');
  if (typeof globalThis.Blob === 'undefined') globalThis.Blob = Blob;
  if (typeof globalThis.File === 'undefined') globalThis.File = File;
} catch (e) {
  // ignore
}


const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // Render: обязательно 0.0.0.0

// ==================== MIDDLEWARE ====================
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ==================== SMALL UTILS ====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ==================== TRANSLATION SYSTEM ====================

// Кэш переводов (простая защита от разрастания)
const trCache = new Map();
const TR_CACHE_MAX = 2500;
function cacheSet(key, val) {
  trCache.set(key, val);
  if (trCache.size > TR_CACHE_MAX) {
    const firstKey = trCache.keys().next().value;
    trCache.delete(firstKey);
  }
}

// Лимитер запросов к MyMemory (чтобы не ловить rate limit)
const TR_CONCURRENCY = 2;
const TR_MIN_INTERVAL_MS = 140;

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

// Перевод через MyMemory API
async function myMemoryTranslate(text, from = 'en', to = 'ru') {
  const clean = String(text || '').trim();
  if (!clean) return clean;

  const key = `${from}|${to}|${clean}`;
  if (trCache.has(key)) return trCache.get(key);

  return limitTranslate(async () => {
    try {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(clean)}&langpair=${from}|${to}`;
      const { data } = await axios.get(url, {
        timeout: 25000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
        }
      });

      const status = Number(data?.responseStatus);
      if (status && status !== 200) {
        // 403 часто означает лимит/блок — возвращаем оригинал
        return clean;
      }

      const translated = data?.responseData?.translatedText || clean;
      cacheSet(key, translated);
      return translated;
    } catch (err) {
      return clean;
    }
  });
}

// Разделение текста на части для перевода
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

// Перевод длинного текста
async function translateLong(text, from = 'en', to = 'ru') {
  const chunks = splitText(text, 480);
  let out = '';
  for (const ch of chunks) {
    out += await myMemoryTranslate(ch, from, to).catch(() => ch);
  }
  return out;
}

// Проверка на кириллицу
function hasCyrillic(s) {
  return /[А-Яа-яЁё]/.test(String(s || ''));
}

// Проверка на английский
function looksEnglish(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (hasCyrillic(t)) return false;
  return /[A-Za-z]/.test(t);
}

// Защита кодовых токенов (чтобы не переводить имена функций/методов)
const CODE_WORDS = [
  'print', 'printf', 'echo', 'console', 'console.log', 'document', 'window',
  'getElementById', 'querySelector', 'function', 'return', 'let', 'const',
  'var', 'class', 'new', 'import', 'from', 'export', 'async', 'await', 'def'
];

function protectCodeTokens(text) {
  const src = String(text || '');
  if (!src) return { protectedText: src, replacements: [] };

  const found = [];
  const add = (v) => {
    if (v && !found.includes(v)) found.push(v);
  };

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

// Основная функция перевода (EN -> RU если надо)
async function toRuIfNeeded(text) {
  const t = String(text || '').trim();
  if (!t) return t;
  if (!looksEnglish(t)) return t;

  const { protectedText, replacements } = protectCodeTokens(t);
  const tr = await translateLong(protectedText, 'en', 'ru');
  return restoreCodeTokens(tr, replacements);
}

// ==================== HELPERS ====================

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

// ==================== API ROUTES ====================

// Image proxy
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

// Translate URL endpoint
function pickMainScope($, url) {
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();

  if (host.includes('wikipedia.org')) {
    const w = $('#mw-content-text').first();
    if (w.length) return w;
  }

  if (host.includes('w3schools.com')) {
    // у W3Schools часто основной контент в #main
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
}

async function translateTextNodesCheerio($, $root, baseUrl) {
  const SKIP = new Set(['script', 'style', 'noscript', 'pre', 'code', 'kbd', 'samp', 'var']);

  // Обработка изображений
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
  });

  // 1) Собираем уникальные текстовые сегменты
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

    // Отсекаем "похожее на код"
    if (/[{};<>]|=>|::|->|===|!==/.test(t)) return;

    // Слишком короткие куски (типа "Next", "Home") часто мусорят
    if (t.length < 3) return;

    uniq.add(t);
  });

  // Жёсткий лимит, чтобы не убить переводчик
  const list = Array.from(uniq).slice(0, 700);
  const map = new Map();

  // 2) Переводим сегменты (с лимитером внутри myMemoryTranslate)
  for (const t of list) {
    if (hasCyrillic(t)) {
      map.set(t, t);
      continue;
    }
    map.set(t, await toRuIfNeeded(t));
  }

  // 3) Подставляем переводы обратно
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

  // Перевод alt и title для изображений
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
      timeout: 35000,
      maxContentLength: 6 * 1024 * 1024,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      }
    });

    const $ = cheerio.load(response.data);

    const rawTitle =
      $('meta[property="og:title"]').attr('content') ||
      $('h1').first().text().trim() ||
      $('title').text().trim() ||
      'Статья';

    const $scope = pickMainScope($, url);
    cleanupScope($scope);

    // ✅ КРИТИЧНОЕ ИСПРАВЛЕНИЕ:
    // Было: const $out = $('');  -> это пустой selection, append туда ничего не добавляет.
    // Должно быть: реальный контейнер-элемент.
    const $out = $('<div id="extracted"></div>');

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

    const htmlBefore = $out.html() || '';
    if (!htmlBefore || htmlBefore.trim().length < 120) {
      return res.status(500).json({
        success: false,
        error: 'Не удалось извлечь контент (страница пустая/защищена/селекторы не совпали).',
        debug: { extractedChars: htmlBefore.length, url }
      });
    }

    await translateTextNodesCheerio($, $out, url);

    res.json({
      success: true,
      title: await toRuIfNeeded(rawTitle),
      contentHtml: $out.html() || '\n\nНе удалось извлечь контент.',
      sourceUrl: url
    });
  } catch (e) {
    res.status(500).json({ success: false, error: `Ошибка при переводе: ${e.message || 'unknown'}` });
  }
});

// Translate text endpoint
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

// Weather endpoint
app.get('/api/weather', async (req, res) => {
  try {
    const city = String(req.query.city || 'Moscow');
    const { data } = await axios.get(
      `https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=ru`,
      {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Render; Node.js)',
          'Accept-Language': 'ru'
        }
      }
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

// Articles endpoint (готовые RU заголовки — чтобы не зависеть от MyMemory)
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
    const out = list.map((a) => ({ ...a, title: a.titleRu || a.title }));
    res.json({ success: true, articles: out });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message || 'articles error' });
  }
});

// Health check
app.get('/api/health', (req, res) => res.json({ success: true }));

// Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/translate', (req, res) => res.sendFile(path.join(__dirname, 'public', 'translate.html')));

// 404
app.use((req, res) => res.status(404).json({ success: false, error: 'Endpoint не найден' }));

// Start server
app.listen(PORT, HOST, () => {
  console.log(`✅ Сервер запущен на http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`📡 API доступен на http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/api`);
  console.log(`🌐 Для Render.com: Слушаю на ${HOST}:${PORT}`);
});
