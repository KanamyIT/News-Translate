(() => {
  const byId = (id) => {
  if (!id || typeof id !== 'string') return null;
  const k = id.trim();
  if (!k) return null;
  return document.getElementById(k);
};

  const qsa = (sel) => Array.from(document.querySelectorAll(sel));

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
    const data = await r.json().catch(() => ({}));
    if (!r.ok && data && data.error) throw new Error(data.error);
    return data;
  }

  function setTheme(dark) {
    document.body.classList.toggle('dark', !!dark);
    localStorage.setItem('theme', dark ? 'dark' : 'light');
    const btn = byId('themeBtn');
    if (btn) btn.innerHTML = dark ? '<i class="fas fa-sun"></i> Тема' : '<i class="fas fa-moon"></i> Тема';
  }

  function switchTab(name) {
    qsa('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    qsa('.tab-content').forEach(p => p.classList.add('hidden'));
    const pane = byId(`${name}Tab`);
    if (pane) pane.classList.remove('hidden');
  }

  function setDirUI(prefix, from, to) {
    const enru = byId(`${prefix}DirEnRu`);
    const ruen = byId(`${prefix}DirRuEn`);
    if (enru) enru.classList.toggle('active', from === 'en' && to === 'ru');
    if (ruen) ruen.classList.toggle('active', from === 'ru' && to === 'en');
  }

  function showLoading(el, msg) {
    if (!el) return;
    el.innerHTML = `<div class="loading"><div class="spinner"></div> ${escapeHtml(msg || 'Загрузка...')}</div>`;
  }

  function showError(el, msg) {
    if (!el) return;
    el.innerHTML = `<div class="result"><h3 style="color:var(--orange);margin-bottom:10px">Ошибка</h3><p>${escapeHtml(msg || 'Ошибка')}</p></div>`;
  }

  // ====== STATE ======
  const state = {
    urlFrom: 'en', urlTo: 'ru',
    textFrom: 'en', textTo: 'ru'
  };

  // ====== WEATHER ======
  async function loadWeather() {
    const box = byId('weatherContent');
    if (!box) return;
    try {
      const data = await apiJson('/api/weather?city=Moscow');
      if (!data.success) throw new Error(data.error || 'weather error');

      const c = data.current || {};
      const forecast = Array.isArray(data.forecast) ? data.forecast : [];

      let html = `<div class="weather-now"><div style="font-size:30px;font-weight:900;margin:4px 0 8px">${Math.round(Number(c.tempC ?? 0))}°C</div>`;
      html += `<div style="font-weight:800">${escapeHtml(c.desc || '—')}</div>`;
      html += `<div style="opacity:.9;margin-top:6px">💧 ${escapeHtml(c.humidity ?? '—')}% • 💨 ${escapeHtml(c.windKmph ?? '—')} km/h</div>`;
      html += `</div>`;

      if (forecast.length) {
        html += `<div class="forecast">`;
        for (const d of forecast) {
          html += `<div class="day"><div class="d">${escapeHtml(d.date || '')}</div>`;
          html += `<div>${escapeHtml(d.minC ?? '—')}°…${escapeHtml(d.maxC ?? '—')}°</div>`;
          html += `<div style="opacity:.95">${escapeHtml(d.desc || '—')}</div></div>`;
        }
        html += `</div>`;
      }

      box.innerHTML = html;
    } catch (e) {
      box.innerHTML = `<div style="opacity:.9">Не удалось загрузить погоду</div>`;
    }
  }

  // ====== FACTS ======
  const FUN_FACTS = [
    'JavaScript был создан за 10 дней в 1995 году!',
    'Python получил имя от комедийного шоу Monty Python!',
    'Node.js позволяет использовать JavaScript на сервере!',
    'Git создан Линусом Торвальдсом, создателем Linux!',
    'HTML начинался с очень маленького набора тегов!'
  ];

  function showFact() {
    const el = byId('factText');
    if (!el) return;
    el.textContent = FUN_FACTS[Math.floor(Math.random() * FUN_FACTS.length)];
  }

  // ====== ARTICLES ======
  async function loadArticles(category) {
    const grid = byId('articlesGrid');
    if (!grid) return;

    showLoading(grid, 'Загружаю статьи...');

    try {
      const data = await apiJson(`/api/articles/${encodeURIComponent(category)}`);
      if (!data.success) throw new Error(data.error || 'articles error');

      const list = Array.isArray(data.articles) ? data.articles : [];
      if (!list.length) {
        grid.innerHTML = `<div class="muted">Пусто</div>`;
        return;
      }

      grid.innerHTML = list.map(a => `
        <div class="article" data-url="${escapeHtml(a.url || '')}">
          <h4>${escapeHtml(a.title || 'Без названия')}</h4>
          <div class="muted">${escapeHtml(a.url || '')}</div>
        </div>
      `).join('');

      grid.querySelectorAll('.article').forEach(card => {
        card.addEventListener('click', () => {
          const url = card.dataset.url || '';
          if (!url) return;
          // ✅ Открываем отдельную страницу статьи
          window.location.href = `/translate?url=${encodeURIComponent(url)}`;
        });
      });
    } catch (e) {
      grid.innerHTML = `<div class="muted">${escapeHtml(e.message || 'Ошибка')}</div>`;
    }
  }

  // ====== URL TRANSLATE ======
  async function translateUrlInto(outputEl) {
    const input = byId('urlInput');
    const url = String(input?.value || '').trim();
    if (!url) return alert('Вставь URL');

    showLoading(outputEl, 'Перевожу страницу...');

    try {
      const data = await apiJson('/api/translate-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, from: state.urlFrom, to: state.urlTo })
      });

      if (!data.success) throw new Error(data.error || 'translate error');

      const html = `
        <div class="translated-toolbar">
          <a class="small-btn" target="_blank" href="${escapeHtml(data.sourceUrl || url)}"><i class="fas fa-link"></i> Оригинал</a>
        </div>
        <div class="result translated">
          <h2 style="color:var(--orange);margin-bottom:10px">${escapeHtml(data.title || '')}</h2>
          ${data.contentHtml || '<div class="muted">Пусто</div>'}
        </div>
      `;
      outputEl.innerHTML = html;
    } catch (e) {
      showError(outputEl, e.message || 'Ошибка перевода');
    }
  }

  // ====== TEXT TRANSLATE ======
  async function translateTextInto(outputEl) {
    const text = String(byId('textInput')?.value || '').trim();
    if (!text) return alert('Вставь текст');

    showLoading(outputEl, 'Перевожу текст...');

    try {
      const data = await apiJson('/api/translate-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, from: state.textFrom, to: state.textTo })
      });

      if (!data.success) throw new Error(data.error || 'translate error');

      outputEl.innerHTML = `
        <div class="result">
          <div class="label">Оригинал</div>
          <p>${escapeHtml(text)}</p>
          <div class="label" style="margin-top:14px">Перевод</div>
          <p>${escapeHtml(data.translated || '')}</p>
        </div>
      `;
    } catch (e) {
      showError(outputEl, e.message || 'Ошибка перевода');
    }
  }

  // ====== INIT ======
  window.addEventListener('DOMContentLoaded', () => {
    setTheme(localStorage.getItem('theme') === 'dark');

    byId('themeBtn')?.addEventListener('click', () => {
      setTheme(!document.body.classList.contains('dark'));
    });

    // Tabs
    qsa('.tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        switchTab(btn.dataset.tab || 'articles');
      });
    });

    // Categories
    qsa('.cat-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        qsa('.cat-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        loadArticles(btn.dataset.category || 'programming');
      });
    });

    // Direction toggles
    byId('urlDirEnRu')?.addEventListener('click', () => { state.urlFrom = 'en'; state.urlTo = 'ru'; setDirUI('url', 'en', 'ru'); });
    byId('urlDirRuEn')?.addEventListener('click', () => { state.urlFrom = 'ru'; state.urlTo = 'en'; setDirUI('url', 'ru', 'en'); });
    byId('textDirEnRu')?.addEventListener('click', () => { state.textFrom = 'en'; state.textTo = 'ru'; setDirUI('text', 'en', 'ru'); });
    byId('textDirRuEn')?.addEventListener('click', () => { state.textFrom = 'ru'; state.textTo = 'en'; setDirUI('text', 'ru', 'en'); });

    setDirUI('url', state.urlFrom, state.urlTo);
    setDirUI('text', state.textFrom, state.textTo);

    // Actions
    byId('translateUrlBtn')?.addEventListener('click', () => translateUrlInto(byId('translatedArea') || byId('contentArea')));
    byId('translateTextBtn')?.addEventListener('click', () => translateTextInto(byId('textResultArea') || byId('contentArea')));

    // Startup
    showFact();
    setInterval(showFact, 15000);

    loadWeather();
    setInterval(loadWeather, 600000);

    loadArticles('programming');
  });
})();
