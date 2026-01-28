(() => {
  const byId = (id) => document.getElementById(id);

  const escapeHtml = (s) =>
    String(s ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');

  async function apiJson(url, options) {
    const r = await fetch(url, options);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
    return data;
  }

  function setActiveDir(from, to) {
    byId('dirEnRu')?.classList.toggle('active', from === 'en' && to === 'ru');
    byId('dirRuEn')?.classList.toggle('active', from === 'ru' && to === 'en');
  }

  function showLoading(msg) {
    const out = byId('out');
    if (!out) return;
    out.innerHTML = `<div class="loading"><div class="spinner"></div> ${escapeHtml(msg || 'Загрузка...')}</div>`;
  }

  function showError(msg) {
    const out = byId('out');
    if (!out) return;
    out.innerHTML = `<div class="result"><h3 style="color:var(--orange);margin-bottom:10px">Ошибка</h3><p>${escapeHtml(msg || 'Ошибка')}</p></div>`;
  }

  async function translateNow() {
    const input = byId('urlInput');
    const out = byId('out');
    const url = String(input?.value || '').trim();
    if (!url) return alert('Вставь URL');

    showLoading('Перевожу страницу...');

    try {
      const { from, to } = window.__dir || { from: 'en', to: 'ru' };

      const data = await apiJson('/api/translate-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, from, to })
      });

      if (!data.success) throw new Error(data.error || 'translate error');

      out.innerHTML = `
        <div class="translated-toolbar">
          <a class="small-btn" target="_blank" href="${escapeHtml(data.sourceUrl || url)}">Оригинал</a>
        </div>
        <div class="result translated">
          <h2 style="color:var(--orange);margin-bottom:10px">${escapeHtml(data.title || '')}</h2>
          ${data.contentHtml || '<div class="muted">Пусто</div>'}
        </div>
      `;
    } catch (e) {
      showError(e?.message || 'Ошибка перевода');
    }
  }

  function init() {
    window.__dir = { from: 'en', to: 'ru' };
    setActiveDir('en', 'ru');

    byId('dirEnRu')?.addEventListener('click', () => {
      window.__dir = { from: 'en', to: 'ru' };
      setActiveDir('en', 'ru');
    });

    byId('dirRuEn')?.addEventListener('click', () => {
      window.__dir = { from: 'ru', to: 'en' };
      setActiveDir('ru', 'en');
    });

    byId('goBtn')?.addEventListener('click', translateNow);
    byId('urlInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') translateNow();
    });

    // ✅ авто-запуск, если пришли из карточки: /translate?url=...
    const params = new URLSearchParams(window.location.search);
    const u = params.get('url');
    if (u) {
      byId('urlInput').value = u;
      translateNow();
    }
  }

  window.addEventListener('DOMContentLoaded', init);
})();
