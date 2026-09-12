// Kibbo floating navbar dropdowns — shared sitewide (extracted from the
// index.html implementation; behavior unchanged). See CLAUDE.md.
(() => {
  const navLinks = document.querySelector('.kibbo-nav-links');
  if (!navLinks) return;
  const items = Array.from(navLinks.querySelectorAll('.kibbo-nav-item'));

  function closeAll() {
    items.forEach(btn => {
      btn.setAttribute('aria-expanded', 'false');
      btn.classList.remove('is-open');
    });
    navLinks.querySelectorAll('.kibbo-dropdown').forEach(p => p.classList.remove('is-open'));
  }

  items.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = btn.dataset.dropdown;
      const panel = navLinks.querySelector('.kibbo-dropdown[data-panel="' + key + '"]');
      const isOpen = btn.classList.contains('is-open');
      closeAll();
      if (!isOpen && panel) {
        btn.classList.add('is-open');
        btn.setAttribute('aria-expanded', 'true');
        panel.classList.add('is-open');
      }
    });
  });

  document.addEventListener('click', (e) => {
    if (!navLinks.contains(e.target)) closeAll();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAll();
  });

  const hamburger = document.querySelector('.kibbo-hamburger');
  const mobileMenu = document.querySelector('.kibbo-mobile-menu');
  if (hamburger && mobileMenu) {
    hamburger.addEventListener('click', () => {
      const open = mobileMenu.classList.toggle('is-open');
      hamburger.setAttribute('aria-expanded', open ? 'true' : 'false');
      hamburger.classList.toggle('is-open', open);
    });
  }
})();
