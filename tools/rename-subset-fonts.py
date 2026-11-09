"""Rename bundled subsets without changing glyphs or copyright/license metadata.

Requires fonttools[woff]==4.61.1. Run on the original files from the git parent
of the font-licensing change to reproduce the renamed fonts. Original, renamed
and name-independent content hashes are recorded in third_party/fonts.json;
this script writes the file hashes and the upstream content fingerprint
(originalContentSha256), then invokes
`node tools/check-subset-fonts.mjs --update` to record the renamed content
hash and verify it against the upstream fingerprint. Existing asset filenames
identify the upstream family, which is recorded per manifest entry as
`family`; the font's primary names are Audivane Sans/Mono Latin.
"""
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
CHECK_SCRIPT = ROOT / "tools/check-subset-fonts.mjs"

node = shutil.which("node")
if node is None:
    raise SystemExit(
        "node is required to read the check constants, record the content "
        "fingerprints and verify the result"
    )

# The font directories and the rewritten name-record IDs are read from
# tools/check-subset-fonts.mjs, the single source of truth shared by both
# tools. Keeping them as local mirrors would let the two tools drift apart.
constants = json.loads(subprocess.run(
    [node, "--input-type=module", "--eval", (
        'import { pathToFileURL } from "node:url";\n'
        'const { FONT_DIRECTORIES: directories,'
        ' RENAMED_NAME_IDS: renamedNameIds }'
        ' = await import(pathToFileURL(process.env.AUDIVANE_FONT_CHECK_MJS));\n'
        'process.stdout.write(JSON.stringify({ directories, renamedNameIds }));'
    )],
    check=True, capture_output=True, text=True,
    env={**os.environ, "AUDIVANE_FONT_CHECK_MJS": str(CHECK_SCRIPT)},
).stdout)
DIRECTORIES = constants["directories"]
# Name records that identify the family: family (1), unique (3), full (4),
# PostScript (6), compatible family/subfamily (18/21), and WWS
# family/subfamily (16/25).
RENAME_NAME_IDS = tuple(constants["renamedNameIds"])


def family(path: Path) -> str:
    # Asset filenames identify the upstream family; manifest.families lists
    # the two allowed names and tools/check-subset-fonts.mjs validates the
    # record against them.
    if "-mono-" in path.name:
        return "Audivane Mono Latin"
    return "Audivane Sans Latin"


with tempfile.TemporaryDirectory() as tmp:
    fonts = []
    for directory in DIRECTORIES:
        for path in sorted((ROOT / directory).glob("*.woff2")):
            fonts.append((path, TTFont(path, recalcTimestamp=False)))

    # Guard every font before rewriting any, so an already renamed file
    # anywhere aborts the run before a single original is modified in place.
    for path, font in fonts:
        if any("Audivane" in record.toUnicode()
               for record in font["name"].names if record.nameID == 1):
            raise SystemExit(f"{path}: use original pre-rename fonts, not already renamed outputs")

    stash = Path(tmp) / "originals"
    records = []
    for path, font in fonts:
        original = path.read_bytes()
        stashed = stash / path.relative_to(ROOT)
        stashed.parent.mkdir(parents=True, exist_ok=True)
        stashed.write_bytes(original)
        for record in font["name"].names:
            if record.nameID in RENAME_NAME_IDS:
                name = record.toUnicode()
                name = name.replace("IBM Plex", "Audivane").replace("IBMPlex", "Audivane")
                # Explicitly identify these as Latin subsets.
                name = name.replace("Sans", "Sans Latin" if " " in name else "SansLatin")
                name = name.replace("Mono", "Mono Latin" if " " in name else "MonoLatin")
                record.string = name.encode(record.getEncoding())
        font.save(path)
        records.append({
            "path": str(path.relative_to(ROOT)),
            "family": family(path),
            "originalSha256": hashlib.sha256(original).hexdigest(),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        })

    fingerprints = subprocess.run(
        [node, str(CHECK_SCRIPT), "--fingerprint",
         *[str(stash / record["path"]) for record in records]],
        check=True, capture_output=True, text=True,
    ).stdout.splitlines()
    if len(fingerprints) != len(records):
        raise SystemExit("fingerprint output does not match the stashed original files")
    for record, line in zip(records, fingerprints):
        digest, _, stashed_path = line.partition("  ")
        if stashed_path != str(stash / record["path"]):
            raise SystemExit(f"fingerprint output out of order: {line}")
        record["originalContentSha256"] = digest

(ROOT / "third_party/fonts.json").write_text(json.dumps({
    "license": "OFL-1.1",
    "families": ["Audivane Sans Latin", "Audivane Mono Latin"],
    "tool": "fonttools[woff]==4.61.1",
    "files": records,
}, indent=2) + "\n")
subprocess.run([node, str(CHECK_SCRIPT), "--update"], check=True)
