#!/usr/bin/env python3
"""Generate the map the /travel/ page draws on.

This is a one-shot generator, not part of the nightly sync. It reads a Natural
Earth "admin 0 countries" file and, optionally, its "admin 1 states and
provinces", simplifies them, and writes:

  * ``_includes/world-land.svg`` -- a bare fragment. ``<g class="land">`` has
    one ``<path>`` per country carrying ``id="c-XXX"`` (ISO 3166-1 alpha-3).
    With ``--states`` there is also ``<g class="states">``, one path per Indian
    state and union territory, ``id="s-<slug>"``. It is not a standalone SVG
    on purpose: /travel/ supplies the ``<svg>`` wrapper because the page, not
    this script, decides the framing -- the default view is fitted to wherever
    the pins happen to be.

  * ``_data/world_map.yml`` -- the numbers the page and the zoom script need to
    turn a lat/lon into a position: the world's bounding box, the x scale, and
    per-country and per-state bounding boxes.

Projection
----------
Equirectangular: x = lon * cos(standard parallel), y = -lat. Placing a pin
stays a multiply, a subtraction and a divide, which Liquid can do. Anything
curved -- Robinson, a conic -- needs trigonometry Liquid does not have, so
every pin would have to be projected here and this rerun whenever a place is
added, which is a bad trade for a page whose whole point is that you can add a
line of YAML to it.

The standard parallel defaults to the Tropic of Cancer, which runs through the
middle of India. Plate carree (``--standard-parallel 0``) draws India a tenth
too wide at the Tropic and a fifth too wide in Ladakh.

Antarctica is dropped: it is a third of the map's height, nobody has a pin
there, and the seventh continent is tracked as a chip on the page instead.

Sources
-------
Natural Earth, public domain. The sandbox cannot reach naturalearthdata.com,
so download these elsewhere into ``_geo/`` (gitignored, and ignored by Jekyll
for its leading underscore):

    https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_0_countries_ind.zip
    https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_1_states_provinces.zip

then

    python3 scripts/build_world_map.py \\
        --source _geo/ne_10m_admin_0_countries_ind.zip \\
        --states _geo/ne_10m_admin_1_states_provinces.zip

Zips are read in place. ``--source`` on its own, with any admin-0 file, gives
the countries without the state layer. geopandas stopped bundling Natural
Earth in 1.0, so there is no default source any more.

Boundaries and Kashmir
----------------------
The map draws India's boundary for Jammu and Kashmir, not the de facto one.
How depends on the source, and the script works out which kind it has from
the geometry rather than the file name: India's polygon either contains
Gilgit and Aksai Chin or it does not.

  * Natural Earth's India point-of-view edition (the ``_ind`` files) already
    draws India's boundary, and is used as it is.

  * The default editions split Jammu and Kashmir between India, Pakistan and
    China. For those, INDIA_CLAIM below moves the claimed area into India.
    It is traced to about a tenth of a degree: fine for a world map, and
    visibly wrong at the zoom the state layer is for, so ``--states`` refuses
    a source that needs it.

The states layer is de facto whichever edition the countries come from:
India's Jammu and Kashmir and Ladakh stop at the Line of Control and the Line
of Actual Control. So the states are fitted inside India's outline from the
admin-0 file, and whatever of that outline they leave uncovered is handed out
the way India's 2019 political map does it -- Azad Kashmir to Jammu and
Kashmir, Gilgit-Baltistan to Ladakh (see CLAIM_OWNERS), and everything else,
Aksai Chin and the Shaksgam valley included, to the state it shares the
longest border with. The script prints each piece it moves and the totals to
check against.

Usage
-----
    python3 scripts/build_world_map.py --source _geo/ne_10m_admin_0_countries_ind.zip
    python3 scripts/build_world_map.py --source ... --states ...
    python3 scripts/build_world_map.py --source ... --tolerance 0.6   # smaller, coarser

Natural Earth is public domain; no attribution is required, though the page
carries one anyway.
"""

