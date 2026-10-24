// Smoke test for drg-ui.js under plain Node, with the Max/Live globals it
// references stubbed out. This does NOT validate real LiveAPI behavior
// (that needs Live itself -- see docs/dev-notes probes) -- it validates
// that the script loads without error and that everything NOT dependent
// on a live Set (classification, ranking, pad-map logic, config
// round-trip, alias editing, lock/override bookkeeping) actually works.
"use strict";

var assert = require("assert");
var path = require("path");
var vm = require("vm");
var fs = require("fs");

var scriptPath = path.join(__dirname, "..", "device", "drg-ui.js");
var classifyPath = path.join(__dirname, "..", "device", "drg-classify.js");
var durationPath = path.join(__dirname, "..", "device", "drg-duration.js");
var scanPath = path.join(__dirname, "..", "device", "drg-scan.js");

var fakeFiles = {}; // path -> bytes, used by the fake File class
// path -> { dirs: [names], files: [names] }, used by the fake Folder class to
// simulate a real, nested directory tree (see the "folderdrop -> real scan"
// test below, added after a real Live test surfaced a bug this file didn't
// catch: drg-ui.js passed maxFolderAdapter as a bare function where
// drg-scan.js's contract requires an object with a .listDir() method).
var fakeDirs = {};
var fakeMgraphicsCalls = 0;
var lastEmbeds = [];
var outletCalls = [];
var patcherFilepath = "C:/Users/fake/DDW Drum Rack Generator.amxd";

function FakeMgraphics() {}
["set_source_rgba", "rectangle", "fill", "stroke", "select_font_face", "set_font_size", "move_to", "show_text", "line_to", "redraw", "init"].forEach(function (m) {
    FakeMgraphics.prototype[m] = function () {};
});

var posts = [];

var sandbox = {
    console: console,
    post: function (m) { posts.push(String(m)); },
    include: function (name) {
        var p = name.indexOf("classify") >= 0 ? classifyPath : name.indexOf("duration") >= 0 ? durationPath : scanPath;
        vm.runInContext(fs.readFileSync(p, "utf8"), sandbox.__context, { filename: p });
    },
    LiveAPI: function (path) {
        this.path = path;
        this.id = 0; // "no track" by default in this stub -- fine, no test calls Live-dependent paths
    },
    Folder: function (path) {
        var listing = fakeDirs[path] || { dirs: [], files: [] };
        var entries = listing.dirs.map(function (d) { return { filename: d, filetype: "fold" }; })
            .concat(listing.files.map(function (f) { return { filename: f, filetype: "file" }; }));
        var idx = 0;
        this.end = entries.length === 0;
        this.filename = entries.length ? entries[0].filename : "";
        this.filetype = entries.length ? entries[0].filetype : "";
        this.next = function () {
            idx++;
            if (idx >= entries.length) { this.end = true; this.filename = ""; this.filetype = ""; }
            else { this.filename = entries[idx].filename; this.filetype = entries[idx].filetype; }
        };
        this.close = function () {};
    },
    File: function (fname, mode) {
        this.isopen = fakeFiles.hasOwnProperty(fname);
        this.eof = this.isopen ? fakeFiles[fname].length : 0;
        var self = this;
        this.readbytes = function (n) { return self.isopen ? fakeFiles[fname] : null; };
        this.readstring = function () { return self.isopen ? fakeFiles[fname] : ""; };
        this.writestring = function (s) { fakeFiles[fname] = s; };
        this.open = function () { this.isopen = true; };
        this.close = function () {};
    },
    Task: function (fn) { this.fn = fn; this.schedule = function () { /* smoke test never lets timers fire */ }; },
    mgraphics: new FakeMgraphics(),
    outlet: function () { outletCalls.push(Array.prototype.slice.call(arguments)); },
    embedmessage: function () { lastEmbeds.push(Array.prototype.slice.call(arguments)); },
    JSON: JSON,
    Math: Math,
    Date: Date,
    Number: Number,
    String: String,
    Array: Array,
    Object: Object,
    Boolean: Boolean,
    parseInt: parseInt,
    RegExp: RegExp,
    isNaN: isNaN,
    this: { patcher: { filepath: patcherFilepath } },
    // Max resolves `this.patcher` from inside plain function calls too --
    // it hangs off the global object, not just the top-level `this`.
    // Without this the config load/save path no-ops under test instead of
    // being exercised (configFilePath() would throw and return null).
    patcher: { filepath: patcherFilepath }
};
sandbox.global = sandbox;
var context = vm.createContext(sandbox);
sandbox.__context = context;

