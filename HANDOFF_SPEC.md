# DDW Drum Rack Generator — Design & Implementation Handoff Spec

This document contains everything needed for Claude (or any AI assistant/developer) to implement the chosen **Ableton Native Sleek** UI design and the **Type Dropdown (Loops / One-Shots / Other) with Category Cut-Offs** in this codebase.

---

## 📂 Key Files in this Repository

| File Path | Role |
| :--- | :--- |
| [`preview-ui-designs.html`](file:///C:/Users/<you>/My%20Apps/Drum%20Rack%20Generator/preview-ui-designs.html) | **Interactive Visual Reference**: Full HTML/CSS mockup showing exact colors, dimensions, tab states, dropdown behavior, and 4×4 pad grid. |
| [`device/drg-ui.js`](file:///C:/Users/<you>/My%20Apps/Drum%20Rack%20Generator/device/drg-ui.js) | **Main M4L UI Controller**: Single `jsui` object using `mgraphics` for rendering and hit-testing (`paint()`, `onclick()`). |
| [`device/drg-classify.js`](file:///C:/Users/<you>/My%20Apps/Drum%20Rack%20Generator/device/drg-classify.js) | **Classifier Engine**: Pure JS logic for segmenting, tagging (`TAG_TOKENS`), and candidate ranking. |
| [`device/pack-amxd.py`](file:///C:/Users/<you>/My%20Apps/Drum%20Rack%20Generator/device/pack-amxd.py) | **Device Builder**: Packs `DDW Drum Rack Generator.maxpat` into a real `.amxd`. Run `python device/pack-amxd.py`. |
| [`test/run.js`](file:///C:/Users/<you>/My%20Apps/Drum%20Rack%20Generator/test/run.js) & [`test/smoke-ui.js`](file:///C:/Users/<you>/My%20Apps/Drum%20Rack%20Generator/test/smoke-ui.js) | **Test Suite**: Unit & smoke tests that run under plain Node (`node test/run.js`). |

---

## 🎨 Design Specification (Concept 1: Ableton Native Sleek)

### 1. Canvas Dimensions & Layout Grid (`420px × 169px`)
* **Total Width**: `420px`, **Total Height**: `169px`
* **Left Rail**: `X = 0`, `W = 20px` (or `24px`) — 4 tabs: `📁 Folders`, `🏷️ Types`, `⚙️ Rules`, `ℹ️ Info`.
* **Tab Panel**: `X = 24px`, `W = 150px` (or `190px`) — displays the active tab view.
* **Middle Column (Macro Hub)**: `W = 90px` — "🎲 Reroll All" button, sample/pack counts, audition toggle, status banner.
* **4×4 Drum Pad Grid**: Notes `36–51` (C1 to D#2) in bottom-left to top-right standard layout.

### 2. Color Tokens (Ableton Live 12 Dark Palette)
* **Background Canvas**: `rgba(0.169, 0.169, 0.169, 1)` / `#2B2B2B`
* **Panel / Cell Surface**: `rgba(0.20, 0.20, 0.20, 1)` / `#333333`
* **Pad Default Border**: `rgba(0.29, 0.29, 0.29, 1)` / `#4A4A4A`
* **Accent Gold / Amber (Active Tab, Locked Pad, Reroll Button)**: `rgba(0.878, 0.690, 0.329, 1)` / `#E0B054`
* **Locked Pad Background Tint**: `rgba(0.16, 0.14, 0.11, 1)`
* **Status Success Green**: `rgba(0.45, 0.85, 0.66, 1)`
* **Status Error / Empty Red**: `rgba(0.95, 0.44, 0.44, 1)`

---

## 🏷️ The New Type Dropdown & Category Cut-Off Engine

Instead of a flat list of tags, the **Types Tab (`🏷️`)** uses a 2-level hierarchical structure:

### Primary Dropdown State (`STATE.activeType`)
Options: `"oneshots" | "loops" | "other"`

### Subcategory Cut-offs & Duration Clamps per Type

1. **`"oneshots"`**:
   * **Subcategories**:
     * `Kicks & 808s` (aliases: `kick, kik, bd, 808`)
     * `Snares & Rims` (aliases: `snare, sd, rim, sidestick`)
     * `Claps & Snaps` (aliases: `clap, snap, cp`)
     * `Hi-Hats (Closed & Open)` (aliases: `hh, ch, oh, hat`)
     * `Toms (Hi/Mid/Low)` (aliases: `tom, ftom, rtom`)
     * `Perc & Shakers` (aliases: `perc, bongo, conga, shaker, tamb`)
     * `Cymbals (Crash & Ride)` (aliases: `crash, ride, cymbal`)
   * **Limiter**: `Max Duration: 1200 ms` (stepper delta: `±50ms`)

2. **`"loops"`**:
   * **Subcategories**:
     * `Full Drum Loops` (tags: `loop, full`)
     * `Top Loops (No Kick)` (tags: `loop, top`)
     * `Percussion Loops` (tags: `loop, perc`)
     * `Bass & 808 Loops` (tags: `loop, bass, 808`)
     * `Drum Fills & Rolls` (tags: `fill, roll`)
     * `Breaks & Vintage Chops` (tags: `break, chop`)
   * **Limiter**: `Max Loop Length: 4 Bars / 8000 ms` (stepper delta: `±1 Bar / ±2000ms`)

3. **`"other"`**:
   * **Subcategories**:
     * `FX, Sweeps & Risers` (tags: `fx, riser, sweep, downlifter, zap`)
     * `Atmospheres & Vinyl` (tags: `atmo, vinyl, noise, texture`)
     * `Tonal Chords & Stabs` (tags: `chord, stab, synth, hit`)
     * `Vocal Chops & Glitches` (tags: `vocal, chop, vox, glitch`)
     * `Wet / Processed Tails` (tags: `wet, verb, delay`)
     * `Unclassified Filenames` (files without explicit keywords)
   * **Limiter**: `Max Tail Length: 2500 ms` (stepper delta: `±100ms`)

---

## 🛠️ Hard Constraints & Architecture Rules
1. **Live 12.4+ API**: Pad assignment relies on `SimplerDevice.replace_sample`.
2. **Single `jsui` Context**: All state, drawing (`mgraphics`), mouse hit-testing (`onclick()`), and LiveAPI calls live in `drg-ui.js`.
3. **Pure Helper Modules**: `drg-classify.js`, `drg-duration.js`, and `drg-scan.js` must have NO Max globals so unit tests run cleanly under plain Node (`test/run.js`).
4. **Never Clear Existing Chains**: Rerolling replaces the sample on the existing Simpler and preserves existing choke groups, sends, and effects.
