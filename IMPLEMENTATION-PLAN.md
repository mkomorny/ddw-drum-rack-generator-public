# DDW Drum Rack Generator — Implementation Plan

Clean-room rebuild of the Windward "Drum Rack Generator" concept (a paid
Max for Live device, `liveextensions.co`) as our own standalone `.amxd`.
Own implementation throughout — no code or assets from the original
device, which is not present on this machine. Built from the behavior
described in `Manual - Drum Rack Generator.pdf` plus the product pages.

Supersedes the earlier `DRUM-RACK-GENERATOR-IMPLEMENTATION-PLAN.md`
(v4, 2026-08-20, in `My Apps/`), which designed this as a Live Actions
Helper tool with a Python host + OSC bridge. That architecture is
dropped; its peer-reviewed classifier design (segment matching, plural
normalization, the 36–51 pad map) carries over unchanged into this
device.

## Decisions locked with the user

| # | Decision |
|---|---|
| A | Standalone `.amxd` MIDI-effect device. No Python host, no OSC bridge. |
| B | v1 scope: ingestion + categorization, and the 4×4 grid with reroll/lock. |
| C | No Push, no Move (user owns neither). |
| D | Note/Move export is a later pass. |
| E | Layout: faithful three-panel (tab rail │ status/mid │ 4×4 grid). |
| F | Audition on single-pad reroll, with an on/off toggle. |
| G | Ask before replacing a non-Drum-Rack instrument; never silently delete. |
| H | New private GitHub repo (`mkomorny/ddw-drum-rack-generator`). |

## Architecture

Code-first: the `.maxpat` is authored as JSON, packed into a real
`.amxd` by `device/pack-amxd.py` (adapted from Live Actions Helper's
`bridge/pack-amxd.py`, `"aaaa"` → `"mmmm"` for a MIDI effect). No Max
GUI patching involved.

One `jsui` object (`drg-ui.js`) owns everything: state, LiveAPI
orchestration, persistence, drawing, and mouse hit-testing. This is a
deliberate departure from the original plan's separate `js` (logic) +
`jsui` (drawing) split — discovered during implementation that each
`js`/`jsui` instance in Max runs its own JS context with no shared
globals, so a two-object split would need real Max messaging for every
single UI interaction. `dropfile`, `opendialog folder`, and `textedit`
remain as real neighboring objects (jsui can do none of drag-and-drop,
folder dialogs, or editable text), tagged with `prepend` on their patch
cords so the jsui's single inlet can tell them apart.

Three pure, Max-independent modules run identically under plain `node`
(tests) and inside Max's `js` engine (via `include()`):
`drg-classify.js`, `drg-duration.js`, `drg-scan.js`.

## Status — v0.1.1 (this pass)