// drg-ui.js uses top-level `this.patcher.filepath` inside configFilePath(),
// which relies on the script's own top-level `this` binding. Running the
// whole file as a *function body* called with a specific `this` gets
// closest to how Max invokes jsui scripts (each callback runs with the
// jsui instance as `this`).
var code = fs.readFileSync(scriptPath, "utf8");
var wrapped = "(function(){\n" + code + "\n; return { bang: bang, folderdrop: folderdrop, aliastext: aliastext, adjustMaxMs: adjustMaxMs, resetCategory: resetCategory, rerollAll: rerollAll, rerollPad: rerollPad, toggleLock: toggleLock, removePack: removePack, reclassifyAll: reclassifyAll, effectivePadMap: effectivePadMap, cloneCategories: cloneCategories, save: save, restorepad: restorepad, STATE: STATE, DrgClassify: DrgClassify, onclick: onclick, paint: paint, loadGlobalConfig: loadGlobalConfig, saveGlobalConfig: saveGlobalConfig, filterRowY: filterRowY, stepperY: stepperY, stepperValueText: stepperValueText, configFilePath: configFilePath, assignPadSample: assignPadSample, loadedSamplePath: loadedSamplePath, pathEncodings: pathEncodings, LAYOUT: { RAIL_W: RAIL_W, PANEL_X: PANEL_X, PANEL_W: PANEL_W, MID_X: MID_X, TAB_ICON_H: TAB_ICON_H, DICE_Y: DICE_Y, DICE_H: DICE_H, AUDITION_Y: AUDITION_Y, CHECKBOX: CHECKBOX, TABS: TABS } }; })";
var factory = vm.runInContext(wrapped, context, { filename: scriptPath });
var api = factory.call({ patcher: { filepath: patcherFilepath } });

var pass = 0, fail = 0;
function test(name, fn) {
    try { fn(); pass++; console.log("  ok  - " + name); }
    catch (e) { fail++; console.log("FAIL  - " + name + "\n        " + (e && e.stack ? e.stack : e)); }
}

test("script loads and exposes its functions", function () {
    assert.strictEqual(typeof api.bang, "function");
    assert.strictEqual(typeof api.DrgClassify, "object");
});

test("effectivePadMap falls back to defaults with no overrides", function () {
    var map = api.effectivePadMap();
    assert.strictEqual(map.length, 16);
    assert.strictEqual(map[0].note, 36);
    assert.strictEqual(map[0].category, "kick");
});

test("effectivePadMap honors a per-pad category override", function () {
    api.STATE.padCategoryOverride[36] = "user1";
    var map = api.effectivePadMap();
    assert.strictEqual(map[0].category, "user1");
    delete api.STATE.padCategoryOverride[36];
});

test("aliastext replaces a category's alias list and reclassifies", function () {
    api.STATE.allFiles = [{ path: "/Kicks/thud.wav", durationMs: 200 }];
    api.STATE.editCategoryIndex = 0; // kick
    api.aliastext("thud boom");
    // The sandbox's Array is a different realm than this file's -- compare
    // by value, not deepStrictEqual's cross-realm reference check.
    assert.strictEqual(JSON.stringify(api.STATE.categories[0].aliases), JSON.stringify(["thud", "boom"]));
    assert.ok(api.STATE.lastRank.byCategory.kick.candidates.indexOf("/Kicks/thud.wav") >= 0);
});

test("resetCategory restores default aliases after aliastext changed them", function () {
    api.resetCategory();
    assert.deepStrictEqual(api.STATE.categories[0].aliases, api.DrgClassify.DEFAULT_CATEGORIES[0].aliases);
});

