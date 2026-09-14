#!/usr/bin/env python3
"""Generate the world map the /travel/ page draws on.

This is a one-shot generator, not part of the nightly sync. It reads the
Natural Earth 1:110m "admin 0 countries" shapefile that ships inside
geopandas, simplifies it, and writes two files:

  * ``_includes/world-map.svg`` -- one ``<path>`` per country, each carrying
    ``id="c-XXX"`` (ISO 3166-1 alpha-3). The travel page inlines this and
    emits a tiny ``<style>`` block that fills the visited ones, so the
    highlighting is resolved at build time and needs no JavaScript.

  * ``_data/world_map.yml`` -- the bounding box in degrees. Pins are placed by
    Liquid arithmetic on ``lat``/``lon``, and it needs the same numbers the
    viewBox was built from. Hardcoding them in the template would silently
    drift the moment the projection or the clip changes.

Projection is plate carree (x = lon, y = -lat) purely so that placing a pin
stays a subtraction and a divide. Anything prettier -- Robinson, Natural
Earth II -- would mean projecting every pin in Python and regenerating the
data file whenever a place is added, which is a bad trade for a page whose
whole point is that you can add a line of YAML to it.

Antarctica is dropped: it is a third of the map's height, nobody has a pin
there, and the seventh continent is tracked as a chip on the page instead.

Usage
-----
    python3 scripts/build_world_map.py
    python3 scripts/build_world_map.py --tolerance 0.4   # smaller, coarser

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

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SVG_PATH = os.path.join(ROOT, "_includes", "world-map.svg")
META_PATH = os.path.join(ROOT, "_data", "world_map.yml")


def iso_for(row):
    """A stable, unique element id for a country."""
    iso = (row.get("iso_a3") or "").strip()
    if iso and iso != "-99":
        return iso
    name = (row.get("name") or "").strip()
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


def build(tolerance, min_area, precision):
    import geopandas  # imported late so --help works without the dependency

    world = geopandas.read_file(
        geopandas.datasets.get_path("naturalearth_lowres"))
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


def render_svg(entries, bounds, precision):
    lon_min, lon_max, lat_min, lat_max = bounds
    width = lon_max - lon_min
    height = lat_max - lat_min

    lines = [
        "<!-- Generated by scripts/build_world_map.py -- do not edit by hand.",
        "     Natural Earth 1:110m admin 0 countries (public domain), plate carree.",
        "     Country fills are set by the <style> block on the page that includes",
        "     this, keyed on the id below. -->",
        f'<svg class="world" xmlns="http://www.w3.org/2000/svg"',
        f'     viewBox="{lon_min:.2f} {-lat_max:.2f} {width:.2f} {height:.2f}"',
        '     preserveAspectRatio="xMidYMid meet" role="img"',
        '     aria-label="World map with visited countries highlighted">',
        '  <g class="land">',
    ]
    for entry in entries:
        name = (entry["name"].replace("&", "&amp;")
                .replace("<", "&lt;").replace(">", "&gt;")
                .replace('"', "&quot;"))
        lines.append(
            f'    <path id="c-{entry["id"]}" data-name="{name}" d="{entry["path"]}"/>')
    lines.append("  </g>")
    lines.append("</svg>")
    return "\n".join(lines) + "\n"


def render_meta(entries, bounds):
    lon_min, lon_max, lat_min, lat_max = bounds
    return (
        "# Generated by scripts/build_world_map.py -- do not edit by hand.\n"
        "#\n"
        "# The bounding box of _includes/world-map.svg, in degrees. The travel\n"
        "# page turns a lat/lon into a percentage offset with these, so they have\n"
        "# to stay in step with the viewBox the SVG was written with.\n"
        f"lon_min: {lon_min:.4f}\n"
        f"lon_max: {lon_max:.4f}\n"
        f"lat_min: {lat_min:.4f}\n"
        f"lat_max: {lat_max:.4f}\n"
        f"width: {lon_max - lon_min:.4f}\n"
        f"height: {lat_max - lat_min:.4f}\n"
        f"countries: {len(entries)}\n"
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
    # The map renders about 700px wide, i.e. ~2px per degree of longitude, so
    # 0.4 deg of simplification is under a pixel of error. Finer tolerances
    # cost real bytes and are invisible.
    ap.add_argument("--tolerance", type=float, default=0.4,
                    help="Douglas-Peucker tolerance in degrees (default 0.4)")
    ap.add_argument("--min-area", type=float, default=0.02,
                    help="drop polygons smaller than this, in square degrees "
                         "(default 0.02, which keeps Mauritius and loses reefs)")
    ap.add_argument("--precision", type=int, default=2,
                    help="decimal places kept per coordinate (default 2, "
                         "about 1 km at the equator)")
    args = ap.parse_args(argv)

    entries, bounds = build(args.tolerance, args.min_area, args.precision)
    svg = render_svg(entries, bounds, args.precision)
    write_atomic(SVG_PATH, svg)
    write_atomic(META_PATH, render_meta(entries, bounds))

    print(f"{len(entries)} countries, {len(svg) / 1024:.0f} KB "
          f"-> {os.path.relpath(SVG_PATH, ROOT)}")
    print(f"bbox lon [{bounds[0]:.1f}, {bounds[1]:.1f}] "
          f"lat [{bounds[2]:.1f}, {bounds[3]:.1f}] "
          f"-> {os.path.relpath(META_PATH, ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