import argparse
import math
import os
import re
import sys
import tempfile
import unicodedata

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
# traced at 1:110m. Only used when the source is a de facto edition.
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
# the zoom a world map opens at, and about the same as the 1:110m outlines it
# sits in. Checked by area, sector by sector rather than in total -- a total can
# come out right while the shape is wrong, which is exactly what happened on the
# first pass here: northern Aksai Chin was short by two thirds and the error was
# hidden by over-claiming elsewhere. As it stands:
#
#     Aksai Chin          37,100 km2   against ~37,244
#     Shaksgam Valley      6,500 km2   against  ~5,180
#     from Pakistan       88,900 km2   against ~85,800
#     India, all in    3,274,800 km2   against 3,287,263  (0.38% out)
#
# This is a reconstruction, not an authority. Natural Earth's India
# point-of-view edition is the real thing, and with it this is never used.
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

# Inside India's boundary and outside the de facto one: Gilgit town, and the
# middle of Aksai Chin. A source whose India contains both already draws
# India's boundary; one whose India contains neither is de facto.
CLAIM_PROBES = ((74.31, 35.92), (79.50, 35.20))

# The Tropic of Cancer.
STANDARD_PARALLEL = 23.44

# The 28 states and 8 union territories, under the names the page shows and
# travel.yml uses, each with the other spellings a source might use. Units
# that merged -- Dadra and Nagar Haveli with Daman and Diu, in 2020 -- list
# their old names as aliases and are dissolved into one.
STATES = {
    "Andaman and Nicobar Islands": ("Andaman and Nicobar",),
    "Andhra Pradesh": (),
    "Arunachal Pradesh": (),
    "Assam": (),
    "Bihar": (),
    "Chandigarh": (),
    "Chhattisgarh": ("Chattisgarh",),
    "Dadra and Nagar Haveli and Daman and Diu": (
        "Dadra and Nagar Haveli", "Daman and Diu"),
    "Delhi": ("NCT of Delhi", "National Capital Territory of Delhi"),
    "Goa": (),
    "Gujarat": (),
    "Haryana": (),
    "Himachal Pradesh": (),
    "Jammu and Kashmir": (),
    "Jharkhand": (),
    "Karnataka": (),
    "Kerala": (),
    "Ladakh": (),
    "Lakshadweep": (),
    "Madhya Pradesh": (),
    "Maharashtra": (),
    "Manipur": (),
    "Meghalaya": (),
    "Mizoram": (),
    "Nagaland": (),
    "Odisha": ("Orissa",),
    "Puducherry": ("Pondicherry",),
    "Punjab": (),
    "Rajasthan": (),
    "Sikkim": (),
    "Tamil Nadu": (),
    "Telangana": (),
    "Tripura": (),
    "Uttar Pradesh": (),
    "Uttarakhand": ("Uttaranchal",),
    "West Bengal": (),
}

# Admin-1 units outside India that India's map places in a particular union
# territory. Only these two need naming: Aksai Chin and Shaksgam touch nothing
# but Ladakh once Gilgit-Baltistan is in it, so the longest-border rule puts
# them there by itself.
CLAIM_OWNERS = {
    "azad kashmir": "Jammu and Kashmir",
    "gilgit baltistan": "Ladakh",
    "northern areas": "Ladakh",   # Gilgit-Baltistan's name in older releases
}

# Published areas, for the sanity check printed after the states are built.
# The first is the former state of Jammu and Kashmir, including the parts
# administered by Pakistan and China, which is what the two UTs add up to.
AREA_CHECKS = (
    (("Jammu and Kashmir", "Ladakh"), 222_236),
    (tuple(STATES), 3_287_263),
)

# Units whose largest piece is smaller than this, in square degrees, get
# class="tiny" so the page can give them a minimum size. That is Lakshadweep,
# Chandigarh, Puducherry, and Dadra and Nagar Haveli and Daman and Diu, which
# are otherwise invisible at the default zoom. Delhi, at about 0.13, is not.
TINY_AREA = 0.05

# How far past India's own bounding box, in degrees, the light simplification
# reaches. The part of every country inside it is simplified together with
# the states, so the borders they share come out as one line; the rest of
# each one is simplified like any other country, or China and Indonesia alone
# would be a quarter of a megabyte. Two degrees takes in all of Nepal,
# Bhutan, Bangladesh and Sri Lanka and the parts of the others you see when
# zoomed in on an Indian border.
DETAIL_MARGIN = 2.0

