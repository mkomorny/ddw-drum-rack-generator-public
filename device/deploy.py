"""Repack the .amxd and deploy the device to every place Live actually loads it from.

THIS SCRIPT IS THE FIX FOR THE BUG THAT COST v0.2.0/v0.3.0/v0.3.1 THREE
WASTED PASSES: editing device/*.js in this repo was never enough, because
Ableton Live does not load the device from the repo. It loads from wherever
the user dragged the .amxd into their User Library -- on this machine, two
separate copies, found to have silently diverged from each other and from
this repo:

    A:\\User Library\\Max Devices\\Drum Rack Generator\\
    A:\\User Library\\Presets\\MIDI Effects\\Drum Rack Generator\\

The second one was still running a pre-v0.3.0 debug build (with
DRG-DEBUG post() tracing still in it) the entire time every later pass was
being "verified" against it. This script closes that gap for good: it
repacks the .amxd from the current .maxpat, then copies the .amxd, .maxpat,
and every drg-*.js file to BOTH deployed locations, every time. Copying to
both -- rather than picking "the right one" -- is deliberate: divergence
between copies is what caused this, and syncing both every run makes it
impossible for them to drift again.

Run this after every code change, before asking the user to test in Live:

    python device/deploy.py

Then in Live: delete the device instance from the track and drag a FRESH
copy in from one of the deployed folders above (Max caches a loaded jsui
script per instance -- reopening a Set or re-selecting an existing instance
does not always pick up a changed script; a fresh drag always does).
"""

from __future__ import annotations

import importlib.util
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# pack-amxd.py has a hyphen in its filename, so it can't be a plain
# `import pack_amxd` -- load it by file path instead.
_spec = importlib.util.spec_from_file_location("drg_pack_amxd", HERE / "pack-amxd.py")
pack_amxd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pack_amxd)

SOURCE_FILES = [
    "DDW Drum Rack Generator.amxd",
    "DDW Drum Rack Generator.maxpat",
    "drg-classify.js",
    "drg-duration.js",
    "drg-scan.js",
    "drg-ui.js",
    "pack-amxd.py",
]

DEPLOY_TARGETS = [
    Path("A:/User Library/Max Devices/Drum Rack Generator"),
    Path("A:/User Library/Presets/MIDI Effects/Drum Rack Generator"),
]


def deploy() -> int:
    out = pack_amxd.pack()
    print("Repacked %s (%d bytes)" % (out, out.stat().st_size))

    any_target_missing = False
    for target in DEPLOY_TARGETS:
        if not target.is_dir():
            print("SKIPPED (directory does not exist): %s" % target)
            any_target_missing = True
            continue
        for name in SOURCE_FILES:
            src = HERE / name
            if not src.is_file():
                print("  ! missing source file, not copied: %s" % src)
                continue
            dest = target / name
            shutil.copy2(src, dest)
        print("Deployed to %s" % target)

    # Sanity check: a debug build should never go back out. This is exactly
    # the class of drift that caused the original bug (a stale build with
    # DRG-DEBUG tracing still in it sat undetected in one of these folders
    # for three passes) -- catch it here instead of relying on someone
    # noticing later.
    for target in DEPLOY_TARGETS:
        deployed_ui = target / "drg-ui.js"
        if deployed_ui.is_file():
            text = deployed_ui.read_text(encoding="utf-8", errors="replace")
            if "DRG-DEBUG" in text:
                print("WARNING: deployed drg-ui.js at %s still contains DRG-DEBUG tracing." % target)

    if any_target_missing:
        print("\nOne or more deploy targets do not exist on this machine -- fix DEPLOY_TARGETS in this script.")
        return 1

    print("\nDone. In Live: delete the device instance from the track and drag a FRESH copy")
    print("in from one of the folders above -- Max caches a loaded script per instance.")
    return 0


if __name__ == "__main__":
    sys.exit(deploy())
