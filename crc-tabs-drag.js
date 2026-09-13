// Drag-to-scroll for horizontally-scrollable category tab/filter rows
// (.crc-tabs on templates/checklists/calculators/questions, .blog-filter-row
// on blog.html) whose visible scrollbar is hidden via CSS. Same mouse
// click-and-drag technique as the homepage's "Explore by problem" carousel
// -- see explore-carousel.js. Native overflow-x:auto already handles
// touch/trackpad scrolling and vertical wheel-scroll on its own.
(function () {
  var tracks = document.querySelectorAll('.crc-tabs, .blog-filter-row');

  tracks.forEach(function (track) {
    var isDown = false;
    var startX = 0;
    var startScrollLeft = 0;
    var dragged = false;

    track.addEventListener('mousedown', function (e) {
      isDown = true;
      dragged = false;
      track.classList.add('dragging');
      startX = e.pageX;
      startScrollLeft = track.scrollLeft;
    });

    window.addEventListener('mousemove', function (e) {
      if (!isDown) return;
      e.preventDefault();
      var dx = e.pageX - startX;
      if (Math.abs(dx) > 4) dragged = true;
      track.scrollLeft = startScrollLeft - dx;
    });

    window.addEventListener('mouseup', function () {
      if (!isDown) return;
      isDown = false;
      track.classList.remove('dragging');
    });

    // Suppress the click-through tab/pill selection when the mouse action
    // was actually a drag, not a click -- same guard as explore-carousel.js.
    track.addEventListener('click', function (e) {
      if (dragged) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
  });
})();
