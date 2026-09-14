/* Filtering for /side-quests/.
 *
 * Progressive enhancement only: the list, the progress bars and the counts are
 * all rendered by Liquid at build time. Without this file every quest is
 * simply visible, which is the correct fallback for a list of 24 things.
 */
(function () {
  'use strict';

  var root = document.getElementById('quests');
  if (!root) { return; }

  var chips = document.getElementById('chips');
  var list = document.getElementById('qlist');
  if (!chips || !list) { return; }

  var items = Array.prototype.slice.call(list.querySelectorAll('.q'));
  var themeButtons = Array.prototype.slice.call(
    chips.querySelectorAll('.chip[data-theme]'));
  var doneToggle = document.getElementById('hide-done');

  var theme = 'all';
  var hideDone = false;

  // Only built if a filter actually empties the list, which needs both a theme
  // and "hide done" to be on at once.
  var empty = document.createElement('p');
  empty.className = 'empty';
  empty.hidden = true;
  empty.textContent = 'Nothing in this bucket that is still open.';
  list.parentNode.insertBefore(empty, list.nextSibling);

  function apply() {
    var shown = 0;

    items.forEach(function (li) {
      var matchesTheme = theme === 'all' || li.getAttribute('data-theme') === theme;
      var matchesDone = !(hideDone && li.classList.contains('done'));
      var visible = matchesTheme && matchesDone;
      li.hidden = !visible;
      if (visible) { shown += 1; }
    });

    empty.hidden = shown !== 0;

    themeButtons.forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-theme') === theme);
    });

    if (doneToggle) {
      doneToggle.classList.toggle('on', hideDone);
      doneToggle.setAttribute('aria-pressed', hideDone ? 'true' : 'false');
    }
  }

  themeButtons.forEach(function (b) {
    b.addEventListener('click', function () {
      // Clicking the active chip clears it, so the filter never traps you.
      var next = b.getAttribute('data-theme');
      theme = (theme === next && next !== 'all') ? 'all' : next;
      apply();
    });
  });

  if (doneToggle) {
    doneToggle.addEventListener('click', function () {
      hideDone = !hideDone;
      apply();
    });
  }

  // A deep link such as /side-quests/#q17 has to survive the filter.
  window.addEventListener('hashchange', function () {
    var hash = window.location.hash;
    var target = null;
    try {
      // Any string can end up in the fragment, and not all of them are
      // selectors -- "#2023" throws rather than returning null.
      target = hash ? document.querySelector(hash) : null;
    } catch (err) {
      return;
    }
    if (target && target.hidden) {
      theme = 'all';
      hideDone = false;
      apply();
      target.scrollIntoView();
    }
  });

  apply();
}());