test("adjustMaxMs raises and floors at 50ms", function () {
    api.STATE.editCategoryIndex = 0;
    var before = api.STATE.categories[0].maxMs;
    api.adjustMaxMs(100);
    assert.strictEqual(api.STATE.categories[0].maxMs, before + 100);
    api.STATE.categories[0].maxMs = 60;
    api.adjustMaxMs(-1000);
    assert.strictEqual(api.STATE.categories[0].maxMs, 50);
});

test("save() embeds pad state via embedmessage (documented Max persistence hook)", function () {
    api.STATE.padSample[36] = "/Kicks/thud.wav";
    api.STATE.padLocked[38] = true;
    lastEmbeds.length = 0;
    api.save();
    assert.ok(lastEmbeds.some(function (call) { return call[0] === "restorepad"; }));
    var padCall = lastEmbeds.filter(function (c) { return c[0] === "restorepad"; })[0];
    var restored = JSON.parse(padCall[1]);
    assert.strictEqual(restored.padSample["36"], "/Kicks/thud.wav");
    assert.strictEqual(restored.padLocked["38"], true);
});

test("restorepad round-trips what save() embedded", function () {
    api.STATE.padSample = {};
    api.STATE.padLocked = {};
    var padCall = lastEmbeds.filter(function (c) { return c[0] === "restorepad"; })[0];
    api.restorepad(padCall[1]);
    assert.strictEqual(api.STATE.padSample["36"], "/Kicks/thud.wav");
    assert.strictEqual(api.STATE.padLocked["38"], true);
});

test("rerollAll and rerollPad are no-ops (not crashes) with no Drum Rack acquired", function () {
    api.STATE.rackPath = null;
    api.STATE.allFiles = [{ path: "/Kicks/a.wav", durationMs: 200 }];
    api.reclassifyAll();
    api.rerollAll(); // assignPadSample() returns {ok:false} for every pad -- must not throw
    api.rerollPad(36);
});

test("toggleLock flips and removePack drops files under that pack's path", function () {
    api.toggleLock(40);
    assert.strictEqual(api.STATE.padLocked[40], true);
    api.toggleLock(40);
    assert.strictEqual(api.STATE.padLocked[40], false);

    api.STATE.packs = [{ id: "p1", path: "/Kicks", name: "Kicks", fileCount: 1 }];
    api.STATE.allFiles = [{ path: "/Kicks/a.wav", durationMs: 200 }, { path: "/Snares/b.wav", durationMs: 200 }];
    api.removePack("p1");
    assert.strictEqual(api.STATE.packs.length, 0);
    assert.strictEqual(api.STATE.allFiles.length, 1);
    assert.strictEqual(api.STATE.allFiles[0].path, "/Snares/b.wav");
});

test("folderdrop scans a real nested tree via the actual Folder-backed adapter", function () {
    fakeDirs["/Packs/TestPack"] = { dirs: ["Kicks"], files: ["readme.txt"] };
    fakeDirs["/Packs/TestPack/Kicks"] = { dirs: [], files: ["kick1.wav"] };
    api.STATE.packs = [];
    api.STATE.allFiles = [];
    api.folderdrop("/Packs/TestPack");
    assert.strictEqual(api.STATE.packs.length, 1);
    assert.strictEqual(api.STATE.packs[0].fileCount, 1);
    assert.strictEqual(api.STATE.allFiles.length, 1);
    assert.strictEqual(api.STATE.allFiles[0].path, "/Packs/TestPack/Kicks/kick1.wav");
});

// ---- Hit-testing ------------------------------------------------------
//
// These exist because paint() and onclick() are separate code paths over
// the same coordinates, with nothing but discipline keeping them aligned.
// v0.1.1 shipped a checkbox drawn at y 82-94 whose click zone was still
// at y 104-116, so the visible control was simply dead. Every test below
// clicks where the control is DRAWN, derived from the same constants the
// painter uses.

test("clicking the audition checkbox where it is drawn toggles audition", function () {
    var L = api.LAYOUT;
    var before = api.STATE.auditionEnabled;
    api.onclick(L.MID_X + 10, L.AUDITION_Y + 2, 1);
    assert.strictEqual(api.STATE.auditionEnabled, !before, "audition did not toggle");
    api.onclick(L.MID_X + 10, L.AUDITION_Y + 2, 1);
    assert.strictEqual(api.STATE.auditionEnabled, before, "audition did not toggle back");
});

