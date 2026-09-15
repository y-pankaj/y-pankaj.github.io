#!/usr/bin/env python3
"""Generate the world map the /travel/ page draws on.

This is a one-shot generator, not part of the nightly sync. It reads a Natural
Earth 1:110m "admin 0 countries" shapefile, simplifies it, and writes:

  * ``_includes/world-land.svg`` -- a bare ``<g class="land">`` fragment, one
    ``<path>`` per country carrying ``id="c-XXX"`` (ISO 3166-1 alpha-3). It is
    not a standalone SVG on purpose: /travel/ supplies the ``<svg>`` wrapper
    because the page, not this script, decides the framing -- the default view
    is fitted to wherever the pins happen to be.

  * ``_data/world_map.yml`` -- the world bounding box in degrees. Pins are
    placed by arithmetic on ``lat``/``lon``, and both the page and the zoom
    script need the same numbers this was built from.

Projection is plate carree (x = lon, y = -lat) purely so that placing a pin
stays a subtraction and a divide. Anything prettier -- Robinson, Natural
Earth II -- would mean projecting every pin in Python and regenerating the
data file whenever a place is added, which is a bad trade for a page whose
whole point is that you can add a line of YAML to it.

Antarctica is dropped: it is a third of the map's height, nobody has a pin
there, and the seventh continent is tracked as a chip on the page instead.

Boundaries and Kashmir
----------------------
By default this reads the copy of Natural Earth bundled inside geopandas,
which is the *de facto* edition: it splits Jammu and Kashmir between India,
Pakistan and China, and shows Aksai Chin as Chinese. That is not the boundary
India recognises, and it is not the boundary an Indian site should publish.

Natural Earth also ships point-of-view editions. To use the Indian one:

    curl -LO https://naciscdn.org/naturalearth/110m/cultural/ne_110m_admin_0_countries_ind.zip
    python3 scripts/build_world_map.py --source ne_110m_admin_0_countries_ind.zip

The zip is read in place, no unpacking needed. Column names differ between
the bundled copy (lowercase) and the published files (uppercase), so both are
accepted. Regenerate, eyeball northern India, and commit the result.

Usage
-----
    python3 scripts/build_world_map.py
    python3 scripts/build_world_map.py --source ne_110m_admin_0_countries_ind.zip
    python3 scripts/build_world_map.py --tolerance 0.6   # smaller, coarser

Natural Earth is public domain; no attribution is required, though the page
carries one anyway.
"""

import argparse
import os
import sys
import tempfile

# Countries Natural Earth leaves as "-99" in iso_a3. Only the ones large
# enough to plausibly hold a pin are worth naming; the rest fall back to a
# slug of the country name and simply never match a visit.
ISO_FIXUPS = {
    "France": "FRA",
    "Norway": "NOR",
    "Kosovo": "XKX",
    "Somaliland": "XSO",
    "N. Cyprus": "XNC",
}

# India's claimed boundary for the former princely state of Jammu and Kashmir,
# traced at this map's resolution.
#
# The bundled Natural Earth data is the de facto edition: Gilgit-Baltistan and
# Azad Kashmir sit inside Pakistan's polygon, Aksai Chin and the Shaksgam
# Valley inside China's, and neither has a vertex dividing them off. Reassigning
# them therefore needs the claim line supplied from outside, which is what this
# is. Where it runs along a border that already exists in the data -- the Wakhan
# corridor, the line south of Aksai Chin, the Punjab border -- the vertices are
# lifted from the data unchanged; the rest is traced.
#
# It is accurate to roughly a tenth of a degree, which is under two pixels at
# the zoom this page opens at, and about the same as the 1:110m outlines it sits
# in. Checked by area, sector by sector rather than in total -- a total can come
# out right while the shape is wrong, which is exactly what happened on the
# first pass here: northern Aksai Chin was short by two thirds and the error was
# hidden by over-claiming elsewhere. As it stands:
#
#     Aksai Chin          37,100 km2   against ~37,244
#     Shaksgam Valley      6,500 km2   against  ~5,180
#     from Pakistan       88,900 km2   against ~85,800
#     India, all in    3,274,800 km2   against 3,287,263  (0.38% out)
#
# This is a reconstruction, not an authority. The exact article is Natural
# Earth's India point-of-view edition; pass it to --source and this is skipped.
INDIA_CLAIM = [
    # -- west: the line between Azad Kashmir / Gilgit-Baltistan and Pakistan --
    (74.45, 32.76),  # on the existing India-Pakistan line, near Jammu
    (73.90, 33.20), (73.75, 33.55), (73.45, 34.05), (73.10, 34.60),
    (72.90, 35.10), (72.85, 35.60), (73.10, 36.15), (73.60, 36.60),
    (74.07, 36.84),  # existing vertex: Pakistan-Afghanistan border
    (74.58, 37.02),  # existing vertex: the Wakhan corridor
    (75.16, 37.13),  # existing vertex: northern tip, Afghanistan-China junction

    # -- north-east: Shaksgam, then along the Kunlun over Aksai Chin ----------
    (76.00, 36.35), (76.90, 36.05), (77.85, 35.80),   # the Trans-Karakoram Tract
    (78.70, 36.10), (79.60, 36.05), (80.45, 35.60),   # northern Aksai Chin
    (80.70, 35.00), (80.15, 34.45),                   # its eastern edge

    # -- south: India's own border vertices, so this stretch takes nothing ---
    (78.91, 34.32), (78.81, 33.51), (79.21, 32.99), (79.18, 32.48),

    # -- closes through Himachal and Punjab, both already India --------------
    (77.50, 32.00), (75.50, 32.30),
]

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SVG_PATH = os.path.join(ROOT, "_includes", "world-land.svg")
META_PATH = os.path.join(ROOT, "_data", "world_map.yml")


