/* Zoom and pan for the map on /travel/.
 *
 * Progressive enhancement. Liquid renders the map already framed on the pins
 * and positions every pin against that same view, so with this file absent the
 * page is a correct static map -- it just does not move. That initial viewBox
 * is also where "home" comes from here, rather than recomputing the fit, so
 * there is exactly one definition of the default view.
 *
 * Everything is in map coordinates: x is longitude, y is negative latitude
 * (plate carree, per scripts/build_world_map.py). Panning and zooming only
 * ever rewrite the viewBox and the pins' percentage offsets.
 */
(function () {
  'use strict';

  var wrap = document.getElementById('map-wrap');
  var svg = document.getElementById('world');
  if (!wrap || !svg || !svg.viewBox || !svg.viewBox.baseVal) { return; }

  var box = svg.viewBox.baseVal;
  var HOME = { x: box.x, y: box.y, w: box.width, h: box.height };
  var view = { x: HOME.x, y: HOME.y, w: HOME.w, h: HOME.h };

  var WORLD = {
    x: parseFloat(wrap.getAttribute('data-lon-min')),
    y: -parseFloat(wrap.getAttribute('data-lat-max')),
    w: parseFloat(wrap.getAttribute('data-lon-max')) - parseFloat(wrap.getAttribute('data-lon-min')),
    h: parseFloat(wrap.getAttribute('data-lat-max')) - parseFloat(wrap.getAttribute('data-lat-min'))
  };
  if (!isFinite(WORLD.w) || WORLD.w <= 0) { return; }

  // Four degrees across is roughly 440 km. Further in than that and a 1:110m
  // outline has nothing left to show -- you get a flat field of one country's
  // fill colour -- while this is still tight enough to separate two pins in
  // neighbouring towns.
  var MIN_SPAN = 4;
  var STEP = 1.6;          // one button press
  var WHEEL_STEP = 1.12;   // one wheel notch, gentler

  var pins = Array.prototype.slice.call(wrap.querySelectorAll('.pin'));

  function rect() { return wrap.getBoundingClientRect(); }

  function clamp() {
    var r = rect();

    view.w = Math.min(Math.max(view.w, MIN_SPAN), WORLD.w);
    // Match the box's real aspect so `meet` never letterboxes. If it did, the
    // viewBox would no longer fill the element and every pin percentage below
    // would be off by the size of the bars.
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
    pins.forEach(function (pin) {
      var lon = parseFloat(pin.getAttribute('data-lon'));
      var lat = parseFloat(pin.getAttribute('data-lat'));
      pin.style.left = ((lon - view.x) / view.w * 100) + '%';
      pin.style.top = ((-lat - view.y) / view.h * 100) + '%';
    });
  }

  /* --- zooming ------------------------------------------------------------ */

  // Zoom about a point in client pixels, so whatever is under the cursor or
  // between the fingers stays under it.
  function zoomAt(factor, clientX, clientY) {
    var r = rect();
    var fx = r.width ? (clientX - r.left) / r.width : 0.5;
    var fy = r.height ? (clientY - r.top) / r.height : 0.5;
    var anchorX = view.x + fx * view.w;
    var anchorY = view.y + fy * view.h;

    var next = Math.min(Math.max(view.w * factor, MIN_SPAN), WORLD.w);
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

  wrap.addEventListener('pointerdown', function (e) {
    if (e.target.closest('.map-tools')) { return; }
    if (active[e.pointerId]) { return; }
    active[e.pointerId] = { x: e.clientX, y: e.clientY };
    count += 1;
    moved = 0;
    startGesture();
    wrap.classList.add('is-panning');
    if (wrap.setPointerCapture) { wrap.setPointerCapture(e.pointerId); }
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

    var start = gesture.view;
    view.w = start.w;
    view.h = start.h;

    // Two fingers: scale by how much the gap changed, about the midpoint.
    if (p[1] && gesture.dist > 0) {
      var dist = Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y);
      var factor = Math.min(Math.max(gesture.dist / dist, MIN_SPAN / start.w),
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

  // A drag that happens to end on a pin must not also follow the pin's link.
  wrap.addEventListener('click', function (e) {
    if (moved > 4) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  /* --- controls ----------------------------------------------------------- */

  var tools = wrap.querySelector('.map-tools');
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

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(apply, 120);
  });

  wrap.classList.add('zoomable');
  apply();
}());
