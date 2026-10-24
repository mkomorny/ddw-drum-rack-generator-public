# DDW Drum Rack Generator

A Max for Live MIDI-effect device that categorizes your sample packs by
filename and builds/rerolls a 16-pad Drum Rack from them, without ever
leaving Live.

Clean-room rebuild of the Windward "Drum Rack Generator" concept — own
implementation and own code throughout, built from the publicly
described behavior, not from the original device (which this project
does not have a copy of).

## Install

1. Copy `device/DDW Drum Rack Generator.amxd` and all of the `device/drg-*.js`
   files into the same folder in your User Library (e.g. a `Devices`
   folder at the top level of your User Library, or the standard
   `/User Library/Presets/MIDI Effects/Max MIDI Effect/` location). The
   `.js` files **must** sit next to the `.amxd` — it loads them by
   filename at runtime. If you deploy to more than one User Library
   location, `python device/deploy.py` copies to every location it knows
   about in one run — see "Rebuilding the device" below; editing this
   repo alone never changes what Live loads.
2. Requires **Ableton Live 12.4+** (needs `SimplerDevice.replace_sample`,
   only available from 12.4) and Max for Live.

## Use

1. Drag the device onto a MIDI track. It builds a Drum Rack automatically
   if the track is empty; if the track already has a different
   instrument, it asks before replacing it (never deletes silently).
2. Open the folder tab (leftmost rail icon) and either drag sample-pack
   folders from Explorer/Finder into the dashed box, or click it to
   browse. Folders are scanned recursively; adding more packs is
   cumulative.
3. Switch to the categorization tab to see and edit each category's
   keyword aliases and maximum sample length. "Reset to default" restores
   the built-in list for the category currently shown.
4. Switch to the Types tab to choose which content is eligible for pads.
   A dropdown at the top selects one of three **exclusive** modes --
   One-Shots, Loops, or Other -- only the active mode's content is
   eligible until you switch modes. Each mode shows its own subcategory
   checklist (with a live count of how many loaded samples carry it) and
   its own max-duration stepper:
   - **One-Shots**: Kicks & 808s, Snares & Rims, Claps & Snaps, Hi-Hats,
     Toms, Perc & Shakers, Cymbals -- grouped from the same pad-role
     categories the grid itself uses.
   - **Loops**: Full Drum Loops, Top Loops (No Kick), Percussion Loops,
     Bass & 808 Loops, Drum Fills & Rolls, Breaks & Vintage Chops. Its
     max-duration stepper is bar-based (default 4 Bars / 8000ms, steps by
     1 Bar / 2000ms) rather than plain milliseconds like the other two
     modes.
   - **Other**: FX/Sweeps/Risers, Atmospheres & Vinyl, Tonal Chords &
     Stabs, Vocal Chops & Glitches, Wet/Processed Tails, and Unclassified
     Filenames (samples that match neither a role nor any other-family
     tag).

   Content type is decided by the sample's **filename** only, never its
   folder -- so a one-shot named after its parent loop (a common "stems
   pack" pattern) is judged on its own name, not the folder it ships in.
   A file carrying more than one subcategory tag needs every one of them
   switched on. Files named as MIDI are never eligible, with no switch.
   Turning every subcategory in a mode off is reported explicitly rather
   than just leaving every pad empty with no explanation.
5. Back on the grid: click a pad's dice icon to reroll just that pad
   (it auto-plays the new sample if the audition toggle is on), the
   lock icon to protect a pad from rerolling, or "Reroll all" to
   regenerate every unlocked pad at once. Click a pad's category label
   to reassign what it draws from.
6. The info tab shows how many candidate samples were found per
   category — a pad reporting empty means that category found nothing
   in your loaded packs (or that your Types filters excluded everything
   that would have matched), never a silent failure.

## What this is not

- Not a port of the original Windward device, and not a factory-preset
  or `.adg`-rack browser — there is no `Browser`/`BrowserItem` class
  exposed to Max for Live, so nothing here can walk Live's own browser.
  It only ever builds from sample files already on disk.
- No Ableton Push or Move/Note export in this version (the user of this
  build owns neither). Move/Note export is planned for a later pass —
  `-_Feature.ExportPresetsToAbl` just needs to already be set in your
  `Options.txt` when that lands.
- Never clears and rebuilds an existing Drum Rack. Rerolling replaces
  the sample on a pad's existing Simpler and leaves everything else on
  that chain (FX, choke groups, sends) intact.

## Project layout

```
device/
  DDW Drum Rack Generator.maxpat   authored patch, JSON
  DDW Drum Rack Generator.amxd     packed device (built by pack-amxd.py)
  drg-ui.js                        the whole device: state, LiveAPI, drawing, hit-testing
  drg-classify.js                  segment-matching classifier (pure, no Max dependency)
  drg-duration.js                  WAV/AIFF/FLAC header duration parsing (pure)
  drg-scan.js                      chunked, pruning directory walker (pure)
  pack-amxd.py                     wraps the .maxpat JSON into a real .amxd
  deploy.py                        repacks + copies the device to every deployed User Library location
test/
  run.js                           classifier/duration/scan unit tests (plain node)
  smoke-ui.js                      drg-ui.js smoke test against stubbed Max globals
  fixtures/                        generated WAV/AIFF/FLAC test audio
```

## Rebuilding the device after editing the .js files

```bash
python "device/deploy.py"
```

This repacks the `.amxd` from the current `.maxpat` **and copies the
`.amxd` plus every `drg-*.js` file to every deployed User Library
location** it knows about (see `DEPLOY_TARGETS` in `device/deploy.py` —
add a path there if you deploy somewhere new). Editing the files in this
repo alone changes nothing Live can see; only a file that has actually
been copied into a User Library location Live is loading from does.
`python "device/pack-amxd.py"` alone still works if you only need the
`.amxd` rebuilt in place in this repo, without deploying anywhere.

Then in Live: **delete the device instance from the track and drag a
fresh copy in** from one of the deployed folders — Max caches a loaded
`jsui` script per instance, and reopening a Set or re-selecting an
existing instance does not reliably pick up a changed script the way
dragging a brand-new instance does.

## Running the tests

```bash
node test/run.js
node test/smoke-ui.js
```
