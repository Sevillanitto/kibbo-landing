/* ============================================================
   Kibbo — Directory page accordion (defensive fallback)
   Every modern browser (Chrome 90+, Firefox 101+, Safari 15.4+) already
   auto-opens an ancestor <details> natively when the page is navigated
   directly to a fragment whose target lives inside it, and scrolls it
   into view on its own. Confirmed working before this script was written.
   This script exists only as a safety net for the rare browser without
   that native "reveal" behavior, and for same-page hash changes (a click
   on a link to "#some-id" on a page you're already on, which some
   browsers don't re-run the native reveal for). If the target is already
   visible, this does nothing.
   Shared across every /directory/*.html page -- no per-page copy needed.
   ============================================================ */
(function () {
  'use strict';

  function revealTarget(hash) {
    if (!hash || hash.length < 2) return;
    var id = decodeURIComponent(hash.slice(1));
    var target = document.getElementById(id);
    if (!target) return;

    var needsScroll = false;
    var el = target;
    while (el) {
      if (el.tagName === 'DETAILS' && !el.open) {
        el.open = true;
        needsScroll = true;
      }
      el = el.parentElement;
    }
    if (needsScroll) target.scrollIntoView();
  }

  revealTarget(window.location.hash);
  window.addEventListener('hashchange', function () {
    revealTarget(window.location.hash);
  });
})();