# The coarse part of a country cut by the detail box starts this far inside
# the box, in degrees, so the two parts overlap instead of risking a hairline
# gap where they are joined back together.
SEAM_OVERLAP = 0.05

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SVG_PATH = os.path.join(ROOT, "_includes", "world-land.svg")
META_PATH = os.path.join(ROOT, "_data", "world_map.yml")


def slugify(text):
    """Jekyll's default ``slugify``, so the page can derive the same ids.

    travel.yml says ``state: Tamil Nadu`` and travel.html looks for
    ``#s-{{ state | slugify }}``. Jekyll lowercases and turns every run of
    non-alphanumerics into one hyphen, trimming them from the ends. The names
    in STATES are plain ASCII, so that is all this needs to do.
    """
    return re.sub(r"[^0-9a-z]+", "-", text.lower()).strip("-")


def normalise_name(text):
    """A loose key for matching names across sources: case, accents,
    ampersands and punctuation all ignored."""
    text = unicodedata.normalize("NFKD", str(text))
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = text.lower().replace("&", " and ")
    return " ".join(re.sub(r"[^0-9a-z]+", " ", text).split())


def read_source(path, bbox=None):
    """Read a shapefile, zip or GeoJSON. Zips are read in place."""
    import geopandas  # imported late so --help works without the dependency

    if path.lower().endswith(".zip") and "://" not in path:
        path = "zip://" + os.path.abspath(path)
    return geopandas.read_file(path, bbox=bbox)


def normalise_columns(frame):
    """Lowercase the attribute names and settle on one spelling for each.

    The copy that used to ship inside geopandas had already been tidied to
    `iso_a3`, `name`, `continent`. The files Natural Earth publishes use
    `ISO_A3`, `NAME`, `CONTINENT`, and recent releases add `ISO_A3_EH` -- the
    "everything has a code" variant, which fills in several of the -99s.
    Accepting all of them is what lets --source take any edition unmodified.
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


def polygons(geom):
    """The polygons in a geometry, whatever it is.

    Overlay operations hand back GeometryCollections with stray lines and
    points in them where two edges merely touch; only the areas matter here.
    """
    if geom is None or geom.is_empty:
        return []
    if geom.geom_type == "Polygon":
        return [geom]
    if geom.geom_type in ("MultiPolygon", "GeometryCollection"):
        return [p for part in geom.geoms for p in polygons(part)]
    return []


def areal(geom):
    """`geom` with everything but its polygons dropped, as one geometry."""
    from shapely.geometry import MultiPolygon, Polygon

    parts = polygons(geom)
    if not parts:
        return Polygon()
    return parts[0] if len(parts) == 1 else MultiPolygon(parts)


def km2(geom):
    """Area on the ellipsoid, in square kilometres."""
    from pyproj import Geod

    area, _ = Geod(ellps="WGS84").geometry_area_perimeter(geom)
    return abs(area) / 1e6


def ring_to_path(coords, precision, x_scale):
    """One closed subpath: 'M x y L x y ... Z', with repeated points dropped.

    Simplification leaves a lot of near-duplicate vertices once the numbers
    are rounded to the output precision. Dropping them is worth roughly a
    third of the file size and changes nothing on screen.
    """
    out = []
    last = None
    for lon, lat in coords:
        # SVG y grows downward, so latitude is negated.
        point = (round(lon * x_scale, precision), round(-lat, precision))
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


def geometry_to_path(geom, min_area, precision, x_scale, holes=False):
    """Flatten a (Multi)Polygon into a single path string.

    Holes are skipped by default. At world scale with a fill-only rendering
    they amount to Lesotho and the Caspian, and keeping them would mean
    carrying fill-rule subtleties into the stylesheet for no visible gain.

    The state layer keeps them (``holes=True``): an enclave there is a real
    unit that has to show through. Orienting every ring -- shells one way,
    holes the other -- is what makes the default nonzero fill rule cut them
    out, and negating y flips both alike, so that survives the projection.
    """
    from shapely.geometry.polygon import orient

    parts = []
    # Small islands go, but never a whole country: one smaller than the limit
    # -- Singapore, the Maldives -- keeps its largest piece, so a visit there
    # still has something to fill.
    pieces = polygons(geom)
    kept = [p for p in pieces if p.area >= min_area]
    if pieces and not kept:
        kept = [max(pieces, key=lambda p: p.area)]
    for poly in kept:
        rings = [poly.exterior]
        if holes:
            poly = orient(poly, 1.0)
            rings = [poly.exterior] + list(poly.interiors)
        for ring in rings:
            sub = ring_to_path(ring.coords, precision, x_scale)
            if sub:
                parts.append(sub)
    return "".join(parts)


def shows_india_view(frame):
    """Does this source already draw India's boundary in Kashmir?"""
    from shapely.geometry import Point

    rows = frame.index[frame["iso_a3"] == "IND"]
    if not len(rows):
        raise SystemExit("source has no IND row")
    india = frame.at[rows[0], "geometry"]
    inside = [india.contains(Point(lon, lat)) for lon, lat in CLAIM_PROBES]
    if all(inside):
        return True
    if not any(inside):
        return False
    raise SystemExit(
        "source draws part of India's Kashmir boundary and not the rest "
        f"(probes {CLAIM_PROBES} -> {inside}); not sure what to do with it")


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
    targets = []
    for iso in ("IND", "PAK", "CHN", "AFG"):
        rows = frame.index[frame["iso_a3"] == iso]
        if not len(rows):
            continue
        for poly in polygons(frame.at[rows[0], "geometry"]):
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


