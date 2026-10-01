// Renders content from /data/resources.json. Editing that JSON file is the
// only thing needed to update the directory — this script and the page
// shells never need to change.
//
// Two jobs, driven by data attributes already in the page HTML:
//   [data-resource-count="<slug>"]  (index page cards)   -> filled with "N resources"
//   [data-resource-list="<slug>"]   (category page)      -> filled with the resource list or an empty-state message
(function () {
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  fetch('/data/resources.json')
    .then(r => r.json())
    .then(data => {
      const categories = data.categories || [];

      document.querySelectorAll('[data-resource-count]').forEach(el => {
        const slug = el.getAttribute('data-resource-count');
        const cat = categories.find(c => c.slug === slug);
        const n = cat ? cat.resources.length : 0;
        el.textContent = `${n} resource${n === 1 ? '' : 's'}`;
      });

      const listEl = document.querySelector('[data-resource-list]');
      if (listEl) {
        const slug = listEl.getAttribute('data-resource-list');
        const cat = categories.find(c => c.slug === slug);
        const resources = cat ? cat.resources : [];
        if (resources.length === 0) {
          listEl.innerHTML = '<p class="resource-empty">No resources listed yet. Know a good one? <a href="/resources/submit/">Submit it →</a></p>';
        } else {
          listEl.innerHTML = resources.map(r => `
            <div class="resource-item">
              <h3 class="resource-name">${esc(r.name)}</h3>
              <p class="resource-desc">${esc(r.description)}</p>
              <div class="resource-meta"><span>${esc(r.country)}</span><span>${esc(r.type)}</span></div>
              <a href="${esc(r.url)}" class="resource-link" target="_blank" rel="noopener">Visit website →</a>
            </div>
          `).join('');
        }
      }
    })
    .catch(() => {
      const listEl = document.querySelector('[data-resource-list]');
      if (listEl) listEl.innerHTML = '<p class="resource-empty">Couldn\'t load resources right now. Try reloading the page.</p>';
    });
})();
