"""Wrap DDW Drum Rack Generator.maxpat in a real Max for Live MIDI-effect .amxd (ampf).

Adapted from Live Actions Helper's bridge/pack-amxd.py (verified pattern: an
.amxd is just a small binary header wrapping the patcher's JSON as UTF-8).
That device is an audio effect ("aaaa"); this one is a MIDI effect ("mmmm")
so it can live on a MIDI track and pass MIDI through to the Drum Rack below
it. The fourcc is computed from the literal bytes rather than hand-typed as
a magic int, so there is no risk of transcribing the wrong 32-bit value.
"""

from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MAXPAT = HERE / "DDW Drum Rack Generator.maxpat"
AMXD = HERE / "DDW Drum Rack Generator.amxd"

MIDI_EFFECT_FOURCC = b"mmmm"
MIDI_EFFECT = int.from_bytes(MIDI_EFFECT_FOURCC, "big")


def pack(src: Path = MAXPAT, dest: Path = AMXD) -> Path:
    data = json.loads(src.read_text(encoding="utf-8"))
    patcher = data.setdefault("patcher", {})
    patcher["devicewidth"] = float(patcher.get("devicewidth") or 420.0)
    project = patcher.setdefault("project", {})
    project.setdefault("version", 1)
    project["amxdtype"] = MIDI_EFFECT
    project.setdefault("devpath", ".")
    project.setdefault("devpathtype", 0)
    payload = json.dumps(data, indent=2).encode("utf-8")
    header = (
        b"ampf"
        + struct.pack("<I", 4)
        + MIDI_EFFECT_FOURCC
        + b"meta"
        + struct.pack("<I", 4)
        + struct.pack("<I", 0)
        + b"ptch"
        + struct.pack("<I", len(payload))
    )
    dest.write_bytes(header + payload)
    return dest


if __name__ == "__main__":
    out = pack()
    print("Wrote", out, "(%d bytes, amxdtype=%d / %r)" % (out.stat().st_size, MIDI_EFFECT, MIDI_EFFECT_FOURCC))
    sys.exit(0)
