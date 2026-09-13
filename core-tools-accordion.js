// "Our Core Tools" accordion — index.html only.
// Only one row open at a time; smooth expand/collapse via CSS grid-template-rows.
(() => {
  const accordion = document.getElementById('coreToolsAccordion');
  if (!accordion) return;

  const rows = Array.from(accordion.querySelectorAll('[data-row]'));

  rows.forEach(row => {
    const toggle = row.querySelector('[data-toggle]');
    toggle.addEventListener('click', () => {
      const isOpen = row.classList.contains('is-open');
      rows.forEach(r => r.classList.remove('is-open'));
      if (!isOpen) row.classList.add('is-open');
    });
  });
})();
