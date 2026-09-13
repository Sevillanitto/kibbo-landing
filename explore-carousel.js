// "Explore by problem" carousel — index.html only.
// Mouse click-and-drag scrolling + arrow-button navigation.
// Native overflow-x:auto already handles touch/trackpad scrolling.
(() => {
  const track = document.getElementById('exploreTrack');
  if (!track) return;

  const arrows = Array.from(document.querySelectorAll('.explore-arrow'));
  arrows.forEach(btn => {
    btn.addEventListener('click', () => {
      const dir = Number(btn.dataset.dir);
      const card = track.querySelector('.explore-card');
      const cardWidth = card ? card.getBoundingClientRect().width : 260;
      const gap = 24;
      track.scrollBy({ left: dir * (cardWidth + gap), behavior: 'smooth' });
    });
  });

  let isDown = false;
  let startX = 0;
  let startScrollLeft = 0;
  let dragged = false;

  track.addEventListener('mousedown', (e) => {
    isDown = true;
    dragged = false;
    track.classList.add('dragging');
    startX = e.pageX;
    startScrollLeft = track.scrollLeft;
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDown) return;
    e.preventDefault();
    const dx = e.pageX - startX;
    if (Math.abs(dx) > 4) dragged = true;
    track.scrollLeft = startScrollLeft - dx;
  });

  window.addEventListener('mouseup', () => {
    if (!isDown) return;
    isDown = false;
    track.classList.remove('dragging');
  });

  // Suppress the click-through navigation on a card when the mouse
  // action was actually a drag, not a click.
  track.addEventListener('click', (e) => {
    if (dragged) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
})();
