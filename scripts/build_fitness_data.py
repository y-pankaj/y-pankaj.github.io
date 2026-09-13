#!/usr/bin/env python3
"""Turn a FitNotes export into the summary the /fitness/ page renders from.

The Apps Script endpoint returns every logged set as one flat JSON array --
strength sets and cardio activities together. This script does two things with
it:

  1. Normalises it into ``_raw/fitnotes.ndjson``: one JSON object per line,
     stably sorted. Directories starting with ``_`` are ignored by Jekyll, so
     this never ships to ``_site``. It exists so that a change to the
     aggregation below can be re-derived without re-querying, and so that each
     sync is an append in ``git diff`` rather than one replaced 100 KB line.

  2. Aggregates it into ``_data/fitness.json``, which Jekyll exposes as
     ``site.data.fitness``. The page inlines it with
     ``{{ site.data.fitness | jsonify }}`` -- no runtime fetch, no CORS, no
     empty page while a cold Apps Script wakes up.

Usage
-----
    # from the Apps Script response
    curl -sSL "$FITNOTES_URL" | python3 scripts/build_fitness_data.py

    # or from a file, which also accepts the NDJSON archive as input
    python3 scripts/build_fitness_data.py --in sample.txt

Exits non-zero without writing anything if the input does not look like a
FitNotes export, or if it has fewer rows than the archive already on disk --
one bad response should not quietly truncate your training history. Neither
file is rewritten when nothing material changed, so running twice in a day is
a genuine no-op. ``generated_at`` is excluded from that comparison. The summary
does change once a day even with no new training, because ``window.end`` tracks
today: the calendar grows a square and the streak counters shift.

What the export actually looks like
-----------------------------------
Worth knowing before changing anything below, because most of it is surprising:

* **Running is in the same file.** Cardio entries carry ``Category: "Cardio"``
  and an ``Exercise`` of "Running (Outdoor)", with ``Distance`` in km and
  ``Time`` as ``H:MM:SS``. Strava is never queried -- it is only a profile link.
* **Exact duplicate rows are real.** FitNotes has no set index, so two identical
  sets on the same day serialise identically. ``sort_key`` sorts without
  deduping; a ``set()`` or ``sort -u`` anywhere in the pipeline silently deletes
  them. The first export had 21.
* **``Comment`` is the run title** -- "5hr sleep run", "Listened to Huberman".
  Only cardio rows use it; strength rows leave it null.
* **``Category`` is already the muscle split** -- Chest, Back, Triceps, Biceps,
  Shoulders, Legs, Abs. No mapping table needed.
* **There is no start time**, only a date, so activities cannot be ordered
  within a day.
* Everything arrives as strings with nulls; units are always ``kgs`` and ``km``
  so far, but the unit columns are there and worth respecting.
"""

import argparse
import collections
import datetime as dt
import json
import os
import re
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

REQUIRED_KEYS = {"Date", "Exercise", "Category", "Weight", "Reps",
                 "Distance", "Time", "Comment"}

# Which cardio entries count towards the running numbers.
RUN_MATCH = re.compile(r"run", re.I)

# Side-quest #6. Matches a flat barbell bench only, so the quest resolves
# itself the day one gets logged.
BENCH_MATCH = re.compile(r"barbell bench press", re.I)
BENCH_EXCLUDE = re.compile(r"incline|decline", re.I)
BENCH_TARGET_KG = 70.0
BENCH_TARGET_REPS = 10

# Distance milestones for the running goals, with the side-quest they belong to.
MILESTONES = [(5.0, "5K", None), (10.0, "10K", None), (21.1, "Half", 4),
              (30.0, "30K", None), (42.2, "Marathon", 5)]

# Profile links for the "where this comes from" section. Add an entry here to
# have another one rendered.
PROFILES = {
    "strava": {
        "label": "Strava",
        "url": "https://www.strava.com/athletes/32680655",
    },
}

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


# --------------------------------------------------------------------------
# Reading and validating
# --------------------------------------------------------------------------

def load_rows(text):
    """Accept either the Apps Script JSON array or the NDJSON archive."""
    text = text.strip()
    if not text:
        raise ValueError("input was empty")
    if text[0] == "[":
        rows = json.loads(text)
    else:
        rows = [json.loads(line) for line in text.splitlines() if line.strip()]

    if not isinstance(rows, list) or not rows:
        raise ValueError("expected a non-empty array of rows")
    if not isinstance(rows[0], dict):
        raise ValueError("rows are not objects -- is this the right endpoint?")
    missing = REQUIRED_KEYS - set(rows[0])
    if missing:
        raise ValueError("rows are missing expected keys: %s"
                         % ", ".join(sorted(missing)))
    return rows


