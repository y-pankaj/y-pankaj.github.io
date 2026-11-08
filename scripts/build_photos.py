#!/usr/bin/env python3
"""Web-sized copies and thumbnails of the photos on /travel/ and /side-quests/.

Camera originals go in ``_photos/``, laid out the way they will be under
``assets/images/``. So ``_photos/travel/kuari-ridge.jpg`` becomes

    assets/images/travel/kuari-ridge.jpg       at most 1600px on the long side
    assets/images/travel/480/kuari-ridge.jpg   480px wide, for the photo tiles
                                               and the map's hover card

and the YAML points at the first: ``src: /assets/images/travel/kuari-ridge.jpg``.
The tiles find the thumbnail on their own (see _includes/photo-tile.html).

It also writes ``_data/photo_sizes.yml``, every photo's width and height,
because Liquid cannot open an image and the film roll on /travel/ sizes each
frame to its photo's shape. ``--sizes`` rewrites just that file, from the
copies already in assets/images, without needing the originals.
``_photos/`` is gitignored and Jekyll skips it for its leading underscore, so
the originals never leave your machine.

Both copies are re-encoded with no metadata. Phone photos carry the GPS
position they were taken at, and a photo taken at home would otherwise publish
where home is. The orientation tag goes with the rest, so it is applied to the
pixels first.

Run it after adding photos; it skips any copy newer than its original.

    python3 scripts/build_photos.py
    python3 scripts/build_photos.py --check   # GPS already in assets/images?
    python3 scripts/build_photos.py --sizes   # only _data/photo_sizes.yml

JPEG, PNG and WebP in. HEIC, the iPhone default, needs the pillow-heif plugin,
or exporting as JPEG first.
"""

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "_photos"
DEST = ROOT / "assets" / "images"
SIZES = ROOT / "_data" / "photo_sizes.yml"

LONG_SIDE = 1600
THUMB_WIDTH = 480
THUMB_DIR = "480"
EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}

GPS_TAG = 34853   # EXIF GPSInfo


def save(image, path, quality, icc):
    """Write a JPEG with nothing in it but pixels and a colour profile."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(".tmp-" + path.name)
    try:
        options = {"quality": quality, "optimize": True, "progressive": True}
        if icc:
            options["icc_profile"] = icc
        image.save(tmp, "JPEG", **options)
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def build_one(original, source, dest, force):
    from PIL import Image, ImageOps

    relative = original.relative_to(source).with_suffix(".jpg")
    web = dest / relative
    thumb = dest / relative.parent / THUMB_DIR / relative.name
    newest = original.stat().st_mtime
    if not force and all(p.exists() and p.stat().st_mtime >= newest
                         for p in (web, thumb)):
        return None

    with Image.open(original) as raw:
        icc = raw.info.get("icc_profile")
        image = ImageOps.exif_transpose(raw).convert("RGB")

    big = image.copy()
    big.thumbnail((LONG_SIDE, LONG_SIDE), Image.LANCZOS)
    save(big, web, 82, icc)

    height = round(image.height * THUMB_WIDTH / image.width)
    small = image.resize((THUMB_WIDTH, max(1, height)), Image.LANCZOS)
    save(small, thumb, 78, icc)
    return web, thumb


def check(dest):
    """List images under assets/images that still carry a GPS position."""
    from PIL import Image

    found = []
    for path in sorted(dest.rglob("*")):
        if path.suffix.lower() not in (".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"):
            continue
        try:
            with Image.open(path) as image:
                if image.getexif().get(GPS_TAG):
                    found.append(path)
        except OSError:
            continue
    for path in found:
        print(f"GPS position in {path}")
    if not found:
        print(f"no GPS positions in {dest}")
    return 1 if found else 0


def site_path(path, dest):
    """/assets/images/travel/x.jpg, for a file under `dest`."""
    try:
        return "/" + path.relative_to(ROOT).as_posix()
    except ValueError:   # a --dest outside the repo stands in for assets/images
        return "/assets/images/" + path.relative_to(dest).as_posix()


def write_sizes(dest, out):
    """Record the size of every web copy that has a thumbnail beside it.

    Those are the photos this script made, which is the set the photo tiles
    and the film roll use. Keys are site paths, as the YAML writes `src`.
    """
    from PIL import Image

    sizes = {}
    for thumb in sorted(dest.rglob(f"{THUMB_DIR}/*.jpg")):
        web = thumb.parent.parent / thumb.name
        if not web.is_file():
            continue
        with Image.open(web) as image:
            sizes[site_path(web, dest)] = image.size

    lines = [
        "# Written by scripts/build_photos.py -- run it again rather than editing.",
        "# The width and height of each photo, which Liquid cannot read for itself.",
        "",
    ]
    lines += [f"{json.dumps(path)}: [{w}, {h}]" for path, (w, h) in sizes.items()]
    text = "\n".join(lines) + "\n"
    if not out.exists() or out.read_text() != text:
        out.write_text(text)
    print(f"{len(sizes)} photo sizes in {out.relative_to(ROOT)}")


def main(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--force", action="store_true",
                    help="rebuild every copy, not just the stale ones")
    ap.add_argument("--check", action="store_true",
                    help="only report published images that carry GPS data")
    ap.add_argument("--sizes", action="store_true",
                    help=f"only rewrite {SIZES.relative_to(ROOT)} from the copies")
    ap.add_argument("--originals", type=Path, default=SOURCE,
                    help=f"where the originals are (default {SOURCE.relative_to(ROOT)})")
    ap.add_argument("--dest", type=Path, default=DEST,
                    help=f"where the copies go (default {DEST.relative_to(ROOT)})")
    args = ap.parse_args(argv)
    source, dest = args.originals.resolve(), args.dest.resolve()

    try:
        import PIL  # noqa: F401
    except ImportError:
        raise SystemExit("needs Pillow: python3 -m pip install Pillow")

    if args.check:
        return check(dest)
    if args.sizes:
        write_sizes(dest, SIZES)
        return 0
    if not source.is_dir():
        raise SystemExit(f"no {source}/ -- put the originals there")

    built = skipped = 0
    for original in sorted(source.rglob("*")):
        if original.suffix.lower() not in EXTENSIONS or original.name.startswith("."):
            continue
        out = build_one(original, source, dest, args.force)
        if out is None:
            skipped += 1
            continue
        built += 1
        web, thumb = out
        print(f"{original.relative_to(source)} -> {web.relative_to(dest)} "
              f"({web.stat().st_size / 1024:.0f} KB), "
              f"{thumb.relative_to(dest)} ({thumb.stat().st_size / 1024:.0f} KB)")
    print(f"{built} built, {skipped} up to date")
    write_sizes(dest, SIZES)
    return 0


if __name__ == "__main__":
    sys.exit(main())
