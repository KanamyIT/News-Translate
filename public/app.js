const facts = [
  "JavaScript был создан за 10 дней в 1995 году!",
  "Python получил имя от комедийного шоу Monty Python!",
  "Node.js позволяет использовать JavaScript на серверах!",
  "Git создан Линусом Торвальдсом, создателем Linux!",
  "HTML начинался с очень маленького набора тегов!"
];

const $ = (id) => document.getElementById(id);

function setFact() {
  $('factText').textContent = facts[Math.floor(Math.random() * facts.length)];
}

function setTheme(dark) {
  document.body.classList.toggle('dark', dark);
  localStorage.setItem('theme', dark ? 'dark' : 'light');
}

function speak(text) {
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text || ''));
    u.lang = 'ru-RU';
    u.rate = 0.95;
    window.speechSynthesis.speak(u);
  } catch {}
}

function showLoading() {
  $('contentArea').innerHTML = `<div class="loading"><div class="spinner"></div> Загружаем и переводим...</div>`;
}

function showError(msg) {
  $('contentArea').innerHTML = `<div class="result"><h3 style="color:var(--orange);margin-bottom:10px">Ошибка</h3><p>${escapeHtml(msg)}</p></div>`;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#039;");
}

// ---------------- Tabs ----------------
function switchTab(tab) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  $(`${tab}-tab`).classList.remove('hidden');

  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.tab-btn[data-tab="${tab}"]`).classList.add('active');

  if (tab === 'weather') updateWeatherAll();
}

// ---------------- Articles ----------------
async function loadCategory(category) {
  const grid = $('articlesGrid');
  grid.innerHTML = `<div class="muted">Загрузка статей...</div>`;

  try {
    const r = await fetch(`/api/articles/${category}`);
    const data = await r.json();
    const list = data.articles || [];

    if (!list.length) {
      grid.innerHTML = `<div class="muted">Нет статей</div>`;
      return;
    }

    grid.innerHTML = list.map(a => `
      <div class="article" data-url="${escapeHtml(a.url)}">
        <h4>${escapeHtml(a.title)}</h4>
        <div class="muted">${escapeHtml(category)} • нажми чтобы открыть</div>
        <div class="muted" style="margin-top:8px">${escapeHtml(a.url)}</div>
      </div>
    `).join('');

    grid.querySelectorAll('.article').forEach(card => {
      card.addEventListener('click', () => {
        $('urlInput').value = card.dataset.url;
        translateUrl();
      });
    });
  } catch (e) {
    grid.innerHTML = `<div class="muted">Ошибка: ${escapeHtml(e.message || '')}</div>`;
  }
}

// ---------------- Translate URL ----------------
async function translateUrl() {
  const url = $('urlInput').value.trim();
  if (!url) return alert('Введите URL');

  showLoading();

  try {
    const r = await fetch('/api/translate-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await r.json();

    if (!data.success) return showError(data.error || 'Не удалось перевести');

    $('contentArea').innerHTML = `
      <div class="translated-toolbar">
        <button class="small-btn" id="speakBtn"><i class="fas fa-volume-up"></i> Озвучить</button>
        <button class="small-btn" id="ocrBtn"><i class="fas fa-eye"></i> OCR: перевести текст на картинках</button>
      </div>
      <div class="result translated">
        <h2 style="color:var(--orange);margin-bottom:10px">${escapeHtml(data.title)}</h2>
        ${data.contentHtml}
      </div>
    `;

    $('speakBtn').addEventListener('click', () => speak(data.title));
    $('ocrBtn').addEventListener('click', () => ocrTranslateImages());

    speak(data.title);
  } catch (e) {
    showError(e.message || 'Ошибка сети');
  }
}

// ---------------- Translate text ----------------
async function translateText() {
  const text = $('textInput').value.trim();
  if (!text) return alert('Введите текст');

  try {
    const r = await fetch('/api/translate-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, from: 'en', to: 'ru' })
    });
    const data = await r.json();
    if (!data.success) return alert(data.error || 'Ошибка');

    const box = $('textResult');
    box.classList.remove('hidden');
    box.innerHTML = `<h3 style="color:var(--orange);margin-bottom:10px">Перевод</h3><p>${escapeHtml(data.translated)}</p>`;
    speak(data.translated);
  } catch (e) {
    alert(e.message || 'Ошибка');
  }
}

// ---------------- Translate word ----------------
async function translateWord(word, direction, outEl) {
  const w = String(word || '').trim();
  if (!w) { outEl.classList.add('hidden'); return; }

  try {
    const r = await fetch('/api/translate-word', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ word: w, direction })
    });
    const data = await r.json();

    outEl.classList.remove('hidden');
    outEl.textContent = data.success ? data.translation : 'Не найдено';
  } catch {
    outEl.classList.remove('hidden');
    outEl.textContent = 'Ошибка';
  }
}

// ---------------- Weather ----------------
function renderForecast(list) {
  if (!Array.isArray(list) || !list.length) return '';
  return list.map(d => `
    <div class="day">
      <div class="d">${escapeHtml(d.date || '')}</div>
      <div class="row">Мин: ${escapeHtml(d.minC ?? '—')}°C • Макс: ${escapeHtml(d.maxC ?? '—')}°C</div>
      <div class="row">${escapeHtml(d.desc || '—')}</div>
    </div>
  `).join('');
}

async function updateWeatherInto(nowElId, fcElId) {
  const nowEl = $(nowElId);
  const fcEl = $(fcElId);
  nowEl.textContent = 'Загрузка...';
  fcEl.innerHTML = '';

  try {
    const r = await fetch('/api/weather?city=Moscow');
    const data = await r.json();
    if (!data.success) throw new Error(data.error || 'weather');

    nowEl.innerHTML = `
      <div style="font-size:30px;font-weight:900;margin:4px 0 10px">${Math.round(Number(data.current?.tempC ?? 0))}°C</div>
      <div>Состояние: ${escapeHtml(data.current?.desc || '—')}</div>
      <div>Влажность: ${escapeHtml(data.current?.humidity || '—')}%</div>
      <div>Ветер: ${escapeHtml(data.current?.windKmph || '—')} км/ч</div>
      <div>Город: ${escapeHtml(data.location || 'Москва')}</div>
    `;

    fcEl.innerHTML = renderForecast(data.forecast || []);
  } catch {
    nowEl.textContent = 'Ошибка загрузки погоды';
  }
}

async function updateWeatherAll() {
  await updateWeatherInto('weatherNow', 'weatherForecast');
  await updateWeatherInto('weatherNowTab', 'weatherForecastTab');
}

// ---------------- OCR images (optional) ----------------
let tesseractLoaded = false;
function loadTesseract() {
  return new Promise((resolve, reject) => {
    if (tesseractLoaded && window.Tesseract) return resolve();
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/tesseract.js@5/dist/tesseract.min.js';
    s.onload = () => { tesseractLoaded = true; resolve(); };
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function ocrTranslateImages() {
  const container = document.querySelector('#contentArea .translated');
  if (!container) return;

  const imgs = Array.from(container.querySelectorAll('img')).slice(0, 3); // ограничим, чтобы не убить браузер
  if (!imgs.length) return alert('Картинок не найдено');

  try {
    await loadTesseract();
  } catch {
    return alert('Не удалось загрузить OCR библиотеку');
  }

  for (const img of imgs) {
    // уже делали OCR — пропустим
    if (img.dataset.ocrDone === '1') continue;
    img.dataset.