def sort_key(r):
    """Stable ordering that keeps duplicates.

    FitNotes has no set index, so two identical sets on the same day are
    genuinely two sets and must both survive. Sort, never dedupe.
    """
    return (r.get("Date") or "", r.get("Exercise") or "",
            num(r.get("Weight")) or 0.0, num(r.get("Reps")) or 0.0,
            num(r.get("Distance")) or 0.0, r.get("Time") or "",
            r.get("Comment") or "")


def num(v):
    if v in (None, ""):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def hms_to_s(t):
    """'0:19:23' or '19:23' -> seconds."""
    if not t:
        return 0
    parts = [int(p) for p in str(t).split(":")]
    out = 0
    for p in parts:
        out = out * 60 + p
    return out


def epley(weight, reps):
    return round(weight * (1 + reps / 30.0))


# --------------------------------------------------------------------------
# Aggregation
# --------------------------------------------------------------------------

def summarise(rows, today, top_n):
    lifts, runs = [], []
    for r in rows:
        w, reps, dist = num(r.get("Weight")), num(r.get("Reps")), num(r.get("Distance"))
        date = dt.date.fromisoformat(r["Date"])
        if w is not None and reps is not None:
            lifts.append({"date": date, "name": r["Exercise"],
                          "muscle": r.get("Category") or "Other",
                          "kg": w, "reps": int(reps), "volume": w * reps})
        elif dist is not None and RUN_MATCH.search(r.get("Exercise") or ""):
            runs.append({"date": date, "km": dist, "sec": hms_to_s(r.get("Time")),
                         "name": (r.get("Comment") or "").strip() or "Run"})

    if not lifts and not runs:
        raise ValueError("no usable rows found")

    all_dates = [x["date"] for x in lifts] + [x["date"] for x in runs]
    start, last = min(all_dates), max(all_dates)
    end = max(last, today)
    days = (end - start).days + 1

    # --- per-day series, the backbone of the calendar ---------------------
    lift_by_day = collections.defaultdict(float)
    run_km_by_day = collections.defaultdict(float)
    run_sec_by_day = collections.defaultdict(int)
    for x in lifts:
        lift_by_day[x["date"]] += x["volume"]
    for x in runs:
        run_km_by_day[x["date"]] += x["km"]
        run_sec_by_day[x["date"]] += x["sec"]

    series_lift, series_km, series_sec = [], [], []
    for i in range(days):
        d = start + dt.timedelta(days=i)
        series_lift.append(round(lift_by_day.get(d, 0.0)))
        series_km.append(round(run_km_by_day.get(d, 0.0), 2))
        series_sec.append(run_sec_by_day.get(d, 0))

    # --- streaks over any training ----------------------------------------
    active = [1 if (series_lift[i] or series_km[i]) else 0 for i in range(days)]
    longest = run_len = 0
    for a in active:
        run_len = run_len + 1 if a else 0
        longest = max(longest, run_len)
    # Count back from the most recent active day, so a rest day today does not
    # read as a broken streak.
    tail = list(reversed(active))
    while tail and not tail[0]:
        tail.pop(0)
    current = 0
    for a in tail:
        if not a:
            break
        current += 1

    # --- monthly and weekly buckets ---------------------------------------
    multi_year = start.year != end.year

    def month_label(d):
        return MONTHS[d.month - 1] + (" '%02d" % (d.year % 100) if multi_year else "")

    def months_between():
        cur = start.replace(day=1)
        while cur <= end:
            yield cur
            cur = (cur.replace(day=28) + dt.timedelta(days=4)).replace(day=1)

    run_monthly, lift_monthly = [], []
    for m in months_between():
        in_m = lambda x: x["date"].year == m.year and x["date"].month == m.month
        km = sum(x["km"] for x in runs if in_m(x))
        kg = sum(x["volume"] for x in lifts if in_m(x))
        run_monthly.append({"m": month_label(m), "ym": m.strftime("%Y-%m"),
                            "km": round(km, 1),
                            "runs": sum(1 for x in runs if in_m(x))})
        lift_monthly.append({"m": month_label(m), "ym": m.strftime("%Y-%m"),
                             "kg": round(kg),
                             "days": len({x["date"] for x in lifts if in_m(x)})})

    run_weekly, lift_weekly = [], []
    wk = start - dt.timedelta(days=start.weekday())  # Monday of the first week
    while wk <= end:
        span = {wk + dt.timedelta(days=i) for i in range(7)}
        run_weekly.append({"w": wk.isoformat(),
                           "km": round(sum(x["km"] for x in runs if x["date"] in span), 1)})
        lift_weekly.append({"w": wk.isoformat(),
                            "kg": round(sum(x["volume"] for x in lifts if x["date"] in span))})
        wk += dt.timedelta(days=7)

    # --- running totals ----------------------------------------------------
    total_km = sum(x["km"] for x in runs)
    total_sec = sum(x["sec"] for x in runs)
    cutoff = end - dt.timedelta(days=29)
    recent_km = sum(x["km"] for x in runs if x["date"] >= cutoff)
    recent_sec = sum(x["sec"] for x in runs if x["date"] >= cutoff)

    running = {
        "totals": {
            "distance_km": round(total_km, 1),
            "moving_time_s": total_sec,
            "count": len(runs),
            "longest_km": round(max(x["km"] for x in runs), 2) if runs else 0,
            "avg_pace_s": round(total_sec / total_km, 1) if total_km else None,
            "pace_30d_s": round(recent_sec / recent_km, 1) if recent_km else None,
            "since": min(x["date"] for x in runs).isoformat() if runs else None,
        },
        "monthly": run_monthly,
        "weekly": run_weekly,
        "recent": [
            {"date": x["date"].isoformat(), "name": x["name"],
             "km": round(x["km"], 2), "sec": x["sec"]}
            for x in sorted(runs, key=lambda x: x["date"], reverse=True)[:6]
        ],
        "profiles": PROFILES,
    }

    # --- lifting totals ----------------------------------------------------
    by_name = collections.defaultdict(list)
    for x in lifts:
        by_name[x["name"]].append(x)

    exercises = []
    for name, sets in sorted(by_name.items(), key=lambda kv: (-len(kv[1]), kv[0]))[:top_n]:
        # A PR is the heaviest set, reps breaking the tie -- the usual meaning.
        pr = max(sets, key=lambda x: (x["kg"], x["reps"], x["date"].toordinal()))
        # The single set that moved the most weight, which is a different thing.
        top = max(sets, key=lambda x: (x["volume"], x["date"].toordinal()))
        exercises.append({
            "name": name,
            "sets": len(sets),
            "volume_kg": round(sum(x["volume"] for x in sets)),
            "muscle": collections.Counter(x["muscle"] for x in sets).most_common(1)[0][0],
            "pr": {"weight_kg": pr["kg"], "reps": pr["reps"],
                   "date": pr["date"].isoformat(), "e1rm_kg": epley(pr["kg"], pr["reps"])},
            "best_volume_set": {"weight_kg": top["kg"], "reps": top["reps"],
                                "date": top["date"].isoformat(),
                                "volume_kg": round(top["volume"])},
        })

    muscle = collections.defaultdict(float)
    for x in lifts:
        muscle[x["muscle"]] += x["volume"]

    lift_days = {x["date"] for x in lifts}
    lifting = {
        "totals": {
            "volume_kg": round(sum(x["volume"] for x in lifts)),
            "sessions": len(lift_days),
            "sets": len(lifts),
            "reps": sum(x["reps"] for x in lifts),
            "exercises": len(by_name),
            "since": min(lift_days).isoformat(),
        },
        "monthly": lift_monthly,
        "weekly": lift_weekly,
        "muscle": [{"name": n, "kg": round(v)}
                   for n, v in sorted(muscle.items(), key=lambda kv: -kv[1])],
        "exercises": exercises,
    }

    # --- goals -------------------------------------------------------------
    longest_km = running["totals"]["longest_km"]
    milestones = [{"km": km, "label": label, "quest": q, "done": km <= longest_km}
                  for km, label, q in MILESTONES]
    nxt = next((m for m in milestones if not m["done"]), None)
    ladder = {
        "longest_km": longest_km,
        "max_km": MILESTONES[-1][0],
        "milestones": milestones,
        "next": None if nxt is None else {
            "label": nxt["label"], "km": nxt["km"],
            "gap_km": round(nxt["km"] - longest_km, 2), "quest": nxt["quest"],
        },
    }

    bench_sets = [x for x in lifts
                  if BENCH_MATCH.search(x["name"]) and not BENCH_EXCLUDE.search(x["name"])]
    if bench_sets:
        best = max(bench_sets, key=lambda x: (x["kg"], x["reps"]))
        pct = round(100 * min(1.0, best["kg"] / BENCH_TARGET_KG)
                    * min(1.0, best["reps"] / BENCH_TARGET_REPS))
        bench = {"quest": 6, "target": "70 kg x 10 clean reps",
                 "status": "%g kg x %d" % (best["kg"], best["reps"]),
                 "date": best["date"].isoformat(), "pct": pct,
                 "note": "best flat barbell bench set so far"}
    else:
        closest = max((x for x in lifts if re.search(r"bench press", x["name"], re.I)),
                      key=lambda x: x["kg"], default=None)
        note = "no flat barbell bench logged yet"
        if closest:
            note += " -- the closest entry is %s at %g kg" % (closest["name"], closest["kg"])
        bench = {"quest": 6, "target": "70 kg x 10 clean reps",
                 "status": "nothing logged", "date": None, "pct": 0, "note": note}

    return {
        "generated_at": dt.datetime.now(dt.timezone.utc)
                          .replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "source_rows": len(rows),
        "source": "FitNotes export",
        "window": {"start": start.isoformat(), "end": end.isoformat(),
                   "last_entry": last.isoformat(), "days": days,
                   "weeks": round(days / 7.0, 1)},
        "running": running,
        "lifting": lifting,
        "calendar": {"start": start.isoformat(), "lift": series_lift,
                     "run": series_km, "run_sec": series_sec},
        "streaks": {"current": current, "longest": longest,
                    "active_days": sum(active), "this_week": sum(active[-7:])},
        "ladder": ladder,
        "bench_quest": bench,
    }


