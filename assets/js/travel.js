/* Zoom, pan, clustering and the hover card for the map on /travel/.
 *
 * Progressive enhancement. Liquid renders the map already framed on the pins
 * and positions every marker against that same view, so with this file absent
 * the page is a correct static map whose markers link down to the list. That
 * initial viewBox is also where "home" comes from here, rather than
 * recomputing the fit, so there is exactly one definition of the default view.
 *
 * Everything is in map coordinates: x is longitude times X_SCALE, y is
 * negative latitude (equirectangular, per scripts/build_world_map.py).
 * Panning and zooming only ever rewrite the viewBox and the markers'
 * percentage offsets; clustering and the card follow from those in apply().
 *
 * The card is a convenience for pointers, built on the fly from the place's
 * entry in the list below. That entry stays the real content: the card is
 * hidden from assistive tech and nothing in it takes keyboard focus, keyboard
 * focus on a marker shows it as a preview, and Enter follows the marker's
 * link down to the entry, where every photo is.
 */
(function () {
  'use strict';

  var stage = document.getElementById('map-stage');
  var wrap = document.getElementById('map-wrap');
  var svg = document.getElementById('world');
  if (!stage || !wrap || !svg || !svg.viewBox || !svg.viewBox.baseVal) { return; }

  function attr(el, name) { return parseFloat(el.getAttribute(name)); }

  var K = attr(wrap, 'data-x-scale') || 1;
  // Wider than this, in map units, and India is one country on a world map;
  // travel.html sets the same class from the same number for the first paint.
  var LOD_SPAN = attr(wrap, 'data-lod-span') || Infinity;

  var box = svg.viewBox.baseVal;
  var HOME = { x: box.x, y: box.y, w: box.width, h: box.height };
  var view = { x: HOME.x, y: HOME.y, w: HOME.w, h: HOME.h };

  var WORLD = {
    x: attr(wrap, 'data-lon-min') * K,
    y: -attr(wrap, 'data-lat-max'),
    w: (attr(wrap, 'data-lon-max') - attr(wrap, 'data-lon-min')) * K,
    h: attr(wrap, 'data-lat-max') - attr(wrap, 'data-lat-min')
  };
  if (!isFinite(WORLD.w) || WORLD.w <= 0) { return; }

  // The area drawn in detail -- India and its neighbours -- if the map has one.
  var DETAIL = null;
  var d = (wrap.getAttribute('data-detail') || '').split(' ').map(parseFloat);
  if (d.length === 4 && d.every(isFinite)) {
    DETAIL = { x0: d[0] * K, x1: d[2] * K, y0: -d[3], y1: -d[1] };
  }

  // Four units across is roughly 400 km. Further in than that and a world
  // outline has nothing left to show -- you get a flat field of one country's
  // fill colour -- while this is still tight enough to separate two pins in
  // neighbouring towns. Where the map is drawn in detail it holds up to about
  // three, which pulls treks a valley apart some 50px apart. Closer than
  // that the 1:10m source is a flat tint with an angular edge, and places
  // that are closer still get fanned out instead.
  var MIN_SPAN = 4;
  var MIN_SPAN_DETAIL = 3;
  var STEP = 1.6;          // one button press
  var WHEEL_STEP = 1.12;   // one wheel notch, gentler

  // Markers closer than this on screen, in pixels, merge into one cluster.
  // Taller than wide, like the markers. At full zoom there is no closer to
  // go, so a cluster is fanned out sideways FAN pixels apart instead.
  var NEAR_X = 16;
  var NEAR_Y = 22;
  var FAN = 20;

  var REDUCE = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var SHEET = window.matchMedia && window.matchMedia('(max-width: 600px)');
  var SVGNS = 'http://www.w3.org/2000/svg';

  var tools = wrap.querySelector('.map-tools');
  var marks = Array.prototype.slice.call(wrap.querySelectorAll('.mark')).map(function (el) {
    // A link dragged by the mouse starts the browser's own drag and drop,
    // which cancels the pointer and with it the pan.
    el.setAttribute('draggable', 'false');
    return {
      el: el,
      id: decodeURIComponent((el.getAttribute('href') || '').slice(1)),
      x: attr(el, 'data-lon') * K,
      y: -attr(el, 'data-lat'),
      sx: 0,
      sy: 0
    };
  });

  function rect() { return wrap.getBoundingClientRect(); }

  function minSpan(cx, cy) {
    if (DETAIL && cx >= DETAIL.x0 && cx <= DETAIL.x1 &&
        cy >= DETAIL.y0 && cy <= DETAIL.y1) {
      return MIN_SPAN_DETAIL;
    }
    return MIN_SPAN;
  }

  function clamp() {
    var r = rect();
    var floor = minSpan(view.x + view.w / 2, view.y + view.h / 2);

    view.w = Math.min(Math.max(view.w, floor), WORLD.w);
    // Match the box's real aspect so `meet` never letterboxes. If it did, the
    // viewBox would no longer fill the element and every marker percentage
    // below would be off by the size of the bars.
    view.h = view.w / (r.height ? r.width / r.height : HOME.w / HOME.h);

    if (view.w >= WORLD.w) {
      view.x = WORLD.x + (WORLD.w - view.w) / 2;
    } else {
      view.x = Math.min(Math.max(view.x, WORLD.x), WORLD.x + WORLD.w - view.w);
    }
    // Vertically the land is shorter than the world is wide, so zoomed right
    // out the view is taller than the content; centre it rather than clamping.
    if (view.h >= WORLD.h) {
      view.y = WORLD.y + (WORLD.h - view.h) / 2;
    } else {
      view.y = Math.min(Math.max(view.y, WORLD.y), WORLD.y + WORLD.h - view.h);
    }
  }

  function apply() {
    clamp();
    svg.setAttribute('viewBox',
      view.x + ' ' + view.y + ' ' + view.w + ' ' + view.h);
    wrap.classList.toggle('lod-world', view.w > LOD_SPAN);

    var r = rect();
    marks.forEach(function (m) {
      var fx = (m.x - view.x) / view.w;
      var fy = (m.y - view.y) / view.h;
      m.el.style.left = (fx * 100) + '%';
      m.el.style.top = (fy * 100) + '%';
      m.sx = fx * r.width;
      m.sy = fy * r.height;
    });
    cluster();
    placeCard();
  }

  function centreOn(x, y, w) {
    var r = rect();
    var aspect = r.height ? r.width / r.height : HOME.w / HOME.h;
    view.w = Math.min(Math.max(w, minSpan(x, y)), WORLD.w);
    view.h = view.w / aspect;
    view.x = x - view.w / 2;
    view.y = y - view.h / 2;
    apply();
  }

  /* --- clustering --------------------------------------------------------- */

  // Cluster buttons, made as needed and reused. A cluster that survives a
  // zoom keeps its own element, matched on its first marker, so focus or a
  // hover on it is not silently handed to some other group.
  var pool = [];

  function show(el, on) { el.classList.toggle('is-hidden', !on); }

  function svgEl(name, attrs) {
    var el = document.createElementNS(SVGNS, name);
    Object.keys(attrs).forEach(function (key) { el.setAttribute(key, attrs[key]); });
    return el;
  }

  // A stack of two bookmarks with the count on the front one.
  function makeCluster() {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'mark mark-cluster';
    var icon = svgEl('svg', {
      'class': 'mark-icon', viewBox: '-2 -4 22 28',
      'aria-hidden': 'true', focusable: 'false'
    });
    icon.appendChild(svgEl('use', {
      'class': 'mark-body mark-back', href: '#mk-body',
      x: '3', y: '-3', width: '18', height: '24'
    }));
    icon.appendChild(svgEl('use', {
      'class': 'mark-body', href: '#mk-body', width: '18', height: '24'
    }));
    icon.appendChild(svgEl('text', { 'class': 'mark-count', x: '9', y: '11.6' }));
    var label = document.createElement('span');
    label.className = 'sr';
    button.appendChild(icon);
    button.appendChild(label);
    wrap.insertBefore(button, tools);
    pool.push(button);
    return button;
  }

  function nameOf(m) {
    var item = document.getElementById(m.id);
    var h = item && item.querySelector('h3');
    return h ? h.textContent.trim() : m.id;
  }

  function fillCluster(button, members) {
    var x = 0;
    var y = 0;
    members.forEach(function (m) { x += m.x; y += m.y; });
    x /= members.length;
    y /= members.length;
    button.members = members;
    button.style.left = ((x - view.x) / view.w * 100) + '%';
    button.style.top = ((y - view.y) / view.h * 100) + '%';
    button.style.zIndex = Math.round(200 + y);
    button.querySelector('.mark-count').textContent = members.length;
    button.querySelector('.sr').textContent = members.length + ' places here: ' +
      members.map(nameOf).join(', ') + '. Zoom in to separate them.';
    button.classList.toggle('is-target', members.some(function (m) {
      return m.el.classList.contains('is-target');
    }));
    show(button, true);
  }

  // Greedy, in screen space, in list order: each marker joins the first
  // group whose first marker it would overlap. Plenty for a few hundred.
  function cluster() {
    var full = view.w <= minSpan(view.x + view.w / 2, view.y + view.h / 2) * 1.0001;
    var groups = [];
    marks.forEach(function (m) {
      for (var i = 0; i < groups.length; i++) {
        var g = groups[i];
        if (Math.abs(g.sx - m.sx) < NEAR_X && Math.abs(g.sy - m.sy) < NEAR_Y) {
          g.members.push(m);
          return;
        }
      }
      groups.push({ sx: m.sx, sy: m.sy, members: [m] });
    });

    var stacks = [];
    groups.forEach(function (g) {
      var n = g.members.length;
      if (n === 1 || full) {
        g.members.forEach(function (m, i) {
          show(m.el, true);
          m.el.style.setProperty('--dx', n === 1 ? '0px' : ((i - (n - 1) / 2) * FAN) + 'px');
        });
      } else {
        stacks.push(g);
      }
    });

    var free = pool.slice();
    function claim(test) {
      for (var i = 0; i < free.length; i++) {
        if (test(free[i])) { return free.splice(i, 1)[0]; }
      }
      return null;
    }
    stacks.forEach(function (g) {
      g.button = claim(function (b) { return b.members && b.members[0] === g.members[0]; });
    });

    var focused = document.activeElement;
    stacks.forEach(function (g) {
      var button = g.button || claim(function () { return true; }) || makeCluster();
      g.members.forEach(function (m) { show(m.el, false); });
      fillCluster(button, g.members);
      // Zooming out from under a focused marker hands focus to its cluster
      // instead of dropping it on the floor.
      if (g.members.some(function (m) { return m.el === focused; })) {
        button.focus({ preventScroll: true });
      }
    });
    free.forEach(function (button) {
      // And zooming in through a focused cluster hands it to its first
      // marker, if that is on its own now -- for the keyboard. A click
      // leaves focus behind on the button too, and following that with a
      // card for a marker the pointer is nowhere near would be odd.
      if (button === focused) {
        var first = button.members && button.members[0].el;
        if (lastInput === 'keyboard' && first && !first.classList.contains('is-hidden')) {
          first.focus({ preventScroll: true });
        } else {
          button.blur();
        }
      }
      show(button, false);
      button.members = null;
    });
  }

  function zoomToCluster(button) {
    var members = button.members;
    if (!members) { return; }
    var x0 = Infinity;
    var x1 = -Infinity;
    var y0 = Infinity;
    var y1 = -Infinity;
    members.forEach(function (m) {
      x0 = Math.min(x0, m.x); x1 = Math.max(x1, m.x);
      y0 = Math.min(y0, m.y); y1 = Math.max(y1, m.y);
    });
    var r = rect();
    var aspect = r.height ? r.width / r.height : 1;
    // Room for the group four times over, and always at least one step in.
    var w = Math.min(Math.max((x1 - x0) * 4, (y1 - y0) * 4 * aspect), view.w / STEP);
    close();
    centreOn((x0 + x1) / 2, (y0 + y1) / 2, w);
  }

  /* --- the card ----------------------------------------------------------- */

  var card = document.createElement('div');
  card.className = 'map-card';
  card.hidden = true;
  card.setAttribute('aria-hidden', 'true');
  stage.appendChild(card);

  var current = null;      // { anchor, pinned }
  var dismissed = null;    // a marker whose preview Esc closed while it kept focus
  var openTimer = 0;
  var closeTimer = 0;
  var lastPointer = 'mouse';
  var lastInput = 'mouse';

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text != null) { node.textContent = text; }
    return node;
  }

  // Nothing in the card takes keyboard focus; see the top of the file.
  function quiet(node) { node.tabIndex = -1; return node; }

  function textOf(root, selector) {
    var node = root.querySelector(selector);
    return node ? node.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  function markFor(anchor) {
    return marks.filter(function (m) { return m.el === anchor; })[0];
  }

  function carousel(images) {
    var shots = el('div', 'card-shots');
    var frame = el('div', 'card-frame');
    var strip = el('div', 'card-strip');
    var count = el('span', 'card-count');
    var caption = el('span', 'card-caption');
    var prev = null;
    var next = null;
    var index = -1;

    var list = Array.prototype.map.call(images, function (img) {
      var shot = el('img');
      shot.alt = img.alt;
      shot.decoding = 'async';
      // Only the one on show and the next are fetched; the rest wait.
      shot.setAttribute('data-src', img.currentSrc || img.src);
      strip.appendChild(shot);
      var figure = img.closest('figure');
      return { img: shot, caption: figure ? textOf(figure, 'figcaption') : '' };
    });

    function load(i) {
      var item = list[i];
      if (item && !item.img.getAttribute('src')) {
        item.img.src = item.img.getAttribute('data-src');
      }
    }

    function showShot(i) {
      if (i === index) { return; }
      index = i;
      load(i);
      load(i + 1);
      count.textContent = list.length > 1 ? (i + 1) + ' / ' + list.length : '';
      caption.textContent = list[i].caption;
      if (prev) {
        prev.disabled = i === 0;
        next.disabled = i === list.length - 1;
      }
    }

    function go(i) {
      i = Math.min(Math.max(i, 0), list.length - 1);
      strip.scrollTo({ left: i * strip.clientWidth, behavior: REDUCE ? 'auto' : 'smooth' });
      showShot(i);
    }

    frame.appendChild(strip);
    if (list.length > 1) {
      prev = quiet(el('button', 'card-nav card-prev', '\u2039'));
      next = quiet(el('button', 'card-nav card-next', '\u203A'));
      prev.type = next.type = 'button';
      prev.setAttribute('aria-label', 'Previous photo');
      next.setAttribute('aria-label', 'Next photo');
      prev.addEventListener('click', function () { go(index - 1); });
      next.addEventListener('click', function () { go(index + 1); });
      frame.appendChild(prev);
      frame.appendChild(next);
      // Swiping is the strip's own scroll-snap; this just keeps up with it.
      var pending = 0;
      strip.addEventListener('scroll', function () {
        window.cancelAnimationFrame(pending);
        pending = window.requestAnimationFrame(function () {
          if (strip.clientWidth) { showShot(Math.round(strip.scrollLeft / strip.clientWidth)); }
        });
      });
    }
    shots.appendChild(frame);
    var line = el('p', 'card-line');
    line.appendChild(count);
    line.appendChild(caption);
    shots.appendChild(line);
    showShot(0);
    return shots;
  }

  function buildPlace(m) {
    var item = m && document.getElementById(m.id);
    if (!item) { return false; }
    card.textContent = '';

    var head = el('div', 'card-head');
    head.appendChild(el('h3', 'card-title', textOf(item, 'h3')));
    var when = textOf(item, '.place-when');
    if (when) { head.appendChild(el('span', 'card-when', when)); }
    card.appendChild(head);

    var where = textOf(item, '.place-where');
    if (where) { card.appendChild(el('p', 'card-where', where)); }
    var note = textOf(item, '.place-note');
    if (note) { card.appendChild(el('p', 'card-note', note)); }

    // Only real photos: a caption-only placeholder in the list is a grey
    // box, and a card full of grey boxes says nothing.
    var images = item.querySelectorAll('.shots img');
    if (images.length) { card.appendChild(carousel(images)); }

    var foot = el('p', 'card-foot');
    var post = item.querySelector('.place-post a');
    if (post) {
      var read = quiet(el('a', 'card-post', 'Read the post'));
      read.href = post.href;
      foot.appendChild(read);
    }
    var more = quiet(el('a', 'card-more', 'Details \u2193'));
    more.href = '#' + m.id;
    more.addEventListener('click', close);
    foot.appendChild(more);
    card.appendChild(foot);
    return true;
  }

  function buildCluster(button) {
    card.textContent = '';
    var head = el('div', 'card-head');
    head.appendChild(el('h3', 'card-title', button.members.length + ' places'));
    card.appendChild(head);
    var list = el('ul', 'card-list');
    button.members.forEach(function (m) {
      var item = document.getElementById(m.id);
      var li = el('li');
      li.appendChild(el('span', 'card-list-name', nameOf(m)));
      var when = item ? textOf(item, '.place-when') : '';
      if (when) { li.appendChild(el('span', 'card-when', when)); }
      list.appendChild(li);
    });
    card.appendChild(list);
    var verb = lastInput === 'keyboard' ? 'Press Enter'
      : lastPointer === 'touch' ? 'Tap' : 'Click';
    card.appendChild(el('p', 'card-hint', verb + ' to zoom in.'));
    return true;
  }

  function open(anchor, pinned) {
    window.clearTimeout(openTimer);
    window.clearTimeout(closeTimer);
    if (!current || current.anchor !== anchor) {
      var built = anchor.classList.contains('mark-cluster')
        ? buildCluster(anchor) : buildPlace(markFor(anchor));
      if (!built) { return; }
      if (current) { current.anchor.classList.remove('is-open'); }
      current = { anchor: anchor, pinned: false };
      anchor.classList.add('is-open');
      card.hidden = false;
    }
    current.pinned = current.pinned || !!pinned;
    placeCard();
  }

  function close() {
    window.clearTimeout(openTimer);
    window.clearTimeout(closeTimer);
    if (!current) { return; }
    current.anchor.classList.remove('is-open');
    current = null;
    card.hidden = true;
    card.textContent = '';
  }

  function closeSoon() {
    if (!current || current.pinned) { return; }
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(function () {
      if (!current || current.pinned) { return; }
      var a = current.anchor;
      if (card.matches(':hover') || a.matches(':hover') || a === document.activeElement) { return; }
      close();
    }, 200);
  }

  // Beside the marker, on whichever side has room, kept within the stage; or
  // on a narrow screen docked across the top or bottom of the map, whichever
  // the marker is not in.
  function placeCard() {
    if (!current) { return; }
    var a = current.anchor;
    if (a.classList.contains('is-hidden')) { close(); return; }
    var s = stage.getBoundingClientRect();
    var b = a.getBoundingClientRect();
    var tipX = b.left + b.width / 2 - s.left;
    var tipY = b.bottom - s.top;
    if (tipX < 0 || tipX > s.width || tipY < 0 || tipY > s.height + 1) { close(); return; }

    var sheet = !!(SHEET && SHEET.matches);
    card.classList.toggle('is-sheet', sheet);
    if (sheet) {
      var low = tipY > s.height / 2;
      card.classList.toggle('at-top', low);
      card.classList.toggle('at-bottom', !low);
      card.style.left = '';
      card.style.top = '';
      return;
    }
    card.classList.remove('at-top', 'at-bottom');
    var w = card.offsetWidth;
    var h = card.offsetHeight;
    var gap = 10;
    var left = b.right - s.left + gap;
    if (left + w > s.width) { left = b.left - s.left - gap - w; }
    if (left < 0) { left = Math.max(0, Math.min(s.width - w, tipX - w / 2)); }
    var top = b.top - s.top + b.height / 2 - h / 2;
    top = Math.max(0, Math.min(top, s.height - h));
    card.style.left = Math.round(left) + 'px';
    card.style.top = Math.round(top) + 'px';
  }

  function anchorOf(target) {
    var a = target && target.closest ? target.closest('.mark') : null;
    return a && wrap.contains(a) ? a : null;
  }

  wrap.addEventListener('pointerover', function (e) {
    if (e.pointerType === 'touch') { return; }
    var a = anchorOf(e.target);
    if (!a) { return; }
    window.clearTimeout(closeTimer);
    if (current && current.anchor === a) { return; }
    window.clearTimeout(openTimer);
    openTimer = window.setTimeout(function () { open(a, false); }, 80);
  });

  wrap.addEventListener('pointerout', function (e) {
    if (e.pointerType === 'touch') { return; }
    var a = anchorOf(e.target);
    if (!a || (e.relatedTarget && a.contains(e.relatedTarget))) { return; }
    window.clearTimeout(openTimer);
    closeSoon();
  });

  card.addEventListener('pointerenter', function () { window.clearTimeout(closeTimer); });
  card.addEventListener('pointerleave', function (e) {
    if (e.pointerType !== 'touch') { closeSoon(); }
  });

  wrap.addEventListener('focusin', function (e) {
    var a = anchorOf(e.target);
    if (a && a !== dismissed) { open(a, false); }
  });
  wrap.addEventListener('focusout', function (e) {
    if (anchorOf(e.target)) {
      dismissed = null;
      closeSoon();
    }
  });

  // On a touch screen the first tap on a marker opens its card and the
  // second follows the link; a mouse has already opened it by hovering.
  // Keyboard activation (detail 0) always follows the link.
  wrap.addEventListener('click', function (e) {
    var a = anchorOf(e.target);
    if (!a) { return; }
    if (a.classList.contains('mark-cluster')) {
      e.preventDefault();
      zoomToCluster(a);
      return;
    }
    if (e.detail !== 0 && lastPointer === 'touch' &&
        !(current && current.anchor === a && current.pinned)) {
      e.preventDefault();
      open(a, true);
      return;
    }
    close();
  });

  document.addEventListener('pointerdown', function (e) {
    lastPointer = e.pointerType || 'mouse';
    lastInput = lastPointer;
    if (current && !card.contains(e.target) && !anchorOf(e.target)) { close(); }
  }, true);

  document.addEventListener('keydown', function (e) {
    lastInput = 'keyboard';
    if (e.key === 'Escape' && current) {
      dismissed = current.anchor === document.activeElement ? current.anchor : null;
      close();
    }
  });

  /* --- zooming ------------------------------------------------------------ */

  // Zoom about a point in client pixels, so whatever is under the cursor or
  // between the fingers stays under it.
  function zoomAt(factor, clientX, clientY) {
    var r = rect();
    var fx = r.width ? (clientX - r.left) / r.width : 0.5;
    var fy = r.height ? (clientY - r.top) / r.height : 0.5;
    var anchorX = view.x + fx * view.w;
    var anchorY = view.y + fy * view.h;

    var next = Math.min(Math.max(view.w * factor, minSpan(anchorX, anchorY)), WORLD.w);
    var ratio = next / view.w;
    view.w = next;
    view.h *= ratio;
    view.x = anchorX - fx * view.w;
    view.y = anchorY - fy * view.h;
    apply();
  }

  function zoomCentre(factor) {
    var r = rect();
    zoomAt(factor, r.left + r.width / 2, r.top + r.height / 2);
  }

  function setView(target) {
    view.x = target.x; view.y = target.y;
    view.w = target.w; view.h = target.h;
    apply();
  }

  wrap.addEventListener('wheel', function (e) {
    e.preventDefault();
    zoomAt(e.deltaY > 0 ? WHEEL_STEP : 1 / WHEEL_STEP, e.clientX, e.clientY);
  }, { passive: false });

  /* --- dragging and pinching ---------------------------------------------- */

  var active = {};        // pointerId -> {x, y}
  var captured = {};      // pointerId -> true once it is driving a gesture
  var count = 0;
  var gesture = null;
  var moved = 0;

  function points() {
    return Object.keys(active).map(function (k) { return active[k]; });
  }

  function startGesture() {
    var p = points();
    gesture = {
      view: { x: view.x, y: view.y, w: view.w, h: view.h },
      cx: (p[0].x + (p[1] ? p[1].x : p[0].x)) / 2,
      cy: (p[0].y + (p[1] ? p[1].y : p[0].y)) / 2,
      dist: p[1] ? Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y) : 0
    };
  }

  // Nothing is captured until the pointer has actually moved. Capturing on
  // the way down retargets the eventual click from the marker to the map,
  // and then a tap on a marker never reaches it.
  wrap.addEventListener('pointerdown', function (e) {
    if (e.target.closest('.map-tools')) { return; }
    if (e.button > 0 || active[e.pointerId]) { return; }
    active[e.pointerId] = { x: e.clientX, y: e.clientY };
    count += 1;
    moved = 0;
    startGesture();
  });

  wrap.addEventListener('pointermove', function (e) {
    if (!active[e.pointerId] || !gesture) { return; }
    active[e.pointerId] = { x: e.clientX, y: e.clientY };
    var p = points();
    var r = rect();
    if (!r.width || !r.height) { return; }

    var cx = (p[0].x + (p[1] ? p[1].x : p[0].x)) / 2;
    var cy = (p[0].y + (p[1] ? p[1].y : p[0].y)) / 2;
    moved = Math.max(moved, Math.abs(cx - gesture.cx) + Math.abs(cy - gesture.cy));
    if (count < 2 && moved <= 4) { return; }

    if (!captured[e.pointerId]) {
      captured[e.pointerId] = true;
      if (wrap.setPointerCapture) { wrap.setPointerCapture(e.pointerId); }
      wrap.classList.add('is-panning');
      close();
    }

    var start = gesture.view;
    view.w = start.w;
    view.h = start.h;

    // Two fingers: scale by how much the gap changed, about the midpoint.
    if (p[1] && gesture.dist > 0) {
      var dist = Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y);
      var floor = minSpan(start.x + start.w / 2, start.y + start.h / 2);
      var factor = Math.min(Math.max(gesture.dist / dist, floor / start.w),
                            WORLD.w / start.w);
      view.w = start.w * factor;
      view.h = start.h * factor;
    }

    // Anchor the gesture's starting midpoint under its current position.
    var fx = (gesture.cx - r.left) / r.width;
    var fy = (gesture.cy - r.top) / r.height;
    var anchorX = start.x + fx * start.w;
    var anchorY = start.y + fy * start.h;
    view.x = anchorX - ((cx - r.left) / r.width) * view.w;
    view.y = anchorY - ((cy - r.top) / r.height) * view.h;
    apply();
  });

  function endPointer(e) {
    if (!active[e.pointerId]) { return; }
    delete active[e.pointerId];
    delete captured[e.pointerId];
    count = Math.max(0, count - 1);
    if (count === 0) {
      gesture = null;
      wrap.classList.remove('is-panning');
    } else {
      startGesture();   // re-baseline so lifting one finger does not jump
    }
  }
  wrap.addEventListener('pointerup', endPointer);
  wrap.addEventListener('pointercancel', endPointer);

  // A drag that happens to end on a marker must not also follow its link.
  // Keyboard clicks (detail 0) are never a drag, and the flag is spent
  // either way, so a drag that ended off the map cannot eat a later click.
  wrap.addEventListener('click', function (e) {
    if (e.detail !== 0 && moved > 4) { e.preventDefault(); e.stopPropagation(); }
    moved = 0;
  }, true);

  /* --- controls ----------------------------------------------------------- */

  if (tools) {
    tools.addEventListener('click', function (e) {
      var button = e.target.closest('button');
      if (!button) { return; }
      var zoom = button.getAttribute('data-zoom');
      if (zoom) { zoomCentre(zoom === 'in' ? 1 / STEP : STEP); return; }
      if (button.getAttribute('data-view') === 'home') { setView(HOME); }
      else { setView({ x: WORLD.x, y: WORLD.y, w: WORLD.w, h: WORLD.h }); }
    });
  }

  wrap.setAttribute('tabindex', '0');
  wrap.addEventListener('keydown', function (e) {
    var nudge = 0.2;
    switch (e.key) {
      case 'ArrowLeft':  view.x -= view.w * nudge; break;
      case 'ArrowRight': view.x += view.w * nudge; break;
      case 'ArrowUp':    view.y -= view.h * nudge; break;
      case 'ArrowDown':  view.y += view.h * nudge; break;
      case '+': case '=': zoomCentre(1 / STEP); return e.preventDefault();
      case '-': case '_': zoomCentre(STEP); return e.preventDefault();
      case '0': setView(HOME); return e.preventDefault();
      default: return;
    }
    e.preventDefault();
    apply();
  });

  /* --- the list ----------------------------------------------------------- */

  // Each entry gets a way back up to its marker, and lights it while hovered.
  marks.forEach(function (m) {
    var item = document.getElementById(m.id);
    var head = item && item.querySelector('.place-head');
    if (!head) { return; }
    var locate = el('button', 'place-locate', 'Show on map');
    locate.type = 'button';
    locate.addEventListener('click', function () {
      stage.scrollIntoView({ block: 'center', behavior: REDUCE ? 'auto' : 'smooth' });
      centreOn(m.x, m.y, Math.min(view.w, 12));
      var holder = pool.filter(function (b) {
        return b.members && b.members.indexOf(m) >= 0 && !b.classList.contains('is-hidden');
      })[0];
      var target = m.el.classList.contains('is-hidden') && holder ? holder : m.el;
      target.focus({ preventScroll: true });
      open(target, true);
    });
    head.appendChild(locate);
    item.addEventListener('pointerenter', function () { m.el.classList.add('is-lit'); });
    item.addEventListener('pointerleave', function () { m.el.classList.remove('is-lit'); });
  });

  // The list entry a link landed on gets its marker lit up too, the way
  // :target lights the entry.
  function markTarget() {
    var id = decodeURIComponent(window.location.hash.slice(1));
    marks.forEach(function (m) { m.el.classList.toggle('is-target', m.id === id); });
  }
  window.addEventListener('hashchange', function () { markTarget(); close(); apply(); });
  markTarget();

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(apply, 120);
  });

  wrap.classList.add('zoomable');
  apply();
}());
