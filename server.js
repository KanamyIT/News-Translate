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

function translateCheerioTextNodes($, $root) {
  const SKIP = new Set(['script', 'style', 'noscript', 'pre', 'code', 'kbd', 'samp', 'var', 'input', 'textarea', 'button']);

  const nodes = $root.find('*').addBack().contents();
  nodes.each((_, node) => {
    if (node.type !== 'text') return;

    const parentTag = (node.parent && node.parent.name ? String(node.parent.name).toLowerCase() : '');
    if (SKIP.has(parentTag)) return;

    const raw = node.data;
    if (!raw || !raw.trim()) return;

    node.data = translator.translateText(raw);
  });
}

function buildCleanArticle($) {
  $('script, style, noscript').remove();

  const $scope =
    $('article').first().length ? $('article').first() :
    $('main').first().length ? $('main').first() :
    $('body');

  // убираем типичный мусор
  $scope.find('nav, footer, header, aside').remove();

  // собираем "нормальный" контент
  const $wrap = $('<div></div>');
  const sel = 'h1,h2,h3,p,ul,ol,li,pre,code,blockquote';

  $scope.find(sel).each((_, el) => {
    const tag = (el.name || '').toLowerCase();
    const text = $(el).text().trim();

    // отсекаем совсем короткий мусор
    if ((tag === 'p' || tag === 'li') && text.length < 20) return;

    $wrap.append($(el).clone());
  });

  // fallback: если получилось пусто
  if ($wrap.text().trim().length < 60) {
    $wrap.empty();
    $scope.find('p').each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > 30) $wrap.append(`<p>${text}</p>`);
    });
  }

  return $wrap;
}

// ====== API ======

app.post('/api/translate-url', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ success: false, error: 'URL не предоставлен' });

    const response = await axios.get(url, {
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Render; Node.js)' }
    });

    const $ = cheerio.load(response.data);

    const rawTitle =
      $('h1').first().text().trim() ||
      $('meta[property="og:title"]').attr('content') ||
      $('title').text().trim() ||
      'Статья';

    const $article = buildCleanArticle($);

    // переводим ТОЛЬКО текстовые узлы, не трогая code/pre
    translateCheerioTextNodes($, $article);

    res.json({
      success: true,
      title: translator.translateText(rawTitle),
      contentHtml: $article.html() || '<p>Не удалось извлечь контент.</p>',
      sourceUrl: url
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: `Ошибка при переводе: ${err.message || 'unknown'}`
    });
  }
});

app.post('/api/translate-text', (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ success: false, error: 'Текст не предоставлен' });

  res.json({ success: true, translated: translator.translateText(text) });
});

app.post('/api/translate-word', (req, res) => {
  const { word, direction } = req.body || {};
  if (!word) return res.status(400).json({ success: false, error: 'Слово не предоставлено' });

  const t = translator.translateWord(word, direction);
  res.json({ success: !!t, translation: t || 'Не найдено' });
});

// Погода: ТОЛЬКО через сервер (чтобы не ловить CORS на фронте)
app.get('/api/weather', async (req, res) => {
  try {
    const city = String(req.query.city || 'Moscow');
    const { data } = await axios.get(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Render; Node.js)' }
    });

    // ВАЖНО: это массивы, поэтому [0]
    const current = data.current_condition?.[0];
    const area = data.nearest_area?.[0];

    res.json({
      success: true,
      tempC: current?.temp_C,
      desc: current?.lang_ru?.[0]?.value || current?.weatherDesc?.[0]?.value || '—',
      humidity: current?.humidity,
      windKmph: current?.windspeedKmph,
      location: area?.areaName?.[0]?.value || city,
      country: area?.country?.[0]?.value || ''
    });
  } catch (err) {
    res.json({
      success: false,
      error: err.message || 'weather error'
    });
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
      { title: 'Средние века', url: 'https://en.wikipedia.org/wiki/Middle_Ages' },
      { title: 'Ренессанс', url: 'https://en.wikipedia.org/wiki/Renaissance' }
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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`✅ Server started on :${PORT}`));
