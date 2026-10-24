// drg-ui.js
//
// The entire DDW Drum Rack Generator device: state, Live Object Model
// orchestration, persistence, drawing, and mouse hit-testing, all in one
// jsui script.
//
// WHY ONE FILE, NOT split js (logic) + jsui (drawing) as first sketched:
// each `js`/`jsui` object instance in Max runs its own separate JS
// context. Two objects loading two different files -- or even the same
// file twice -- do NOT share global state; there is no way for a plain
// `js` object's variables to be read directly by a `jsui` object without
// real Max messaging (patch cords) for every single interaction. For a
// UI this chatty (every pad click needs current state to decide what to
// draw next), that is a lot of fragile plumbing for no benefit. Putting
// both drawing and LiveAPI calls in the jsui script keeps everything in
// one JS context; only the things jsui genuinely cannot do itself
// (native OS drag-and-drop targets, editable text fields) exist as real
// neighboring Max objects, wired in via `prepend`-tagged patch cords.
//
// autowatch / inlets / outlets are read by Max at load time.
autowatch = 1;
inlets = 1;
outlets = 1; // "openfolder" -> opendialog trigger; "note" <note> <vel> -> noteout (audition).
// Single outlet, tagged messages sorted in the patch by [route openfolder note] --
// same prepend/route pattern already used for jsui's inputs, chosen after a real
// Live load kept losing outlet 1 (jsui reported "patchcord outlet out of range" and
// misrouted note data into opendialog) despite `outlets = 2` matching the maxpat's
// declared numoutlets. Root cause unconfirmed; one outlet removes the failure mode.

// Required by Max's mgraphics API: registers this jsui instance for the paint
// cycle at all. Without this, paint() is simply never called -- refresh() /
// mgraphics.redraw() silently no-op, and the device shows a blank white panel
// forever. This was the actual cause of the panel never rendering; found via
// https://docs.cycling74.com/max8/vignettes/jsmgraphics after confirming (via
// temporary post() logging) that bang() and refresh() both ran fine but no
// paint() call was ever logged.
mgraphics.init();

include("drg-classify.js");
include("drg-duration.js");
include("drg-scan.js");

// ---------------------------------------------------------------------
// Layout constants -- fixed logical size matching the device's
// presentation_rect in the .maxpat. Three panels, faithful to the
// manual's described tab-rail / status / 4x4-grid arrangement.
// ---------------------------------------------------------------------
var W = 420, H = 169;
var RAIL_W = 20;
var PANEL_X = RAIL_W, PANEL_W = 150;
var MID_X = PANEL_X + PANEL_W, MID_W = 90;
var GRID_X = MID_X + MID_W, GRID_W = W - GRID_X;
var GRID_Y = 4, GRID_H = H - 8, GAP = 3, COLS = 4, ROWS = 4;
var CELL_W = (GRID_W - GAP * (COLS - 1)) / COLS;
var CELL_H = (GRID_H - GAP * (ROWS - 1)) / ROWS;

var TAB_ICON_H = 34;

// The tab list lives here ONCE because it is consumed by both paintRail()
// and onclick(): when it was duplicated as a literal in each, adding a tab
// to one copy and not the other was a standing invitation to the exact
// drift bug described below.
var TABS = ["folder", "info", "categorization", "filters"];
var TAB_ICONS = ["F", "i", "C", "T"];

// Mid-panel control Y-positions -- shared between paintMid() and onclick()
// so a hit-test zone can never drift out of sync with what's actually
// drawn. (Found a real instance of that drift here: the audition-toggle
// click zone was hardcoded to y 104-116 while paintMid drew the checkbox
// at y 82-94, so clicking the visible checkbox did nothing.)
var DICE_Y = 8, DICE_H = 26;
var AUDITION_Y = DICE_Y + DICE_H + 48;
var CHECKBOX = 12;

// Types-panel filter rows. Same discipline: one source of truth for row
// geometry, used by both paintFiltersPanel() and handleFiltersPanelClick().
var FILTER_LIST_Y = 24, FILTER_ROW_H = 15;
function filterRowY(i) { return FILTER_LIST_Y + i * FILTER_ROW_H; }

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------
var STATE = {
    tab: "folder",                 // "folder" | "info" | "categorization"
    packs: [],                     // [{ id, path, name, fileCount }]
    categories: cloneCategories(DrgClassify.DEFAULT_CATEGORIES),
    padCategoryOverride: {},       // note -> category id (user reassigned a pad)
    padSample: {},                 // note -> absolute path currently loaded
    padLocked: {},                 // note -> bool
    editCategoryIndex: 0,          // which category the categorization tab is editing
    categoryPickerOpen: null,      // null | "categorization" | { forPadNote: N }
    auditionEnabled: true,
    // Type tab: which mode is active, each mode's subcategory switches, and
    // each mode's max-duration ceiling. Modes are exclusive -- only the
    // active mode's content is eligible for pad-filling (see reclassifyAll).
    typeMode: "oneshots",
    modeFilters: {
        oneshots: DrgClassify.defaultModeFilters("oneshots"),
        loops: DrgClassify.defaultModeFilters("loops"),
        other: DrgClassify.defaultModeFilters("other")
    },
    modeMaxMs: {
        oneshots: DrgClassify.TYPE_MODES.oneshots.defaultMaxMs,
        loops: DrgClassify.TYPE_MODES.loops.defaultMaxMs,
        other: DrgClassify.TYPE_MODES.other.defaultMaxMs
    },
    seedText: "",
    status: "Drop a sample-pack folder to begin.",
    statusIsError: false,
    statusIsConfirm: false,        // status bar doubles as the replace-instrument confirm
    pendingReplace: null,          // { index, name }
    allFiles: [],                  // [{ path, durationMs }]
    lastRank: null,                // output of DrgClassify.rankCandidates
    scanning: null,                // { scanner, packId } while a scan Task is running
    rackPath: null,
    trackPath: "this_device canonical_parent",
    ready: false,
    // Which absolute-path slash encoding actually loads a sample on this
    // machine's Live build -- discovered on the first successful write
    // (see pathEncodings()/assignPadSample), null | "forward" | "back".
    pathEncodingThatWorks: null,
    // Packs still waiting to be (re)scanned on startup -- see bang(). Not
    // persisted; rebuilt from STATE.packs each time the device loads.
    scanQueue: []
};

function cloneCategories(cats) {
    var out = [];
    for (var i = 0; i < cats.length; i++) {
        out.push({ id: cats[i].id, label: cats[i].label, aliases: cats[i].aliases.slice(), maxMs: cats[i].maxMs });
    }
    return out;
}

// ---------------------------------------------------------------------
// LiveAPI helpers -- same idioms as Live Actions Helper's
// bridge/live-actions-pal.js (liveApi/unwrap wrappers, path-string
// child navigation, chain lookup by in_note before assuming an index).
// ---------------------------------------------------------------------
function unwrap(v) {
    if (v && typeof v === "object" && typeof v.length === "number") {
        return v.length === 1 ? v[0] : v;
    }
    return v;
}

function safeGet(api, prop, fallback) {
    try { return unwrap(api.get(prop)); } catch (e) { return fallback; }
}

// ---------------------------------------------------------------------
// Persistence
//
// Per-instance (pad samples/locks/overrides/seed/audition): the
// documented save()/embedmessage() mechanism -- Max calls save() when
// the patcher (Live Set) is saved, and whatever embedmessage() calls
// are queued get replayed as real inbound messages the next time the
// Set loads. This is the only sanctioned way for a js/jsui object to
// carry state across a Set save/reload.
//
// Global (packs + category definitions, shared across every instance
// of this device): a JSON file written next to the .amxd itself, via
// this.patcher.filepath. NOT %APPDATA% -- that was the old Live Actions
// Helper-era plan for a Python host; this device has no Python host,
// and there is no documented environment-variable accessor in Max's js
// engine. Patcher.filepath is documented and gives the device's own
// location, which is stable once the user drags the .amxd into their
// User Library. UNVERIFIED IN LIVE: whether a *loaded* M4L device
// reports the original .amxd's path here or an unpacked/temp path --
// see docs/dev-notes, probe P7. Falls back to in-memory-only (session
// does not survive a Live restart, but does not crash) if the path is
// unusable.
// ---------------------------------------------------------------------

function save() {
    try {
        embedmessage("restorepad", JSON.stringify({
            padSample: STATE.padSample,
            padLocked: STATE.padLocked,
            padCategoryOverride: STATE.padCategoryOverride
        }));
        embedmessage("restoreseed", STATE.seedText);
        embedmessage("restoreaudition", STATE.auditionEnabled ? 1 : 0);
    } catch (e) {}
}