def first_column(frame, candidates):
    for column in candidates:
        if column in frame.columns:
            return column
    return None


def build_states(source, india):
    """India's 36 units, fitted to `india` and filling it exactly.

    Returns {canonical name: geometry}. The geometries tile `india` with no
    gaps or overlaps, which is what lets them be simplified as one coverage
    afterwards and still meet each other -- and India's neighbours -- edge to
    edge.
    """
    import shapely
    from shapely.ops import unary_union

    west, south, east, north = india.bounds
    frame = read_source(source, bbox=(west - 1, south - 1, east + 1, north + 1))
    frame = frame.rename(columns={c: c.lower() for c in frame.columns})

    name_column = first_column(
        frame, ("name", "name_en", "st_nm", "state_name", "state"))
    if name_column is None:
        raise SystemExit(
            f"states source has no name column; got {sorted(frame.columns)}")
    # Natural Earth's file is the whole world. A source with no country column
    # is taken to be India only, which is how DataMeet's files come.
    country_column = first_column(frame, ("adm0_a3", "sov_a3", "iso_a3"))
    if country_column:
        is_india = frame[country_column] == "IND"
    else:
        is_india = frame[name_column].notna()

    lookup = {}
    for canonical, aliases in STATES.items():
        for alias in (canonical,) + aliases:
            lookup[normalise_name(alias)] = canonical

    parts, unknown = {}, set()
    for idx in frame.index[is_india]:
        raw = frame.at[idx, name_column]
        canonical = lookup.get(normalise_name(raw))
        if canonical is None:
            unknown.add(str(raw))
            continue
        parts.setdefault(canonical, []).append(frame.at[idx, "geometry"])

    if unknown:
        raise SystemExit(
            "states source has Indian units this script does not recognise: "
            f"{sorted(unknown)}. Add them to STATES as aliases of the unit "
            "they now belong to.")
    missing = sorted(set(STATES) - set(parts))
    if missing:
        hint = ""
        if "Ladakh" in missing:
            hint = (" Ladakh became its own union territory in 2019; a source "
                    "without it still has the old state of Jammu and Kashmir, "
                    "and splitting that needs district boundaries this script "
                    "does not have. Use a newer release, or a source that is "
                    "already split.")
        raise SystemExit(f"states source is missing {missing}.{hint}")

    # Fit each unit inside India's outline and keep them from overlapping one
    # another. Taking them in a fixed order means a sliver claimed by two
    # sources' worth of edges goes to the same one every run.
    units, taken = {}, []
    for name in sorted(parts):
        geom = shapely.make_valid(unary_union(parts[name])).intersection(india)
        if taken:
            geom = geom.difference(unary_union(taken))
        units[name] = areal(geom)
        taken.append(units[name])

    rest = areal(india.difference(unary_union(taken)))
    moved = []

    # First, the parts India's map assigns by name.
    for idx in frame.index[~is_india]:
        owner = CLAIM_OWNERS.get(normalise_name(frame.at[idx, name_column]))
        if owner is None:
            continue
        piece = areal(rest.intersection(frame.at[idx, "geometry"]))
        if piece.is_empty:
            continue
        units[owner] = areal(unary_union([units[owner], piece]))
        rest = areal(rest.difference(piece))
        moved.append((str(frame.at[idx, name_column]), piece, owner))

    # Then everything else, to whichever unit it shares the most border with.
    # Biggest first, so a sliver along the edge of a big piece follows it.
    for piece in sorted(polygons(rest), key=lambda p: p.area, reverse=True):
        edge = piece.boundary
        best, best_length = None, 0.0
        for name, geom in units.items():
            if not geom.envelope.intersects(piece.envelope):
                continue
            length = edge.intersection(geom.boundary).length
            if length > best_length:
                best, best_length = name, length
        if best is None:
            # Touches nothing: an island the states layer left out. The
            # nearest unit is the only sensible home for it.
            best = min(units, key=lambda n: units[n].distance(piece))
        units[best] = areal(unary_union([units[best], piece]))
        moved.append(("unassigned", piece, best))

    # Printed with a location, because the longest-border rule is only as
    # good as the layer's idea of who borders whom, and a piece that went to
    # the wrong state is obvious once you can see where it is.
    for label, piece, owner in moved:
        size = km2(piece)
        if size >= 10:
            at = piece.representative_point()
            print(f"  {label} at {at.x:.2f}E {at.y:.2f}N: "
                  f"{size:,.0f} km2 -> {owner}")
    small = [m for m in moved if km2(m[1]) < 10]
    if small:
        print(f"  {len(small)} slivers under 10 km2 each, "
              f"{sum(km2(m[1]) for m in small):,.1f} km2 in all, "
              "to their neighbours")
    for names, expected in AREA_CHECKS:
        total = sum(km2(units[n]) for n in names)
        label = " + ".join(names) if len(names) < 3 else "India, all in"
        print(f"  {label}: {total:,.0f} km2 against {expected:,} "
              f"({(total - expected) / expected:+.2%})")
    return units