def normalise_columns(frame):
    """Lowercase the attribute names and settle on one spelling for each.

    The copy bundled in geopandas has already been tidied to `iso_a3`, `name`,
    `continent`. The files Natural Earth publishes use `ISO_A3`, `NAME`,
    `CONTINENT`, and recent releases add `ISO_A3_EH` -- the "everything has a
    code" variant, which fills in several of the -99s. Accepting all of them
    is what lets --source take a point-of-view edition unmodified.
    """
    frame = frame.rename(columns={c: c.lower() for c in frame.columns})
    for wanted, candidates in (
            ("iso_a3", ("iso_a3", "iso_a3_eh", "adm0_a3", "sov_a3")),
            ("name", ("name", "name_en", "admin", "sovereignt")),
            ("continent", ("continent", "region_un")),
    ):
        if wanted in frame.columns:
            continue
        for candidate in candidates:
            if candidate in frame.columns:
                frame[wanted] = frame[candidate]
                break
        else:
            raise SystemExit(
                f"source has no column for {wanted!r}; got {sorted(frame.columns)}")
    return frame


def iso_for(row):
    """A stable, unique element id for a country."""
    for column in ("iso_a3", "iso_a3_eh", "adm0_a3"):
        iso = str(row.get(column) or "").strip()
        if iso and iso not in ("-99", "nan"):
            return iso
    name = str(row.get("name") or "").strip()
    if name in ISO_FIXUPS:
        return ISO_FIXUPS[name]
    return "x-" + "".join(c.lower() if c.isalnum() else "-" for c in name)


def ring_to_path(coords, precision):
    """One closed subpath: 'M x y L x y ... Z', with repeated points dropped.

    Simplification leaves a lot of near-duplicate vertices once the numbers
    are rounded to the output precision. Dropping them is worth roughly a
    third of the file size and changes nothing on screen.
    """
    out = []
    last = None
    for lon, lat in coords:
        # Plate carree. SVG y grows downward, so latitude is negated.
        point = (round(lon, precision), round(-lat, precision))
        if point == last:
            continue
        out.append(point)
        last = point
    if len(out) < 3:
        return ""
    # A closing 'Z' makes the final vertex redundant when it repeats the first.
    if out[-1] == out[0]:
        out.pop()
        if len(out) < 3:
            return ""

    def fmt(value):
        text = f"{value:.{precision}f}".rstrip("0").rstrip(".")
        return text if text not in ("", "-0") else "0"

    head = out[0]
    body = " ".join(f"{fmt(x)} {fmt(y)}" for x, y in out[1:])
    return f"M{fmt(head[0])} {fmt(head[1])}L{body}Z"


def geometry_to_path(geom, min_area, precision):
    """Flatten a (Multi)Polygon into a single path string.

    Holes are skipped. At 1:110m with a fill-only rendering they amount to
    Lesotho and the Caspian, and keeping them would mean carrying fill-rule
    subtleties into the stylesheet for no visible gain.
    """
    parts = []
    polygons = list(getattr(geom, "geoms", [geom]))
    for poly in polygons:
        if poly.is_empty or poly.area < min_area:
            continue
        sub = ring_to_path(poly.exterior.coords, precision)
        if sub:
            parts.append(sub)
    return "".join(parts)