# --------------------------------------------------------------------------
# Writing
# --------------------------------------------------------------------------

def write_atomic(path, text):
    """Write via a temp file in the same directory, then rename.

    A crash or a full disk mid-write leaves the previous file intact rather
    than a half-written one that the next build would choke on.
    """
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp-")
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(text)
        # mkstemp is 0600; these get committed and read by the build, so widen
        # to the usual 0644 minus whatever the umask says.
        umask = os.umask(0)
        os.umask(umask)
        os.chmod(tmp, 0o666 & ~umask)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def write_if_changed(path, text, ignore_keys=()):
    """Write only when the content actually differs. Returns True if written.

    ``generated_at`` moves on every run, so a plain byte comparison would
    rewrite the summary each time and defeat the workflow's skip-empty-commits
    step. Ignoring it means a second run on the same day is a genuine no-op,
    while a new day -- which shifts the window, the calendar and the streaks --
    still produces a commit.
    """
    if os.path.exists(path):
        with open(path) as fh:
            old = fh.read()
        if old == text:
            return False
        if ignore_keys:
            try:
                a, b = json.loads(old), json.loads(text)
            except ValueError:
                a = b = None
            if a is not None:
                for k in ignore_keys:
                    a.pop(k, None)
                    b.pop(k, None)
                if a == b:
                    return False
    write_atomic(path, text)
    return True


