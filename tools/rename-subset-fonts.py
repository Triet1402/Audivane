"""Rename bundled subsets without changing glyphs or copyright/license metadata.

Requires fonttools[woff]==4.61.1. Run on the original files from the git parent
of the font-licensing change to reproduce the renamed fonts. Original and output
hashes are recorded in third_party/fonts.json. Existing asset filenames identify
the upstream family; the font's primary names are Audivane Sans/Mono Latin.
"""
import hashlib
import json
from pathlib import Path

from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
DIRECTORIES = [
    "apps/client/src/assets/fonts",
    "apps/landing/public/fonts",
    "website/public/fonts",
]
records = []
for directory in DIRECTORIES:
    for path in sorted((ROOT / directory).glob("*.woff2")):
        original = path.read_bytes()
        font = TTFont(path, recalcTimestamp=False)
        if any("Audivane" in record.toUnicode() for record in font["name"].names if record.nameID == 1):
            raise SystemExit("Use original pre-rename fonts, not already renamed outputs")
        for record in font["name"].names:
            if record.nameID in (1, 3, 4, 6, 16, 18, 21, 25):
                name = record.toUnicode()
                name = name.replace("IBM Plex", "Audivane").replace("IBMPlex", "Audivane")
                # Explicitly identify these as Latin subsets.
                name = name.replace("Sans", "Sans Latin" if " " in name else "SansLatin")
                name = name.replace("Mono", "Mono Latin" if " " in name else "MonoLatin")
                record.string = name.encode(record.getEncoding())
        font.save(path)
        records.append({
            "path": str(path.relative_to(ROOT)),
            "originalSha256": hashlib.sha256(original).hexdigest(),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        })
(ROOT / "third_party/fonts.json").write_text(json.dumps({
    "license": "OFL-1.1",
    "families": ["Audivane Sans Latin", "Audivane Mono Latin"],
    "derivedFrom": "IBM Plex Sans and IBM Plex Mono; bundled Latin subsets",
    "modification": "Renamed primary font metadata only; glyphs unchanged.",
    "tool": "fonttools[woff]==4.61.1",
    "files": records,
}, indent=2) + "\n")