function restorepad(json) {
    try {
        var d = JSON.parse(String(json));
        STATE.padSample = d.padSample || {};
        STATE.padLocked = d.padLocked || {};
        STATE.padCategoryOverride = d.padCategoryOverride || {};
    } catch (e) {}
}

function restoreseed(s) { STATE.seedText = String(s || ""); }
function restoreaudition(v) { STATE.auditionEnabled = !!Number(v); }

function configFilePath() {
    var p = "";
    try { p = this.patcher.filepath; } catch (e) { p = ""; }
    if (!p) return null;
    var dir = p.replace(/[\\/][^\\/]*$/, "");
    return dir + "/ddw-drum-rack-generator-config.json";
}

function loadGlobalConfig() {
    var path = configFilePath();
    if (!path) { setStatus("Could not resolve a config location -- packs won't persist this session.", true); return; }
    try {
        var f = new File(path, "read");
        if (!f.isopen) return; // no config yet -- fine, first run
        var text = f.readstring(f.eof);
        f.close();
        var d = JSON.parse(text);
        if (d.categories) STATE.categories = d.categories;
        if (d.packs) STATE.packs = d.packs;
        if (d.typeMode && DrgClassify.TYPE_MODES[d.typeMode]) STATE.typeMode = d.typeMode;
        // Merged over the defaults key-by-key rather than assigned, so a
        // config written by an older build (no `modeFilters`/`modeMaxMs` at
        // all, e.g. the old v0.2.0 `filters` shape, or only some keys)
        // still loads with the rest at their defaults instead of blank.
        if (d.modeFilters) {
            for (var m = 0; m < DrgClassify.TYPE_MODE_ORDER.length; m++) {
                var modeKey = DrgClassify.TYPE_MODE_ORDER[m];
                var savedForMode = d.modeFilters[modeKey];
                if (!savedForMode) continue;
                var subcats = DrgClassify.TYPE_MODES[modeKey].subcats;
                for (var k = 0; k < subcats.length; k++) {
                    var subId = subcats[k].id;
                    if (savedForMode[subId] !== undefined) STATE.modeFilters[modeKey][subId] = !!savedForMode[subId];
                }
            }
        }
        if (d.modeMaxMs) {
            for (var m2 = 0; m2 < DrgClassify.TYPE_MODE_ORDER.length; m2++) {
                var mk2 = DrgClassify.TYPE_MODE_ORDER[m2];
                if (d.modeMaxMs[mk2] !== undefined) STATE.modeMaxMs[mk2] = Number(d.modeMaxMs[mk2]);
            }
        }
    } catch (e) {
        // Corrupt or unreadable config -- start clean rather than crash.
    }
}

function saveGlobalConfig() {
    var path = configFilePath();
    if (!path) return;
    try {
        var f = new File(path, "write");
        f.open(path);
        f.writestring(JSON.stringify({ categories: STATE.categories, packs: STATE.packs, typeMode: STATE.typeMode, modeFilters: STATE.modeFilters, modeMaxMs: STATE.modeMaxMs }, null, 2));
        f.close();
    } catch (e) {
        setStatus("Could not save pack list to disk (" + e + ").", true);
    }
}

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------
function bang() {
    // live.thisdevice's bang, fired once the device is actually live in
    // the Set -- LiveAPI calls before this point are unreliable.
    loadGlobalConfig();
    acquireDrumRack();
    // v0.4.0: STATE.packs is persisted (config JSON) but STATE.allFiles
    // never was -- a device that reloaded with packs already in its folder
    // list had zero actual candidates for every pad until the user
    // re-dropped every folder by hand, with nothing telling them why.
    // Re-walk every persisted pack's folder here instead.
    if (STATE.packs.length > 0) {
        STATE.scanQueue = STATE.packs.slice();
        setStatus("Restoring " + STATE.packs.length + " pack" + (STATE.packs.length === 1 ? "" : "s") + "…", false);
        startNextQueuedScan();
    } else {
        reclassifyAll();
    }
    STATE.ready = true;
    refresh();
}

function startNextQueuedScan() {
    if (!STATE.scanQueue || STATE.scanQueue.length === 0) return;
    var pack = STATE.scanQueue.shift();
    startScan(pack);
}

function acquireDrumRack(afterReplace) {
    var track = new LiveAPI(STATE.trackPath);
    if (!track || !track.id) {
        setStatus("No track found. Drop this device on a MIDI track.", true);
        return;
    }
    var count = 0;
    try { count = track.getcount("devices"); } catch (e) { count = 0; }
    var rackIndex = -1, otherIndex = -1, otherName = "";
    for (var i = 0; i < count; i++) {
        var d = new LiveAPI(STATE.trackPath + " devices " + i);
        var canDrumPads = Number(safeGet(d, "can_have_drum_pads", 0)) === 1;
        if (canDrumPads) { rackIndex = i; break; }
        var type = Number(safeGet(d, "type", -1)); // Device.type: 0 audio_effect, 1 instrument, 2 midi_effect
        if (type === 1 && otherIndex === -1) {
            otherIndex = i;
            otherName = String(safeGet(d, "name", "instrument"));
        }
    }
    if (rackIndex >= 0) {
        STATE.rackPath = STATE.trackPath + " devices " + rackIndex;
        setStatus("Ready.", false);
        return;
    }
    if (otherIndex >= 0 && !afterReplace) {
        STATE.pendingReplace = { index: otherIndex, name: otherName };
        setStatus("Track has '" + otherName + "'. Click here to replace it with a Drum Rack.", true, true);
        return;
    }
    if (otherIndex >= 0 && afterReplace) {
        try { track.call("delete_device", otherIndex); } catch (e) {}
    }
    try {
        track.call("insert_device", "Drum Rack");
    } catch (e2) {
        setStatus("Could not create a Drum Rack on this track: " + e2, true);
        return;
    }
    // Re-scan to find the index Live gave the new rack.
    count = 0;
    try { count = track.getcount("devices"); } catch (e3) { count = 0; }
    for (var j = 0; j < count; j++) {
        var d2 = new LiveAPI(STATE.trackPath + " devices " + j);
        if (Number(safeGet(d2, "can_have_drum_pads", 0)) === 1) {
            STATE.rackPath = STATE.trackPath + " devices " + j;
            setStatus("Drum Rack created. Ready.", false);
            return;
        }
    }
    setStatus("Inserted a Drum Rack but could not find it afterward.", true);
}

function confirmReplaceInstrument() {
    if (!STATE.pendingReplace) return;
    STATE.pendingReplace = null;
    acquireDrumRack(true);
    refresh();
}

// ---------------------------------------------------------------------
// Pad write -- adapted from the proven palAssignPadSample() pattern in
// Live Actions Helper's bridge/live-actions-pal.js: look up an existing
// chain BY in_note first, never assume index.
//
// The newly-created chain is located the same way: NOT by assuming it
// lands at index (chainCount - 1) -- there is no documented guarantee a
// Drum Rack appends a new chain rather than inserting it note-sorted or
// otherwise, and temporary post() tracing while chasing a real pad-
// assignment bug in Live (v0.2.0 -> v0.3.0 pass) pointed at exactly this
// assumption. Fixed by diffing chain `id`s before/after insert_chain and
// finding the one that's new, which holds regardless of where Live
// actually put it. Falls back to (newCount - 1) only if that scan somehow
// turns up nothing, so no path regresses to "silently wrong chain."
//
// v0.4.0 ROOT-CAUSE FIX: LiveAPI.call() does NOT throw in Max's `js`
// engine on failure -- it posts a warning to the Max window and returns
// normally. So `simpler.call("replace_sample", absolutePath)` wrapped in
// try/catch below was decorative: the catch could never fire, this
// function always returned { ok: true }, and every pass before this one
// reported "Sample loaded." over a Simpler that silently never got a
// sample. loadedSamplePath() reads the fact back from Live instead of
// trusting the call site: after replace_sample, ask the Simpler's own
// `sample` child what file_path it actually holds. Empty means the write
// failed, whatever the call site says. STATE.pathEncodingThatWorks caches
// whichever encoding succeeds first so the remaining 15 pads don't each
// pay for three round trips.
// ---------------------------------------------------------------------
function loadedSamplePath(simplerPath) {
    try {
        var s = new LiveAPI(simplerPath + " sample");
        if (!s || !s.id || String(s.id) === "0") return "";
        return String(unwrap(s.get("file_path")) || "");
    } catch (e) { return ""; }
}

