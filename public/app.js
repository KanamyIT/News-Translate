(() => {
  const CAT_RU = {
    programming: 'программирование',
    history: 'история',
    games: 'игры',
    cinema: 'кино'
  };

  const FUN_FACTS = [
    "JavaScript был создан за 10 дней в 1995 году!",
    "Python получил имя от комедийного шоу Monty Python!",
    "Node.js позволяет использовать JavaScript на серверах!",
    "Git создан Линусом Торвальдсом, создателем Linux!",
    "HTML начинался с очень маленького набора тегов!"
  ];

  const byId = (id) => (id && typeof id === 'string' ? document.getElementById(id) : null);

  function escapeHtml(str) {
    return String(str ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  async function apiJson(url, options) {
    const r = await fetch(url, options);
    return await r.json();
  }

  function setTheme(dark) {
    document.body.classList.toggle('dark', !!dark);
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  }

  function setFact() {
    const el = byId('factText');
    if (!el) return;
    el.textContent = FUN_FACTS[Math.floor(Math.random() * FUN_FACTS.length)];
  }

  function showLoading() {
    const area = byId('contentArea');
    if (!area) return;
    area.innerHTML = `<div class="loading"><div class="spinner"></div> Загружаем и переводим...</div>`;
  }

  function showError(msg) {
    const area = byId('contentArea');
    if (!area) return;
    area.innerHTML = `
      <div class="result">
        <h3 style="color:var(--orange);margin-bottom:10px">Ошибка</h3>
        <p>${escapeHtml(msg)}</p>
      </div>
    `;
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

  // ---------- Weather ----------
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
    const nowEl = byId(nowElId);
    const fcEl = byId(fcElId);
    if (!nowEl || !fcEl) return;

    nowEl.textContent = 'Загрузка...';
    fcEl.innerHTML = '';

    try {
      const data = await apiJson('/api/weather?city=Moscow');
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

  // ---------- Cards page ----------
  async function loadCategory(category) {
    const grid = byId('articlesGrid');
    if (!grid) return;

    grid.innerHTML = `<div class="muted">Загрузка статей...</div>`;

    try {
      const data = await apiJson(`/api/articles/${encodeURIComponent(category)}`);
      const list = data.articles || [];

      if (!list.length) {
        grid.innerHTML = `<div class="muted">Нет статей</div>`;
        return;
      }

      const catLabel = CAT_RU[category] || category;

      grid.innerHTML = list.map(a => `
        <div class="article" data-url="${escapeHtml(a.url)}">
          <h4>${escapeHtml(a.title)}</h4>
          <div class="muted">${escapeHtml(catLabel)} • нажми чтобы открыть</div>
          <div class="muted" style="margin-top:8px">${escapeHtml(a.url)}</div>
        </div>
      `).join('');

      // 1 клик -> сразу на страницу перевода
      grid.querySelectorAll('.article').forEach(card => {
        card.addEventListener('click', () => {
          const url = card.dataset.url || '';
          window.location.href = `/translate?url=${encodeURIComponent(url)}`;
        });
      });
    } catch (e) {
      grid.innerHTML = `<div class="muted">Ошибка: ${escapeHtml(e?.message || 'network')}</div>`;
    }
  }

  // ---------- Translate page ----------
  let translateAbort = null;

  async function translateUrl() {
    const input = byId('urlInput');
    const url = (input?.value || '').trim();
    if (!url) return alert('Введите URL');

    try { translateAbort?.abort(); } catch {}
    translateAbort = new AbortController();

    showLoading();

    try {
      const r = await fetch('/api/translate-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
        signal: translateAbort.signal
      });

      const data = await r.json();
      if (!data.success) return showError(data.error || 'Не удалось перевести');

      const area = byId('contentArea');
      if (!area) return;

      area.innerHTML = `
        <div class="translated-toolbar">
          <button class="small-btn" id="speakBtn"><i class="fas fa-volume-up"></i> Озвучить</button>
          <button class="small-btn" id="ocrBtn"><i class="fas fa-eye"></i> OCR: перевести текст на картинках</button>
        </div>
        <div class="result translated">
          <h2 style="color:var(--orange);margin-bottom:10px">${escapeHtml(data.title || 'Статья')}</h2>
          ${data.contentHtml || '<p>Пусто</p>'}
        </div>
      `;

      byId('speakBtn')?.addEventListener('click', () => speak(data.title || ''));
      byId('ocrBtn')?.addEventListener('click', () => ocrTranslateImages());
      speak(data.title || '');
    } catch (e) {
      if (e?.name === 'AbortError') return;
      showError(e?.message || 'Ошибка сети');
    }
  }

  // ---------- OCR (optional) ----------
  let tesseractLoading = null;

  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve();
    if (tesseractLoading) return tesseractLoading;

    tesseractLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://unpkg.com/tesseract.js@5/dist/tesseract.min.js';
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });

    return tesseractLoading;
  }

  async function ocrTranslateImages() {
    const container = document.querySelector('#contentArea .translated');
    if (!container) return;

    const imgs = Array.from(container.querySelectorAll('img')).slice(0, 3);
    if (!imgs.length) return alert('Картинок не найдено');

    try {
      await loadTesseract();
    } catch {
      return alert('Не удалось загрузить OCR библиотеку');
    }

    for (const img of imgs) {
      if (img.dataset.ocrDone === '1') continue;
      img.dataset.ocrDone = '1';

      const box = document.createElement('div');
      box.className = 'ocr-box';
      box.innerHTML = `<div class="ocr-title">OCR перевод</div><div class="muted">Распознаю текст...</div>`;
      img.insertAdjacentElement('afterend', box);

      try {
        const r = await window.Tesseract.recognize(img.src, 'eng+rus');
        const text = (r?.data?.text || '').trim();

        if (!text) {
          box.innerHTML = `<div class="ocr-title">OCR перевод</div><div class="muted">Текста на картинке не найдено</div>`;
          continue;
        }

        const tr = await apiJson('/api/translate-text', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, from: 'en', to: 'ru' })
        });

        const translated = tr?.success ? (tr.translated || '') : text;

        box.innerHTML = `
          <div class="ocr-title">OCR перевод</div>
          <div class="muted"><b>Оригинал:</b> ${escapeHtml(text.slice(0, 600))}${text.length > 600 ? '…' : ''}</div>
          <div style="margin-top:8px"><b>Перевод:</b> ${escapeHtml(String(translated).slice(0, 600))}${String(translated).length > 600 ? '…' : ''}</div>
        `;
      } catch {
        box.innerHTML = `<div class="ocr-title">OCR перевод</div><div class="muted">Ошибка OCR</div>`;
      }
    }
  }

  // ---------- Init ----------
  document.addEventListener('DOMContentLoaded', () => {
    // theme
    setTheme(localStorage.getItem('theme') === 'dark');
    byId('themeBtn')?.addEventListener('click', () => setTheme(!document.body.classList.contains('dark')));

    // font (если ты не менял styles.css)
    document.body.style.fontFamily = `"Manrope", system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif`;

    // page routing
    const page = document.body.dataset.page;

    if (page === 'cards') {
      setFact();
      setInterval(setFact, 15000);
      updateWeatherInto('weatherNow', 'weatherForecast');

      document.querySelectorAll('.cat-btn').forEach(btn => {
        btn.addEventListener('click', () => loadCategory(btn.dataset.cat || ''));
      });
    }

    if (page === 'translate') {
      // автоперевод при заходе по /translate?url=...
      const params = new URLSearchParams(window.location.search);
      const url = params.get('url') || '';
      const input = byId('urlInput');
      if (input) input.value = url;

      byId('translateUrlBtn')?.addEventListener('click', translateUrl);
      byId('urlInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') translateUrl(); });

      if (url) translateUrl();
    }
  });
})();