def make_coverage(geoms):
    """Rebuild polygons that should tile together so that they do, exactly.

    The states come out of a chain of intersections and differences, and the
    neighbours from a different file, so a border two of them share can be
    the same line with different vertices on each side -- an extra vertex
    where one operation split an edge and the other did not. That is enough
    for the coverage simplifier to treat it as two borders and move them
    apart.

    So everything is redrawn from one shared set of edges: every outline is
    noded against every other, the result is cut into faces, and each face
    goes back to the polygon it lies in. Two polygons that touch now share
    one edge, vertex for vertex. A face in two of them -- an overlap -- goes
    to the first, which is why the states are passed in ahead of the
    neighbours; a face in none is sea, or a gap, and is dropped.
    """
    import shapely
    from shapely.ops import polygonize, unary_union

    edges = unary_union([g.boundary for g in geoms])
    tree = shapely.STRtree(geoms)
    faces = [[] for _ in geoms]
    for face in polygonize(edges):
        hits = tree.query(face.representative_point(), predicate="within")
        if len(hits):
            faces[min(hits)].append(face)
    return [areal(unary_union(parts)) for parts in faces]


def simplify_coverage(geoms, labels, tolerance):
    """Simplify polygons that tile together so that they still do.

    Simplifying each polygon on its own moves a shared border differently on
    each side of it, leaving gaps and overlaps all the way along. At world
    scale the stroke hides them; along a state border it would not.
    """
    import numpy
    import shapely

    if not hasattr(shapely, "coverage_simplify"):
        raise SystemExit("--states needs shapely 2.1 or later, on GEOS 3.12+")
    array = numpy.array(geoms, dtype=object)
    if not shapely.coverage_is_valid(array):
        bad = shapely.coverage_invalid_edges(array)
        named = [f"{label} ({edge.length:.3f} deg)"
                 for label, edge in zip(labels, bad)
                 if edge is not None and not edge.is_empty]
        print(f"warning: {len(named)} of the detail polygons do not tile "
              "cleanly, so their shared borders may show hairline gaps. "
              "Length of mismatched edge: " + ", ".join(named),
              file=sys.stderr)
    return list(shapely.coverage_simplify(array, tolerance))


