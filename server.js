// --- FIX for Node 18 + undici: define global Blob/File if missing ---
try {
  const { Blob, File } = require('buffer');
  if (typeof globalThis.Blob === 'undefined') globalThis.Blob = Blob;
  if (typeof globalThis.File === 'undefined') globalThis.File = File;
} catch {}

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

const FROM = 'en';
const TO = 'ru';

// ====== HARD limits to avoid 502 ======
const TRANSLATE_BUDGET_MS = Number(process.env.TRANSLATE_BUDGET_MS) || 12000; // 12s
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS) || 20000;       // 20s

// ====== cache ======
const trCache = new Map();
const TR_CACHE_MAX = 5000;
function cacheGet(k) { return trCache.get(k); }
function cacheSet(k, v) {
  trCache.set(k, v);
  if (trCache.size > TR_CACHE_MAX) trCache.delete(trCache.keys().next().value);
}

// ====== limiter ======
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

// ====== heuristics ======
function hasCyrillic(s) { return /[А-Яа-яЁё]/.test(String(s || '')); }
function looksEnglish(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (hasCyrillic(t)) return false;
  return /[A-Za-z]/.test(t);
}
function normalizeText(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }
function looksCodey(t) {
  const s = String(t || '');
  if (/[{};<>]|=>|::|->|===|!==/.test(s)) return true;
  return false;
}

// ====== token protection ======
const CODE_WORDS = [
  'print','printf','console','console.log','document','window','getElementById','querySelector',
  'function','return','let','const','var','class','new','import','from','export','async','await',
  'def','None','True','False','list','dict','tuple','set','str','int','float','bool',
  'HTTP','URL','JSON','API','Node.js','React','CSS','HTML','JS'
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

// ====== translators ======
async function translateWithRetry(fn, label) {
  const tries = 3;
  let last = null;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const base = [300, 800, 1500][i] || 1500;
      await sleep(base + rand(0, 250));
    }
  }
  throw new Error(`${label} failed: ${last?.message || 'unknown'}`);
}

async function myMemoryTranslateRaw(text) {
  const clean = String(text || '').trim();
  if (!clean) return clean;

  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(clean)}&langpair=${FROM}|${TO}`;
  const { data } = await axios.get(url, { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0' } });
  const status = Number(data?.responseStatus);
  const translated = String(data?.responseData?.translatedText || '').trim();
  if ((status && status !== 200) || !translated) throw new Error(`MyMemory status=${status || 'unknown'}`);
  return translated;
}

async function libreTranslateRaw(text) {
  const endpoint = String(process.env.LIBRETRANSLATE_URL || '').trim();
  if (!endpoint) throw new Error('LibreTranslate not configured');

  const payload = { q: String(text || ''), source: FROM, target: TO, format: 'text' };
  const apiKey = String(process.env.LIBRETRANSLATE_API_KEY || '').trim();
  if (apiKey) payload.api_key = apiKey;

  const { data } = await axios.post(endpoint, payload, {
    timeout: 15000,
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' }
  });

  const translated = String(data?.translatedText || '').trim();
  if (!translated) throw new Error('LibreTranslate empty');
  return translated;
}

async function translateShort(text) {
  const clean = String(text || '').trim();
  if (!clean) return clean;

  const key = `${FROM}|${TO}|${clean}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  let tr = clean;
  try {
    tr = await limitTranslate(() => translateWithRetry(() => myMemoryTranslateRaw(clean), 'MyMemory'));
  } catch {
    try {
      tr = await limitTranslate(() => translateWithRetry(() => libreTranslateRaw(clean), 'LibreTranslate'));
    } catch {
      tr = clean;
    }
  }

  cacheSet(key, tr);
  return tr;
}

// ====== batching ======
const SEP = '\n@@@SPLIT@@@\n';
const SEP_RE = /\n@@@SPLIT@@@\n/g;

function splitByBudget(items, maxChars = 1600) {
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

async function translateBatch(lines) {
  const protectedLines = [];
  const repls = [];

  for (const line of lines) {
    const { protectedText, replacements } = protectCodeTokens(line);
    protectedLines.push(protectedText);
    repls.push(replacements);
  }

  const joined = protectedLines.join(SEP);
  const translatedJoined = await translateShort(joined);

  // if failed, fallback per line
  const parts = translatedJoined.split(SEP_RE);
  if (parts.length !== lines.length) {
    const out = [];
    for (let i = 0; i < lines.length; i++) out.push(await translateShort(protectedLines[i]));
    return out.map((t, i) => restoreCodeTokens(t, repls[i]));
  }

  return parts.map((t, i) => restoreCodeTokens(t, repls[i]));
}

async function toRuIfNeeded(text) {
  const t = normalizeText(text);
  if (!t) return t;
  if (!looksEnglish(t)) return t;
  if (t.length < 6) return t;
  if (looksCodey(t)) return t;
  return await translateShort(t);
}

// ====== DOM helpers ======
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
  const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
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
}