test("clicking the Reroll button zone does not toggle audition", function () {
    var L = api.LAYOUT;
    var before = api.STATE.auditionEnabled;
    api.onclick(L.MID_X + 10, L.DICE_Y + 2, 1);
    assert.strictEqual(api.STATE.auditionEnabled, before);
});

test("rail click selects each tab, including filters", function () {
    var L = api.LAYOUT;
    for (var i = 0; i < L.TABS.length; i++) {
        api.onclick(4, 8 + i * L.TAB_ICON_H + 2, 1);
        assert.strictEqual(api.STATE.tab, L.TABS[i], "rail row " + i);
    }
});

test("clicking the mode label cycles One-Shots -> Loops -> Other -> One-Shots", function () {
    var L = api.LAYOUT;
    api.STATE.tab = "filters";
    api.STATE.typeMode = "oneshots";
    api.onclick(L.PANEL_X + 10, 6, 1); // MODE_LABEL_Y..+H, see drg-ui.js
    assert.strictEqual(api.STATE.typeMode, "loops");
    api.onclick(L.PANEL_X + 10, 6, 1);
    assert.strictEqual(api.STATE.typeMode, "other");
    api.onclick(L.PANEL_X + 10, 6, 1);
    assert.strictEqual(api.STATE.typeMode, "oneshots");
});

test("clicking a Types row toggles exactly that mode's subcategory and nothing else", function () {
    var L = api.LAYOUT;
    api.STATE.tab = "filters";
    api.STATE.typeMode = "loops";
    var subcats = api.DrgClassify.TYPE_MODES.loops.subcats;

    for (var i = 0; i < subcats.length; i++) {
        var before = {};
        for (var k = 0; k < subcats.length; k++) before[subcats[k].id] = api.STATE.modeFilters.loops[subcats[k].id];

        api.onclick(L.PANEL_X + 10, api.filterRowY(i) + 2, 1);

        for (var k2 = 0; k2 < subcats.length; k2++) {
            var expected = k2 === i ? !before[subcats[k2].id] : before[subcats[k2].id];
            assert.strictEqual(api.STATE.modeFilters.loops[subcats[k2].id], expected,
                "clicking row " + i + " (" + subcats[i].id + ") changed " + subcats[k2].id);
        }
        api.onclick(L.PANEL_X + 10, api.filterRowY(i) + 2, 1); // restore
    }
});

test("the max-duration stepper adjusts only the active mode's ceiling", function () {
    var L = api.LAYOUT;
    api.STATE.tab = "filters";
    api.STATE.typeMode = "other";
    var before = api.STATE.modeMaxMs.other;
    var sy = api.stepperY("other");
    api.onclick(L.PANEL_X + L.PANEL_W - 10, sy + 4, 1); // "+"
    assert.strictEqual(api.STATE.modeMaxMs.other, before + 100);
    api.onclick(L.PANEL_X + L.PANEL_W - 35, sy + 4, 1); // "-"
    assert.strictEqual(api.STATE.modeMaxMs.other, before);
    assert.strictEqual(api.STATE.modeMaxMs.oneshots, api.DrgClassify.TYPE_MODES.oneshots.defaultMaxMs, "other modes' ceilings must be untouched");
});

test("turning every subcategory off reports it instead of silently emptying the rack", function () {
    var L = api.LAYOUT;
    api.STATE.tab = "filters";
    api.STATE.typeMode = "oneshots";
    var subcats = api.DrgClassify.TYPE_MODES.oneshots.subcats;
    for (var i = 0; i < subcats.length; i++) api.onclick(L.PANEL_X + 10, api.filterRowY(i) + 2, 1);

    assert.ok(api.STATE.statusIsError, "expected an error-styled status");
    assert.ok(/subcategories are off/i.test(api.STATE.status), "unhelpful status: " + api.STATE.status);

    for (var j = 0; j < subcats.length; j++) api.onclick(L.PANEL_X + 10, api.filterRowY(j) + 2, 1);
    assert.strictEqual(api.STATE.modeFilters.oneshots.kicks808, true);
});