def build(args, x_scale):
    """Read, reconcile and simplify. Returns countries, states, world bbox,
    detail box, and whether the source drew India's boundary itself."""
    from shapely.geometry import box
    from shapely.ops import unary_union

    world = normalise_columns(read_source(args.source))
    india_view = shows_india_view(world)
    if not india_view:
        if args.states:
            raise SystemExit(
                "--states needs India's boundary from the countries source, "
                "and this one is de facto. Use the India point-of-view edition "
                "(ne_10m_admin_0_countries_ind); the hand-traced fallback is "
                "too coarse at state zoom.")
        if args.india_claim:
            world = apply_india_claim(world.copy())
    world = world[world["continent"] != "Antarctica"]
    world = world[~world.geometry.is_empty & world.geometry.notna()]

    detail, states, detail_box = {}, [], None
    if args.states:
        india_idx = world.index[world["iso_a3"] == "IND"][0]
        india = world.at[india_idx, "geometry"]
        units = build_states(args.states, india)

        west, south, east, north = india.bounds
        detail_box = (west - DETAIL_MARGIN, south - DETAIL_MARGIN,
                      east + DETAIL_MARGIN, north + DETAIL_MARGIN)
        reach = box(*detail_box)
        near = [idx for idx in world.index
                if idx != india_idx and world.at[idx, "geometry"].intersects(reach)]

        names = sorted(units)
        inside = [areal(world.at[i, "geometry"].intersection(reach)) for i in near]
        simple = simplify_coverage(
            make_coverage([units[n] for n in names] + inside),
            names + [str(world.at[i, "name"]) for i in near],
            args.detail_tolerance)
        for name, geom in zip(names, simple):
            states.append({
                "slug": slugify(name),
                "name": name,
                "path": geometry_to_path(geom, args.detail_min_area,
                                         args.detail_precision, x_scale,
                                         holes=True),
                "bounds": geom.bounds,
                "tiny": max((p.area for p in polygons(geom)),
                            default=0) < TINY_AREA,
            })
        # The neighbours' parts inside the box were simplified in the same
        # pass as the states, so the borders between them are the same line.
        # Outside it they are ordinary countries, and the two halves are
        # joined back into one outline -- one path, so no stroke runs along
        # the join.
        inner = reach.buffer(-SEAM_OVERLAP, join_style="mitre")
        for idx, geom in zip(near, simple[len(names):]):
            fine = [p for p in polygons(geom) if p.area >= args.neighbour_min_area]
            rest = world.at[idx, "geometry"].difference(inner).simplify(
                args.tolerance, preserve_topology=True)
            coarse = [p for p in polygons(rest) if p.area >= args.min_area]
            if not fine and not coarse:
                # All islands, every one under both limits: the Maldives.
                fine = [max(polygons(geom) + polygons(rest), key=lambda p: p.area)]
            detail[idx] = (unary_union(fine + coarse), args.detail_precision)

        # India's own country outline only shows on the world map -- in the
        # close-up the states draw India and the page hides it -- so it is
        # simplified like any other country rather than repeating the
        # states' detail.
        coarse = india.simplify(args.tolerance, preserve_topology=True)
        detail[india_idx] = (
            unary_union([p for p in polygons(coarse) if p.area >= args.min_area]),
            args.precision)

    entries = []
    lon_min = lat_min = float("inf")
    lon_max = lat_max = float("-inf")

    for idx, row in world.iterrows():
        if idx in detail:
            # Small pieces were filtered above, each half by its own limit.
            geom, precision = detail[idx]
            path = geometry_to_path(geom, 0, precision, x_scale)
        else:
            # preserve_topology keeps polygons valid, which matters because a
            # self-intersecting ring renders as a blob with the default fill
            # rule.
            geom = row.geometry.simplify(args.tolerance, preserve_topology=True)
            path = geometry_to_path(geom, args.min_area, args.precision, x_scale)
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

    # Natural Earth's 1:10m file has extra rows under an existing code --
    # Brazilian Island is BRA -- and those are part of that country, so they
    # join its path. Two slug ids colliding would be two different countries
    # with one name; make that loud rather than letting one silently steal
    # the other's highlight.
    merged = {}
    for entry in entries:
        first = merged.get(entry["id"])
        if first is None:
            merged[entry["id"]] = entry
            continue
        if entry["id"].startswith("x-"):
            raise SystemExit(
                f"duplicate id {entry['id']}: {first['name']} / {entry['name']}")
        print(f"  {entry['name']} joins {first['name']} as {entry['id']}")
        first["path"] += entry["path"]
        first["bounds"] = (min(first["bounds"][0], entry["bounds"][0]),
                           min(first["bounds"][1], entry["bounds"][1]),
                           max(first["bounds"][2], entry["bounds"][2]),
                           max(first["bounds"][3], entry["bounds"][3]))
    entries = sorted(merged.values(), key=lambda e: e["id"])
    # Big units first so the small ones -- Chandigarh inside Punjab and
    # Haryana, Mahe on the Kerala coast -- are drawn on top of them.
    states.sort(key=lambda s: (s["tiny"], s["slug"]))
    return (entries, states, (lon_min, lon_max, lat_min, lat_max),
            detail_box, india_view)