// IMPORTANT: translate with time budget (prevents 502)
async function translateTextNodesCheerio($, $root, baseUrl, deadlineTs) {
  const SKIP = new Set([
    'script','style','noscript','pre','code','kbd','samp','var',
    'a','button','label','input','select','option','nav'
  ]);

  // images keep
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
  const uniq = new Map();

  nodes.each((_, node) => {
    if (node.type !== 'text') return;
    const parentTag = node.parent?.name ? String(node.parent.name).toLowerCase() : '';
    if (SKIP.has(parentTag)) return;

    const raw = node.data;
    if (!raw || !raw.trim()) return;

    const t = normalizeText(raw);

    // режем мусор
    if (t.length < 20) return;
    if (!looksEnglish(t)) return;
    if (looksCodey(t)) return;

    if (!uniq.has(t)) uniq.set(t, t);
  });

  const list = Array.from(uniq.keys()).slice(0, 160); // меньше сегментов = быстрее
  const batches = splitByBudget(list, 1600);

  const map = new Map();
  let translatedSegments = 0;
  let stoppedByBudget = false;

  for (const batch of batches) {
    if (Date.now() > deadlineTs) { stoppedByBudget = true; break; }
    const trs = await translateBatch(batch);
    for (let i = 0; i < batch.length; i++) {
      const src = batch[i];
      const tr = normalizeText(trs[i]);
      map.set(src, tr);
      if (tr && tr !== src) translatedSegments++;
    }
  }

  // apply replacements
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

  return { totalSegments: list.length, translatedSegments, batches: batches.length, stoppedByBudget };
}

// ===================== routes =====================

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

    const tFetch0 = Date.now();
    const response = await axios.get(url, {
      timeout: FETCH_TIMEOUT_MS,
      maxContentLength: 7 * 1024 * 1024,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8'
      }
    });
    const fetchMs = Date.now() - tFetch0;

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

    const selector =
      'h1,h2,h3,h4,h5,h6,p,ul,ol,li,pre,code,blockquote,figure,img,figcaption,' +
      'div.w3-panel,div.w3-note,div.w3-example,div.w3-info,div.w3-warning';

    const els = $scope.find(selector).toArray();

    let added = 0;
    let charBudget = 0;

    const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
    const isWiki = host.includes('wikipedia.org');

    const MAX_ELEMS = isWiki ? 360 : 460;
    const MAX_CHARS = isWiki ? 60000 : 95000;

    for (const el of els) {
      if (added >= MAX_ELEMS || charBudget >= MAX_CHARS) break;

      const $el = $(el);
      const tag = (el.name || '').toLowerCase();
      if ($el.parents('nav,header,footer,aside').length) continue;

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

    const extractMs = Date.now() - tExt0;

    const htmlBefore = $out.html() || '';
    if (!htmlBefore || htmlBefore.trim().length < 120) {
      return res.status(500).json({
        success: false,
        error: 'Не удалось извлечь контент (страница пустая/защищена/селекторы не совпали).',
        debug: { extractedChars: htmlBefore.length, url }
      });
    }

    // --- translate with time budget ---
    const tTr0 = Date.now();
    const deadline = Date.now() + TRANSLATE_BUDGET_MS;
    const segInfo = await translateTextNodesCheerio($, $out, url, deadline);
    const translateMs = Date.now() - tTr0;

    const titleRu = await toRuIfNeeded(rawTitle);

    res.json({
      success: true,
      title: titleRu,
      contentHtml: $out.html() || '',
      sourceUrl: url,
      debug: {
        fetchMs,
        extractMs,
        translateMs,
        totalMs: Date.now() - t0,
        ...segInfo
      }
    });
  } catch (e) {
    // не отдаём “пустой 502”: возвращаем нормальную ошибку JSON
    res.status(500).json({ success: false, error: e?.message || 'unknown' });
  }
});

app.get('/api/health', (req, res) => res.json({ success: true }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/translate', (req, res) => res.sendFile(path.join(__dirname, 'public', 'translate.html')));

app.use((req, res) => res.status(404).json({ success: false, error: 'Endpoint не найден' }));

app.listen(PORT, HOST, () => {
  console.log(`✅ http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});
