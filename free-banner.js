// Kibbo free-tools banner: a thin dismissible bar pointing to /free-to-try.
// Shown once the visitor scrolls into the "Our Core Tools" section (rather
// than immediately on load), via IntersectionObserver on .core-tools.
// Dismissal persists in localStorage, same pattern as cookie-consent.js.
// If the cookie consent banner is still showing when the trigger point is
// reached, this waits for it to be dismissed first, so the two never stack.
(function () {
  var DISMISS_KEY = 'kibbo_free_banner_dismissed';
  var TRIGGER_SELECTOR = '.core-tools';

  function isDismissed() {
    try { return window.localStorage.getItem(DISMISS_KEY) === 'true'; } catch (e) { return false; }
  }
  function setDismissed() {
    try { window.localStorage.setItem(DISMISS_KEY, 'true'); } catch (e) { /* ignore, e.g. storage blocked */ }
  }

  if (isDismissed()) return;

  var target = document.querySelector(TRIGGER_SELECTOR);
  if (!target) return; // section not present on this page

  var triggered = false;
  var reachedTrigger = false;

  function cookieBannerVisible() {
    return !!document.querySelector('.cookie-banner');
  }

  function showBanner() {
    var banner = document.createElement('div');
    banner.className = 'free-banner';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Free tools');

    var copy = document.createElement('p');
    copy.className = 'free-banner-copy';
    copy.textContent = 'Get free templates and generate your legal documents — no account needed.';

    var actions = document.createElement('div');
    actions.className = 'free-banner-actions';

    var cta = document.createElement('a');
    cta.href = '/free-to-try';
    cta.className = 'free-banner-btn';
    cta.textContent = 'Get started →';

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'free-banner-close';
    closeBtn.setAttribute('aria-label', 'Dismiss');
    closeBtn.innerHTML = '&times;';

    actions.appendChild(cta);
    actions.appendChild(closeBtn);
    banner.appendChild(copy);
    banner.appendChild(actions);
    document.body.appendChild(banner);

    // Trigger the slide-up transition on the next frame.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { banner.classList.add('is-visible'); });
    });

    closeBtn.addEventListener('click', function () {
      setDismissed();
      banner.classList.remove('is-visible');
      setTimeout(function () { banner.remove(); }, 220);
    });
  }

  function tryShow() {
    if (triggered || isDismissed() || cookieBannerVisible()) return;
    triggered = true;
    showBanner();
    io.disconnect();
    bodyObserver.disconnect();
  }

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        reachedTrigger = true;
        tryShow();
      }
    });
  }, { threshold: 0 });
  io.observe(target);

  // If the cookie banner was still up when the section came into view, tryShow()
  // above will have declined and the IntersectionObserver won't fire again on its
  // own once the user keeps scrolling past the section. Watch for the cookie
  // banner's removal instead, and show ours right after -- as long as the trigger
  // point was reached at some point, not only if it's still on screen right now.
  var bodyObserver = new MutationObserver(function () {
    if (reachedTrigger) tryShow();
  });
  bodyObserver.observe(document.body, { childList: true });
})();
