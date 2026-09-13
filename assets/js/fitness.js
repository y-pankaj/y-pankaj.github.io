/* ==========================================================================
   /fitness/ -- charts and tables, rendered from site.data.fitness.

   The page inlines the summary as `window.FITNESS_DATA` via Liquid, so there
   is no fetch here: everything is already in the document by the time this
   runs. Charts are hand-rolled SVG -- no library, no build step, nothing the
   Jekyll site does not already ship.

   The summary is produced by scripts/build_fitness_data.py from the FitNotes
   export, and refreshed by .github/workflows/sync-fitness.yml.
   ========================================================================== */

(function () {
  'use strict';

  var DATA = window.FITNESS_DATA;
  if (!DATA || !document.getElementById('fitness')) { return; }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const el = (id) => document.getElementById(id);
  const nf = (n) => n.toLocaleString('en-US');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

  /** 228800 -> "228.8" (tonnes). */
  const tonnes = (kg) => (kg / 1000).toFixed(1);

  /** 5442 -> "1:30:42"; 1893 -> "31:33". */
  function hms(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.round(sec % 60);
    const p = (v) => String(v).padStart(2, '0');
    return h ? h + ':' + p(m) + ':' + p(s) : m + ':' + p(s);
  }

  /** seconds-per-km -> "5:38". Rounds the total, so 359.8 is 6:00 and not 5:60. */
  function paceStr(spk) {
    const v = Math.round(spk);
    return Math.floor(v / 60) + ':' + String(v % 60).padStart(2, '0');
  }

  /** "2026-09-12" -> Date at local midnight (no timezone drift). */
  const d8 = (iso) => new Date(iso + 'T00:00:00');

  /** "2026-09-12" -> "12 Sep". */
  function dShort(iso) {
    const d = d8(iso);
    return d.getDate() + ' ' + MONTHS[d.getMonth()];
  }

  /** "2026-09-12" -> "12 Sep 2026". */
  function dLong(iso) {
    return dShort(iso) + ' ' + d8(iso).getFullYear();
  }

  /* Charts scale down to fit a narrow column but never scale up past the size
     they were drawn at -- otherwise the 10px labels balloon on a wide screen. */
  function svg(w, h, inner, label) {
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" style="max-width:' + w +
           'px" role="img" aria-label="' + esc(label || '') + '">' + inner + '</svg>';
  }

  /* -------------------------------------------------------------------------
     Contribution heatmap, GitHub-shaped: one column per week (Sunday first),
     one row per weekday, intensity in quartiles of the day's training load.
     ------------------------------------------------------------------------- */

  /** Per-day load for the given mode; `both` sums the two normalised series. */
  function loadSeries(mode) {
    const cal = DATA.calendar;
    const maxL = Math.max.apply(null, cal.lift) || 1;
    const maxR = Math.max.apply(null, cal.run) || 1;
    return cal.lift.map((kg, i) => {
      const km = cal.run[i];
      if (mode === 'lift') return kg;
      if (mode === 'run') return km;
      return kg / maxL + km / maxR;
    });
  }

  function quartiles(vals) {
    const on = vals.filter((v) => v > 0).sort((a, b) => a - b);
    if (!on.length) return [0, 0, 0];
    const at = (p) => on[Math.min(on.length - 1, Math.floor(on.length * p))];
    return [at(0.25), at(0.5), at(0.75)];
  }

  function heatmap(host, opts) {
    opts = opts || {};
    const mode = opts.mode || 'both';
    const CELL = opts.cell || 11;
    const GAP = opts.gap || 3;
    const P = CELL + GAP;
    const LEFT = 28;
    const TOP = 16;

    const cal = DATA.calendar;
    const n = cal.lift.length;
    const start = d8(cal.start);
    const off = start.getDay();               // 0 = Sunday, matches GitHub
    const cols = Math.ceil((n + off) / 7);
    const W = LEFT + cols * P - GAP + 2;
    const H = TOP + 7 * P - GAP + 2;

    const load = loadSeries(mode);
    const q = quartiles(load);
    const lvl = (v) => (v <= 0 ? 0 : v <= q[0] ? 1 : v <= q[1] ? 2 : v <= q[2] ? 3 : 4);

    let cells = '';
    let labels = '';
    // A window that opens mid-month leaves a stub with no label, same as GitHub.
    // One that opens on the 1st gets labelled like any other month.
    let lastMonth = start.getDate() === 1 ? -1 : start.getMonth();

    for (let i = 0; i < n; i++) {
      const slot = i + off;
      const col = Math.floor(slot / 7);
      const row = slot % 7;
      const day = new Date(start.getTime() + i * 86400000);
      const x = LEFT + col * P;
      const y = TOP + row * P;

      const kg = cal.lift[i];
      const km = cal.run[i];
      const bits = [];
      if (kg) bits.push(nf(kg) + ' kg lifted');
      if (km) bits.push(km.toFixed(1) + ' km run' + (cal.run_sec[i] ? ' in ' + hms(cal.run_sec[i]) : ''));
      const tip = day.getDate() + ' ' + MONTHS[day.getMonth()] + ' ' + day.getFullYear() +
                  ' — ' + (bits.length ? bits.join(' · ') : 'rest');

      cells += '<rect class="hm l' + lvl(load[i]) +
               '" x="' + x + '" y="' + y + '" width="' + CELL + '" height="' + CELL +
               '" rx="2"><title>' + esc(tip) + '</title></rect>';

      // Month label over the column that contains the 1st.
      if (day.getDate() === 1 && day.getMonth() !== lastMonth) {
        labels += '<text class="hm-lbl" x="' + x + '" y="' + (TOP - 5) + '">' +
                  MONTHS[day.getMonth()] + '</text>';
        lastMonth = day.getMonth();
      }
    }

    ['Mon', 'Wed', 'Fri'].forEach((name, k) => {
      const row = 1 + k * 2;
      labels += '<text class="hm-lbl" x="0" y="' + (TOP + row * P + CELL / 2 + 3.5) + '">' +
                name + '</text>';
    });

    host.innerHTML = '<div class="hm-wrap">' +
      '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H +
      '" role="img" aria-label="Training contribution calendar">' +
      labels + cells + '</svg></div>';
  }

  function heatLegend(extra) {
    return '<div class="hm-foot">' + (extra || '') +
      '<span class="sp"></span><span class="hm-key">rest' +
      '<i style="background:var(--hm0)"></i><i style="background:var(--a28)"></i>' +
      '<i style="background:var(--a50)"></i><i style="background:var(--a74)"></i>' +
      '<i style="background:var(--a100)"></i>heavy</span></div>';
  }

  /* -------------------------------------------------------------------------
     Vertical bars with a value on top and a two-part label underneath.
     items: [{k:'May', v:30500, label:'30.5t', sub:'10d'}]
     ------------------------------------------------------------------------- */
  function vbars(host, items, opts) {
    opts = opts || {};
    const BW = opts.bw || 44;
    const GAPX = opts.gapx || 30;
    const PH = opts.h || 112;
    const TOPPAD = 16;
    const BASE = TOPPAD + PH;
    const W = items.length * (BW + GAPX);
    const H = BASE + 24;
    const max = Math.max.apply(null, items.map((i) => i.v)) || 1;

    let out = '';
    items.forEach((it, i) => {
      const x = i * (BW + GAPX) + GAPX / 2;
      const h = Math.max(1, Math.round((it.v / max) * PH));
      const cx = x + BW / 2;
      out += '<rect class="bar' + (it.hi ? ' hi' : '') + '" x="' + x + '" y="' +
             (BASE - h) + '" width="' + BW + '" height="' + h + '">' +
             '<title>' + esc(it.k + ': ' + (it.label || nf(it.v))) + '</title></rect>';
      out += '<text class="v" x="' + cx + '" y="' + (BASE - h - 5) +
             '" text-anchor="middle">' + esc(it.label || nf(it.v)) + '</text>';
      out += '<text class="k" x="' + cx + '" y="' + (BASE + 16) + '" text-anchor="middle">' +
             esc(it.k) + (it.sub ? ' <tspan class="dim">' + esc(it.sub) + '</tspan>' : '') +
             '</text>';
    });
    out += '<line class="axis" x1="0" y1="' + BASE + '" x2="' + W + '" y2="' + BASE + '"/>';
    host.innerHTML = svg(W, H, out, opts.label || 'bar chart');
  }

  /* -------------------------------------------------------------------------
     Weekly bars plus a 4-week rolling average line.
     ------------------------------------------------------------------------- */
  function weeklyChart(host, weeks, opts) {
    opts = opts || {};
    const key = opts.key || 'kg';
    const unit = opts.unit || 'kg';
    const BW = opts.bw || 26;
    const GAPX = opts.gapx || 8;
    const PH = 110;
    const TOPPAD = 12;
    const BASE = TOPPAD + PH;
    const W = weeks.length * (BW + GAPX);
    const H = BASE + 22;
    const max = Math.max.apply(null, weeks.map((w) => w[key])) || 1;

    let bars = '';
    const pts = [];
    weeks.forEach((w, i) => {
      const x = i * (BW + GAPX);
      const h = Math.max(1, Math.round((w[key] / max) * PH));
      bars += '<rect class="bar" x="' + x + '" y="' + (BASE - h) + '" width="' + BW +
              '" height="' + h + '" rx="1"><title>' + esc('Week of ' + dLong(w.w) +
              ' — ' + nf(w[key]) + ' ' + unit) + '</title></rect>';
      const win = weeks.slice(Math.max(0, i - 3), i + 1);
      const avg = win.reduce((a, b) => a + b[key], 0) / win.length;
      pts.push((x + BW / 2) + ',' + (BASE - (avg / max) * PH));
    });

    let ticks = '';
    weeks.forEach((w, i) => {
      const d = d8(w.w);
      if (i === 0 || d.getDate() <= 7) {
        ticks += '<text x="' + (i * (BW + GAPX) + BW / 2) + '" y="' + (BASE + 15) +
                 '" text-anchor="middle">' + MONTHS[d.getMonth()] + '</text>';
      }
    });

    host.innerHTML = svg(W, H,
      bars + '<polyline class="avg" points="' + pts.join(' ') + '"/>' +
      '<line class="axis" x1="0" y1="' + BASE + '" x2="' + W + '" y2="' + BASE + '"/>' + ticks,
      'weekly volume');
  }

  /* -------------------------------------------------------------------------
     Ranked horizontal bars. rows: [{name, v, right, pct}]
     ------------------------------------------------------------------------- */
  function rankRows(host, rows, opts) {
    opts = opts || {};
    const max = Math.max.apply(null, rows.map((r) => r.v)) || 1;
    const total = rows.reduce((a, b) => a + b.v, 0) || 1;
    host.innerHTML = rows.map((r) =>
      '<div class="rank"><div class="rank-name">' + esc(r.name) + '</div>' +
      '<div class="rank-track"><i style="width:' + ((r.v / max) * 100).toFixed(1) + '%"></i></div>' +
      '<div class="rank-v">' + (r.right || nf(r.v)) + '<span> ' + (opts.unit || 'kg') + '</span></div>' +
      '<div class="rank-p">' + Math.round((r.v / total) * 100) + '%</div></div>'
    ).join('');
  }

  /* -------------------------------------------------------------------------
     PR dot plot: one row per exercise, dot placed on the date the PR landed,
     dot size scaled by estimated 1RM. Answers "what" and "when" in one read.
     ------------------------------------------------------------------------- */

  /* -------------------------------------------------------------------------
     Pace against distance, one dot per run in the window.
     ------------------------------------------------------------------------- */
  function paceScatter(host, days) {
    const cal = DATA.calendar;
    const n = cal.run.length;
    const from = Math.max(0, n - (days || 180));
    const pts = [];
    for (let i = from; i < n; i++) {
      if (cal.run[i] > 0) pts.push([cal.run[i], cal.run_sec[i] / cal.run[i], i]);
    }

    const L = 46, R = 12, T = 12, B = 30;
    const W = 760, H = 250;
    const PW = W - L - R, PH = H - T - B;
    if (!pts.length) { host.innerHTML = ''; return; }

    // Bounds follow the data. Runs of 1.5-7 km on a 0-20 km axis would all pile
    // into the left quarter.
    const xStep = Math.max(...pts.map((p) => p[0])) <= 12 ? 2 : 5;
    const xMax = Math.ceil(Math.max(...pts.map((p) => p[0])) / xStep) * xStep;
    const paces = pts.map((p) => p[1]);
    const yStep = (Math.max(...paces) - Math.min(...paces)) <= 150 ? 30 : 60;
    const yMin = Math.floor((Math.min(...paces) - 12) / yStep) * yStep;
    const yMax = Math.ceil((Math.max(...paces) + 12) / yStep) * yStep;
    const X = (km) => L + Math.min(km, xMax) / xMax * PW;
    const Y = (s) => T + PH - ((Math.min(Math.max(s, yMin), yMax) - yMin) / (yMax - yMin)) * PH;

    let g = '';
    for (let s = yMin; s <= yMax; s += yStep) {
      g += '<line class="gl" x1="' + L + '" y1="' + Y(s).toFixed(1) + '" x2="' + (W - R) +
           '" y2="' + Y(s).toFixed(1) + '"/>';
      g += '<text x="' + (L - 8) + '" y="' + (Y(s) + 3.5).toFixed(1) +
           '" text-anchor="end">' + paceStr(s) + '</text>';
    }
    for (let km = 0; km <= xMax; km += xStep) {
      g += '<text x="' + X(km).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle">' +
           km + (km === xMax ? ' km' : '') + '</text>';
    }

    const start = d8(cal.start);
    const dots = pts.map((p) => {
      const day = new Date(start.getTime() + p[2] * 86400000);
      return '<circle cx="' + X(p[0]).toFixed(1) + '" cy="' + Y(p[1]).toFixed(1) +
        '" r="3.4" fill="var(--accent)" opacity="0.5"><title>' +
        esc(day.getDate() + ' ' + MONTHS[day.getMonth()] + ' — ' + p[0].toFixed(1) +
            ' km at ' + paceStr(p[1]) + ' /km') + '</title></circle>';
    }).join('');

    host.innerHTML = svg(W, H,
      g + dots + '<line class="axis" x1="' + L + '" y1="' + (T + PH) + '" x2="' + (W - R) +
      '" y2="' + (T + PH) + '"/>', 'pace against distance');
  }

  /* -------------------------------------------------------------------------
     Distance ladder. There are no race times to show, so the running goals are
     drawn as reach instead of speed: how far the longest run has got, and which
     milestones are still ahead of it.
     ------------------------------------------------------------------------- */
  function distanceLadder(host, lad) {
    const W = 760;
    const H = 112;
    const L = 14;
    const RGT = 14;
    const PW = W - L - RGT;
    const BY = 54;
    const BH = 16;
    const X = (km) => L + (km / lad.max_km) * PW;
    const reached = X(lad.longest_km);

    let out =
      '<rect x="' + L + '" y="' + BY + '" width="' + PW + '" height="' + BH +
      '" rx="8" fill="var(--fill)"/>' +
      '<rect x="' + L + '" y="' + BY + '" width="' + (reached - L).toFixed(1) +
      '" height="' + BH + '" rx="8" fill="var(--accent)" opacity="0.9"/>';

    lad.milestones.forEach((m, i) => {
      const x = X(m.km);
      const cy = BY + BH / 2;
      const anchor = i === lad.milestones.length - 1 ? 'end'
                   : i === 0 ? 'start' : 'middle';
      // Passed rungs sit on top of the filled bar, so they need a ring in the
      // panel colour to stay visible; the ones still ahead are left hollow.
      out += '<line class="gl" x1="' + x.toFixed(1) + '" y1="' + (BY - 12) +
             '" x2="' + x.toFixed(1) + '" y2="' + (BY + BH + 12) + '"/>';
      out += '<circle cx="' + x.toFixed(1) + '" cy="' + cy + '" r="7" ' +
             'fill="var(--panel)" stroke="' + (m.done ? 'var(--accent)' : 'var(--border)') +
             '" stroke-width="' + (m.done ? 2.5 : 1.5) + '"><title>' +
             esc(m.label + ' — ' + m.km + ' km' + (m.done ? ' — done' : ' — not yet')) +
             '</title></circle>';
      if (m.done) {
        out += '<circle cx="' + x.toFixed(1) + '" cy="' + cy +
               '" r="2.5" fill="var(--accent)"/>';
      }
      const km = (m.label === '5K' || m.label === '10K' || m.label === '30K')
        ? '' : ' <tspan class="dim">' + m.km + ' km</tspan>';
      out += '<text class="k" x="' + x.toFixed(1) + '" y="' + (BY - 19) +
             '" text-anchor="' + anchor + '">' + esc(m.label) + km +
             (m.quest ? ' <tspan class="dim">#' + m.quest + '</tspan>' : '') + '</text>';
    });

    // "You are here" caret under the filled edge.
    const cx = Math.min(Math.max(reached, L + 34), W - RGT - 34);
    out += '<path d="M' + (reached - 5).toFixed(1) + ' ' + (BY + BH + 4) +
           ' L' + (reached + 5).toFixed(1) + ' ' + (BY + BH + 4) +
           ' L' + reached.toFixed(1) + ' ' + (BY + BH - 1) + ' Z" fill="var(--accent)"/>';
    out += '<text class="v" x="' + cx.toFixed(1) + '" y="' + (BY + BH + 20) +
           '" text-anchor="middle">' + lad.longest_km + ' km longest run</text>';

    host.innerHTML = svg(W, H, out, 'distance milestones reached');
  }

  /* -------------------------------------------------------------------------
     Cumulative area over the window. series: flat per-day values.
     ------------------------------------------------------------------------- */

  /* -------------------------------------------------------------------------
     Where the numbers come from, with profile links.
     ------------------------------------------------------------------------- */
  /* Where the numbers come from. The profile cards are driven by
     DATA.running.profiles, so adding or removing one is a data change. */
  function sourcesPanel() {
    var profiles = (DATA.running && DATA.running.profiles) || {};
    function card(kicker, name, note) {
      return '<div class="src-card"><div class="src-kicker">' + kicker + '</div>' +
        '<div class="src-name">' + name + '</div>' +
        '<div class="src-note">' + note + '</div></div>';
    }

    var out = card('Logging', 'FitNotes',
      'Every set at the rack and every run on the road goes in here. One CSV ' +
      'export is the only thing this page reads.');

    Object.keys(profiles).forEach(function (key) {
      var p = profiles[key];
      var name = p.url
        ? '<a href="' + p.url + '">' + esc(p.label) + ' &rarr;</a>'
        : esc(p.label);
      out += card('Profile', name, esc(p.note || ''));
    });

    return '<div class="src-grid">' + out + '</div>' +
      '<p class="src-foot">Nothing here is typed in by hand. A nightly job ' +
      'pulls the export and rebuilds the site, so the numbers are never more ' +
      'than a day behind.</p>';
  }

  function benchQuest() {
    const q = DATA.bench_quest;
    const started = q.pct > 0;
    return '<div class="quest-line"><div class="quest-top">' +
      '<span>Bench ' + esc(q.target) + ' <span class="q">side-quest #' + q.quest +
      '</span></span><span class="dimtxt">' + esc(q.status) +
      (q.date ? ' &middot; ' + dLong(q.date) : '') + '</span></div>' +
      '<div class="goal-bar"><i style="width:' + Math.max(q.pct, 2) + '%' +
      (started ? '' : ';background:var(--border)') + '"></i></div>' +
      '<div class="goal-note">' + esc(q.note) + '</div></div>';
  }

  /* -------------------------------------------------------------------------
     Small building blocks reused across the three mockups.
     ------------------------------------------------------------------------- */
  function statCards(cards, cls) {
    return '<div class="stat-grid' + (cls ? ' ' + cls : '') + '">' + cards.map((c) =>
      '<div class="stat-card"><div class="n">' + c.n + (c.u ? '<small> ' + c.u + '</small>' : '') +
      '</div><div class="l">' + esc(c.l) + '</div>' +
      (c.hint ? '<div class="hint">' + esc(c.hint) + '</div>' : '') + '</div>'
    ).join('') + '</div>';
  }

  function runFeed(runs, opts) {
    opts = opts || {};
    // FitNotes records a date but no start time, so the row shows the date and
    // whatever note was left on the run.
    return '<div class="runs">' + runs.map((r) =>
      '<div class="run-row"><div class="run-ico">\u25B6</div>' +
      '<div class="run-main"><div class="run-name">' + esc(r.name) + '</div>' +
      '<div class="run-when">' + dLong(r.date) + '</div></div>' +
      '<div class="run-num"><b>' + r.km.toFixed(2) + ' km</b><span>' + hms(r.sec) +
      ' \u00B7 ' + paceStr(r.sec / r.km) + ' /km</span></div></div>'
    ).join('') +
    '<div class="runs-foot"><span>' + (opts.foot || 'Last six activities') +
    '</span><span>' + DATA.running.totals.count + ' runs logged</span></div></div>';
  }

  /** Prose under the ladder: what has been reached, and what is next. */
  function ladderNote() {
    const lad = DATA.ladder;
    const rt = DATA.running.totals;
    const done = lad.milestones.filter((m) => m.done);
    let out = 'Longest run so far is <b>' + lad.longest_km + ' km</b>';
    out += done.length
      ? ', past the <b>' + done[done.length - 1].label + '</b> rung. '
      : ', short of the first rung. ';

    if (lad.next) {
      out += 'Next is <b>' + lad.next.label + '</b> at ' + lad.next.km +
        ' km &mdash; <b>' + lad.next.gap_km + ' km</b> further than anything run yet. ';
    }

    const quest = lad.milestones.find((m) => m.quest && !m.done);
    if (quest && (!lad.next || quest.label !== lad.next.label)) {
      out += 'Side-quest&nbsp;#' + quest.quest + ' sits at ' + quest.km + ' km, another <b>' +
        (quest.km - (lad.next ? lad.next.km : lad.longest_km)).toFixed(1) +
        ' km</b> beyond that. ';
    }

    out += 'Average pace across all ' + rt.count + ' runs is <b>' +
      paceStr(rt.avg_pace_s) + ' /km</b>.';
    return out;
  }

  /* Skin switcher for the preview chrome only. */

  /* Variation 2 -- "Report": a bare headline band, one big switchable calendar,
     and the top twelve as a table rather than tiles. Reads top to bottom. */

  const R = DATA.running;
  const L = DATA.lifting;
  const rt = R.totals;
  const lt = L.totals;
  const s = DATA.streaks;

  el('since').textContent = dLong(DATA.window.start);
  el('cal-range').textContent = dLong(DATA.window.start) + ' – ' + dLong(DATA.window.end) +
    ' · ' + DATA.window.weeks + ' weeks';

  /* --- headline band -------------------------------------------------------- */
  const hrs = Math.floor(rt.moving_time_s / 3600);
  const mins = Math.floor((rt.moving_time_s % 3600) / 60);

  el('band').innerHTML = statCards([
    { n: nf(Math.round(rt.distance_km)), u: 'km', l: 'Distance run' },
    { n: nf(hrs) + '<small>h </small>' + mins, u: 'm', l: 'Moving time' },
    { n: nf(rt.count), l: 'Runs' },
    { n: rt.longest_km, u: 'km', l: 'Longest run', hint: 'average ' + paceStr(rt.avg_pace_s) + ' /km' },
    { n: tonnes(lt.volume_kg), u: 't', l: 'Weight lifted' },
    { n: nf(lt.sessions), l: 'Lifting sessions' },
    { n: nf(lt.sets), l: 'Sets logged', hint: nf(lt.reps) + ' reps' },
    { n: s.active_days, l: 'Active days', hint: 'of ' + DATA.window.days }
  ], 'c4');

  /* --- calendar, switchable ------------------------------------------------- */
  const MODE_NOTE = {
    both: 'lifting and running, combined load',
    lift: 'lifting volume only',
    run: 'distance run only'
  };

  function drawHeat(mode) {
    heatmap(el('heat'), { mode: mode, cell: 24, gap: 6 });
    el('heat-foot').innerHTML = heatLegend('<span>' + MODE_NOTE[mode] + '</span>');
  }

  el('mode').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    el('mode').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
    drawHeat(btn.dataset.mode);
  });
  drawHeat('both');

  el('streaks').innerHTML =
    '<span><b>' + s.current + '</b> day streak</span>' +
    '<span>longest <b>' + s.longest + '</b></span>' +
    '<span><b>' + (s.active_days / DATA.window.weeks).toFixed(1) + '</b> sessions a week</span>' +
    '<span><b>' + s.this_week + '</b> of the last seven days</span>';

  /* --- running -------------------------------------------------------------- */
  el('run-note').textContent = 'Kilometres a month. September is still in progress.';
  vbars(el('run-months'), R.monthly.map((m, i) => ({
    k: m.m, v: m.km, label: Math.round(m.km) + '',
    hi: i === R.monthly.length - 1, sub: i === R.monthly.length - 1 ? 'so far' : ''
  })), { bw: 34, gapx: 22, h: 100, label: 'distance by month' });

  paceScatter(el('scatter'), DATA.window.days);

  el('run-feed').innerHTML = runFeed(R.recent, { foot: 'Newest first' });

  /* --- lifting -------------------------------------------------------------- */
  const peak = L.weekly.reduce((a, w) => (w.kg > a.kg ? w : a), L.weekly[0]);
  el('week-note').textContent = 'Peak week ' + dLong(peak.w) + ' at ' + nf(peak.kg) + ' kg.';
  weeklyChart(el('weekly'), L.weekly, { bw: 32, gapx: 10 });

  const byS = L.exercises.slice().sort((a, c) => c.sets - a.sets);
  const maxSets = byS[0].sets;
  el('pr').innerHTML =
    '<thead><tr><th>Exercise</th><th class="num">Sets</th><th class="num">Volume</th>' +
    '<th class="num">Best set</th><th class="num">e1RM</th><th class="num">Achieved</th></tr></thead>' +
    '<tbody>' + byS.map((x) =>
      '<tr><td>' + esc(x.name) + '</td>' +
      '<td class="num"><i class="setbar" style="width:' +
        Math.round((x.sets / maxSets) * 46) + 'px"></i>' + x.sets + '</td>' +
      '<td class="num">' + nf(x.volume_kg) + ' <span style="opacity:.55">kg</span></td>' +
      '<td class="num pill"><b>' + x.pr.weight_kg + '</b> kg <span>&times; ' + x.pr.reps + '</span></td>' +
      '<td class="num dim">' + x.pr.e1rm_kg + ' kg</td>' +
      '<td class="num dim">' + dLong(x.pr.date) + '</td></tr>'
    ).join('') + '</tbody>';

  el('lift-note').textContent = 'Tonnes lifted, with training days under each bar.';
  vbars(el('lift-months'), L.monthly.map((m, i) => ({
    k: m.m, v: m.kg, label: tonnes(m.kg) + 't', sub: m.days + 'd',
    hi: i === L.monthly.length - 1
  })), { bw: 34, gapx: 22, h: 100, label: 'volume by month' });

  rankRows(el('muscle'), L.muscle.map((m) => ({ name: m.name, v: m.kg })), { unit: 'kg' });

  const peakKm = R.weekly.reduce((a, w) => (w.km > a.km ? w : a), R.weekly[0]);
  el('wdist-note').textContent = 'Biggest week ' + dLong(peakKm.w) + ' at ' + peakKm.km + ' km.';
  weeklyChart(el('wdist'), R.weekly, { key: 'km', unit: 'km' });

  /* --- goals ---------------------------------------------------------------- */
  distanceLadder(el('ladder'), DATA.ladder);
  el('ladder-note').innerHTML = ladderNote();
  el('bench').innerHTML = benchQuest();

  el('sources').innerHTML = sourcesPanel();
})();