def snap_to_source(points, frame, tolerance=0.02):
    """Pull traced vertices onto the exact source vertices they came from.

    The shared ones in INDIA_CLAIM -- the Wakhan corridor, the Punjab border --
    were read off a two-decimal listing, so they miss Natural Earth's real
    coordinates by a few metres. That is enough for the intersection to shave a
    17 km2 ribbon off Pakistan along the Afghan border and strand it. Snapping
    first makes the shared edges exactly coincident, so the cut is clean.

    The tolerance is about 2 km: close enough to catch a rounded copy of a
    vertex, far enough from the traced stretches to leave them alone.
    """
    import math

    targets = []
    for iso in ("IND", "PAK", "CHN", "AFG"):
        rows = frame.index[frame["iso_a3"] == iso]
        if not len(rows):
            continue
        geom = frame.at[rows[0], "geometry"]
        for poly in getattr(geom, "geoms", [geom]):
            if poly.geom_type == "Polygon":
                targets.extend(poly.exterior.coords)

    snapped = []
    for x, y in points:
        best, best_distance = None, tolerance
        for tx, ty in targets:
            distance = math.hypot(tx - x, ty - y)
            if distance < best_distance:
                best, best_distance = (tx, ty), distance
        snapped.append(best if best else (x, y))
    return snapped


def apply_india_claim(frame):
    """Move whatever of Pakistan and China lies inside INDIA_CLAIM into India.

    A union rather than an overlay, so the internal boundaries dissolve and
    northern India comes out as one polygon with no seam down the middle of it.

    India can only ever gain what Pakistan and China had: the claim polygon is
    intersected with those two and nothing else, so no third country loses
    anything and no ocean becomes land, however roughly the polygon is drawn.
    """
    from shapely.geometry import Polygon
    from shapely.ops import unary_union

    claim = Polygon(snap_to_source(INDIA_CLAIM, frame))
    if not claim.is_valid:
        claim = claim.buffer(0)

    def row_for(iso):
        matches = frame.index[frame["iso_a3"] == iso]
        return matches[0] if len(matches) else None

    india = row_for("IND")
    if india is None:
        print("warning: no IND in the source, leaving boundaries alone",
              file=sys.stderr)
        return frame

    gained = []
    for iso in ("PAK", "CHN"):
        other = row_for(iso)
        if other is None:
            continue
        geom = frame.at[other, "geometry"]
        inside = geom.intersection(claim)
        if inside.is_empty:
            continue
        gained.append(inside)
        frame.at[other, "geometry"] = geom.difference(claim)

    if gained:
        frame.at[india, "geometry"] = unary_union(
            [frame.at[india, "geometry"]] + gained).buffer(0)
    return frame


def build(tolerance, min_area, precision, source=None, india_claim=True):
    import geopandas  # imported late so --help works without the dependency

    if source:
        # Fiona reads a shapefile straight out of a zip; no unpacking step.
        if source.lower().endswith(".zip") and "://" not in source:
            source = "zip://" + os.path.abspath(source)
        world = geopandas.read_file(source)
    else:
        world = geopandas.read_file(
            geopandas.datasets.get_path("naturalearth_lowres"))
    world = normalise_columns(world)
    if india_claim:
        world = apply_india_claim(world.copy())
    world = world[world["continent"] != "Antarctica"]
    world = world[~world.geometry.is_empty & world.geometry.notna()]

    # preserve_topology keeps polygons valid, which matters because a
    # self-intersecting ring renders as a blob with the default fill rule.
    simplified = world.geometry.simplify(tolerance, preserve_topology=True)

    entries = []
    lon_min = lat_min = float("inf")
    lon_max = lat_max = float("-inf")

    for idx, geom in simplified.items():
        row = world.loc[idx]
        path = geometry_to_path(geom, min_area, precision)
        if not path:
            continue
        west, south, east, north = geom.bounds
        lon_min, lon_max = min(lon_min, west), max(lon_max, east)
        lat_min, lat_max = min(lat_min, south), max(lat_max, north)
        entries.append({
            "id": iso_for(row),
            "name": str(row["name"]),
            "continent": str(row["continent"]),
            "path": path,
            "bounds": (west, south, east, north),
        })

    if not entries:
        raise SystemExit("no country geometry survived simplification")

    # Two ids can collide only via the name-slug fallback; make it loud
    # rather than letting one country silently steal another's highlight.
    seen = {}
    for entry in entries:
        if entry["id"] in seen:
            raise SystemExit(
                f"duplicate id {entry['id']}: {seen[entry['id']]} / {entry['name']}")
        seen[entry["id"]] = entry["name"]

    entries.sort(key=lambda e: e["id"])
    return entries, (lon_min, lon_max, lat_min, lat_max)


def render_svg(entries, source_label):
    """The land as a bare <g>, for /travel/ to drop inside its own <svg>.

    No <svg> element and no viewBox here: the page computes those, because the
    default view is fitted to the pins rather than to the world.
    """
    lines = [
        "<!-- Generated by scripts/build_world_map.py -- do not edit by hand.",
        f"     {source_label}, plate carree, coordinates in degrees",
        "     (x = longitude, y = -latitude).",
        "",
        "     This is a fragment, not a standalone SVG. /travel/ wraps it in an",
        "     <svg> whose viewBox it works out from the pins, and fills the",
        "     visited countries with a <style> block keyed on the ids below. -->",
        '<g class="land">',
    ]
    for entry in entries:
        name = (entry["name"].replace("&", "&amp;")
                .replace("<", "&lt;").replace(">", "&gt;")
                .replace('"', "&quot;"))
        lines.append(
            f'  <path id="c-{entry["id"]}" data-name="{name}" d="{entry["path"]}"/>')
    lines.append("</g>")
    return "\n".join(lines) + "\n"