test("Type-mode state round-trips through the global config; a config without it keeps defaults", function () {
    api.STATE.typeMode = "loops";
    api.STATE.modeFilters.loops.full = false;
    api.STATE.modeMaxMs.loops = 6000;
    api.saveGlobalConfig();
    api.STATE.typeMode = "oneshots";
    api.STATE.modeFilters.loops.full = true;
    api.STATE.modeMaxMs.loops = 8000;
    api.loadGlobalConfig();
    assert.strictEqual(api.STATE.typeMode, "loops", "saved mode did not round-trip");
    assert.strictEqual(api.STATE.modeFilters.loops.full, false, "saved subcategory did not round-trip");
    assert.strictEqual(api.STATE.modeMaxMs.loops, 6000, "saved ceiling did not round-trip");

    // A config written by a build predating Type modes (or the old v0.2.0
    // `filters` shape) must not wipe today's defaults out.
    api.STATE.typeMode = "oneshots";
    api.STATE.modeFilters.loops.full = true;
    api.STATE.modeMaxMs.loops = api.DrgClassify.TYPE_MODES.loops.defaultMaxMs;
    // Called unbound (not as api.configFilePath()) so `this` falls back to
    // the sandbox global, exactly as it does for drg-ui.js's own internal
    // callers -- otherwise it resolves a different path than saveGlobalConfig.
    var cfgPath = (0, api.configFilePath)();
    fakeFiles[cfgPath] = JSON.stringify({ categories: api.STATE.categories, packs: [] });
    api.loadGlobalConfig();
    assert.strictEqual(api.STATE.typeMode, "oneshots", "missing key should leave the default mode");
    assert.strictEqual(api.STATE.modeFilters.loops.full, true, "missing key should leave the default on");
    assert.strictEqual(api.STATE.modeMaxMs.loops, api.DrgClassify.TYPE_MODES.loops.defaultMaxMs, "missing key should leave the default ceiling");
});

test("painting every tab completes without throwing", function () {
    var L = api.LAYOUT;
    for (var i = 0; i < L.TABS.length; i++) {
        api.STATE.tab = L.TABS[i];
        posts.length = 0;
        api.paint();
        var threw = posts.filter(function (m) { return m.indexOf("paint() THREW") >= 0; });
        assert.strictEqual(threw.length, 0, L.TABS[i] + " tab: " + threw.join(" | "));
    }
});

// ---------------------------------------------------------------------
// v0.4.0: assignPadSample's self-verification. This is the actual root
// cause found this pass -- LiveAPI.call() never throws on failure in the
// real Max js engine, so the old code's try/catch around
// simpler.call("replace_sample", ...) could never fire, always returned
// { ok: true }, and every earlier pass reported "Sample loaded." over a
// Simpler that silently never got a sample. A minimal in-memory fake Live
// models just enough of the LiveAPI surface assignPadSample touches
// (chains/devices/get/set/call/getcount, keyed by path string) to prove
// the read-back now catches that failure instead of trusting the call.
// ---------------------------------------------------------------------
function makeFakeLive(options) {
    options = options || {};
    var replaceSampleSucceeds = options.replaceSampleSucceeds !== false;
    var chains = [];
    var nextId = 1;

    function FakeLiveAPI(p) {
        this.path = p;
        var chainMatch = /chains (\d+)/.exec(p);
        var chain = chainMatch ? chains[Number(chainMatch[1])] : null;
        var isDevicesRow = /devices \d+$/.test(p) && chain;
        var isSample = / sample$/.test(p) && chain;

        if (p === "fakerack") this.id = 999;
        else if (chainMatch && /chains \d+$/.test(p)) this.id = chain ? chain.id : 0;
        else if (isDevicesRow) this.id = chain && chain.device ? 100 + Number(chainMatch[1]) : 0;
        else if (isSample) this.id = chain && chain.device ? 200 + Number(chainMatch[1]) : 0;
        else this.id = 0;

        this.get = function (prop) {
            if (!chain) return null;
            if (prop === "in_note") return chain.inNote;
            if (prop === "class_name") return chain.device ? "Simpler" : "";
            if (prop === "file_path") return chain.device ? (chain.device.filePath || "") : "";
            return null;
        };
        this.set = function (prop, val) {
            if (chain && prop === "in_note") chain.inNote = val;
        };
        this.getcount = function (kind) {
            if (kind === "chains") return chains.length;
            if (kind === "devices") return chain && chain.device ? 1 : 0;
            return 0;
        };
        this.call = function (method) {
            var args = Array.prototype.slice.call(arguments, 1);
            if (method === "insert_chain") chains.push({ id: ++nextId, inNote: null, device: null });
            else if (method === "insert_device" && chain) chain.device = { filePath: "" };
            else if (method === "replace_sample" && chain && chain.device && replaceSampleSucceeds) chain.device.filePath = args[0];
            // replaceSampleSucceeds === false: deliberately a no-op, same as
            // a real Live build silently rejecting the write -- the exact
            // failure mode this test exists to catch.
        };
    }
    return FakeLiveAPI;
}