- ✅ done in v0.1.0 — Segment-matching classifier: whole-segment matching,
  plural normalization, folder-beats-filename scoring, exclusion list,
  last-resort `808`→kick tier, 14 categories (11 predefined + 3 blank
  user slots — shaker/tambourine folded into "perc" so the 16-pad map's
  11 distinct category ids reconciles exactly to the manual's 11+3).
- ✅ done in v0.1.0 — WAV/AIFF/FLAC duration parsing from file headers
  (no audio decoding). MP3/OGG return "unknown", counted separately,
  never guessed or silently dropped.
- ✅ done in v0.1.0 — Chunked, pruning directory scanner (dot-dirs,
  `node_modules`, `unins*`, etc. skipped; runs in ~200-file steps via a
  Max `Task` so Live's UI stays responsive).
- ✅ done in v0.1.0 — Drum Rack acquisition: adopt an existing rack
  (detected via `can_have_drum_pads`, not a guessed `class_name`
  string), create one if the track has no instrument, ask-before-replace
  (via an in-panel confirm click) if it has a different instrument.
- ✅ done in v0.1.0 — Pad write, adapted from the proven
  `palAssignPadSample()` pattern in Live Actions Helper's
  `bridge/live-actions-pal.js`: chain lookup by `in_note` first, never
  by assumed index; insert Simpler; `replace_sample`; best-effort
  `choke_group`/`playback_mode`/warp-off settings pass, independent
  per-write.
- ✅ done in v0.1.0 — 4×4 pad grid: per-pad category (with per-pad
  override), lock, reroll (with audition + toggle), Reroll All, status
  bar. Folder tab (drag-drop + click-to-browse + pack list). Info tab
  (per-category candidate counts). Categorization tab (alias
  replacement, max-length stepper, reset-to-default).
- ✅ done in v0.1.0 — Persistence: per-instance pad state via the
  documented `save()`/`embedmessage()` hook; global pack list and
  category definitions via a JSON file next to the `.amxd`
  (`Patcher.filepath`-derived, not `%APPDATA%` — see dev notes).
- ✅ done in v0.1.0 — 22 classifier/duration/scan unit tests (`test/run.js`)
  and 10 jsui smoke tests against stubbed Max globals (`test/smoke-ui.js`),
  all green under plain Node.
- ✅ done in v0.1.1 — First real in-Live load surfaced three genuine bugs,
  all fixed and verified against the actual running device (not just unit
  tests):
  - `jsui`'s script-declared `outlets = 2` wasn't reliably honored on a
    hand-packed (never Max-UI-saved) `.amxd`, causing Max to report
    "patchcord outlet out of range" and misroute audition note data into
    `opendialog`. Fixed by collapsing to a single tagged outlet, sorted in
    the patch by a `[route openfolder note]` object -- the same
    prepend/route pattern already used for jsui's inputs, so no dynamic
    outlet count is relied on at all.
  - The `jsui` box's `@filename` was only ever embedded in the box's
    `text` string, which is not reliably re-parsed when a `.maxpat` is
    loaded from a saved file rather than typed live into Max's editor. Max
    for Live's own `Live Actions Bridge.maxpat` (proven, shipped) stores
    this via an explicit `saved_object_attributes.filename` key instead --
    added the same key to our `jsui` box.
  - **The actual panel-never-renders bug**: `paint()` was never being
    called at all -- confirmed via temporary `post()` tracing showing
    `bang()` and `refresh()` both ran, but `paint()` never logged. Root
    cause: the required `mgraphics.init()` top-level call (documented at
    <https://docs.cycling74.com/max8/vignettes/jsmgraphics>) was missing.
    Without it, `mgraphics.redraw()` silently no-ops forever. One line
    fixed the entire "blank white panel" symptom.
  - **A real wiring bug in our own code**, independent of any Max quirk:
    `drg-scan.js`'s documented contract is `adapter.listDir(path)` -- an
    object with a method -- but `drg-ui.js` passed `maxFolderAdapter`
    directly as a bare function. Every directory visit threw
    `adapter.listDir is not a function`, silently caught by the scanner's
    "unreadable directory, skip" handler, so every scan reported done
    immediately with zero results regardless of folder contents. This
    slipped through both test files because `test/run.js` exercises
    `drg-scan.js` with a correctly-shaped fake adapter, and
    `smoke-ui.js` never drove the real scan pipeline end-to-end. Fixed by
    wrapping: `{ listDir: maxFolderAdapter }`. A new regression test
    (`test/smoke-ui.js`, "folderdrop scans a real nested tree...") drives
    `folderdrop()` against a stateful fake `Folder` global and asserts
    real files are found -- confirmed to fail on the old code and pass on
    the fix.
  - Verified live afterward: the full three-panel UI renders correctly
    (tab rail, folder panel, status, 4x4 grid with correct pad-map
    labels); Drum Rack auto-creation on an empty track works
    ("Using Default Preset Drum Rack.adg"); the folder click-to-browse
    path opens a real OS folder dialog end-to-end through the new
    single-outlet/route wiring; a real 67-file sample pack was scanned
    correctly (not the old "0 samples" failure), and a non-drum (horror
    SFX) pack correctly reported "0 pads loaded, 16 empty (no matching)"
    rather than mis-assigning anything -- honest-empty behavior working
    as designed.
  - Not yet re-verified live this pass: a pack with actual drum-named
    files landing on the correct pads (already covered by 22 passing
    classifier unit tests, just not re-confirmed inside Live itself);
    lock/reroll-one/audition-toggle interaction; Set save/reload
    persistence; the out-of-order pad-assignment regression (P5).
- ⬜ not yet done — Note/Move export conversion (decision D). Options.txt
  already has `-_Feature.ExportPresetsToAbl` enabled on this machine, so
  that pass is unblocked whenever it's picked up.
- ⬜ not yet done — Push integration. Out of scope per decision C; revisit
  only if the user acquires a Push.
- ⬜ not yet done — Categorization tab's alias field doesn't sync its
  displayed content to the currently-selected category (jsui draws the
  current list as read-only text instead; the real `textedit` box is
  entry-only and replaces the whole list on Enter). Deliberate v1 trim,
  not a hidden gap — revisit if it proves annoying in practice.

- ✅ done in v0.2.0 -- Content-type filters replace the old blanket
  loop/fill/break/wet/midi/full/top path exclusion, which had a real
  failure mode: a vendor "stems" pack with one-shots named after their
  parent loop (e.g. "Seaside Drum Loop - 84 BPM Kick.wav" inside a "Loop
  Stems" folder) lost 100% of its files, because the old rule matched
  those tokens anywhere in the FULL PATH, folder names included. Tags now
  come from the FILENAME only, and each tag (loop / fill / break / wet /
  full / top / one-shots-other) has an independent on/off switch on a new
  "Types" tab, with live per-tag sample counts so a switch's cost is
  never invisible. A file carrying multiple tags is excluded if ANY of
  them is off. "midi" stays hard-excluded, no switch. Also repaired
  pre-existing breakage left by an abandoned single-toggle attempt: the
  audition checkbox's click zone had drifted out of sync with where it
  is drawn (drawn y 82-94, click zone still y 104-116) -- fixed by
  routing both the painter and onclick() through the same shared Y
  constants, and by hoisting the tab list out of two independent literal
  copies into one `TABS` array so a tab added to one can't be missed in
  the other. 18 new/updated tests (9 classifier, 9 UI/hit-test) all pass;
  see `test/run.js` and `test/smoke-ui.js`.

## Status — v0.3.0 (this pass)

- ✅ done -- **Pad-assignment bug fix (resolves P5)**. `assignPadSample()`
  no longer assumes a newly-inserted Drum Rack chain lands at index
  `chainCount - 1`; it now diffs chain `id`s captured before/after
  `insert_chain` and locates the actual new chain by identity, falling
  back to the old index-based guess only if that scan turns up nothing.
  Found while chasing a real pad-write bug live in Ableton (temporary
  `post()` tracing, since removed once root-caused -- same discipline as
  the v0.1.1 bug hunt).
- ✅ done -- **Types tab rebuilt as three exclusive Type modes**
  (One-Shots / Loops / Other), replacing the flat 7-toggle content-type
  list from v0.2.0. A dropdown-style label (mgraphics has no native
  `<select>`; clicking cycles the three modes) selects which mode is
  active; only that mode's content is eligible for pad-filling until
  switched. Each mode has its own subcategory checklist with live counts
  (`DrgClassify.TYPE_MODES`, single source of truth shared by drawing,
  hit-testing, and tests) and its own max-duration stepper, which layers
  as an additional ceiling on top of each category's own `maxMs` rather
  than replacing it.
  - One-Shots' 7 subcategories (Kicks & 808s, Snares & Rims, Claps &
    Snaps, Hi-Hats, Toms, Perc & Shakers, Cymbals) are grouped straight
    from the existing 11 pad-role categories -- no new classification
    code, no new alias guessing, since the role-matching engine already
    covers this axis.
  - Loops' and Other's subcategories are new content-type tags with
    best-guess filename aliases (`fx`, `atmo`, `tonal`, `vocal`, plus the
    reused `loop`/`fill`/`break`/`full`/`top`/`wet`) -- **not yet
    verified against real sample packs**, flagged for the user to review
    and correct via alias editing if a real pack's filenames don't match
    the guessed tokens.
  - `percloop`/`bassloop` are compound tags (a base loop-family tag AND a
    perc/bass/808 role token in the same filename) since single-token
    whole-segment matching can't express "a loop that is also
    percussive" as one alias.
  - The 16-pad grid, its categories, and its layout are **unchanged** --
    only the Types tab's content-type filtering was redesigned. (The
    visual mockup this was built from also showed different pad-role
    labels per note; treated as placeholder flavor text from an
    AI-generated showcase page, not a deliberate respec of the locked
    pad map.)
  - Persistence: the old `filters` config key is gone, replaced by
    `typeMode`/`modeFilters`/`modeMaxMs`. `loadGlobalConfig` merges over
    defaults key-by-key as before, so an old v0.2.0 config's unused
    `filters` key is simply ignored -- no explicit migration needed.
  - 18 new/updated classify.js tests and 6 new/updated smoke-ui.js tests
    cover the new mode gating, compound tags, mode-cycle/stepper hit
    zones, and config round-trip; see `test/run.js` and `test/smoke-ui.js`.
- ⬜ not yet done -- Loops/Other alias review against real packs (see
  above). Note/Move export (decision D) and Push integration (decision C)
  remain out of scope, unchanged from v0.1.1.

## Status — v0.3.1 (this pass)

User reload after v0.3.0 reported two problems: the panel looked
unchanged from before, and pads came up with a bare "Simpler" and no
sample loaded (visible in Live's own Drum Rack chain names).

- ✅ done -- **Real visual pass on the Types panel and pad grid**, not
  just the logic change v0.3.0 shipped. v0.3.0's redesign changed the
  *data model and interaction* (mode dropdown, subcategory switches,
  stepper) but reused the exact same flat gray drawing style as before,
  so it looked all but identical at a glance -- a real miss, not a
  misunderstanding on the user's part. Fixed:
  - The mode "dropdown" and max-duration stepper are now boxed/bordered
    controls (`mgraphics` has no native `<select>`, so this is the
    closest faithful translation) instead of bare inline text, colored
    to match the reference mockup's palette (`#15161c`/`#3d4354` for the
    dropdown, `#171820`/`#2a2e3d` for the stepper).
  - Pad grid category labels are now colored tag pills (low-alpha fill +
    full-alpha text, `CATEGORY_COLORS` in drg-ui.js) matching the
    mockup's cat-kick/cat-snare/cat-hat/cat-perc palette, replacing plain
    gray text.
  - Panel/rail/mid background shades retuned to the mockup's actual hex
    values (`#181818`/`#141414`/`#202020`) instead of the earlier
    approximations, which were visibly lighter/flatter.
- ✅ done -- **Hardened the P5 chain-index fix against a getcount() race**:
  `rack.getcount("chains")` read immediately after `insert_chain()` has
  been observed (per the user's blank-Simpler report) to potentially
  still report the pre-insert count on some Live builds, which would
  make the id-diff scan find nothing new and fall back to grabbing an
  *existing* chain by index -- silently reassigning that chain's note
  instead of the new one, while the actually-new chain sits blank.
  `assignPadSample()` now re-reads the count once if it didn't increase
  before doing the id-diff scan. This is a defensive fix, not a confirmed
  root-cause -- no running Ableton instance was available to reproduce
  the race directly (see Verification).

## Status — v0.4.0 (this pass)

Root-cause pass, prompted by the user reporting v0.3.1 changed nothing
whatsoever after a reload. It hadn't -- **Live was never loading this
repo.** It loads from wherever the .amxd was dragged into the user's
User Library, and two separate deployed copies at `A:\User Library\` had
silently diverged from this repo and from each other; one was still a
pre-v0.3.0 debug build with `DRG-DEBUG` tracing still in it. Every prior
pass's "nothing changed" reports were literally true.

- ✅ done -- **`device/deploy.py`**: repacks the `.amxd` and copies it plus
  every `drg-*.js` to *both* `A:\User Library\Max Devices\Drum Rack
  Generator\` and `A:\User Library\Presets\MIDI Effects\Drum Rack
  Generator\` every run, so the two copies can no longer drift apart.
  **A pass is not complete until this has run** -- this is the step whose
  absence invalidated three prior passes.
- ✅ done -- **Fixed the actual blank-Simpler bug**: `LiveAPI.call()` does
  not throw on failure in Max's `js` engine, so the `try/catch` around
  `simpler.call("replace_sample", ...)` could never fire; `assignPadSample`
  always returned `ok: true` and the device reported "Sample loaded." over
  an empty Simpler. `assignPadSample` now reads the Simpler's own `sample`
  child's `file_path` back after the call and only reports success if it's
  non-empty, retrying with alternate path-slash encodings first. The
  v0.3.1 chain-index race hardening is superseded by this -- it's no
  longer possible for the wrong-chain failure mode to report success
  either.
- ✅ done -- **Fixed the classification-input bug**: `reclassifyAll()` was
  passing the *absolute* scanned path as `relPath`, so `classifyFile()`'s
  folder-tier matching saw `A:`, `Samples_Packs`, `Downloaded`, `Packs`,
  ... before ever reaching the real category folder. `drg-scan.js` already
  computed a correct pack-relative path and it was being discarded;
  `STATE.allFiles` and `rankCandidates()`'s `files` now carry both
  `relPath` (classification) and `path` (what actually gets loaded).
- ✅ done -- **Fixed persisted packs never reloading their files**:
  `STATE.packs` was saved/restored across sessions but `STATE.allFiles`
  (the actual scanned file list) never was, so a reloaded device showed
  its packs in the folder list while having zero real candidates for
  every pad. `bang()` now re-walks every persisted pack's folder on
  startup via a small scan queue.
- ✅ done -- **Taxonomy corrected against the real library**: every alias
  in `DEFAULT_CATEGORIES`/`TAG_DEFS` was segment-matched against 40,000
  real filenames from the user's `A:\Samples_Packs`. Added `roll`→fill,
  `noise`→atmo, `verb`/`delay`→wet, `zap`→fx, `ftom`/`rtom`→tom, and a
  `cymbal`→crash last-resort fallback (all verified as real, non-trivial
  hits). Deliberately did **not** add `synth`/`hit` to Tonal from
  HANDOFF_SPEC.md's list -- `synth` alone matches 2300+ mostly-melodic
  files in this library and would flood Other mode.
- ✅ done -- **Fixed a real hi-hat misclassification found via that same
  data audit**: `"Hihat Open.wav"` and `"Hihat Pedal.wav"` were both
  classifying as *closed*, because longest-alias-wins picked "hihat" (6
  chars) over the actual qualifier "open"/"pedal". `hat_closed` now has a
  `genericAliases` list (`hihat`, `hat`) that only wins when no category's
  *specific* alias matched anywhere in the same tier.
- ✅ done -- **Visual pass matched to the mockup's real hex values**, not
  approximations: a `COLORS` table at the top of `drg-ui.js` now maps
  every drawn color to its exact source in
  `DDW Drum Rack Generator — Ableton Device UI (Redesigned Types Dropdown).html`
  (`#e5a93c` amber, `#181818`/`#1a1a1a`/`#202020` grounds, `#262626` pad
  surface, category tag colors, status/empty-row treatments). Added the
  locked-pad background tint (`#2a251c`) and panel/rail border strokes the
  mockup has and earlier passes never drew.
- ✅ done -- **Loops mode's stepper is bar-based** per HANDOFF_SPEC.md
  ("4 Bars / 8000ms", delta ±1 Bar/±2000ms) instead of the ±250ms it
  shipped with in v0.3.0/v0.3.1.

## Verification

Without Live: `node test/run.js && node test/smoke-ui.js` — 65 tests,
both must stay green through any future change to `device/*.js`.

**Deploy, every pass, before asking for live verification**:
`python device/deploy.py` — without this the code change never reaches
Live no matter how correct it is (see v0.4.0 above).

In Live: first real load done in v0.1.1. **Still not re-verified live**
by me -- no running Ableton instance was available during v0.3.0, v0.3.1,
or v0.4.0's development. Before considering v0.4.0 confirmed, a human at
the keyboard needs to, on a **fresh** empty track (old blank-Simpler
chains from before this fix won't self-repair): delete any existing
device instance and drag a fresh copy from
`A:\User Library\Presets\MIDI Effects\Drum Rack Generator\`, load a pack
from `A:\Samples_Packs`, and confirm Reroll All either shows real sample
names on the pads or a specific named error -- never "Sample loaded."
over a blank Simpler. Also check: each of the 3 Type modes filtering with
correct live subcategory counts, the Loops stepper showing bars, the
palette actually matching the mockup, that the pad grid's categories/
layout are unchanged, and the remaining lock/reroll-one/audition-toggle
and Set save/reload persistence probes carried over from v0.1.1.