def existing_row_count(path):
    if not os.path.exists(path):
        return 0
    with open(path) as fh:
        return sum(1 for line in fh if line.strip())


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", default="-",
                    help="input file, or '-' for stdin (default)")
    ap.add_argument("--ndjson", default=os.path.join(REPO, "_raw", "fitnotes.ndjson"),
                    help="normalised archive to write")
    ap.add_argument("--out", default=os.path.join(REPO, "_data", "fitness.json"),
                    help="summary the site reads")
    ap.add_argument("--today", default=None,
                    help="YYYY-MM-DD, for reproducible output (default: today)")
    ap.add_argument("--top", type=int, default=12,
                    help="how many exercises to detail, by set count")
    ap.add_argument("--allow-shrink", action="store_true",
                    help="write even if the input has fewer rows than the archive")
    ap.add_argument("--indent", type=int, default=None,
                    help="pretty-print the summary with this indent")
    args = ap.parse_args(argv)

    text = sys.stdin.read() if args.src == "-" else open(args.src).read()

    try:
        rows = load_rows(text)
    except ValueError as exc:
        sys.exit("refusing to write: %s" % exc)

    was = existing_row_count(args.ndjson)
    if len(rows) < was and not args.allow_shrink:
        sys.exit("refusing to write: input has %d rows but the archive has %d. "
                 "Pass --allow-shrink if this is intentional." % (len(rows), was))

    today = dt.date.fromisoformat(args.today) if args.today else dt.date.today()

    try:
        summary = summarise(rows, today, args.top)
    except (ValueError, KeyError) as exc:
        sys.exit("refusing to write: could not summarise input: %s" % exc)

    rows.sort(key=sort_key)
    wrote_raw = write_if_changed(
        args.ndjson, "".join(json.dumps(r, sort_keys=True) + "\n" for r in rows))
    wrote_out = write_if_changed(
        args.out,
        json.dumps(summary, indent=args.indent,
                   separators=None if args.indent else (",", ":")) + "\n",
        ignore_keys=("generated_at",))

    t = summary["lifting"]["totals"]
    r = summary["running"]["totals"]
    print("%s  %d rows (was %d)%s"
          % (args.ndjson, len(rows), was, "" if wrote_raw else "  [unchanged]"))
    print("%s  %.1f t over %d sessions, %.1f km over %d runs, %s to %s%s"
          % (args.out, t["volume_kg"] / 1000.0, t["sessions"],
             r["distance_km"], r["count"],
             summary["window"]["start"], summary["window"]["end"],
             "" if wrote_out else "  [unchanged]"))


if __name__ == "__main__":
    main()