test("assignPadSample reports failure, not success, when replace_sample silently doesn't take", function () {
    api.STATE.rackPath = "fakerack";
    var savedLiveAPI = sandbox.LiveAPI;
    sandbox.LiveAPI = makeFakeLive({ replaceSampleSucceeds: false });
    try {
        var result = api.assignPadSample(36, "A:/Samples_Packs/Kicks/Kick 01.wav");
        assert.strictEqual(result.ok, false, "must not report ok:true when the sample never actually loaded");
        assert.ok(/did not take/.test(result.error), "error should name the real failure, not a generic one: " + result.error);
    } finally {
        sandbox.LiveAPI = savedLiveAPI;
        api.STATE.rackPath = null;
    }
});

test("assignPadSample reports success once the read-back confirms a non-empty file_path", function () {
    api.STATE.rackPath = "fakerack";
    var savedLiveAPI = sandbox.LiveAPI;
    sandbox.LiveAPI = makeFakeLive({ replaceSampleSucceeds: true });
    try {
        var result = api.assignPadSample(38, "A:/Samples_Packs/Snares/Snare 01.wav");
        assert.strictEqual(result.ok, true, "must report success once file_path reads back non-empty: " + (result.error || ""));
    } finally {
        sandbox.LiveAPI = savedLiveAPI;
        api.STATE.rackPath = null;
    }
});

test("classification runs on the pack-relative path, not the absolute scanned path", function () {
    // Before v0.4.0, reclassifyAll() passed the ABSOLUTE path as relPath,
    // so classifyFile()'s folder tier matched segments like "samples_packs"
    // and "downloaded" before it ever reached the real category folder
    // ("kicks"). A file sitting directly in a category-named folder must
    // classify by that folder, not fall through to filename/last-resort.
    // Reset mode/category state explicitly rather than relying on where
    // earlier tests in this file happened to leave it (STATE persists
    // across tests in this shared-sandbox harness).
    api.STATE.typeMode = "oneshots";
    api.STATE.modeFilters.oneshots = api.DrgClassify.defaultModeFilters("oneshots");
    api.STATE.modeMaxMs.oneshots = api.DrgClassify.TYPE_MODES.oneshots.defaultMaxMs;
    api.STATE.categories = api.cloneCategories(api.DrgClassify.DEFAULT_CATEGORIES);
    api.STATE.allFiles = [{ path: "A:/Samples_Packs/Downloaded Packs/Vendor/Kicks/909.wav", relPath: "Kicks/909.wav", durationMs: 200 }];
    api.reclassifyAll();
    // Sandbox Array is a different vm realm -- compare by value (see the
    // aliastext test above for the same established idiom in this file).
    var candidates = api.STATE.lastRank.byCategory.kick.candidates;
    assert.strictEqual(JSON.stringify(candidates), JSON.stringify(["A:/Samples_Packs/Downloaded Packs/Vendor/Kicks/909.wav"]), "ranked pool must contain the ABSOLUTE path (loadable), classified using the relative one");
});

test("Loops mode's stepper shows bars, per HANDOFF_SPEC ('4 Bars / 8000ms')", function () {
    assert.strictEqual(api.stepperValueText("loops", 8000), "4 Bars (8000ms)");
    assert.strictEqual(api.stepperValueText("oneshots", 1200), "1200 ms");
});

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