def escape(text):
    return (text.replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def render_svg(entries, states, source_label):
    """The land as bare <g>s, for /travel/ to drop inside its own <svg>.

    No <svg> element and no viewBox here: the page computes those, because the
    default view is fitted to the pins rather than to the world.
    """
    lines = [
        "<!-- Generated by scripts/build_world_map.py -- do not edit by hand.",
        f"     {source_label}.",
        "     Equirectangular: x = longitude * x_scale, y = -latitude, with",
        "     x_scale in _data/world_map.yml.",
        "",
        "     This is a fragment, not a standalone SVG. /travel/ wraps it in an",
        "     <svg> whose viewBox it works out from the pins, and fills the",
        "     visited countries and states with a <style> block keyed on the",
        "     ids below. -->",
        '<g class="land">',
    ]
    for entry in entries:
        lines.append(
            f'  <path id="c-{entry["id"]}" data-name="{escape(entry["name"])}"'
            f' d="{entry["path"]}"/>')
    lines.append("</g>")
    if states:
        lines.append('<g class="states">')
        for state in states:
            tiny = ' class="tiny"' if state["tiny"] else ""
            lines.append(
                f'  <path id="s-{state["slug"]}"{tiny}'
                f' data-name="{escape(state["name"])}" d="{state["path"]}"/>')
        lines.append("</g>")
    return "\n".join(lines) + "\n"


def render_meta(entries, states, bounds, detail_box, x_scale, parallel,
                source_label):
    lon_min, lon_max, lat_min, lat_max = bounds

    def box4(values):
        return "[" + ", ".join(f"{v:.2f}" for v in values) + "]"

    text = (
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
        "# The map's x is longitude times this, cos() of the standard parallel.\n"
        "# Everything else in this file stays in degrees.\n"
        f"standard_parallel: {parallel:.2f}\n"
        f"x_scale: {x_scale:.6f}\n"
    )
    if detail_box:
        text += (
            "\n"
            "# [west, south, east, north] of the area drawn in detail. The zoom\n"
            "# script lets you in closer here than over the rest of the world.\n"
            f"detail_box: {box4(detail_box)}\n"
        )
    text += (
        "\n"
        "# Per-country bounding boxes: [west, south, east, north].\n"
        "# /travel/ unions the ones it has visited to work out the default view,\n"
        "# so framing on India shows all of India and not just the part with pins\n"
        "# in it.\n"
        "countries:\n"
        + "".join(f"  {e['id']}: {box4(e['bounds'])}\n" for e in entries)
    )
    if states:
        text += (
            "\n"
            "# India's 28 states and 8 union territories: [west, south, east,\n"
            "# north], keyed on the slug of the name travel.yml's `state` takes.\n"
            "# /travel/ checks each place's state against this list.\n"
            "states:\n"
            + "".join(f"  {s['slug']}: {box4(s['bounds'])}"
                      f"   # {s['name']}\n" for s in sorted(states, key=lambda s: s['slug']))
        )
    return text


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
    ap.add_argument("--source", required=True, metavar="PATH",
                    help="a Natural Earth admin-0 countries shapefile or zip. "
                         "Use the India point-of-view edition -- see above")
    ap.add_argument("--states", metavar="PATH",
                    help="a Natural Earth admin-1 states and provinces file; "
                         "adds the layer of India's states and union "
                         "territories")
    ap.add_argument("--standard-parallel", type=float, default=STANDARD_PARALLEL,
                    help="latitude at which the map is true to scale "
                         f"(default {STANDARD_PARALLEL}, the Tropic of Cancer; "
                         "0 is plate carree)")
    # The page opens zoomed in on wherever the pins are -- about 17px per
    # degree -- and everything but India and its neighbours is background
    # there. 0.2 deg is 3-4px of error at that scale, about what the 1:110m
    # outlines the page used to draw had built in, at a third of the bytes the
    # 1:10m source would otherwise take. The island limit does most of the
    # rest: the Arctic archipelagos alone were 50 KB.
    ap.add_argument("--tolerance", type=float, default=0.2,
                    help="Douglas-Peucker tolerance in degrees for countries "
                         "away from India (default 0.2)")
    ap.add_argument("--min-area", type=float, default=0.1,
                    help="drop islands smaller than this, in square degrees, "
                         "away from India (default 0.1, about 1,000 km2; a "
                         "country smaller than that keeps its largest piece)")
    ap.add_argument("--precision", type=int, default=2,
                    help="decimal places kept per coordinate (default 2, "
                         "about 1 km at the equator)")
    # The state layer is for zooming in to about three degrees across, some
    # 230px per degree. 0.03 here is gentler than it sounds -- the coverage
    # simplifier's tolerance is the square root of the area of the triangles
    # it removes, not a distance -- and holds up there; 0.01 tripled the
    # states' size for detail you only see past the point the 1:10m source
    # runs out anyway.
    ap.add_argument("--detail-tolerance", type=float, default=0.03,
                    help="coverage simplification tolerance for India, its "
                         "states and its neighbours (default 0.03)")
    ap.add_argument("--detail-precision", type=int, default=3,
                    help="decimal places for the same (default 3)")
    ap.add_argument("--detail-min-area", type=float, default=1e-5,
                    help="smallest Indian island kept, in square degrees "
                         "(default 1e-5, about 0.1 km2: all of Lakshadweep)")
    ap.add_argument("--neighbour-min-area", type=float, default=1e-3,
                    help="smallest island kept for India's neighbours "
                         "(default 1e-3, about 12 km2)")
    ap.add_argument("--no-india-claim", dest="india_claim", action="store_false",
                    help="with a de facto source, leave its Kashmir boundary "
                         "alone instead of applying INDIA_CLAIM")
    ap.set_defaults(india_claim=True)
    args = ap.parse_args(argv)

    x_scale = math.cos(math.radians(args.standard_parallel))
    entries, states, bounds, detail_box, india_view = build(args, x_scale)

    source_label = ("Natural Earth admin 0 countries from "
                    f"{os.path.basename(args.source)}")
    if india_view:
        source_label += ", India's boundary as the source draws it"
    elif args.india_claim:
        source_label += (", Jammu and Kashmir reassigned to India's claimed "
                         "boundary")
    else:
        source_label += ", de facto boundaries"
    if states:
        source_label += (", India's states and union territories from "
                         f"{os.path.basename(args.states)}")

    svg = render_svg(entries, states, source_label)
    write_atomic(SVG_PATH, svg)
    write_atomic(META_PATH, render_meta(entries, states, bounds, detail_box,
                                        x_scale, args.standard_parallel,
                                        source_label))

    print(f"{len(entries)} countries, {len(states)} states and UTs, "
          f"{len(svg) / 1024:.0f} KB -> {os.path.relpath(SVG_PATH, ROOT)}")
    print(f"bbox lon [{bounds[0]:.1f}, {bounds[1]:.1f}] "
          f"lat [{bounds[2]:.1f}, {bounds[3]:.1f}], x_scale {x_scale:.4f} "
          f"-> {os.path.relpath(META_PATH, ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
