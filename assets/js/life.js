/* /life/ -- the life-in-weeks grid.
 *
 * Everything comes out of the JSON block at the bottom of life.html: the start
 * date and eras from _data/life.yml, and the posts, places, quests and
 * training days that the rest of the site already keeps. Nothing is fetched.
 *
 * A row is one year of life and holds 52 squares, so the day or two left over
 * at the end of each year folds into its last square. Born as a bare year,
 * the rows are calendar years; born on a date, they turn over on it.
 *
 * Dates are whole days counted in UTC, so neither the reader's time zone nor
 * a change of clocks can push anything into the next week. "Today" is the
 * reader's own date.
 *
 * Hue is kept for the three kinds of marked week -- quests in the accent, as
 * on /side-quests/, then posts and trips -- and everything else is a step of
 * grey: weeks to come, weeks lived, weeks with training in them. This week is
 * the solid ink square. The list under the grid says all of it again as text,
 * with the links, and is what the grid's keyboard controls lead to.
 */
(function () {
  'use strict';

  const root = document.getElementById('life');
  const src = document.getElementById('life-data');
  const stage = document.getElementById('life-stage');
  const grid = document.getElementById('life-grid');
  const card = document.getElementById('life-card');
  if (!root || !src || !stage || !grid || !card) { return; }

  let DATA;
  try {
    DATA = JSON.parse(src.textContent);
  } catch (err) {
    return;
  }

  const WEEKS = 52;
  const DAY_MS = 86400000;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const LINKS = DATA.links || {};

  // In the order a square picks its colour: a week with a trip and a quest
  // in it shows the quest. Fixed, so a filter never repaints what it leaves.
  const KINDS = [
    { key: 'quest', label: 'Quests', one: 'Quest', colour: 'var(--accent)' },
    { key: 'post', label: 'Posts', one: 'Post', colour: 'var(--wk-post)' },
    { key: 'trip', label: 'Trips', one: 'Trip', colour: 'var(--wk-trip)' },
  ];
  const KIND = {};
  KINDS.forEach((k) => { KIND[k.key] = k; });

  const nf = (n) => n.toLocaleString('en-US');

  /** Only the site's own paths and plain web links become an href. */
  const safeUrl = (u) => (typeof u === 'string' && /^(\/(?!\/)|#|https?:\/\/)/i.test(u) ? u : '#');

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined && text !== null) { node.textContent = String(text); }
    return node;
  }

  // -------------------------------------------------------------------------
  // Dates
  // -------------------------------------------------------------------------

  /** Whole days since 1970-01-01, UTC. `m` is 1-12, and overflow rolls on. */
  const dayNum = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);

  /** Day number -> { y, m, d }. */
  function ymd(n) {
    const t = new Date(n * DAY_MS);
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  }

  /**
   * 2023, "2023", "2023-06" or "2023-06-14" -> { y, m, d }, with m and d 0
   * when they were not given. Anything else is null.
   */
  function parseWhen(v) {
    if (v === null || v === undefined) { return null; }
    const m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?/.exec(String(v).trim());
    if (!m) { return null; }
    const y = Number(m[1]);
    const mo = m[2] ? Number(m[2]) : 0;
    const d = m[3] ? Number(m[3]) : 0;
    if (y < 1000 || mo > 12 || d > 31 || (m[2] && mo < 1) || (m[3] && d < 1)) { return null; }
    return { y: y, m: mo, d: d };
  }

  /** The day a `when` stands for: its date, or the middle of its month or year. */
  function whenDay(w) {
    if (w.d) { return { n: dayNum(w.y, w.m, w.d), exact: true }; }
    if (w.m) { return { n: dayNum(w.y, w.m, 15), exact: false }; }
    return { n: dayNum(w.y, 7, 2), exact: false };
  }

  /** As the `when` was written: "2023", "Jun 2023" or "14 Jun 2023". */
  function whenLabel(w) {
    if (w.d) { return w.d + ' ' + MONTHS[w.m - 1] + ' ' + w.y; }
    if (w.m) { return MONTHS[w.m - 1] + ' ' + w.y; }
    return String(w.y);
  }

  /** Day number -> "14 Jun 2023". */
  function dayLabel(n) {
    const t = ymd(n);
    return t.d + ' ' + MONTHS[t.m - 1] + ' ' + t.y;
  }

  /** Day number -> "Jun 2023". */
  function monthLabel(n) {
    const t = ymd(n);
    return MONTHS[t.m - 1] + ' ' + t.y;
  }

  /** Two day numbers -> "15-21 Oct 2026", "29 Sep - 5 Oct 2026", and so on. */
  function rangeLabel(a, b) {
    const p = ymd(a);
    const q = ymd(b);
    if (p.y !== q.y) {
      return p.d + ' ' + MONTHS[p.m - 1] + ' ' + p.y + ' – ' + q.d + ' ' + MONTHS[q.m - 1] + ' ' + q.y;
    }
    if (p.m !== q.m) {
      return p.d + ' ' + MONTHS[p.m - 1] + ' – ' + q.d + ' ' + MONTHS[q.m - 1] + ' ' + q.y;
    }
    return p.d + '–' + q.d + ' ' + MONTHS[q.m - 1] + ' ' + q.y;
  }

  /** Jekyll's default slugify, which is what /travel/ builds its anchors with. */
  const slugify = (s) => String(s).toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');

  // -------------------------------------------------------------------------
  // The grid's frame: where each row starts, and which square a day is in
  // -------------------------------------------------------------------------

  const born = parseWhen(DATA.born);
  if (!born) {
    stage.insertBefore(el('p', 'empty', 'Set `born` in _data/life.yml and the grid will draw itself.'), grid);
    return;
  }
  const BY = born.y;
  const BM = born.m || 1;
  const BD = born.d || 1;
  const YEARS = Math.max(1, Math.min(120, parseInt(DATA.years, 10) || 90));
  const SQUARES = YEARS * WEEKS;

  /** First day of row r, the r-th year of life. Row YEARS is the day after the grid. */
  const rowStart = (r) => dayNum(BY + r, BM, BD);
  const START = rowStart(0);
  const END = rowStart(YEARS);

  /** Day number -> square index, or -1 if it falls outside the grid. */
  function locate(n) {
    if (n < START || n >= END) { return -1; }
    let r = ymd(n).y - BY;
    if (n < rowStart(r)) { r -= 1; }
    return r * WEEKS + Math.min(WEEKS - 1, Math.floor((n - rowStart(r)) / 7));
  }

  /** Square index -> [first day, last day]. A row's last square runs to its end. */
  function squareDays(i) {
    const r = Math.floor(i / WEEKS);
    const c = i % WEEKS;
    const a = rowStart(r) + c * 7;
    return [a, c === WEEKS - 1 ? rowStart(r + 1) - 1 : a + 6];
  }

  const now = new Date();
  const TODAY = dayNum(now.getFullYear(), now.getMonth() + 1, now.getDate());
  const NOW = locate(TODAY);
  // Squares before this one are lived. Past the end of the grid, all of them.
  const LIVED_TO = TODAY >= END ? SQUARES : Math.max(NOW, 0);

  // -------------------------------------------------------------------------
  // What happened when
  // -------------------------------------------------------------------------

  const marks = new Map();   // square -> { items: [...], exact: {kind: bool}, train }
  const events = [];

  function markAt(i) {
    let m = marks.get(i);
    if (!m) {
      m = { items: [], exact: {}, train: null };
      marks.set(i, m);
    }
    return m;
  }

  function addEvent(kind, at, title, sub, url, when) {
    const i = locate(at.n);
    if (i < 0) { return; }
    const ev = { kind: kind, n: at.n, exact: at.exact, title: title, sub: sub, url: url, when: when, i: i };
    events.push(ev);
    const m = markAt(i);
    m.items.push(ev);
    // One exact mark of a kind is enough to fill the square.
    m.exact[kind] = m.exact[kind] || at.exact;
  }

  (Array.isArray(DATA.posts) ? DATA.posts : []).forEach((p) => {
    const w = parseWhen(p && p.date);
    if (!w || !w.d) { return; }
    addEvent('post', whenDay(w), p.title || 'Untitled', null, p.url, whenLabel(w));
  });

  // The anchor /travel/ gives a place: its `id`, or its name as a slug, with
  // the year added when two entries share a name. Kept in step with the loop
  // in travel.html.
  const places = Array.isArray(DATA.places) ? DATA.places : [];
  const sameName = {};
  places.forEach((p) => {
    if (p && p.place) { sameName[p.place] = (sameName[p.place] || 0) + 1; }
  });
  places.forEach((p) => {
    if (!p || !p.place) { return; }
    const w = parseWhen(p.when);
    if (!w) { return; }
    let anchor;
    if (p.id) {
      anchor = slugify(p.id);
    } else if (sameName[p.place] > 1) {
      anchor = slugify(p.place + ' ' + p.when);
    } else {
      anchor = slugify(p.place);
    }
    const where = [p.state, p.country].filter(Boolean).join(', ');
    addEvent('trip', whenDay(w), p.place, where, (LINKS.travel || '/travel/') + '#' + anchor, whenLabel(w));
  });

  // Finished quests with a date. One that finished itself by reaching its
  // target has no `when` to put it anywhere, so it stays off the grid.
  (Array.isArray(DATA.quests) ? DATA.quests : []).forEach((q) => {
    if (!q || !q.done) { return; }
    const w = parseWhen(q.when);
    if (!w) { return; }
    addEvent('quest', whenDay(w), q.text, 'Side quest #' + q.id,
             (LINKS.quests || '/side-quests/') + '#q' + q.id, whenLabel(w));
  });

  // Training: any day with a lift or a run in it.
  const tr = DATA.training || {};
  const t0 = parseWhen(tr.start);
  let trainFrom = null;
  if (t0 && t0.d && Array.isArray(tr.lift)) {
    const base = dayNum(t0.y, t0.m, t0.d);
    const runs = Array.isArray(tr.run) ? tr.run : [];
    const len = Math.max(tr.lift.length, runs.length);
    for (let k = 0; k < len; k += 1) {
      const lifted = Number(tr.lift[k]) > 0;
      const ran = Number(runs[k]) > 0;
      if (!lifted && !ran) { continue; }
      const i = locate(base + k);
      if (i < 0) { continue; }
      if (trainFrom === null) { trainFrom = base + k; }
      const m = markAt(i);
      m.train = m.train || { days: 0, lifts: 0, runs: 0 };
      m.train.days += 1;
      if (lifted) { m.train.lifts += 1; }
      if (ran) { m.train.runs += 1; }
    }
  }

  // Eras run from the first day of `from` to the last day of `to`, inclusive;
  // one with no `to` is still going.
  const eras = (Array.isArray(DATA.eras) ? DATA.eras : []).map((e) => {
    if (!e || !e.label) { return null; }
    const a = parseWhen(e.from);
    if (!a) { return null; }
    const b = e.to === undefined || e.to === null ? null : parseWhen(e.to);
    const from = dayNum(a.y, a.m || 1, a.d || 1);
    let to;
    if (!b) {
      to = Math.min(TODAY, END - 1);
    } else if (b.d) {
      to = dayNum(b.y, b.m, b.d);
    } else if (b.m) {
      to = dayNum(b.y, b.m + 1, 1) - 1;
    } else {
      to = dayNum(b.y + 1, 1, 1) - 1;
    }
    if (to < from || to < START || from >= END) { return null; }
    return {
      label: String(e.label),
      from: Math.max(from, START),
      to: Math.min(to, END - 1),
      span: whenLabel(a) + ' – ' + (b ? whenLabel(b) : 'now'),
    };
  }).filter(Boolean);

  function erasOn(a, b) {
    return eras.filter((e) => e.from <= b && e.to >= a);
  }

  // -------------------------------------------------------------------------
  // The grid
  // -------------------------------------------------------------------------

  const squares = new Array(SQUARES);
  const frag = document.createDocumentFragment();

  const corner = el('span', 'yr', 'Age');
  corner.setAttribute('aria-hidden', 'true');
  frag.appendChild(corner);
  const axis = el('span', 'wk-axis', 'Week 1 → 52');
  axis.setAttribute('aria-hidden', 'true');
  frag.appendChild(axis);

  for (let r = 0; r < YEARS; r += 1) {
    if (r && r % 10 === 0) { frag.appendChild(el('span', 'decade')); }
    const isNowRow = NOW >= 0 && Math.floor(NOW / WEEKS) === r;
    const label = el('span', isNowRow ? 'yr is-now' : 'yr', (r % 5 === 0 || isNowRow) ? r : null);
    label.setAttribute('aria-hidden', 'true');
    frag.appendChild(label);
    for (let c = 0; c < WEEKS; c += 1) {
      const i = r * WEEKS + c;
      const sq = document.createElement('i');
      sq.setAttribute('data-i', i);
      if (i === NOW) {
        sq.className = 'now';
      } else if (i < LIVED_TO) {
        sq.className = 'lived';
      }
      squares[i] = sq;
      frag.appendChild(sq);
    }
  }
  grid.appendChild(frag);

  /** The kind a square shows: the first in KINDS present, then training. */
  function shownKind(m, only) {
    for (let k = 0; k < KINDS.length; k += 1) {
      const key = KINDS[k].key;
      if ((only === 'all' || only === key) && m.items.some((ev) => ev.kind === key)) { return key; }
    }
    if ((only === 'all' || only === 'train') && m.train) { return 'train'; }
    return null;
  }

  /** Recolour the marked squares for a filter. The rest never change. */
  function paint(only) {
    marks.forEach((m, i) => {
      const sq = squares[i];
      sq.classList.remove('fill', 'ring', 'trained');
      sq.style.removeProperty('--c');
      const kind = shownKind(m, only);
      if (!kind) { return; }
      if (kind === 'train') {
        sq.classList.add('trained');
        return;
      }
      sq.style.setProperty('--c', KIND[kind].colour);
      sq.classList.add(m.exact[kind] ? 'fill' : 'ring');
    });
  }

  // -------------------------------------------------------------------------
  // Headline numbers, filters and the key
  // -------------------------------------------------------------------------

  const livedDays = Math.max(0, Math.min(TODAY, END) - START);
  const weeksLived = Math.floor(livedDays / 7);
  const weeksAll = Math.floor((END - START) / 7);
  let markedWeeks = 0;
  let trainedWeeks = 0;
  marks.forEach((m) => {
    if (m.items.length) { markedWeeks += 1; }
    if (m.train) { trainedWeeks += 1; }
  });
  const counts = { quest: 0, post: 0, trip: 0 };
  events.forEach((ev) => { counts[ev.kind] += 1; });

  const meta = document.getElementById('life-meta');
  if (meta) {
    if (TODAY < START) {
      meta.textContent = 'Starts ' + dayLabel(START);
    } else if (NOW < 0) {
      meta.textContent = 'All ' + YEARS + ' years lived';
    } else {
      const pct = (100 * livedDays / (END - START)).toFixed(1);
      meta.textContent = 'Age ' + Math.floor(NOW / WEEKS) + ', week ' + (NOW % WEEKS + 1) +
        ' · ' + pct + '% of the way to ' + YEARS;
    }
  }

  function statCard(value, label, hint) {
    const c = el('div', 'stat-card');
    c.appendChild(el('div', 'n', value));
    c.appendChild(el('div', 'l', label));
    if (hint) { c.appendChild(el('div', 'hint', hint)); }
    return c;
  }
  const stats = el('div', 'stat-grid c4');
  stats.appendChild(statCard(nf(weeksLived), 'Weeks lived'));
  stats.appendChild(statCard(nf(Math.max(0, weeksAll - weeksLived)), 'Weeks to go', 'to ' + YEARS));
  stats.appendChild(statCard(nf(markedWeeks), 'Weeks marked', 'a post, trip or quest'));
  stats.appendChild(statCard(nf(trainedWeeks), 'Weeks trained',
    trainFrom === null ? null : 'since ' + monthLabel(trainFrom)));
  root.insertBefore(stats, stage);

  // One row of filters above the grid, doubling as the legend for the hues.
  const chips = el('div', 'chips');
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', 'Show one kind of week');
  const chipDefs = [{ key: 'all', label: 'All' }]
    .concat(KINDS.map((k) => ({ key: k.key, label: k.label, n: counts[k.key], colour: k.colour })))
    .concat([{ key: 'train', label: 'Training', n: trainedWeeks, colour: 'var(--wk-trained)', unit: 'wk' }]);
  const chipEls = chipDefs.map((d) => {
    const b = el('button', 'chip');
    b.type = 'button';
    b.setAttribute('data-only', d.key);
    if (d.colour) {
      const sw = el('span', 'sw');
      sw.style.setProperty('--c', d.colour);
      sw.setAttribute('aria-hidden', 'true');
      b.appendChild(sw);
    }
    b.appendChild(document.createTextNode(d.label));
    if (d.n !== undefined) { b.appendChild(el('em', null, d.unit ? d.n + ' ' + d.unit : d.n)); }
    chips.appendChild(b);
    return b;
  });
  root.insertBefore(chips, stage);

  // The greys and the two special squares, under the grid.
  const keys = el('div', 'life-keys');
  [['sw', '--wk-future', 'To come'], ['sw', '--wk-lived', 'Lived'],
   ['sw is-now', null, 'This week'], ['sw is-ring', null, 'Known only to the month or year']]
    .forEach((k) => {
      const item = el('span');
      const sw = el('span', k[0]);
      if (k[1]) { sw.style.setProperty('--c', 'var(' + k[1] + ')'); }
      sw.setAttribute('aria-hidden', 'true');
      item.appendChild(sw);
      item.appendChild(document.createTextNode(k[2]));
      keys.appendChild(item);
    });
  stage.parentNode.insertBefore(keys, stage.nextSibling);

  let only = 'all';
  function setOnly(next) {
    // Clicking the chip that is on turns it off again, as on /side-quests/.
    only = (next === only && next !== 'all') ? 'all' : next;
    chipEls.forEach((b) => {
      const on = b.getAttribute('data-only') === only;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    paint(only);
  }
  chipEls.forEach((b) => {
    b.addEventListener('click', () => { setOnly(b.getAttribute('data-only')); });
  });
  setOnly('all');

  // -------------------------------------------------------------------------
  // The marked weeks, as text
  // -------------------------------------------------------------------------

  const ORDER = { quest: 0, trip: 1, post: 2 };
  events.sort((a, b) => (b.n - a.n) || (ORDER[a.kind] - ORDER[b.kind]));

  const section = el('section', 'life-marked');
  section.appendChild(el('h2', 'sect', 'The marked weeks'));
  const rowFor = new Map();   // square -> its first row in the list
  if (!events.length) {
    section.appendChild(el('p', 'empty', 'Nothing marked yet.'));
  }
  let year = null;
  let list = null;
  events.forEach((ev) => {
    const y = ymd(ev.n).y;
    if (y !== year) {
      year = y;
      section.appendChild(el('h3', 'life-year', y));
      list = el('ul', 'life-rows');
      section.appendChild(list);
    }
    const li = el('li');
    li.setAttribute('data-i', ev.i);
    li.appendChild(el('span', 'lr-when', ev.when));
    const kind = el('span', 'lr-kind');
    const sw = el('span', ev.exact ? 'sw' : 'sw is-ring');
    sw.style.setProperty('--c', KIND[ev.kind].colour);
    if (!ev.exact) { sw.style.boxShadow = 'inset 0 0 0 2px ' + KIND[ev.kind].colour; }
    sw.setAttribute('aria-hidden', 'true');
    kind.appendChild(sw);
    kind.appendChild(document.createTextNode(KIND[ev.kind].one));
    li.appendChild(kind);
    const what = el('span', 'lr-what');
    const link = el('a', null, ev.title);
    link.href = safeUrl(ev.url);
    what.appendChild(link);
    if (ev.sub) { what.appendChild(el('span', 'lr-sub', ev.sub)); }
    li.appendChild(what);
    list.appendChild(li);
    if (!rowFor.has(ev.i)) { rowFor.set(ev.i, li); }

    li.addEventListener('mouseenter', () => {
      li.classList.add('is-hot');
      squares[ev.i].classList.add('hl');
    });
    li.addEventListener('mouseleave', () => {
      li.classList.remove('is-hot');
      squares[ev.i].classList.remove('hl');
    });
  });

  if (trainedWeeks) {
    const more = el('p', 'life-more');
    more.appendChild(document.createTextNode(
      'Plus ' + trainedWeeks + ' week' + (trainedWeeks === 1 ? '' : 's') +
      ' with a lift or a run in them. The '));
    const fit = el('a', null, 'Fitness page');
    fit.href = safeUrl(LINKS.fitness || '/fitness/');
    more.appendChild(fit);
    more.appendChild(document.createTextNode(' has the detail.'));
    section.appendChild(more);
  }
  keys.parentNode.insertBefore(section, keys.nextSibling);

  // -------------------------------------------------------------------------
  // Era brackets, down the right of the grid
  // -------------------------------------------------------------------------

  let layoutEras = function () {};
  if (eras.length) {
    stage.classList.add('has-eras');
    const layer = el('div', 'life-eras');
    layer.setAttribute('aria-hidden', 'true');
    stage.appendChild(layer);

    // Overlapping eras take lanes side by side; the labels sit past the last.
    const laneEnds = [];
    eras.slice().sort((a, b) => a.from - b.from).forEach((e) => {
      let lane = laneEnds.findIndex((end) => end < e.from);
      if (lane < 0) {
        lane = laneEnds.length;
        laneEnds.push(e.to);
      } else {
        laneEnds[lane] = e.to;
      }
      e.lane = lane;
      e.line = el('span', 'era-line');
      e.tick = el('span', 'era-tick');
      e.labelEl = el('span', 'era-label', e.label);
      e.labelEl.appendChild(el('small', null, e.span));
      layer.appendChild(e.line);
      layer.appendChild(e.tick);
      layer.appendChild(e.labelEl);
    });
    const lanes = laneEnds.length;

    layoutEras = function () {
      const LANE = 9;
      let floor = 0;   // the lowest a label may start, so labels never overlap
      eras.slice().sort((a, b) => a.from - b.from).forEach((e) => {
        const top = squares[Math.floor(locate(e.from) / WEEKS) * WEEKS];
        const bottom = squares[Math.floor(locate(e.to) / WEEKS) * WEEKS];
        const y0 = top.offsetTop;
        const y1 = bottom.offsetTop + bottom.offsetHeight;
        const x = 4 + e.lane * LANE;
        e.line.style.left = x + 'px';
        e.line.style.top = y0 + 'px';
        e.line.style.height = Math.max(2, y1 - y0) + 'px';
        const lx = 4 + lanes * LANE + 4;
        const ly = Math.max(y0 - 3, floor);
        e.tick.style.left = x + 'px';
        e.tick.style.top = y0 + 'px';
        e.tick.style.width = Math.max(4, lx - x - 2) + 'px';
        e.labelEl.style.left = lx + 'px';
        e.labelEl.style.width = Math.max(24, layer.clientWidth - lx - 2) + 'px';
        e.labelEl.style.top = ly + 'px';
        floor = ly + e.labelEl.offsetHeight + 2;
      });
    };
    layoutEras();
  }

  // -------------------------------------------------------------------------
  // The card, the hover and the keyboard
  // -------------------------------------------------------------------------

  let hot = -1;
  let pinned = false;
  let cursor = -1;

  const say = el('p', 'sr');
  say.setAttribute('aria-live', 'polite');
  root.appendChild(say);

  function setHot(i) {
    if (hot >= 0) { squares[hot].classList.remove('hot'); }
    hot = i;
    if (hot >= 0) { squares[hot].classList.add('hot'); }
  }

  /** What one square holds, as lines of text; the card and the live region share it. */
  function describe(i) {
    const days = squareDays(i);
    const m = marks.get(i);
    const out = {
      title: 'Age ' + Math.floor(i / WEEKS) + ', week ' + (i % WEEKS + 1),
      when: rangeLabel(days[0], days[1]),
      state: i === NOW ? 'This week' : (i >= LIVED_TO ? 'To come' : null),
      eras: erasOn(days[0], days[1]).map((e) => e.label),
      items: m ? m.items.slice().sort((a, b) => ORDER[a.kind] - ORDER[b.kind]) : [],
      train: m && m.train ? m.train : null,
    };
    return out;
  }

  function trainText(t) {
    const parts = [];
    if (t.lifts) { parts.push(t.lifts + (t.lifts === 1 ? ' lift' : ' lifts')); }
    if (t.runs) { parts.push(t.runs + (t.runs === 1 ? ' run' : ' runs')); }
    return 'Trained on ' + t.days + (t.days === 1 ? ' day' : ' days') + ': ' + parts.join(', ');
  }

  function fillCard(i) {
    const d = describe(i);
    card.textContent = '';
    // The stylesheet stacks these two, so a long range never squeezes the title.
    const head = el('p', 'card-head');
    head.appendChild(el('span', 'card-title', d.title));
    head.appendChild(el('span', 'card-when', d.when));
    card.appendChild(head);
    if (d.state) { card.appendChild(el('p', 'card-line', d.state)); }
    if (d.eras.length) { card.appendChild(el('p', 'card-line', d.eras.join(' · '))); }
    if (d.items.length) {
      const ul = el('ul', 'card-items');
      d.items.forEach((ev) => {
        const li = el('li');
        const key = el('span', 'line-key');
        key.style.setProperty('--c', KIND[ev.kind].colour);
        li.appendChild(key);
        const body = el('span');
        const a = el('a', null, ev.title);
        a.href = safeUrl(ev.url);
        // The card is a pointer's convenience: the list under the grid is
        // where the keyboard goes, so nothing in here takes focus.
        a.tabIndex = -1;
        body.appendChild(a);
        body.appendChild(el('span', 'card-sub',
          KIND[ev.kind].one + (ev.sub ? ' · ' + ev.sub : '') + ' · ' + ev.when));
        li.appendChild(body);
        ul.appendChild(li);
      });
      card.appendChild(ul);
    }
    if (d.train) { card.appendChild(el('p', 'card-line', trainText(d.train))); }
    return d;
  }

  /** Beside the square if there is room, otherwise above or below it. */
  function placeCard(i) {
    const s = stage.getBoundingClientRect();
    const q = squares[i].getBoundingClientRect();
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const gap = 10;
    const x0 = q.left - s.left;
    const y0 = q.top - s.top;
    let left = x0 + q.width + gap;
    let top = y0 + q.height / 2 - ch / 2;
    if (left + cw > s.width) { left = x0 - gap - cw; }
    if (left < 0) {
      left = Math.max(0, Math.min(s.width - cw, x0 + q.width / 2 - cw / 2));
      top = y0 - gap - ch;
      if (top < 0) { top = y0 + q.height + gap; }
    } else {
      top = Math.max(0, Math.min(s.height - ch, top));
    }
    card.style.left = Math.round(left) + 'px';
    card.style.top = Math.round(top) + 'px';
  }

  function show(i) {
    setHot(i);
    fillCard(i);
    card.hidden = false;
    card.classList.toggle('is-pinned', pinned);
    placeCard(i);
  }

  function hide() {
    pinned = false;
    card.hidden = true;
    card.classList.remove('is-pinned');
    setHot(document.activeElement === grid ? cursor : -1);
  }

  function squareFrom(target) {
    const sq = target && target.closest ? target.closest('i[data-i]') : null;
    return sq && grid.contains(sq) ? Number(sq.getAttribute('data-i')) : -1;
  }

  grid.addEventListener('pointermove', (e) => {
    if (pinned || e.pointerType === 'touch') { return; }
    const i = squareFrom(e.target);
    // Over a gap between squares, the last one stays: the gaps are part of
    // the target, or the card would flicker on every pixel between squares.
    if (i >= 0 && i !== hot) { show(i); }
  });
  grid.addEventListener('pointerleave', () => {
    if (pinned) { return; }
    if (document.activeElement === grid && cursor >= 0) {
      show(cursor);
    } else {
      hide();
    }
  });
  grid.addEventListener('click', (e) => {
    const i = squareFrom(e.target);
    if (i < 0) { return; }
    if (pinned && i === hot) {
      hide();
      return;
    }
    pinned = true;
    cursor = i;
    show(i);
  });
  document.addEventListener('click', (e) => {
    if (pinned && !stage.contains(e.target)) { hide(); }
  });

  // The keyboard: arrows move a week or a year, Home and End go to either end
  // of a row, and Enter goes down to that week in the list, links and all.
  grid.tabIndex = 0;
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-roledescription', 'grid of weeks');
  grid.setAttribute('aria-label', 'Every week of a ' + YEARS + '-year life. ' +
    'Arrow keys move a week or a year at a time; Enter goes to that week in the list below.');

  function moveTo(i) {
    cursor = Math.max(0, Math.min(SQUARES - 1, i));
    show(cursor);
    const d = describe(cursor);
    const bits = [d.title + ', ' + d.when];
    if (d.state) { bits.push(d.state); }
    d.eras.forEach((x) => { bits.push(x); });
    d.items.forEach((ev) => { bits.push(KIND[ev.kind].one + ': ' + ev.title); });
    if (d.train) { bits.push(trainText(d.train)); }
    say.textContent = bits.join('. ') + '.';
  }

  let byPointer = false;
  // Only a press that is about to give the grid focus counts, or a later Tab
  // into the grid would find the flag still up.
  grid.addEventListener('pointerdown', () => { byPointer = document.activeElement !== grid; });
  grid.addEventListener('focus', () => {
    if (cursor < 0) { cursor = NOW >= 0 ? NOW : Math.max(0, LIVED_TO - 1); }
    if (byPointer) {
      byPointer = false;
      return;
    }
    moveTo(cursor);
  });
  grid.addEventListener('blur', () => {
    if (!pinned) { hide(); }
  });
  grid.addEventListener('keydown', (e) => {
    const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -WEEKS, ArrowDown: WEEKS };
    if (Object.prototype.hasOwnProperty.call(steps, e.key)) {
      e.preventDefault();
      pinned = false;
      const next = cursor + steps[e.key];
      if (next >= 0 && next < SQUARES) { moveTo(next); }
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const rowAt = cursor - (cursor % WEEKS);
      moveTo(e.key === 'Home' ? rowAt : rowAt + WEEKS - 1);
    } else if (e.key === 'Enter') {
      const row = rowFor.get(cursor);
      if (row) {
        e.preventDefault();
        row.scrollIntoView({ block: 'center' });
        row.querySelector('a').focus();
      } else {
        say.textContent = 'Nothing marked that week.';
      }
    } else if (e.key === 'Escape') {
      hide();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pinned) { hide(); }
  });

  // Squares change size with the column, and the card and brackets with them.
  let queued = false;
  window.addEventListener('resize', () => {
    if (queued) { return; }
    queued = true;
    window.requestAnimationFrame(() => {
      queued = false;
      layoutEras();
      if (!card.hidden && hot >= 0) { placeCard(hot); }
    });
  });
}());
