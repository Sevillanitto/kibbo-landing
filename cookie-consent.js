// Kibbo cookie consent banner + gated Google Analytics loader.
// Included site-wide via <script src="/cookie-consent.js" defer></script>
// in every page's <head>, replacing the old unconditional inline GA
// snippet. GA (gtag.js) is only fetched from the network when consent
// has been recorded as "accepted" -- either just now via the banner, or
// from a prior visit. "declined" (or no choice yet) means the gtag.js
// script tag is never inserted into the DOM, so it never loads.
(function () {
  var GA_ID = 'G-N0QKW8L27Y';
  var CONSENT_KEY = 'kibbo_cookie_consent';

  // Stub dataLayer/gtag immediately so any future inline gtag(...) calls
  // elsewhere on a page never throw, even before/if GA itself loads.
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;

  function getConsent() {
    try { return window.localStorage.getItem(CONSENT_KEY); } catch (e) { return null; }
  }
  function setConsent(value) {
    try { window.localStorage.setItem(CONSENT_KEY, value); } catch (e) { /* ignore, e.g. storage blocked */ }
  }

  var gaLoaded = false;
  function loadGA() {
    if (gaLoaded) return;
    gaLoaded = true;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
    gtag('js', new Date());
    gtag('config', GA_ID);
  }

  function showBanner() {
    var banner = document.createElement('div');
    banner.className = 'cookie-banner';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Cookie consent');

    var copy = document.createElement('p');
    copy.className = 'cookie-banner-copy';
    copy.textContent = 'We use cookies to understand how visitors use Kibbo, mainly via Google Analytics. No ad tracking, nothing sold to third parties. ';
    var link = document.createElement('a');
    link.href = '/cookie-policy.html';
    link.textContent = 'Cookie Policy';
    copy.appendChild(link);

    var actions = document.createElement('div');
    actions.className = 'cookie-banner-actions';

    var declineBtn = document.createElement('button');
    declineBtn.type = 'button';
    declineBtn.className = 'cookie-banner-btn cookie-banner-decline';
    declineBtn.textContent = 'Decline';

    var acceptBtn = document.createElement('button');
    acceptBtn.type = 'button';
    acceptBtn.className = 'cookie-banner-btn cookie-banner-accept';
    acceptBtn.textContent = 'Accept';

    actions.appendChild(declineBtn);
    actions.appendChild(acceptBtn);
    banner.appendChild(copy);
    banner.appendChild(actions);
    document.body.appendChild(banner);

    acceptBtn.addEventListener('click', function () {
      setConsent('accepted');
      loadGA();
      banner.remove();
    });
    declineBtn.addEventListener('click', function () {
      setConsent('declined');
      banner.remove();
    });
  }

  var consent = getConsent();
  if (consent === 'accepted') {
    loadGA();
  } else if (consent !== 'declined') {
    showBanner();
  }
  // consent === 'declined': do nothing -- GA never loads, banner never shows.
})();
