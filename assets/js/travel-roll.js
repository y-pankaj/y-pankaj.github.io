/* The film roll on /travel/: the gate, the map following it, and the viewer.
 *
 * Progressive enhancement, like travel.js. travel.html renders the roll as a
 * strip of film you scroll sideways, each frame linking to its full-size
 * photo, and this file adds:
 *
 *   - the gate: the frame in the middle of the strip is the one shown at full
 *     brightness and captioned underneath, and its place's marker (or the
 *     cluster it is in) and state light up on the map;
 *   - the map winding the film: clicking a marker brings its place into the
 *     gate, rather than jumping down the page to the list;
 *   - the viewer: clicking a photo, or a cover in the list, opens it full
 *     screen, and next and previous carry on from one place to the next.
 *
 * /travel/#kuari-pass/2 opens the second photo of that place. The plain
 * #kuari-pass anchors still go to the entry in the list.
 *
 * Of travel.js it needs nothing but the markup that leaves behind: the
 * markers, and the cluster buttons it hangs a `members` list on.
 */
(function () {
  'use strict';

  var roll = document.getElementById('roll');
  var film = document.getElementById('roll-film');
  if (!roll || !film) { return; }

  var track = film.querySelector('.roll-track');
  var leader = track.querySelector('.roll-leader');
  var tail = track.querySelector('.roll-tail');
  var caption = roll.querySelector('.roll-caption');
  var steps = roll.querySelectorAll('.roll-step');
  var wrap = document.getElementById('map-wrap');

  var REDUCE = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var SMOOTH = REDUCE ? 'auto' : 'smooth';

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text != null) { node.textContent = text; }
    return node;
  }

  /* --- what is on the film ---------------------------------------------- */

  var places = [];
  var byId = {};
  var frames = [];
  var photos = [];

  Array.prototype.forEach.call(roll.querySelectorAll('.roll-place'), function (group) {
    var place = {
      el: group,
      id: group.getAttribute('data-place'),
      state: group.getAttribute('data-state'),
      title: group.getAttribute('data-title'),
      where: group.getAttribute('data-where'),
      when: group.getAttribute('data-when'),
      frames: [],
      photos: []
    };
    Array.prototype.forEach.call(group.querySelectorAll('.roll-frame'), function (node) {
      var img = node.querySelector('img');
      var frame = {
        el: node,
        img: img,
        place: place,
        index: frames.length,
        blank: !img,
        caption: img ? img.alt : node.getAttribute('data-caption') || '',
        full: img ? node.getAttribute('href') : null
      };
      place.frames.push(frame);
      frames.push(frame);
      if (img) {
        frame.n = place.photos.length + 1;   // its number in #place/n
        frame.photo = photos.length;
        place.photos.push(frame);
        photos.push(frame);
      }
    });
    places.push(place);
    byId[place.id] = place;
  });
  if (!frames.length) { return; }

  /* --- the gate ----------------------------------------------------------- */

  // Room either side, so the first and last frames can sit in the middle.
  function pad() {
    var w = film.clientWidth;
    var first = frames[0].el;
    var last = frames[frames.length - 1].el;
    var group = last.closest('.roll-place');
    var after = group.offsetLeft + group.offsetWidth - (last.offsetLeft + last.offsetWidth);
    var left = Math.max(14, (w - first.offsetWidth) / 2);
    var right = Math.max(14, (w - last.offsetWidth) / 2 - after);
    track.style.paddingLeft = left + 'px';
    track.style.paddingRight = right + 'px';
    if (leader) { leader.classList.toggle('is-cramped', leader.offsetWidth + 30 > left); }
    if (tail) { tail.classList.toggle('is-cramped', tail.offsetWidth + 30 > right + after); }
  }

  function centreOf(frame) {
    return frame.el.offsetLeft + frame.el.offsetWidth / 2;
  }

  function nearest() {
    var mid = film.scrollLeft + film.clientWidth / 2;
    var best = frames[0];
    frames.forEach(function (f) {
      if (Math.abs(centreOf(f) - mid) < Math.abs(centreOf(best) - mid)) { best = f; }
    });
    return best;
  }

  function wind(frame, how) {
    film.scrollTo({ left: centreOf(frame) - film.clientWidth / 2, behavior: how || SMOOTH });
    setGate(frame);
  }

  var gate = null;

  function setGate(frame) {
    if (frame === gate) { return; }
    var moved = !gate || gate.place !== frame.place;
    if (gate) { gate.el.classList.remove('is-gate'); }
    gate = frame;
    frame.el.classList.add('is-gate');

    var place = frame.place;
    caption.textContent = '';
    if (frame.blank) {
      caption.appendChild(el('em', null, 'Still to come: '));
      caption.appendChild(document.createTextNode(frame.caption || 'a photo'));
    } else {
      caption.appendChild(el('strong', null, frame.caption));
    }
    caption.appendChild(el('span', null,
      [place.title, place.where, place.when].filter(Boolean).join(' · ')));

    steps[0].disabled = frame.index === 0;
    steps[1].disabled = frame.index === frames.length - 1;
    if (moved) { light(); }
  }

  var ticking = false;
  film.addEventListener('scroll', function () {
    if (ticking || drag) { return; }
    ticking = true;
    window.requestAnimationFrame(function () {
      ticking = false;
      setGate(nearest());
    });
  }, { passive: true });

  function step(by) {
    var next = frames[Math.min(Math.max(gate.index + by, 0), frames.length - 1)];
    var focused = film.contains(document.activeElement) && document.activeElement !== film;
    wind(next);
    if (focused && next.el.focus) { next.el.focus({ preventScroll: true }); }
  }

  Array.prototype.forEach.call(steps, function (button) {
    button.addEventListener('click', function () {
      step(parseInt(button.getAttribute('data-step'), 10));
    });
  });

  film.addEventListener('keydown', function (e) {
    var key = e.key;
    if (key === 'ArrowRight' || key === 'ArrowLeft') {
      e.preventDefault();
      step(key === 'ArrowRight' ? 1 : -1);
    } else if (key === 'Home' || key === 'End') {
      e.preventDefault();
      wind(frames[key === 'Home' ? 0 : frames.length - 1]);
    } else if (key === 'Enter' && e.target === film && !gate.blank) {
      e.preventDefault();
      open(gate.photo, gate.el);
    }
  });

  // Tabbing onto a frame brings it into the gate.
  film.addEventListener('focusin', function (e) {
    var node = e.target.closest && e.target.closest('.roll-frame');
    var frame = node && frames.filter(function (f) { return f.el === node; })[0];
    if (frame && frame !== gate) { wind(frame); }
  });

  /* --- dragging with a mouse ---------------------------------------------- */

  // Touch and trackpads scroll the film natively. A mouse wheel only goes up
  // and down, and that is left alone for the page, so a mouse gets to drag
  // the film instead. Snapping is off while it does, or every pixel would
  // snap, and back on once the release has glided to the nearest frame.
  var drag = null;
  var dragged = false;
  var settle = null;

  film.addEventListener('pointerdown', function (e) {
    if (e.pointerType !== 'mouse' || e.button !== 0) { return; }
    drag = { x: e.clientX, left: film.scrollLeft, moved: 0, id: e.pointerId };
  });

  film.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) { return; }
    var dx = e.clientX - drag.x;
    drag.moved = Math.max(drag.moved, Math.abs(dx));
    if (drag.moved <= 4) { return; }
    if (!roll.classList.contains('is-dragging')) {
      window.clearTimeout(settle);
      roll.classList.add('is-dragging');
      if (film.setPointerCapture) { film.setPointerCapture(e.pointerId); }
    }
    film.scrollLeft = drag.left - dx;
    setGate(nearest());
  });

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.id) { return; }
    var was = drag.moved > 4;
    drag = null;
    if (!was) { return; }
    dragged = true;
    wind(nearest());
    settle = window.setTimeout(function () {
      roll.classList.remove('is-dragging');
    }, REDUCE ? 0 : 450);
  }
  film.addEventListener('pointerup', endDrag);
  film.addEventListener('pointercancel', endDrag);

  /* --- clicks on the film ------------------------------------------------- */

  film.addEventListener('click', function (e) {
    if (dragged) {
      dragged = false;
      e.preventDefault();
      return;
    }
    var node = e.target.closest && e.target.closest('.roll-frame');
    if (!node) { return; }
    var frame = frames.filter(function (f) { return f.el === node; })[0];
    if (!frame) { return; }
    e.preventDefault();
    if (frame.blank) { wind(frame); } else { open(frame.photo, node); }
  });

  /* --- the map ------------------------------------------------------------ */

  function light() {
    if (!wrap) { return; }
    Array.prototype.forEach.call(wrap.querySelectorAll('.is-gate'), function (node) {
      node.classList.remove('is-gate');
    });
    if (!gate) { return; }
    var place = gate.place;
    var mark = wrap.querySelector('a.mark[href="#' + place.id + '"]');
    if (mark) {
      mark.classList.add('is-gate');
      // Merged into a cluster at this zoom: light the cluster instead.
      if (mark.classList.contains('is-hidden')) {
        Array.prototype.forEach.call(wrap.querySelectorAll('.mark-cluster:not(.is-hidden)'), function (b) {
          if (b.members && b.members.some(function (m) { return m.el === mark; })) {
            b.classList.add('is-gate');
          }
        });
      }
    }
    var state = place.state && document.getElementById('s-' + place.state);
    if (state) { state.classList.add('is-gate'); }
  }

  if (wrap) {
    // travel.js re-clusters whenever the view moves; light again after it.
    var relight = null;
    ['wheel', 'pointerup', 'click', 'keyup'].forEach(function (type) {
      wrap.addEventListener(type, function () {
        window.clearTimeout(relight);
        relight = window.setTimeout(light, 60);
      }, { passive: true });
    });

    // A marker winds the film to its place. This runs after travel.js has
    // seen the click, and only a mouse click loses its link here, so the
    // page stays where the map and film are. travel.js's own rules for the
    // rest stand: a first tap previews (and winds the film too), a second
    // tap follows the link down to the entry, and so does the keyboard
    // (detail 0), since nothing in the card can take focus.
    var pointer = 'mouse';
    wrap.addEventListener('pointerdown', function (e) {
      pointer = e.pointerType || 'mouse';
    }, true);
    wrap.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a.mark');
      if (!a || e.detail === 0) { return; }
      var place = byId[decodeURIComponent((a.getAttribute('href') || '').slice(1))];
      if (!place || !place.frames.length) { return; }
      if (pointer === 'mouse') {
        e.preventDefault();
      } else if (!e.defaultPrevented) {
        return;   // the second tap, on its way to the entry
      }
      wind(place.frames[0]);
      bringIntoView();
    });
  }

  // Scrolls the page just far enough to show the whole roll. Not
  // scrollIntoView: Chrome drops a smooth one while the film is still in a
  // smooth scroll of its own, so this finds the page's scroller -- on this
  // site .site-main, not the window -- and moves that.
  function bringIntoView() {
    var box = roll.getBoundingClientRect();
    var scroller = roll.parentNode;
    while (scroller && scroller !== document.body &&
           !/(auto|scroll)/.test(window.getComputedStyle(scroller).overflowY)) {
      scroller = scroller.parentNode;
    }
    var view = scroller && scroller !== document.body
      ? scroller.getBoundingClientRect()
      : { top: 0, bottom: window.innerHeight };
    var top = Math.max(view.top, 0);
    var bottom = Math.min(view.bottom, window.innerHeight);
    var by = box.top < top ? box.top - top : box.bottom > bottom ? box.bottom - bottom + 8 : 0;
    if (!by) { return; }
    (scroller && scroller !== document.body ? scroller : window)
      .scrollBy({ top: by, behavior: SMOOTH });
  }

  /* --- the viewer --------------------------------------------------------- */

  var viewer = null;
  var parts = {};
  var current = -1;
  var opener = null;
  var swipe = null;

  function build() {
    viewer = el('div', 'roll-viewer');
    viewer.hidden = true;
    viewer.setAttribute('role', 'dialog');
    viewer.setAttribute('aria-modal', 'true');
    viewer.setAttribute('aria-label', 'Photos from the travel page');

    var head = el('div', 'rv-head');
    parts.title = el('h2', 'rv-title');
    parts.where = el('p', 'rv-where');
    parts.close = el('button', 'rv-close', '×');
    parts.close.type = 'button';
    parts.close.setAttribute('aria-label', 'Close');
    head.appendChild(parts.title);
    head.appendChild(parts.where);
    head.appendChild(parts.close);

    var stage = el('div', 'rv-stage');
    parts.img = el('img', 'rv-img');
    parts.img.draggable = false;
    parts.prev = el('button', 'rv-prev', '‹');
    parts.next = el('button', 'rv-next', '›');
    parts.prev.type = parts.next.type = 'button';
    parts.prev.setAttribute('aria-label', 'Previous photo');
    parts.next.setAttribute('aria-label', 'Next photo');
    stage.appendChild(parts.img);
    stage.appendChild(parts.prev);
    stage.appendChild(parts.next);

    var foot = el('div', 'rv-foot');
    parts.cap = el('p', 'rv-cap');
    parts.cap.setAttribute('aria-live', 'polite');
    parts.count = el('span', 'rv-count');
    parts.entry = el('a', 'rv-entry', 'The entry in the list ↓');
    foot.appendChild(parts.cap);
    foot.appendChild(parts.count);
    foot.appendChild(parts.entry);

    var strip = el('div', 'rv-strip');
    parts.thumbs = photos.map(function (f, i) {
      var b = el('button');
      b.type = 'button';
      b.setAttribute('aria-label', f.place.title + ': ' + f.caption);
      var t = el('img');
      t.alt = '';
      t.src = f.img.getAttribute('src');
      t.loading = 'lazy';
      b.appendChild(t);
      b.addEventListener('click', function () { show(i); });
      strip.appendChild(b);
      return b;
    });

    viewer.appendChild(head);
    viewer.appendChild(stage);
    viewer.appendChild(foot);
    viewer.appendChild(strip);
    document.body.appendChild(viewer);

    parts.close.addEventListener('click', close);
    parts.prev.addEventListener('click', function () { show(current - 1); });
    parts.next.addEventListener('click', function () { show(current + 1); });
    parts.entry.addEventListener('click', function () { close(true); });

    viewer.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); show(current + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); show(current - 1); }
      else if (e.key === 'Tab') { trap(e); }
    });

    stage.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse') { return; }
      swipe = { x: e.clientX, y: e.clientY };
    });
    stage.addEventListener('pointerup', function (e) {
      if (!swipe) { return; }
      var dx = e.clientX - swipe.x;
      var dy = e.clientY - swipe.y;
      swipe = null;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) { show(current + (dx < 0 ? 1 : -1)); }
    });
    stage.addEventListener('pointercancel', function () { swipe = null; });
  }

  // Focus stays in the dialog while it is open.
  function trap(e) {
    var items = Array.prototype.filter.call(
      viewer.querySelectorAll('button, a[href]'),
      function (n) { return !n.disabled && n.offsetParent !== null; });
    if (!items.length) { return; }
    var first = items[0];
    var last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function show(i) {
    if (i < 0 || i >= photos.length) { return; }
    current = i;
    var f = photos[i];
    var place = f.place;

    // The thumbnail the film already has goes up at once, and the full
    // size replaces it when it has arrived.
    parts.img.src = f.img.currentSrc || f.img.getAttribute('src');
    parts.img.alt = f.caption;
    var full = new Image();
    full.onload = function () { if (current === i) { parts.img.src = f.full; } };
    full.src = f.full;
    [i - 1, i + 1].forEach(function (j) {
      if (photos[j]) { new Image().src = photos[j].full; }
    });

    parts.title.textContent = place.title;
    parts.where.textContent = [place.where, place.when].filter(Boolean).join(' · ');
    parts.cap.textContent = f.caption;
    parts.count.textContent = (i + 1) + ' / ' + photos.length;
    parts.entry.href = '#' + place.id;
    parts.prev.disabled = i === 0;
    parts.next.disabled = i === photos.length - 1;
    parts.thumbs.forEach(function (b, j) {
      b.setAttribute('aria-current', j === i ? 'true' : 'false');
    });
    var thumb = parts.thumbs[i];
    var strip = thumb.parentNode;
    strip.scrollTo({
      left: thumb.offsetLeft + thumb.offsetWidth / 2 - strip.clientWidth / 2,
      behavior: SMOOTH
    });

    // The film follows underneath, so closing lands on the same photo.
    wind(f, 'auto');
    window.history.replaceState(null, '', '#' + place.id + '/' + f.n);
  }

  function open(i, from) {
    if (!viewer) { build(); }
    opener = from || document.activeElement;
    viewer.hidden = false;
    document.documentElement.classList.add('rv-open');
    show(i);
    parts.close.focus({ preventScroll: true });
  }

  // `following` is true when a link in the viewer is about to set the hash.
  function close(following) {
    if (!viewer || viewer.hidden) { return; }
    viewer.hidden = true;
    document.documentElement.classList.remove('rv-open');
    if (following !== true) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      // Opened from the film, focus goes back to whichever photo the viewer
      // ended on, which the film has kept in the gate; the frame that opened
      // it would wind the film back on focus.
      var back = opener && film.contains(opener) ? photos[current].el : opener;
      if (back && back.focus) { back.focus({ preventScroll: true }); }
    }
    opener = null;
  }

  // The covers in the list open the viewer at their place.
  Array.prototype.forEach.call(document.querySelectorAll('.place-roll[data-place]'), function (a) {
    var place = byId[a.getAttribute('data-place')];
    if (!place || !place.photos.length) { return; }
    a.addEventListener('click', function (e) {
      e.preventDefault();
      open(place.photos[0].photo, a);
    });
  });

  // #kuari-pass/2: that place's second photo.
  function fromHash() {
    var m = /^#(.+)\/(\d+)$/.exec(decodeURIComponent(window.location.hash));
    var place = m && byId[m[1]];
    var f = place && place.photos[parseInt(m[2], 10) - 1];
    if (f) { open(f.photo); }
  }
  window.addEventListener('hashchange', fromHash);

  /* --- frames without a size ---------------------------------------------- */

  // travel.html sizes each frame from _data/photo_sizes.yml. A photo added
  // without running scripts/build_photos.py is not in there and starts as a
  // 3:2 frame; once the image is in, its frame takes the photo's real shape.
  frames.forEach(function (f) {
    if (!f.img) { return; }
    function fit() {
      var w = f.img.naturalWidth;
      var h = f.img.naturalHeight;
      var was = parseFloat(f.el.style.getPropertyValue('--ar'));
      if (!w || !h || Math.abs(w / h - was) < 0.01) { return; }
      f.el.style.setProperty('--ar', (w / h).toFixed(4));
      pad();
    }
    if (f.img.complete) { fit(); } else { f.img.addEventListener('load', fit); }
  });

  /* --- start -------------------------------------------------------------- */

  roll.classList.add('is-live');
  pad();
  wind(frames[0], 'auto');
  fromHash();

  var resizing = null;
  window.addEventListener('resize', function () {
    window.clearTimeout(resizing);
    resizing = window.setTimeout(function () {
      pad();
      wind(gate || frames[0], 'auto');
    }, 120);
  });
}());