def render_meta(entries, bounds, source_label):
    lon_min, lon_max, lat_min, lat_max = bounds
    return (
        "# Generated by scripts/build_world_map.py -- do not edit by hand.\n"
        "#\n"
        "# The bounding box of _includes/world-land.svg, in degrees. /travel/ and\n"
        "# assets/js/travel.js both turn a lat/lon into a position with these, and\n"
        "# clamp zooming out to them, so they have to stay in step with the\n"
        "# geometry they were measured from.\n"
        f"# Source: {source_label}\n"
        f"lon_min: {lon_min:.4f}\n"
        f"lon_max: {lon_max:.4f}\n"
        f"lat_min: {lat_min:.4f}\n"
        f"lat_max: {lat_max:.4f}\n"
        f"width: {lon_max - lon_min:.4f}\n"
        f"height: {lat_max - lat_min:.4f}\n"
        f"count: {len(entries)}\n"
        "\n"
        "# Per-country bounding boxes: [west, south, east, north].\n"
        "# /travel/ unions the ones it has visited to work out the default view,\n"
        "# so framing on India shows all of India and not just the part with pins\n"
        "# in it.\n"
        "countries:\n"
        + "".join(
            f"  {e['id']}: [{e['bounds'][0]:.2f}, {e['bounds'][1]:.2f},"
            f" {e['bounds'][2]:.2f}, {e['bounds'][3]:.2f}]\n"
            for e in entries)
    )


def write_atomic(path, text):
    """Write via a temp file in the same directory, then rename."""
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp-")
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(text)
        # mkstemp is 0600; these get committed and read by the build.
        umask = os.umask(0)
        os.umask(umask)
        os.chmod(tmp, 0o666 & ~umask)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def main(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    # The page opens zoomed in on wherever the pins are -- currently about 39
    # degrees of longitude across 690px, so ~18px per degree. At that scale 0.4
    # deg of simplification is a visible 7px of error. 0.15 keeps very nearly
    # everything the 1:110m source has (94 KB against 133 KB unsimplified); the
    # remaining blockiness is the source resolution, not this.
    ap.add_argument("--tolerance", type=float, default=0.15,
                    help="Douglas-Peucker tolerance in degrees (default 0.15)")
    ap.add_argument("--min-area", type=float, default=0.02,
                    help="drop polygons smaller than this, in square degrees "
                         "(default 0.02, which keeps Mauritius and loses reefs)")
    ap.add_argument("--precision", type=int, default=2,
                    help="decimal places kept per coordinate (default 2, "
                         "about 1 km at the equator)")
    ap.add_argument("--source", default=None, metavar="PATH",
                    help="a Natural Earth admin-0 shapefile or zip to use "
                         "instead of the copy bundled in geopandas. Use this "
                         "with ne_110m_admin_0_countries_ind to get India's "
                         "boundary rather than the de facto one -- see the "
                         "module docstring")
    ap.add_argument("--no-india-claim", dest="india_claim", action="store_false",
                    help="leave the de facto Kashmir boundary alone. Applied "
                         "automatically when --source is given, on the "
                         "assumption that a point-of-view edition already has "
                         "the boundary you want")
    ap.set_defaults(india_claim=True)
    args = ap.parse_args(argv)

    # A point-of-view edition carries its own boundaries; patching them would
    # be both wrong and, if the file is the Indian one, redundant.
    india_claim = args.india_claim and not args.source

    if args.source:
        source_label = ("Natural Earth admin 0 countries from "
                        f"{os.path.basename(args.source)}")
    else:
        source_label = ("Natural Earth 1:110m admin 0 countries bundled with "
                        "geopandas (public domain)")
        source_label += (", Jammu and Kashmir reassigned to India's claimed "
                         "boundary" if india_claim else ", de facto boundaries")

    entries, bounds = build(args.tolerance, args.min_area, args.precision,
                            args.source, india_claim)
    svg = render_svg(entries, source_label)
    write_atomic(SVG_PATH, svg)
    write_atomic(META_PATH, render_meta(entries, bounds, source_label))

    print(f"{len(entries)} countries, {len(svg) / 1024:.0f} KB "
          f"-> {os.path.relpath(SVG_PATH, ROOT)}")
    print(f"bbox lon [{bounds[0]:.1f}, {bounds[1]:.1f}] "
          f"lat [{bounds[2]:.1f}, {bounds[3]:.1f}] "
          f"-> {os.path.relpath(META_PATH, ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