function pathEncodings(absolutePath) {
    var forward = String(absolutePath).replace(/\\/g, "/");
    var back = String(absolutePath).replace(/\//g, "\\");
    // Order: whichever encoding already proved itself this session first,
    // then the as-given path, then both slash styles as fallbacks.
    var list = [absolutePath, forward, back];
    if (STATE.pathEncodingThatWorks === "forward") list = [forward, absolutePath, back];
    else if (STATE.pathEncodingThatWorks === "back") list = [back, absolutePath, forward];
    var seen = {}, out = [];
    for (var i = 0; i < list.length; i++) {
        if (!seen[list[i]]) { seen[list[i]] = true; out.push(list[i]); }
    }
    return out;
}

function assignPadSample(note, absolutePath) {
    if (!STATE.rackPath) return { ok: false, error: "no Drum Rack" };
    var rack = new LiveAPI(STATE.rackPath);
    var chainCount = 0;
    try { chainCount = rack.getcount("chains"); } catch (e) {
        return { ok: false, error: "chains unavailable (requires Live 12.3+)" };
    }
    var chainPath = null;
    var existingIds = {};
    for (var i = 0; i < chainCount; i++) {
        var c = new LiveAPI(STATE.rackPath + " chains " + i);
        existingIds[String(c.id)] = true;
        if (Number(safeGet(c, "in_note", NaN)) === note) { chainPath = STATE.rackPath + " chains " + i; break; }
    }
    if (!chainPath) {
        try { rack.call("insert_chain"); } catch (e2) {
            return { ok: false, error: "could not add a Rack chain (requires Live 12.3+): " + e2 };
        }
        var newCount = 0;
        try { newCount = rack.getcount("chains"); } catch (e3) { newCount = 0; }
        // getcount() immediately after insert_chain has been observed to
        // still report the pre-insert count on some Live builds -- one
        // re-read closes that race instead of silently grabbing an
        // existing chain by the (newCount - 1) fallback below.
        if (newCount <= chainCount) {
            try { newCount = rack.getcount("chains"); } catch (e3b) { newCount = chainCount; }
        }
        var newIndex = -1;
        for (var j = 0; j < newCount; j++) {
            var cj = new LiveAPI(STATE.rackPath + " chains " + j);
            if (!existingIds[String(cj.id)]) { newIndex = j; break; }
        }
        if (newIndex === -1) newIndex = newCount - 1; // fallback -- see header comment
        chainPath = STATE.rackPath + " chains " + newIndex;
        var newChain = new LiveAPI(chainPath);
        try { newChain.set("in_note", note); } catch (e4) {
            return { ok: false, error: "could not assign pad note: " + e4 };
        }
    }
    var chain = new LiveAPI(chainPath);
    var devCount = 0;
    try { devCount = chain.getcount("devices"); } catch (e5) { devCount = 0; }
    if (devCount === 0) {
        try { chain.call("insert_device", "Simpler"); } catch (e6) {
            return { ok: false, error: "could not insert Simpler: " + e6 };
        }
        try { devCount = chain.getcount("devices"); } catch (e7) { devCount = 0; }
    }
    if (devCount === 0) return { ok: false, error: "Simpler was not inserted" };

    var simplerPath = chainPath + " devices " + (devCount - 1);
    var simpler = new LiveAPI(simplerPath);
    var className = String(safeGet(simpler, "class_name", ""));
    if (className && className !== "Simpler") {
        return { ok: false, error: "pad already has " + className + " -- skipped, not overwritten", skipped: true };
    }

    var encodings = pathEncodings(absolutePath);
    var loaded = "";
    var triedEncoding = null;
    for (var enc = 0; enc < encodings.length; enc++) {
        try { simpler.call("replace_sample", encodings[enc]); } catch (e8) { continue; }
        loaded = loadedSamplePath(simplerPath);
        if (loaded) { triedEncoding = encodings[enc]; break; }
    }
    if (!loaded) {
        return { ok: false, error: "replace_sample did not take -- '" + basename(absolutePath) + "' never loaded onto this pad (tried " + encodings.length + " path encodings)" };
    }
    // Remember which encoding worked so the rest of this rack's pads skip
    // straight to it instead of re-discovering it one call at a time.
    if (triedEncoding === encodings[0] && triedEncoding.indexOf("/") !== -1 && triedEncoding.indexOf("\\") === -1) {
        STATE.pathEncodingThatWorks = "forward";
    } else if (triedEncoding && triedEncoding.indexOf("\\") !== -1) {
        STATE.pathEncodingThatWorks = "back";
    }

    // Settings pass -- independent, best-effort. None of these three
    // has a working precedent anywhere in the source codebase this was
    // adapted from; each may fail alone without blocking the others or
    // the sample load that already succeeded above. See probe P3b.
    var settingsFailed = [];
    if (note === 42 || note === 44 || note === 46) {
        try { chain.set("choke_group", 1); } catch (e9) { settingsFailed.push("choke_group"); }
    }
    try { simpler.set("playback_mode", 1); } catch (e10) { settingsFailed.push("playback_mode"); }
    try {
        var sampleApi = new LiveAPI(simplerPath + " sample");
        sampleApi.set("warping", 0);
    } catch (e11) { settingsFailed.push("warping"); }

    return { ok: true, settingsFailed: settingsFailed };
}

// ---------------------------------------------------------------------
// Scanning -- chunked via Task so a large library doesn't freeze Live's
// main thread. Folder listing uses the community-verified idiom
// (f.filetype === "fold" identifies subfolders during iteration); see
// docs/dev-notes probe P4 for the in-Live confirmation this still needs.
// ---------------------------------------------------------------------
function maxFolderAdapter(fullPath) {
    var dirs = [], files = [];
    var f = new Folder(fullPath);
    while (!f.end) {
        if (f.filetype === "fold") dirs.push(f.filename);
        else files.push(f.filename);
        f.next();
    }
    f.close();
    return { dirs: dirs, files: files };
}

function readDurationMs(fullPath) {
    var bytes = null;
    try {
        var file = new File(fullPath, "read");
        if (file.isopen) {
            bytes = file.readbytes(65536);
            file.close();
        }
    } catch (e) { bytes = null; }
    if (!bytes) return null;
    return DrgDuration.getDurationMs(fullPath, bytes);
}

function startScan(pack) {
    var scanner = DrgScan.createScanner(pack.path, { listDir: maxFolderAdapter }, DrgClassify.isAudioFile);
    STATE.scanning = { scanner: scanner, packId: pack.id, found: 0 };
    setStatus("Scanning '" + pack.name + "'…", false);
    stepScanTask();
}

function stepScanTask() {
    if (!STATE.scanning) return;
    var r = STATE.scanning.scanner.step(200);
    STATE.scanning.found = r.results.length;
    if (!r.done) {
        var task = new Task(stepScanTask, this);
        task.schedule(15);
        refresh();
        return;
    }
    // Done -- read durations (also chunked, same reasoning) then fold
    // into STATE.allFiles and reclassify.
    var results = r.results;
    var pack = null;
    for (var i = 0; i < STATE.packs.length; i++) if (STATE.packs[i].id === STATE.scanning.packId) pack = STATE.packs[i];
    STATE.scanning = null;
    readDurationsChunked(results, 0, pack);
}

function readDurationsChunked(results, index, pack) {
    var budget = 100;
    var end = Math.min(results.length, index + budget);
    for (var i = index; i < end; i++) {
        // relPath (pack-relative, e.g. "Kicks/kick_01.wav") is what
        // classification runs on; path (absolute) is what actually gets
        // loaded onto a pad. drg-scan.js already computes relPath via
        // relativeTo() -- it was being discarded here before v0.4.0, which
        // meant classifyFile() saw "A:/Samples_Packs/.../Kicks/kick_01.wav"
        // and matched folder segments like "samples_packs" before ever
        // reaching "kicks".
        STATE.allFiles.push({ path: results[i].path, relPath: results[i].relPath, durationMs: readDurationMs(results[i].path) });
    }
    if (end < results.length) {
        var task = new Task(function () { readDurationsChunked(results, end, pack); }, this);
        task.schedule(15);
        return;
    }
    if (pack) pack.fileCount = results.length;
    reclassifyAll();
    if (STATE.scanQueue && STATE.scanQueue.length > 0) {
        // Mid-restore: keep going, don't save/report per-pack yet -- the
        // "Added 'X'" message and disk write happen once at the end so a
        // multi-pack restore doesn't spam either.
        startNextQueuedScan();
    } else {
        saveGlobalConfig();
        setStatus(pack ? ("Added '" + pack.name + "' -- " + results.length + " samples.") : "Scan complete.", false);
    }
    refresh();
}

function reclassifyAll() {
    var files = [];
    for (var i = 0; i < STATE.allFiles.length; i++) {
        // relPath drives classification; path (absolute) is what lands in
        // the ranked pools and eventually reaches assignPadSample(). Older
        // saved allFiles entries (pre-v0.4.0 config) have no relPath --
        // fall back to path so a stale config doesn't just stop matching
        // anything until the user rescans.
        var f = STATE.allFiles[i];
        files.push({ relPath: f.relPath || f.path, path: f.path, durationMs: f.durationMs });
    }
    var seed = STATE.seedText === "" ? null : Number(STATE.seedText);
    STATE.lastRank = DrgClassify.rankCandidates(files, STATE.categories, seed, {
        mode: STATE.typeMode,
        modeFilters: STATE.modeFilters[STATE.typeMode],
        maxMs: STATE.modeMaxMs[STATE.typeMode]
    });
}

function effectivePadMap() {
    var map = [];
    for (var i = 0; i < DrgClassify.PAD_MAP.length; i++) {
        var p = DrgClassify.PAD_MAP[i];
        var cat = STATE.padCategoryOverride.hasOwnProperty(p.note) ? STATE.padCategoryOverride[p.note] : p.category;
        map.push({ note: p.note, category: cat });
    }
    return map;
}

// ---------------------------------------------------------------------
// Reroll / lock
// ---------------------------------------------------------------------
function rerollAll() {
    if (!STATE.lastRank) reclassifyAll();
    var assignments = DrgClassify.assignToPads(STATE.lastRank, effectivePadMap(), lockedPathMap());
    applyAssignments(assignments, false);
}

function lockedPathMap() {
    var m = {};
    for (var note in STATE.padLocked) {
        if (STATE.padLocked[note] && STATE.padSample[note]) m[note] = STATE.padSample[note];
    }
    return m;
}

function rerollPad(note) {
    if (STATE.padLocked[note]) return;
    if (!STATE.lastRank) reclassifyAll();
    var map = effectivePadMap();
    var single = null;
    for (var i = 0; i < map.length; i++) if (map[i].note === note) single = map[i];
    if (!single) return;
    var bucket = STATE.lastRank.byCategory[single.category] || { candidates: [] };
    var candidates = bucket.candidates;
    if (candidates.length === 0) {
        setStatus("No samples found for " + labelFor(single.category) + ".", true);
        return;
    }
    var current = STATE.padSample[note];
    var pick = candidates[Math.floor(Math.random() * candidates.length)];
    if (candidates.length > 1) {
        var guard = 0;
        while (pick === current && guard < 8) { pick = candidates[Math.floor(Math.random() * candidates.length)]; guard++; }
    }
    applyAssignments([{ note: note, category: single.category, path: pick, empty: false }], true);
}

function applyAssignments(assignments, isSingle) {
    var emptyCount = 0, okCount = 0;
    for (var i = 0; i < assignments.length; i++) {
        var a = assignments[i];
        if (a.locked) continue;
        if (a.empty) { emptyCount++; continue; }
        var result = assignPadSample(a.note, a.path);
        if (result.ok) {
            STATE.padSample[a.note] = a.path;
            okCount++;
            if (isSingle && STATE.auditionEnabled) auditionNote(a.note);
        } else if (!result.skipped) {
            setStatus("Pad " + a.note + ": " + result.error, true);
        }
    }
    if (emptyCount > 0 && !isSingle) {
        setStatus(okCount + " pads loaded, " + emptyCount + " empty (no matching samples).", emptyCount > 0);
    } else if (!STATE.statusIsError) {
        setStatus("Sample loaded.", false);
    }
    refresh();
}

function toggleLock(note) {
    STATE.padLocked[note] = !STATE.padLocked[note];
    refresh();
}

function auditionNote(note) {
    outlet(0, "note", note, 100);
    var task = new Task(function () { outlet(0, "note", note, 0); }, this);
    task.schedule(150);
}

function labelFor(categoryId) {
    for (var i = 0; i < STATE.categories.length; i++) if (STATE.categories[i].id === categoryId) return STATE.categories[i].label;
    return categoryId;
}

// ---------------------------------------------------------------------
// Folder ingestion -- from dropfile (drag from Explorer/Finder) or
// opendialog folder (click-to-browse fallback). Both are tagged with a
// `prepend` in the patch so they land on the same handler regardless of
// source.
// ---------------------------------------------------------------------
function folderdrop(pathStr) {
    var p = String(pathStr || "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (!p) return;
    for (var i = 0; i < STATE.packs.length; i++) {
        if (STATE.packs[i].path === p) { setStatus("'" + STATE.packs[i].name + "' is already added.", true); return; }
    }
    var name = p.split("/").pop() || p;
    var pack = { id: "pack" + Date.now() + Math.floor(Math.random() * 1000), path: p, name: name, fileCount: 0 };
    STATE.packs.push(pack);
    startScan(pack);
    refresh();
}

function removePack(packId) {
    var removed = null;
    STATE.packs = STATE.packs.filter(function (p) { if (p.id === packId) { removed = p; return false; } return true; });
    if (removed) {
        STATE.allFiles = STATE.allFiles.filter(function (f) { return f.path.indexOf(removed.path) !== 0; });
        reclassifyAll();
        saveGlobalConfig();
        setStatus("Removed '" + removed.name + "'.", false);
        refresh();
    }
}

function requestFolderPicker() {
    outlet(0, "openfolder"); // -> [route openfolder note] -> opendialog folder in the patch
}

// ---------------------------------------------------------------------
// Categorization tab controls
// ---------------------------------------------------------------------
function aliastext(text) {
    var cat = STATE.categories[STATE.editCategoryIndex];
    if (!cat) return;
    var aliases = String(text || "").toLowerCase().split(/\s+/).filter(function (t) { return t.length > 0; });
    cat.aliases = aliases;
    reclassifyAll();
    saveGlobalConfig();
    setStatus("Updated aliases for " + cat.label + ".", false);
    refresh();
}

function adjustMaxMs(delta) {
    var cat = STATE.categories[STATE.editCategoryIndex];
    if (!cat) return;
    cat.maxMs = Math.max(50, (cat.maxMs || 0) + delta);
    reclassifyAll();
    saveGlobalConfig();
    refresh();
}

function resetCategory() {
    var idx = STATE.editCategoryIndex;
    var def = DrgClassify.DEFAULT_CATEGORIES[idx];
    if (!def) return;
    STATE.categories[idx] = { id: def.id, label: def.label, aliases: def.aliases.slice(), maxMs: def.maxMs };
    reclassifyAll();
    saveGlobalConfig();
    setStatus("Reset " + def.label + " to defaults.", false);
    refresh();
}

// ---------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------
function setStatus(msg, isError, isConfirm) {
    STATE.status = msg;
    STATE.statusIsError = !!isError;
    STATE.statusIsConfirm = !!isConfirm;
    refresh();
}

// ---------------------------------------------------------------------
// Drawing
//
// COLORS -- every value here is a direct hex->0-1 conversion from
// "DDW Drum Rack Generator — Ableton Device UI (Redesigned Types Dropdown).html"
// (the user's Ableton Native Sleek mockup), not an approximation. One
// table so the device's palette can't drift from the reference the way
// v0.3.1's did (that pass invented values instead of reading the mockup's
// actual CSS, e.g. its amber was #E0B054-ish rather than the mockup's
// real #e5a93c).
// ---------------------------------------------------------------------
var COLORS = {
    outerBg: [0.094, 0.094, 0.094],        // #181818 device-viewport
    layoutBg: [0.102, 0.102, 0.102],       // #1a1a1a .c1-layout
    layoutBorder: [0.180, 0.180, 0.180],   // #2e2e2e
    railBg: [0.078, 0.078, 0.078],         // #141414 .c1-rail
    railActiveBg: [0.165, 0.165, 0.165],   // #2a2a2a .c1-rail-btn.active
    railInactiveText: [0.4, 0.4, 0.4],     // #666
    amber: [0.898, 0.663, 0.235],          // #e5a93c
    amberHover: [0.961, 0.729, 0.322],     // #f5ba52
    amberDeep: [0.102, 0.067, 0.008],      // #1a1102 text-on-amber
    panelBg: [0.125, 0.125, 0.125],        // #202020 .c1-panel / .c1-mid
    panelBorder: [0.173, 0.173, 0.173],    // #2c2c2c
    headingText: [0.867, 0.867, 0.867],    // #ddd
    dropzoneBorder: [0.267, 0.267, 0.267], // #444
    dropzoneBg: [0.098, 0.098, 0.098],     // #191919
    dropzoneText: [0.533, 0.533, 0.533],   // #888
    packItemBg: [0.149, 0.149, 0.149],     // #262626
    packItemBorder: [0.184, 0.184, 0.184], // #2f2f2f
    packItemText: [0.8, 0.8, 0.8],         // #ccc
    removeText: [0.957, 0.247, 0.369],     // #f43f5e
    dropdownBg: [0.082, 0.086, 0.110],     // #15161c .c1-type-select
    dropdownBorder: [0.239, 0.263, 0.329], // #3d4354
    rowText: [0.8, 0.8, 0.8],              // #ccc .c1-filter-chk
    countText: [0.533, 0.533, 0.533],      // #888 .c1-filter-count
    stepperBg: [0.090, 0.094, 0.125],      // #171820 .cutoff-stepper-box
    stepperBorder: [0.165, 0.180, 0.239],  // #2a2e3d
    stepperText: [0.667, 0.667, 0.667],    // #aaa
    catSelectBg: [0.094, 0.094, 0.094],    // #181818 .c1-cat-select
    catSelectBorder: [0.2, 0.2, 0.2],      // #333
    aliasBoxText: [0.667, 0.667, 0.667],   // #aaa .c1-alias-box
    tipText: [0.467, 0.467, 0.467],        // #777 .c1-alias-input-tip
    resetBorder: [0.267, 0.196, 0.141],    // #443224 .c1-reset-btn
    resetText: [0.851, 0.467, 0.024],      // #d97706
    infoText: [0.733, 0.733, 0.733],       // #bbb .c1-info-row
    emptyText: [0.973, 0.443, 0.443],      // #f87171 .c1-info-row.empty
    emptyBg: [0.937, 0.267, 0.267],        // #ef4444 @ 0.1 alpha
    statsText: [0.533, 0.533, 0.533],      // #888 .c1-stats
    statsBg: [0.094, 0.094, 0.094],        // #181818
    statsBorder: [0.149, 0.149, 0.149],    // #262626
    toggleText: [0.667, 0.667, 0.667],     // #aaa .c1-toggle
    statusOkBg: [0.090, 0.141, 0.122],     // #17241f .c1-status
    statusOkBorder: [0.141, 0.275, 0.216], // #244637
    statusOkText: [0.447, 0.851, 0.667],   // #72d9aa
    padBg: [0.149, 0.149, 0.149],          // #262626 .c1-pad
    padBorder: [0.212, 0.212, 0.212],      // #363636
    padLockedBg: [0.165, 0.145, 0.110],    // #2a251c .c1-pad.locked
    padFileText: [0.933, 0.933, 0.933],    // #eee .c1-pad-file
    // .cat-kick / .cat-snare / .cat-hat / .cat-perc text colors -- also
    // used (at low alpha) as each tag pill's fill.
    catKick: [0.961, 0.620, 0.043],        // #f59e0b
    catSnare: [0.957, 0.247, 0.369],       // #f43f5e
    catHat: [0.220, 0.741, 0.973],         // #38bdf8
    catPerc: [0.753, 0.518, 0.988]         // #c084fc
};

function refresh() { mgraphics.redraw(); }

function padRect(note) {
    var idx = note - 36;
    var col = idx % 4;
    var rowFromBottom = Math.floor(idx / 4); // 0 = bottom row (36-39)
    var row = 3 - rowFromBottom;
    var x = GRID_X + col * (CELL_W + GAP);
    var y = GRID_Y + row * (CELL_H + GAP);
    return [x, y, CELL_W, CELL_H];
}

function basename(p) {
    if (!p) return "";
    var parts = String(p).replace(/\\/g, "/").split("/");
    return parts[parts.length - 1];
}

function paint() {
    // try/catch so a bug in one paint sub-routine posts a visible error in
    // the Max Console instead of silently leaving a stale/blank panel.
    try {
        var g = mgraphics;
        g.set_source_rgba(COLORS.outerBg[0], COLORS.outerBg[1], COLORS.outerBg[2], 1);
        g.rectangle(0, 0, W, H);
        g.fill();

        paintRail(g);
        if (STATE.tab === "folder") paintFolderPanel(g);
        else if (STATE.tab === "info") paintInfoPanel(g);
        else if (STATE.tab === "filters") paintFiltersPanel(g);
        else paintCategorizationPanel(g);
        paintMid(g);
        paintGrid(g);

        if (STATE.categoryPickerOpen) paintCategoryPicker(g);
    } catch (e) {
        post("DRG: paint() THREW: " + (e && e.message ? e.message : e) + "\n");
    }
}

function paintRail(g) {
    g.set_source_rgba(COLORS.railBg[0], COLORS.railBg[1], COLORS.railBg[2], 1);
    g.rectangle(0, 0, RAIL_W, H);
    g.fill();
    for (var i = 0; i < TABS.length; i++) {
        var y = 8 + i * TAB_ICON_H;
        var on = STATE.tab === TABS[i];
        if (on) {
            // .c1-rail-btn.active: filled background + amber left accent bar.
            g.set_source_rgba(COLORS.railActiveBg[0], COLORS.railActiveBg[1], COLORS.railActiveBg[2], 1);
            g.rectangle(0, y - 4, RAIL_W, TAB_ICON_H - 4);
            g.fill();
            g.set_source_rgba(COLORS.amber[0], COLORS.amber[1], COLORS.amber[2], 1);
            g.rectangle(0, y - 4, 3, TAB_ICON_H - 4);
            g.fill();
        }
        var col = on ? COLORS.amber : COLORS.railInactiveText;
        g.set_source_rgba(col[0], col[1], col[2], 1);
        g.select_font_face("Arial");
        g.set_font_size(11);
        g.move_to(6, y + 12);
        g.show_text(TAB_ICONS[i]);
    }
}

function paintMid(g) {
    g.set_source_rgba(COLORS.panelBg[0], COLORS.panelBg[1], COLORS.panelBg[2], 1);
    g.rectangle(MID_X, 0, MID_W, H);
    g.fill();
    g.set_source_rgba(COLORS.panelBorder[0], COLORS.panelBorder[1], COLORS.panelBorder[2], 1);
    g.rectangle(MID_X, 0, MID_W, H);
    g.stroke();

    // Reroll All button -- .c1-reroll-btn: amber fill, deep-brown text.
    g.set_source_rgba(COLORS.amber[0], COLORS.amber[1], COLORS.amber[2], 1);
    roundRect(g, MID_X + 8, DICE_Y, MID_W - 16, DICE_H, 4);
    g.fill();
    g.set_source_rgba(COLORS.amberDeep[0], COLORS.amberDeep[1], COLORS.amberDeep[2], 1);
    g.select_font_face("Arial");
    g.set_font_size(11);
    centerText(g, "Reroll all", MID_X + 8, DICE_Y, MID_W - 16, DICE_H);

    // Pack / sample summary -- .c1-stats
    var statsY = DICE_Y + DICE_H + 6;
    g.set_source_rgba(COLORS.statsBg[0], COLORS.statsBg[1], COLORS.statsBg[2], 1);
    g.rectangle(MID_X + 8, statsY, MID_W - 16, 30);
    g.fill();
    g.set_source_rgba(COLORS.statsBorder[0], COLORS.statsBorder[1], COLORS.statsBorder[2], 1);
    g.rectangle(MID_X + 8, statsY, MID_W - 16, 30);
    g.stroke();
    g.set_source_rgba(COLORS.statsText[0], COLORS.statsText[1], COLORS.statsText[2], 1);
    g.set_font_size(9);
    g.move_to(MID_X + 12, statsY + 12);
    g.show_text(STATE.packs.length + " pack" + (STATE.packs.length === 1 ? "" : "s"));
    g.move_to(MID_X + 12, statsY + 24);
    g.show_text(STATE.allFiles.length + " samples");

    // Audition toggle -- .c1-toggle
    var col = STATE.auditionEnabled ? COLORS.amber : COLORS.toggleText;
    g.set_source_rgba(col[0], col[1], col[2], 1);
    g.rectangle(MID_X + 8, AUDITION_Y, CHECKBOX, CHECKBOX);
    if (STATE.auditionEnabled) g.fill(); else g.stroke();
    g.set_source_rgba(COLORS.toggleText[0], COLORS.toggleText[1], COLORS.toggleText[2], 1);
    g.set_font_size(9);
    g.move_to(MID_X + 24, AUDITION_Y + 10);
    g.show_text("Audition on reroll");

    // Status bar -- .c1-status (success) has an explicit green treatment
    // in the mockup; the error state has no mockup analogue, so it keeps
    // the existing red-family scheme, now via the emptyText/emptyBg tokens
    // that ARE from the mockup (.c1-info-row.empty) rather than invented.
    var statusY = H - 30;
    var bg = STATE.statusIsError ? COLORS.emptyBg : COLORS.statusOkBg;
    var bgAlpha = STATE.statusIsError ? 0.18 : 1;
    var border = STATE.statusIsError ? COLORS.emptyText : COLORS.statusOkBorder;
    var text = STATE.statusIsError ? COLORS.emptyText : COLORS.statusOkText;
    g.set_source_rgba(bg[0], bg[1], bg[2], bgAlpha);
    g.rectangle(MID_X + 4, statusY, MID_W - 8, 24);
    g.fill();
    g.set_source_rgba(border[0], border[1], border[2], 1);
    g.rectangle(MID_X + 4, statusY, MID_W - 8, 24);
    g.stroke();
    g.set_source_rgba(text[0], text[1], text[2], 1);
    g.set_font_size(9);
    wrapText(g, STATE.status, MID_X + 8, statusY + 10, MID_W - 16, 10);
}

function roundRect(g, x, y, w, h, r) {
    g.rectangle(x, y, w, h); // mgraphics has no native rounded-rect in every build; a plain rect keeps this correct-by-construction over decorative-but-fragile
}

function centerText(g, text, x, y, w, h) {
    g.move_to(x + 6, y + h / 2 + 4);
    g.show_text(text);
}

function wrapText(g, text, x, y, maxWidth, lineHeight) {
    var words = String(text).split(" ");
    var line = "";
    var cy = y;
    for (var i = 0; i < words.length; i++) {
        var test = line ? line + " " + words[i] : words[i];
        if (test.length * 5.2 > maxWidth && line) {
            g.move_to(x, cy);
            g.show_text(line);
            cy += lineHeight;
            line = words[i];
        } else {
            line = test;
        }
    }
    if (line) { g.move_to(x, cy); g.show_text(line); }
}

function paintFolderPanel(g) {
    g.set_source_rgba(COLORS.panelBg[0], COLORS.panelBg[1], COLORS.panelBg[2], 1);
    g.rectangle(PANEL_X, 0, PANEL_W, H);
    g.fill();
    g.set_source_rgba(COLORS.panelBorder[0], COLORS.panelBorder[1], COLORS.panelBorder[2], 1);
    g.rectangle(PANEL_X, 0, PANEL_W, H);
    g.stroke();

    // .c1-dropzone
    var dropY = 4, dropH = 44;
    g.set_source_rgba(COLORS.dropzoneBg[0], COLORS.dropzoneBg[1], COLORS.dropzoneBg[2], 1);
    g.rectangle(PANEL_X + 6, dropY, PANEL_W - 12, dropH);
    g.fill();
    g.set_source_rgba(COLORS.dropzoneBorder[0], COLORS.dropzoneBorder[1], COLORS.dropzoneBorder[2], 1);
    g.rectangle(PANEL_X + 6, dropY, PANEL_W - 12, dropH);
    g.stroke();
    g.set_source_rgba(COLORS.dropzoneText[0], COLORS.dropzoneText[1], COLORS.dropzoneText[2], 1);
    g.set_font_size(9);
    wrapText(g, "Drop sample folders here, or click to browse", PANEL_X + 12, dropY + 14, PANEL_W - 24, 11);

    // .c1-pack-item rows
    var y = dropY + dropH + 10;
    for (var i = 0; i < STATE.packs.length; i++) {
        var p = STATE.packs[i];
        g.set_source_rgba(COLORS.packItemBg[0], COLORS.packItemBg[1], COLORS.packItemBg[2], 1);
        g.rectangle(PANEL_X + 6, y, PANEL_W - 12, 18);
        g.fill();
        g.set_source_rgba(COLORS.packItemBorder[0], COLORS.packItemBorder[1], COLORS.packItemBorder[2], 1);
        g.rectangle(PANEL_X + 6, y, PANEL_W - 12, 18);
        g.stroke();
        g.set_source_rgba(COLORS.packItemText[0], COLORS.packItemText[1], COLORS.packItemText[2], 1);
        g.set_font_size(9);
        g.move_to(PANEL_X + 10, y + 13);
        g.show_text(truncate(p.name, 16) + " (" + p.fileCount + ")");
        g.set_source_rgba(COLORS.removeText[0], COLORS.removeText[1], COLORS.removeText[2], 1);
        g.move_to(PANEL_X + PANEL_W - 16, y + 13);
        g.show_text("x");
        y += 20;
        if (y > H - 12) break;
    }
}

function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

function paintInfoPanel(g) {
    g.set_source_rgba(COLORS.panelBg[0], COLORS.panelBg[1], COLORS.panelBg[2], 1);
    g.rectangle(PANEL_X, 0, PANEL_W, H);
    g.fill();
    g.set_source_rgba(COLORS.panelBorder[0], COLORS.panelBorder[1], COLORS.panelBorder[2], 1);
    g.rectangle(PANEL_X, 0, PANEL_W, H);
    g.stroke();
    g.set_font_size(9);
    var y = 10;
    for (var i = 0; i < STATE.categories.length; i++) {
        var cat = STATE.categories[i];
        var bucket = STATE.lastRank ? STATE.lastRank.byCategory[cat.id] : null;
        var count = bucket ? bucket.candidates.length : 0;
        var unknown = bucket ? bucket.unknownDurationCount : 0;
        var empty = count === 0;
        // .c1-info-row.empty: faint red background highlight + red text --
        // a pad reporting empty should be visually loud, never silent.
        if (empty) {
            g.set_source_rgba(COLORS.emptyBg[0], COLORS.emptyBg[1], COLORS.emptyBg[2], 0.1);
            g.rectangle(PANEL_X + 3, y - 8, PANEL_W - 6, 12);
            g.fill();
        }
        var textCol = empty ? COLORS.emptyText : COLORS.infoText;
        g.set_source_rgba(textCol[0], textCol[1], textCol[2], 1);
        g.move_to(PANEL_X + 6, y);
        g.show_text(cat.label + ": " + count + (unknown ? " (" + unknown + " ?)" : ""));
        y += 12;
        if (y > H - 8) break;
    }
}

// The Types tab: a mode dropdown (One-Shots / Loops / Other -- modes are
// exclusive, see reclassifyAll), the active mode's subcategory switches
// with live counts, and a max-duration stepper for that mode. The counts
// are the point -- the bug that prompted the original version of this
// panel was an *invisible* exclusion (a whole stems pack silently
// dropped), so it always shows what each switch is currently costing you,
// computed before any switch is applied (see subcatCounts in
// drg-classify.js's rankCandidates).
var MODE_LABEL_Y = 2, MODE_LABEL_H = 18;
var STEPPER_LABELS = { oneshots: "Max Duration:", loops: "Max Loop:", other: "Max Tail:" };
// Loops is bar-based per HANDOFF_SPEC.md ("4 Bars / 8000ms", stepper delta
// "+/-1 Bar / +/-2000ms"), not millisecond-based like the other two modes.
// BAR_MS is a fixed display conversion (2000ms/bar) -- this device has no
// tempo binding to Live's own transport, so it is not an actual bars/beats
// read of the Set; it only reproduces the spec's own stated numbers.
var BAR_MS = 2000;
var STEP_DELTA_MS = { oneshots: 50, loops: BAR_MS, other: 100 };

function stepperLabel(mode) { return STEPPER_LABELS[mode] || "Max:"; }
function stepperY(mode) { return filterRowY(DrgClassify.TYPE_MODES[mode].subcats.length) + 6; }
function stepperValueText(mode, ms) {
    if (mode === "loops") return Math.round(ms / BAR_MS) + " Bars (" + Math.round(ms) + "ms)";
    return Math.round(ms) + " ms";
}

function paintFiltersPanel(g) {
    g.set_source_rgba(COLORS.panelBg[0], COLORS.panelBg[1], COLORS.panelBg[2], 1);
    g.rectangle(PANEL_X, 0, PANEL_W, H);
    g.fill();
    g.set_source_rgba(COLORS.panelBorder[0], COLORS.panelBorder[1], COLORS.panelBorder[2], 1);
    g.rectangle(PANEL_X, 0, PANEL_W, H);
    g.stroke();

    var mode = STATE.typeMode;
    var modeDef = DrgClassify.TYPE_MODES[mode];

    // Mode "dropdown" -- mgraphics has no native <select>, so this is a
    // boxed, bordered control (.c1-type-select) that cycles
    // One-Shots -> Loops -> Other on click (handled in
    // handleFiltersPanelClick), the same clickable-label idiom already
    // used for the category picker in paintCategorizationPanel.
    g.set_source_rgba(COLORS.dropdownBg[0], COLORS.dropdownBg[1], COLORS.dropdownBg[2], 1);
    g.rectangle(PANEL_X + 4, MODE_LABEL_Y, PANEL_W - 8, MODE_LABEL_H);
    g.fill();
    g.set_source_rgba(COLORS.dropdownBorder[0], COLORS.dropdownBorder[1], COLORS.dropdownBorder[2], 1);
    g.rectangle(PANEL_X + 4, MODE_LABEL_Y, PANEL_W - 8, MODE_LABEL_H);
    g.stroke();
    g.set_source_rgba(COLORS.amber[0], COLORS.amber[1], COLORS.amber[2], 1);
    g.select_font_face("Arial");
    g.set_font_size(10);
    g.move_to(PANEL_X + 9, MODE_LABEL_Y + 13);
    g.show_text("Type: " + modeDef.label + " ▾");

    var counts = STATE.lastRank ? STATE.lastRank.subcatCounts : null;
    var subcats = modeDef.subcats;
    var modeFilters = STATE.modeFilters[mode];

    for (var i = 0; i < subcats.length; i++) {
        var sub = subcats[i];
        var on = modeFilters[sub.id] !== false;
        var y = filterRowY(i);

        g.set_source_rgba(COLORS.amber[0], COLORS.amber[1], COLORS.amber[2], on ? 1 : 0.35);
        g.rectangle(PANEL_X + 8, y, CHECKBOX, CHECKBOX);
        if (on) g.fill(); else g.stroke();

        var rowCol = on ? COLORS.rowText : COLORS.countText;
        g.set_source_rgba(rowCol[0], rowCol[1], rowCol[2], 1);
        g.set_font_size(9);
        g.move_to(PANEL_X + 26, y + 10);
        g.show_text(sub.label);

        if (counts) {
            var n = String(counts[sub.id] || 0);
            // Crude right-align on the same ~5.2px-per-char approximation
            // wrapText() already uses; mgraphics exposes no text metrics.
            g.set_source_rgba(COLORS.countText[0], COLORS.countText[1], COLORS.countText[2], 1);
            g.move_to(PANEL_X + PANEL_W - 10 - n.length * 5.2, y + 10);
            g.show_text(n);
        }
    }

    // Stepper box -- .cutoff-stepper-box. Loops mode shows its bar count
    // per HANDOFF_SPEC ("4 Bars / 8000ms"), the other two show plain ms.
    var sy = stepperY(mode);
    g.set_source_rgba(COLORS.stepperBg[0], COLORS.stepperBg[1], COLORS.stepperBg[2], 1);
    g.rectangle(PANEL_X + 4, sy, PANEL_W - 8, 16);
    g.fill();
    g.set_source_rgba(COLORS.stepperBorder[0], COLORS.stepperBorder[1], COLORS.stepperBorder[2], 1);
    g.rectangle(PANEL_X + 4, sy, PANEL_W - 8, 16);
    g.stroke();
    g.set_source_rgba(COLORS.stepperText[0], COLORS.stepperText[1], COLORS.stepperText[2], 1);
    g.set_font_size(9);
    g.move_to(PANEL_X + 8, sy + 11);
    g.show_text(stepperLabel(mode) + " " + stepperValueText(mode, STATE.modeMaxMs[mode]));
    g.set_source_rgba(COLORS.amber[0], COLORS.amber[1], COLORS.amber[2], 1);
    g.move_to(PANEL_X + PANEL_W - 40, sy + 11);
    g.show_text("-  +");

    // Stated, not switchable -- see HARD_EXCLUDE_TOKENS in drg-classify.js.
    // Only drawn if it fits below the stepper (row count varies by mode).
    var midiY = sy + 20;
    if (midiY <= H - 6) {
        g.set_source_rgba(0.45, 0.45, 0.45, 1);
        g.set_font_size(8);
        g.move_to(PANEL_X + 8, midiY);
        var midiN = STATE.lastRank ? STATE.lastRank.midiCount : 0;
        g.show_text("MIDI never included" + (midiN ? " (" + midiN + ")" : ""));
    }
}

function paintCategorizationPanel(g) {
    g.set_source_rgba(COLORS.panelBg[0], COLORS.panelBg[1], COLORS.panelBg[2], 1);
    g.rectangle(PANEL_X, 0, PANEL_W, H);
    g.fill();
    g.set_source_rgba(COLORS.panelBorder[0], COLORS.panelBorder[1], COLORS.panelBorder[2], 1);
    g.rectangle(PANEL_X, 0, PANEL_W, H);
    g.stroke();
    var cat = STATE.categories[STATE.editCategoryIndex] || STATE.categories[0];

    // .c1-cat-select -- boxed dropdown, amber label text.
    g.set_source_rgba(COLORS.catSelectBg[0], COLORS.catSelectBg[1], COLORS.catSelectBg[2], 1);
    g.rectangle(PANEL_X + 4, 3, PANEL_W - 8, 16);
    g.fill();
    g.set_source_rgba(COLORS.catSelectBorder[0], COLORS.catSelectBorder[1], COLORS.catSelectBorder[2], 1);
    g.rectangle(PANEL_X + 4, 3, PANEL_W - 8, 16);
    g.stroke();
    g.set_source_rgba(COLORS.amber[0], COLORS.amber[1], COLORS.amber[2], 1);
    g.set_font_size(10);
    g.move_to(PANEL_X + 8, 14);
    g.show_text(cat.label + " ▾");

    // .c1-alias-box
    g.set_font_size(9);
    g.set_source_rgba(COLORS.aliasBoxText[0], COLORS.aliasBoxText[1], COLORS.aliasBoxText[2], 1);
    wrapText(g, "Current: " + (cat.aliases.length ? cat.aliases.join(", ") : "(none)"), PANEL_X + 6, 34, PANEL_W - 12, 11);

    // .c1-alias-input-tip
    g.set_source_rgba(COLORS.tipText[0], COLORS.tipText[1], COLORS.tipText[2], 1);
    g.move_to(PANEL_X + 6, 76);
    g.show_text("Type new aliases below,");
    g.move_to(PANEL_X + 6, 88);
    g.show_text("Enter replaces the list.");

    g.set_source_rgba(COLORS.stepperText[0], COLORS.stepperText[1], COLORS.stepperText[2], 1);
    g.move_to(PANEL_X + 6, 118);
    g.show_text("Max length: " + Math.round(cat.maxMs) + " ms");
    g.set_source_rgba(COLORS.amber[0], COLORS.amber[1], COLORS.amber[2], 1);
    g.move_to(PANEL_X + PANEL_W - 40, 118);
    g.show_text("-  +");

    // .c1-reset-btn
    g.set_source_rgba(COLORS.resetBorder[0], COLORS.resetBorder[1], COLORS.resetBorder[2], 1);
    g.rectangle(PANEL_X + 6, 130, PANEL_W - 12, 14);
    g.stroke();
    g.set_source_rgba(COLORS.resetText[0], COLORS.resetText[1], COLORS.resetText[2], 1);
    g.move_to(PANEL_X + 10, 140);
    g.show_text("Reset to default");
}

function paintCategoryPicker(g) {
    var picker = STATE.categoryPickerOpen;
    var x = picker.forPadNote !== undefined ? padRect(picker.forPadNote)[0] : PANEL_X;
    var w = 130, rowH = 13;
    var h = Math.min(STATE.categories.length * rowH + 4, H - 8);
    var y = 4;
    g.set_source_rgba(0.1, 0.1, 0.1, 0.96);
    g.rectangle(x, y, w, h);
    g.fill();
    g.set_font_size(9);
    for (var i = 0; i < STATE.categories.length; i++) {
        var ry = y + 2 + i * rowH;
        if (ry > y + h - rowH) break;
        g.set_source_rgba(0.85, 0.85, 0.85, 1);
        g.move_to(x + 4, ry + 10);
        g.show_text(STATE.categories[i].label);
    }
}

// Per-category tag colors, matching the mockup's .cat-kick/.cat-snare/
// .cat-hat/.cat-perc classes exactly (see COLORS above). Drawn as a filled
// pill (low-alpha background, full-alpha text) instead of plain gray
// label text.
var CATEGORY_COLORS = {
    kick: COLORS.catKick,
    rim: COLORS.catSnare,
    snare: COLORS.catSnare,
    clap: COLORS.catSnare,
    tom: COLORS.catPerc,
    hat_closed: COLORS.catHat,
    hat_pedal: COLORS.catHat,
    hat_open: COLORS.catHat,
    perc: COLORS.catPerc,
    crash: COLORS.catHat,
    ride: COLORS.catHat
};
var DEFAULT_TAG_COLOR = [0.65, 0.65, 0.65];

function colorForCategory(catId) { return CATEGORY_COLORS[catId] || DEFAULT_TAG_COLOR; }

function paintGrid(g) {
    for (var i = 0; i < 16; i++) {
        var note = 36 + i;
        var r = padRect(note);
        var map = effectivePadMap();
        var catId = "kick";
        for (var m = 0; m < map.length; m++) if (map[m].note === note) catId = map[m].category;
        var locked = !!STATE.padLocked[note];
        var samplePath = STATE.padSample[note];
        var col = colorForCategory(catId);

        // .c1-pad.locked: distinct amber-tinted background + amber border +
        // faint inset glow (approximated here as the tint alone -- mgraphics
        // has no box-shadow). Previously locked pads only got a border
        // color change; the mockup gives them a whole different fill.
        var bg = locked ? COLORS.padLockedBg : COLORS.padBg;
        g.set_source_rgba(bg[0], bg[1], bg[2], 1);
        g.rectangle(r[0], r[1], r[2], r[3]);
        g.fill();
        var borderCol = locked ? COLORS.amber : COLORS.padBorder;
        g.set_source_rgba(borderCol[0], borderCol[1], borderCol[2], 1);
        g.rectangle(r[0], r[1], r[2], r[3]);
        g.stroke();

        g.set_source_rgba(COLORS.padFileText[0], COLORS.padFileText[1], COLORS.padFileText[2], 1);
        g.set_font_size(8);
        g.move_to(r[0] + 3, r[1] + 10);
        g.show_text(samplePath ? truncate(basename(samplePath), 12) : "— empty —");

        // Category tag pill: low-alpha color fill behind, full-alpha
        // colored text on top -- same treatment as the reference mockup's
        // colored cat-tag badges, not just plain gray text.
        var tagText = labelFor(catId).toUpperCase();
        var tagY = r[1] + r[3] - 13;
        var tagW = Math.min(r[2] - 6, 6 + tagText.length * 4.4);
        g.set_source_rgba(col[0], col[1], col[2], 0.2);
        g.rectangle(r[0] + 3, tagY, tagW, 10);
        g.fill();
        g.set_source_rgba(col[0], col[1], col[2], 1);
        g.set_font_size(6.5);
        g.move_to(r[0] + 6, tagY + 8);
        g.show_text(tagText);

        // dice icon (reroll) top-right, lock icon bottom-right
        g.set_source_rgba(COLORS.amber[0], COLORS.amber[1], COLORS.amber[2], 1);
        g.move_to(r[0] + r[2] - 10, r[1] + 10);
        g.show_text("⚄");
        var lockCol = locked ? COLORS.amber : [0.5, 0.5, 0.5];
        g.set_source_rgba(lockCol[0], lockCol[1], lockCol[2], 1);
        g.move_to(r[0] + r[2] - 10, r[1] + r[3] - 4);
        g.show_text(locked ? "▣" : "□");
    }
}

// ---------------------------------------------------------------------
// Mouse hit-testing
// ---------------------------------------------------------------------
function inRect(x, y, r) { return x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3]; }

function onclick(x, y, button) {
    if (STATE.pendingReplace && x >= MID_X) { confirmReplaceInstrument(); return; }
    if (STATE.categoryPickerOpen) { handlePickerClick(x, y); return; }

    if (x < RAIL_W) {
        var idx = Math.floor((y - 8) / TAB_ICON_H);
        if (idx >= 0 && idx < TABS.length) { STATE.tab = TABS[idx]; refresh(); }
        return;
    }

    if (x >= PANEL_X && x < PANEL_X + PANEL_W) {
        if (STATE.tab === "folder") { handleFolderPanelClick(x, y); return; }
        if (STATE.tab === "filters") { handleFiltersPanelClick(x, y); return; }
        if (STATE.tab === "categorization") { handleCategorizationPanelClick(x, y); return; }
        return;
    }

    if (x >= MID_X && x < MID_X + MID_W) {
        if (y >= DICE_Y && y <= DICE_Y + DICE_H) { rerollAll(); return; }
        if (y >= AUDITION_Y && y <= AUDITION_Y + CHECKBOX) { STATE.auditionEnabled = !STATE.auditionEnabled; refresh(); return; }
        return;
    }

    if (x >= GRID_X) {
        for (var i = 0; i < 16; i++) {
            var note = 36 + i;
            var r = padRect(note);
            if (!inRect(x, y, r)) continue;
            if (x >= r[0] + r[2] - 14 && y <= r[1] + 14) { rerollPad(note); return; }
            if (x >= r[0] + r[2] - 14 && y >= r[1] + r[3] - 14) { toggleLock(note); return; }
            if (y >= r[1] + r[3] - 12) { STATE.categoryPickerOpen = { forPadNote: note }; refresh(); return; }
            return;
        }
    }
}

function handleFolderPanelClick(x, y) {
    var dropY = 4, dropH = 44;
    if (y >= dropY && y <= dropY + dropH) { requestFolderPicker(); return; }
    var listY = dropY + dropH + 10;
    for (var i = 0; i < STATE.packs.length; i++) {
        var rowY = listY + i * 20;
        if (y >= rowY && y <= rowY + 18) {
            if (x >= PANEL_X + PANEL_W - 20) removePack(STATE.packs[i].id);
            return;
        }
    }
}

function handleFiltersPanelClick(x, y) {
    if (y >= MODE_LABEL_Y && y <= MODE_LABEL_Y + MODE_LABEL_H) {
        var order = DrgClassify.TYPE_MODE_ORDER;
        var idx = order.indexOf(STATE.typeMode);
        STATE.typeMode = order[(idx + 1) % order.length];
        reclassifyAll();
        saveGlobalConfig();
        setStatus("Switched Type to " + DrgClassify.TYPE_MODES[STATE.typeMode].label + ".", false);
        return;
    }

    var mode = STATE.typeMode;
    var subcats = DrgClassify.TYPE_MODES[mode].subcats;
    for (var i = 0; i < subcats.length; i++) {
        var rowY = filterRowY(i);
        if (y < rowY || y > rowY + CHECKBOX) continue;
        STATE.modeFilters[mode][subcats[i].id] = STATE.modeFilters[mode][subcats[i].id] === false;
        reclassifyAll();
        saveGlobalConfig();
        announceModeState();
        return;
    }

    var sy = stepperY(mode);
    if (y >= sy && y <= sy + 16) {
        var delta = STEP_DELTA_MS[mode] || 50;
        if (x >= PANEL_X + PANEL_W - 40 && x < PANEL_X + PANEL_W - 20) {
            STATE.modeMaxMs[mode] = Math.max(50, STATE.modeMaxMs[mode] - delta);
        } else if (x >= PANEL_X + PANEL_W - 20) {
            STATE.modeMaxMs[mode] = STATE.modeMaxMs[mode] + delta;
        } else {
            return;
        }
        reclassifyAll();
        saveGlobalConfig();
        refresh();
        return;
    }
}

// Turning every subcategory off yields an empty rack for the active mode.
// Say so outright rather than letting the user hunt for why every pad
// went blank -- the same "never fail silently" rule the info tab's
// per-category counts follow.
function announceModeState() {
    var mode = STATE.typeMode;
    var subcats = DrgClassify.TYPE_MODES[mode].subcats;
    var anyOn = false;
    for (var i = 0; i < subcats.length; i++) {
        if (STATE.modeFilters[mode][subcats[i].id] !== false) { anyOn = true; break; }
    }
    if (!anyOn) {
        setStatus("All " + DrgClassify.TYPE_MODES[mode].label + " subcategories are off -- no samples can be assigned.", true);
        return;
    }
    var total = 0;
    if (STATE.lastRank) {
        for (var id in STATE.lastRank.byCategory) {
            if (STATE.lastRank.byCategory.hasOwnProperty(id)) {
                total += STATE.lastRank.byCategory[id].candidates.length;
            }
        }
    }
    setStatus(total + " candidate sample" + (total === 1 ? "" : "s") + " after filtering. Reroll to apply.", false);
}

function handleCategorizationPanelClick(x, y) {
    if (y <= 20) { STATE.categoryPickerOpen = "categorization"; refresh(); return; }
    if (y >= 112 && y <= 124) {
        if (x >= PANEL_X + PANEL_W - 40 && x < PANEL_X + PANEL_W - 20) { adjustMaxMs(-50); return; }
        if (x >= PANEL_X + PANEL_W - 20) { adjustMaxMs(50); return; }
    }
    if (y >= 130 && y <= 144) { resetCategory(); return; }
}

function handlePickerClick(x, y) {
    var picker = STATE.categoryPickerOpen;
    var px = picker.forPadNote !== undefined ? padRect(picker.forPadNote)[0] : PANEL_X;
    var rowH = 13;
    var idx = Math.floor((y - 6) / rowH);
    STATE.categoryPickerOpen = null;
    if (idx < 0 || idx >= STATE.categories.length) { refresh(); return; }
    if (picker.forPadNote !== undefined) {
        STATE.padCategoryOverride[picker.forPadNote] = STATE.categories[idx].id;
    } else {
        STATE.editCategoryIndex = idx;
    }
    refresh();
}

function onresize(w, h) { /* fixed logical layout by design; see header comment */ }
