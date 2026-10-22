/* Silk Board Simulator -- a crossing game, on /silk-board/ and the 404 page.
 *
 * Get from HSR Layout to BTM Layout on foot: four lanes each way, a median
 * with metro pillars and cows on it, potholes that hold you in place, and
 * three chances. Every real second counts as a minute at the junction.
 *
 * One canvas, drawn in board units -- 13 x 11 squares of 32 -- and scaled to
 * the column. Each lane is a loop a little longer than the board, so whatever
 * drives off one side comes back on the other, and the gaps in a lane never
 * close up: every level can be crossed, it only gets quicker and busier.
 * Traffic keeps left, so the near lanes run right to left.
 *
 * Keys are only read while the game has focus, so the arrows still scroll the
 * page around it, and it pauses when focus or the tab goes elsewhere. The
 * scores and messages are ordinary DOM, the messages in a live region.
 */
(function () {
  'use strict';

  const game = document.querySelector('.silk-game');
  if (!game) { return; }
  const canvas = game.querySelector('canvas');
  const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
  const cryptoApi = window.crypto;
  if (!ctx || !cryptoApi || !cryptoApi.getRandomValues) { return; }

  const randBuf = new Uint32Array(1);
  /** A number in [0, 1). */
  const rnd = () => cryptoApi.getRandomValues(randBuf)[0] / 4294967296;
  const pick = (list) => list[Math.floor(rnd() * list.length)];

  // -------------------------------------------------------------------------
  // The board
  // -------------------------------------------------------------------------

  const T = 32;
  const COLS = 13;
  const ROWS = 11;
  const W = COLS * T;
  const H = ROWS * T;
  const GOAL = 0;
  const MEDIAN = 5;
  const HOME = ROWS - 1;
  const START_COL = 6;
  const PILLARS = [3, 9];

  // Lanes loop over LOOP pixels and are drawn OFF pixels to the left of
  // that, so a vehicle wraps while it is off the board on both sides --
  // OFF has to be longer than the longest bus.
  const OFF = 4 * T;
  const LOOP = W + 6 * T;

  const VEHICLES = {
    auto: { len: T },
    car: { len: 1.5 * T },
    bus: { len: 3 * T },
    bike: { len: 0.75 * T },
  };
  const MIN_GAP = 1.8 * T;

  // Row, direction (+1 is left to right), squares a second, what drives in
  // it, and how many at the start and at most.
  const LANES = [
    { row: 1, dir: 1, speed: 1.5, kinds: ['car', 'auto', 'car'], n: 3, max: 4 },
    { row: 2, dir: 1, speed: 2.6, kinds: ['bike'], n: 3, max: 5 },
    { row: 3, dir: 1, speed: 1.0, kinds: ['bus', 'auto'], n: 2, max: 3 },
    { row: 4, dir: 1, speed: 1.8, kinds: ['auto'], n: 4, max: 5 },
    { row: 6, dir: -1, speed: 1.9, kinds: ['car'], n: 3, max: 4 },
    { row: 7, dir: -1, speed: 1.1, kinds: ['bus', 'car'], n: 2, max: 3 },
    { row: 8, dir: -1, speed: 2.8, kinds: ['bike'], n: 3, max: 5 },
    { row: 9, dir: -1, speed: 1.4, kinds: ['auto', 'car'], n: 3, max: 4 },
  ];
  const LANE_ROWS = LANES.map((l) => l.row);

  const CAR_COLOURS = ['#e9e9e6', '#b9bec4', '#c0392b', '#1f2a36', '#2d6cb5', '#7d8c3c'];
  const HELMETS = ['#f3c623', '#e9e9e6', '#1f2a36', '#c0392b'];
  // Most bikes are carrying somebody's dinner.
  const BOXES = [null, '#f26c22', '#d63b35', '#f8cb46', '#5e2b8c'];

  const LINES = {
    start: ['Go. Nobody is going to stop for you.',
            'The signal is green. For somebody.',
            'Google Maps says four minutes. Good luck.'],
    made: ['You crossed Silk Board. Tell your grandchildren.',
           'Made it to BTM. Now do it again.',
           'Across. It gets quicker from here, and not in a good way.'],
    auto: ['Hit by an auto. It did not even put the meter on.',
           'Auto anna took a shortcut. Through you.'],
    bus: ['That was the 500D. It was not stopping.',
          'BMTC waits for no one.'],
    car: ['An SUV changed lanes without indicating. As is tradition.',
          'A car honked first. Here that counts as a warning.'],
    bike: ['A Rapido came out of nowhere. They always do.',
           'A delivery rider with nine minutes left on the clock.'],
    pothole: ['Pothole. You will be here a minute.',
              'Into a pothole. It has been there longer than the flyover.'],
    cow: ['A cow. It has right of way. It always has.',
          'The cow is not moving. So neither are you.'],
    pillar: ['A metro pillar. It is not moving either.'],
  };

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  const ACTIVE = { playing: true, made: true, dying: true };
  let state = 'ready';
  let paused = false;
  let stateT = 0;
  let level = 1;
  let speedUp = 1;
  let crossings = 0;
  let lives = 3;
  let clock = 0;
  let best = readBest();
  let lanes = [];
  let laneByRow = {};
  let potholes = new Set();
  let cows = [];
  let splat = null;
  const player = { col: START_COL, row: HOME, fromCol: START_COL, fromRow: HOME, hop: 1, stuck: 0, safe: 0 };

  function readBest() {
    try {
      const n = parseInt(window.localStorage.getItem('silk-board-best'), 10);
      return n >= 0 && n < 100000 ? n : 0;
    } catch (err) {
      return 0;
    }
  }

  function saveBest() {
    try {
      window.localStorage.setItem('silk-board-best', String(best));
    } catch (err) {
      // Private windows can refuse storage; the best just will not stick.
    }
  }

  /** Spread a lane's vehicles round its loop, never closer than MIN_GAP. */
  function buildLane(spec) {
    const count = Math.min(spec.max, spec.n + Math.floor((level - 1) / 2));
    const spacing = LOOP / count;
    const longest = Math.max.apply(null, spec.kinds.map((k) => VEHICLES[k].len));
    const slack = Math.max(0, spacing - longest - MIN_GAP);
    const cars = [];
    for (let k = 0; k < count; k += 1) {
      const kind = spec.kinds[k % spec.kinds.length];
      cars.push({
        kind: kind,
        len: VEHICLES[kind].len,
        x: k * spacing + rnd() * slack,
        colour: pick(CAR_COLOURS),
        helmet: pick(HELMETS),
        box: pick(BOXES),
      });
    }
    return { row: spec.row, dir: spec.dir, speed: spec.speed, cars: cars };
  }

  function setLevel() {
    speedUp = Math.min(2.1, 1 + 0.12 * (level - 1));
    lanes = LANES.map(buildLane);
    laneByRow = {};
    lanes.forEach((l) => { laneByRow[l.row] = l; });
    potholes = new Set();
    const want = Math.min(6, 3 + Math.floor((level - 1) / 2));
    while (potholes.size < want) {
      potholes.add(Math.floor(rnd() * COLS) + ',' + pick(LANE_ROWS));
    }
  }

  function spawnCows() {
    const free = [];
    for (let c = 0; c < COLS - 1; c += 1) {
      if (PILLARS.indexOf(c) < 0 && PILLARS.indexOf(c + 1) < 0 && c !== START_COL) { free.push(c); }
    }
    const a = pick(free);
    const rest = free.filter((c) => Math.abs(c - a) > 2);
    const b = rest.length ? pick(rest) : a;
    cows = [a, b].filter((c, k, all) => all.indexOf(c) === k).map((c) => ({
      x: c * T,
      dir: rnd() < 0.5 ? -1 : 1,
      speed: 10 + rnd() * 12,
      wait: rnd() * 2,
      spots: rnd() < 0.5,
    }));
  }

  function respawn() {
    player.col = START_COL;
    player.row = HOME;
    player.fromCol = START_COL;
    player.fromRow = HOME;
    player.hop = 1;
    player.stuck = 0;
    player.safe = 0.6;
    splat = null;
  }

  const potholeAt = (c, r) => potholes.has(c + ',' + r);

  function cowAt(c) {
    return cows.some((cow) => cow.x + 4 < (c + 1) * T && cow.x + T - 4 > c * T);
  }

  // -------------------------------------------------------------------------
  // The DOM around the canvas
  // -------------------------------------------------------------------------

  const hudEl = {};
  game.querySelectorAll('[data-hud]').forEach((node) => { hudEl[node.getAttribute('data-hud')] = node; });
  const screens = {};
  game.querySelectorAll('[data-screen]').forEach((node) => { screens[node.getAttribute('data-screen')] = node; });
  const overEl = {};
  game.querySelectorAll('[data-over]').forEach((node) => { overEl[node.getAttribute('data-over')] = node; });

  function showScreen(name) {
    Object.keys(screens).forEach((k) => { screens[k].hidden = k !== name; });
  }

  /** "42m", "1h 05m": a real second is a minute at the junction. */
  function stuckFor(seconds) {
    const m = Math.floor(seconds);
    const h = Math.floor(m / 60);
    return h ? h + 'h ' + String(m % 60).padStart(2, '0') + 'm' : m + 'm';
  }

  let shownMinutes = -1;
  function hud() {
    if (hudEl.score) { hudEl.score.textContent = String(crossings); }
    if (hudEl.lives) { hudEl.lives.textContent = '●'.repeat(lives) + '○'.repeat(3 - lives); }
    if (hudEl.best) { hudEl.best.textContent = String(best); }
    shownMinutes = -1;
    hudTime();
  }
  function hudTime() {
    const m = Math.floor(clock);
    if (m === shownMinutes || !hudEl.time) { return; }
    shownMinutes = m;
    hudEl.time.textContent = stuckFor(clock);
  }

  let msgTimer = 0;
  let lastLine = '';
  let lastLineAt = 0;
  /** A line under the board, read out by screen readers. `quiet` lines do not repeat. */
  function say(text, quiet) {
    const t = Date.now();
    if (quiet && text === lastLine && t - lastLineAt < 2500) { return; }
    lastLine = text;
    lastLineAt = t;
    if (!hudEl.msg) { return; }
    hudEl.msg.textContent = text;
    window.clearTimeout(msgTimer);
    msgTimer = window.setTimeout(() => { hudEl.msg.textContent = ''; }, 3200);
  }

  // -------------------------------------------------------------------------
  // Moving, crossing, getting hit
  // -------------------------------------------------------------------------

  function tryMove(dc, dr) {
    if (state !== 'playing' || paused || player.stuck > 0) { return; }
    const c = player.col + dc;
    const r = player.row + dr;
    if (c < 0 || c >= COLS || r < 0 || r >= ROWS) { return; }
    if (r === MEDIAN && PILLARS.indexOf(c) >= 0) {
      say(pick(LINES.pillar), true);
      return;
    }
    if (r === MEDIAN && cowAt(c)) {
      say(pick(LINES.cow), true);
      return;
    }
    player.fromCol = player.col;
    player.fromRow = player.row;
    player.col = c;
    player.row = r;
    player.hop = 0;
    if (r === GOAL) {
      crossed();
    } else if (potholeAt(c, r)) {
      player.stuck = 0.9;
      say(pick(LINES.pothole));
    }
  }

  function crossed() {
    crossings += 1;
    level += 1;
    state = 'made';
    stateT = 0.6;
    say(pick(LINES.made));
    hud();
  }

  function hitCheck() {
    const lane = laneByRow[player.row];
    if (!lane) { return; }
    const x0 = player.col * T + 7;
    const x1 = player.col * T + T - 7;
    for (let k = 0; k < lane.cars.length; k += 1) {
      const v = lane.cars[k];
      const x = v.x - OFF;
      if (x + 3 < x1 && x + v.len - 3 > x0) {
        die(v.kind);
        return;
      }
    }
  }

  function die(kind) {
    lives -= 1;
    state = 'dying';
    stateT = 1.2;
    splat = { x: (player.col + 0.5) * T, y: (player.row + 0.5) * T };
    say(pick(LINES[kind]) + (lives ? '' : ' That was the last chance.'));
    hud();
  }

  function gameOver() {
    state = 'over';
    const record = crossings > best;
    if (record) {
      best = crossings;
      saveBest();
    }
    hud();
    let title;
    if (crossings === 0) {
      title = 'Still on the HSR side';
    } else if (crossings === 1) {
      title = 'One crossing. Respect.';
    } else if (crossings < 5) {
      title = 'Silk Board regular';
    } else {
      title = 'Silk Board survivor';
    }
    if (overEl.title) { overEl.title.textContent = title; }
    if (overEl.line) {
      overEl.line.textContent = summary('You', 'your') + (record && crossings ? ' A new best.' : '');
    }
    if (overEl.shared) { overEl.shared.hidden = true; }
    const hadFocus = game.contains(document.activeElement);
    showScreen('over');
    if (hadFocus) { screens.over.querySelector('[data-act="start"]').focus({ preventScroll: true }); }
  }

  /** "You crossed Silk Board 3 times and lost 1h 04m of your life." */
  function summary(who, whose) {
    return who + ' crossed Silk Board ' + crossings + (crossings === 1 ? ' time' : ' times') +
      ' and lost ' + stuckFor(clock) + ' of ' + whose + ' life.';
  }

  function start() {
    level = 1;
    crossings = 0;
    lives = 3;
    clock = 0;
    paused = false;
    setLevel();
    spawnCows();
    respawn();
    state = 'playing';
    showScreen(null);
    hud();
    say(pick(LINES.start));
    game.focus({ preventScroll: true });
    kick();
  }

  function pause(focusResume) {
    if (!ACTIVE[state] || paused) { return; }
    paused = true;
    showScreen('paused');
    if (focusResume) { screens.paused.querySelector('[data-act="resume"]').focus({ preventScroll: true }); }
  }

  function resume() {
    if (!paused) { return; }
    paused = false;
    showScreen(null);
    game.focus({ preventScroll: true });
    kick();
  }

  async function share() {
    const url = new URL(game.getAttribute('data-url') || '/silk-board/', window.location.href).href;
    const text = summary('I', 'my') + ' Your turn:';
    const note = overEl.shared;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Silk Board Simulator', text: text, url: url });
        return;
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text + ' ' + url);
        if (note) {
          note.textContent = 'Copied. Paste it somewhere that deserves it.';
          note.hidden = false;
        }
        return;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') { return; }
    }
    // No share sheet and no clipboard: put it where it can be copied by hand.
    if (note) {
      note.textContent = text + ' ' + url;
      note.hidden = false;
    }
  }

  // -------------------------------------------------------------------------
  // The loop
  // -------------------------------------------------------------------------

  function updateCow(cow, dt) {
    if (cow.wait > 0) {
      cow.wait -= dt;
      return;
    }
    const nx = cow.x + cow.dir * cow.speed * dt;
    const a = nx + 3;
    const b = nx + T - 3;
    let blocked = nx < 0 || nx > W - T;
    PILLARS.forEach((c) => { if (b > c * T && a < (c + 1) * T) { blocked = true; } });
    cows.forEach((o) => { if (o !== cow && b > o.x + 2 && a < o.x + T - 2) { blocked = true; } });
    if (player.row === MEDIAN && b > player.col * T && a < (player.col + 1) * T) { blocked = true; }
    if (blocked) {
      cow.dir = -cow.dir;
      cow.wait = 0.4 + rnd() * 1.2;
      return;
    }
    cow.x = nx;
    // Now and then a cow stops to think about things.
    if (rnd() < dt * 0.25) { cow.wait = 1 + rnd() * 2; }
  }

  function update(dt) {
    clock += dt;
    lanes.forEach((lane) => {
      const step = lane.speed * speedUp * T * lane.dir * dt;
      lane.cars.forEach((v) => { v.x = ((v.x + step) % LOOP + LOOP) % LOOP; });
    });
    cows.forEach((cow) => { updateCow(cow, dt); });
    if (player.hop < 1) { player.hop = Math.min(1, player.hop + dt / 0.09); }

    if (state === 'playing') {
      if (player.stuck > 0) { player.stuck = Math.max(0, player.stuck - dt); }
      if (player.safe > 0) {
        player.safe = Math.max(0, player.safe - dt);
      } else {
        hitCheck();
      }
    } else if (state === 'made' || state === 'dying') {
      stateT -= dt;
      if (stateT <= 0) {
        if (state === 'dying' && lives <= 0) {
          gameOver();
        } else {
          if (state === 'made') { setLevel(); }
          respawn();
          state = 'playing';
        }
      }
    }
    hudTime();
  }

  let raf = 0;
  let last = 0;
  function frame(t) {
    raf = 0;
    if (paused || !ACTIVE[state]) {
      draw();
      return;
    }
    const dt = last ? Math.min(0.05, (t - last) / 1000) : 0;
    last = t;
    update(dt);
    draw();
    if (ACTIVE[state] && !paused) { raf = window.requestAnimationFrame(frame); }
  }
  function kick() {
    if (raf) { return; }
    last = 0;
    raf = window.requestAnimationFrame(frame);
  }

  // -------------------------------------------------------------------------
  // Drawing, in board units. Vehicles are drawn facing right and mirrored for
  // the lanes that run the other way.
  // -------------------------------------------------------------------------

  function rr(x, y, w, h, r, fill) {
    const k = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + k, y);
    ctx.arcTo(x + w, y, x + w, y + h, k);
    ctx.arcTo(x + w, y + h, x, y + h, k);
    ctx.arcTo(x, y + h, x, y, k);
    ctx.arcTo(x, y, x + w, y, k);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  function disc(x, y, r, fill) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
  }

  function ellipse(x, y, rx, ry, fill) {
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
  }

  const FONT = '700 10px system-ui, -apple-system, "Segoe UI", sans-serif';

  function drawFootpath(row, name) {
    const y = row * T;
    ctx.fillStyle = '#c9c1b3';
    ctx.fillRect(0, y, W, T);
    ctx.fillStyle = '#b6ae9f';
    for (let c = 0; c <= COLS; c += 1) { ctx.fillRect(c * T - 1, y, 1, T); }
    ctx.fillRect(0, y + T / 2, W, 1);
    // The kerb, on the road side.
    ctx.fillStyle = '#e8e3d8';
    ctx.fillRect(0, row === GOAL ? y + T - 3 : y, W, 3);
    ctx.fillStyle = 'rgba(70, 63, 52, .75)';
    ctx.font = FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Off to the left, where nobody starts or stands for long.
    ctx.fillText(name, W / 4, y + T / 2 + 1);
  }

  function drawRoad(fromRow, toRow) {
    const y0 = fromRow * T;
    const y1 = (toRow + 1) * T;
    ctx.fillStyle = '#3b3e44';
    ctx.fillRect(0, y0, W, y1 - y0);
    // Lane lines, dashed, between the lanes of one carriageway.
    ctx.fillStyle = 'rgba(232, 232, 224, .55)';
    for (let r = fromRow + 1; r <= toRow; r += 1) {
      for (let x = 6; x < W; x += 26) { ctx.fillRect(x, r * T - 1, 13, 2); }
    }
  }

  function drawMedian() {
    const y = MEDIAN * T;
    ctx.fillStyle = '#7f8a5c';
    ctx.fillRect(0, y, W, T);
    ctx.fillStyle = '#e3c341';
    ctx.fillRect(0, y, W, 2);
    ctx.fillRect(0, y + T - 2, W, 2);
    // Dust and tufts.
    ctx.fillStyle = 'rgba(60, 70, 40, .35)';
    for (let x = 9; x < W; x += 37) { ctx.fillRect(x, y + 9 + (x % 3) * 4, 3, 2); }
    PILLARS.forEach((c) => {
      const x = c * T;
      rr(x + 6, y + 5, T - 8, T - 8, 3, 'rgba(0, 0, 0, .25)');
      rr(x + 4, y + 3, T - 8, T - 8, 3, '#b3b4ae');
      rr(x + 8, y + 7, T - 16, T - 16, 2, '#c9cac4');
    });
  }

  function drawPothole(key) {
    const parts = key.split(',');
    const x = (Number(parts[0]) + 0.5) * T;
    const y = (Number(parts[1]) + 0.5) * T;
    ellipse(x, y, 11, 7, '#56595f');
    ellipse(x + 1, y + 1, 9, 5, '#1f2125');
    ellipse(x - 2, y - 1, 3, 1.5, 'rgba(120, 160, 190, .55)');
  }

  function drawAuto(v) {
    const L = v.len;
    rr(2, 5, L - 4, T - 10, 6, '#2f7d3a');
    rr(4, 7, L - 12, T - 14, 4, '#f3c623');
    rr(L - 9, 10, 5, T - 20, 2, '#1d1d1d');
    disc(L - 3, T / 2, 2, '#fff6c8');
  }

  function drawCar(v) {
    const L = v.len;
    rr(2, 5, L - 4, T - 10, 6, v.colour);
    rr(L - 17, 8, 8, T - 16, 2, 'rgba(25, 35, 45, .8)');
    rr(6, 9, 6, T - 18, 2, 'rgba(25, 35, 45, .65)');
    ctx.fillStyle = '#fff6c8';
    ctx.fillRect(L - 4, 7, 2, 4);
    ctx.fillRect(L - 4, T - 11, 2, 4);
  }

  function drawBus(v) {
    const L = v.len;
    rr(1, 3, L - 2, T - 6, 4, '#1d5fa8');
    ctx.fillStyle = '#9cc7ef';
    ctx.fillRect(6, 4, L - 14, 3);
    ctx.fillRect(6, T - 7, L - 14, 3);
    ctx.fillRect(L - 6, 6, 3, T - 12);
    rr(L * 0.38, 10, L * 0.24, T - 20, 2, '#3a7fc9');
  }

  function drawBike(v) {
    const L = v.len;
    rr(1, 13, L - 2, 6, 3, '#26282c');
    if (v.box) { rr(0, 9, 9, 14, 2, v.box); }
    disc(L - 9, T / 2, 5, v.helmet);
    ctx.fillStyle = '#1d1d1d';
    ctx.fillRect(L - 3, 10, 2, 12);
  }

  const DRAW = { auto: drawAuto, car: drawCar, bus: drawBus, bike: drawBike };

  function drawVehicle(v, lane) {
    const x = v.x - OFF;
    if (x > W || x + v.len < 0) { return; }
    const y = lane.row * T;
    ctx.save();
    if (lane.dir < 0) {
      ctx.translate(x + v.len, y);
      ctx.scale(-1, 1);
    } else {
      ctx.translate(x, y);
    }
    // A shadow first, so the traffic sits on the road.
    rr(3, 7, v.len - 4, T - 10, 5, 'rgba(0, 0, 0, .28)');
    DRAW[v.kind](v);
    ctx.restore();
    if (v.kind === 'bus') {
      ctx.fillStyle = 'rgba(255, 255, 255, .9)';
      ctx.font = FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('500D', x + v.len / 2, y + T / 2 + 1);
    }
  }

  function drawCow(cow) {
    const y = MEDIAN * T;
    ctx.save();
    if (cow.dir < 0) {
      ctx.translate(cow.x + T, y);
      ctx.scale(-1, 1);
    } else {
      ctx.translate(cow.x, y);
    }
    ellipse(15, 18, 12, 8, 'rgba(0, 0, 0, .22)');
    ellipse(14, 16, 12, 8, '#f2eee6');
    if (cow.spots) {
      ellipse(10, 13, 4, 3, '#2b2b2b');
      ellipse(17, 19, 3, 2.5, '#2b2b2b');
    } else {
      ellipse(12, 16, 5, 4, '#c79a62');
    }
    ellipse(27, 16, 5, 4.5, '#e6dfd2');
    ctx.fillStyle = '#d8ccb0';
    ctx.fillRect(27, 9, 2, 4);
    ctx.fillRect(27, 19, 2, 4);
    disc(31, 16, 1.6, '#c58f86');
    ctx.restore();
  }

  function drawPlayer() {
    if (state === 'dying') {
      // Blinks, then is gone.
      if (Math.floor(stateT * 10) % 2) { return; }
    } else if (player.safe > 0 && Math.floor(player.safe * 12) % 2) {
      return;
    }
    const e = 1 - Math.pow(1 - player.hop, 2);
    const cx = (player.fromCol + (player.col - player.fromCol) * e + 0.5) * T;
    const cy = (player.fromRow + (player.row - player.fromRow) * e + 0.5) * T;
    const lift = player.hop < 1 ? Math.sin(player.hop * Math.PI) * 4 : 0;
    const sunk = player.stuck > 0 ? 0.75 : 1;
    ellipse(cx + 1, cy + 3, 9 * sunk, 6 * sunk, 'rgba(0, 0, 0, .3)');
    if (player.stuck > 0) { ellipse(cx, cy + 2, 12, 7, 'rgba(120, 160, 190, .55)'); }
    ellipse(cx, cy - lift, 10 * sunk, 7 * sunk, '#ffffff');
    ellipse(cx, cy - lift, 8.5 * sunk, 5.5 * sunk, '#fc4c02');
    disc(cx, cy - lift, 4.2 * sunk, '#2b2b2b');
  }

  function drawSplat() {
    const n = 10;
    ctx.beginPath();
    for (let k = 0; k < n * 2; k += 1) {
      const r = k % 2 ? 6 : 14;
      const a = (k / (n * 2)) * Math.PI * 2;
      const x = splat.x + Math.cos(a) * r;
      const y = splat.y + Math.sin(a) * r;
      if (k) { ctx.lineTo(x, y); } else { ctx.moveTo(x, y); }
    }
    ctx.closePath();
    ctx.fillStyle = '#ffd43b';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#d6336c';
    ctx.stroke();
    ctx.fillStyle = '#7a1631';
    ctx.font = '800 9px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('BONK', splat.x, splat.y + 1);
  }

  function draw() {
    drawFootpath(GOAL, 'BTM LAYOUT');
    drawRoad(1, MEDIAN - 1);
    drawMedian();
    drawRoad(MEDIAN + 1, HOME - 1);
    drawFootpath(HOME, 'HSR LAYOUT');
    potholes.forEach(drawPothole);
    cows.forEach(drawCow);
    lanes.forEach((lane) => { lane.cars.forEach((v) => { drawVehicle(v, lane); }); });
    if (state !== 'over') { drawPlayer(); }
    if (splat) { drawSplat(); }
  }

  /** Back the canvas with as many pixels as it is shown at, then draw in board units. */
  function fit() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const scale = (canvas.clientWidth || W) / W;
    const bw = Math.max(1, Math.round(W * scale * dpr));
    const bh = Math.max(1, Math.round(H * scale * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    ctx.setTransform(bw / W, 0, 0, bh / H, 0, 0);
    draw();
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  const MOVES = {
    up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
  };
  const KEYS = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    w: 'up', s: 'down', a: 'left', d: 'right',
    W: 'up', S: 'down', A: 'left', D: 'right',
  };

  game.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) { return; }
    const move = KEYS[e.key];
    if (move) {
      if (ACTIVE[state] && !paused) {
        e.preventDefault();
        tryMove(MOVES[move][0], MOVES[move][1]);
      }
      return;
    }
    if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') {
      if (paused) {
        resume();
      } else {
        pause(true);
      }
      e.preventDefault();
      return;
    }
    // Space or Enter on the game itself; on a button they press the button.
    if ((e.key === ' ' || e.key === 'Enter') && e.target === game) {
      e.preventDefault();
      if (paused) {
        resume();
      } else if (!ACTIVE[state]) {
        start();
      }
    }
  });

  game.addEventListener('click', (e) => {
    const b = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!b) { return; }
    const act = b.getAttribute('data-act');
    if (act === 'start') {
      start();
    } else if (act === 'resume') {
      resume();
    } else if (act === 'share') {
      share();
    }
  });

  // Swipe to move, tap to step forward.
  let touch = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (!ACTIVE[state] || paused) { return; }
    e.preventDefault();
    touch = { x: e.clientX, y: e.clientY, id: e.pointerId };
    game.focus({ preventScroll: true });
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!touch || e.pointerId !== touch.id) { return; }
    const dx = e.clientX - touch.x;
    const dy = e.clientY - touch.y;
    touch = null;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 16) {
      tryMove(0, -1);
    } else if (Math.abs(dx) > Math.abs(dy)) {
      tryMove(dx > 0 ? 1 : -1, 0);
    } else {
      tryMove(0, dy > 0 ? 1 : -1);
    }
  });
  canvas.addEventListener('pointercancel', () => { touch = null; });

  // The pad. Acting on pointerdown is what makes it feel immediate, and not
  // letting the press take focus keeps the game from pausing itself.
  game.querySelectorAll('[data-move]').forEach((b) => {
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const m = MOVES[b.getAttribute('data-move')];
      if (m) { tryMove(m[0], m[1]); }
    });
  });

  game.addEventListener('focusout', (e) => {
    if (!game.contains(e.relatedTarget)) { pause(false); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { pause(false); }
  });

  let resizeQueued = false;
  window.addEventListener('resize', () => {
    if (resizeQueued) { return; }
    resizeQueued = true;
    window.requestAnimationFrame(() => {
      resizeQueued = false;
      fit();
    });
  });

  // A first frame, under the start screen.
  setLevel();
  spawnCows();
  respawn();
  player.safe = 0;
  hud();
  fit();
}());
