// Node test runner for the pure-logic modules (classify, duration, scan).
// No Live, no Max, no dependencies -- run with: node test/run.js
"use strict";

var assert = require("assert");
var path = require("path");
var fs = require("fs");

var DrgClassify = require(path.join(__dirname, "..", "device", "drg-classify.js"));
var DrgDuration = require(path.join(__dirname, "..", "device", "drg-duration.js"));
var DrgScan = require(path.join(__dirname, "..", "device", "drg-scan.js"));

var pass = 0, fail = 0;

function test(name, fn) {
    try {
        fn();
        pass++;
        console.log("  ok  - " + name);
    } catch (e) {
        fail++;
        console.log("FAIL  - " + name);
        console.log("        " + (e && e.message ? e.message : e));
    }
}

console.log("== classify.js — segment matching & exclusion ==");

test("scratch.wav is unmatched (ch must not fire)", function () {
    var r = DrgClassify.classifyFile("scratch.wav", DrgClassify.DEFAULT_CATEGORIES);
    assert.strictEqual(r, null);
});

test("sidechain_bounce.wav is unmatched (side must not fire)", function () {
    var r = DrgClassify.classifyFile("sidechain_bounce.wav", DrgClassify.DEFAULT_CATEGORIES);
    assert.strictEqual(r, null);
});

test("/Hats/closed.wav classifies as hat_closed (plural folder normalization)", function () {
    var r = DrgClassify.classifyFile("/Hats/closed.wav", DrgClassify.DEFAULT_CATEGORIES);
    assert.ok(r && !r.excluded, "expected a match");
    assert.strictEqual(r.category, "hat_closed");
    assert.strictEqual(r.tier, "folder");
});

test("/kicks/thump_layer_hat.wav classifies as kick (folder beats filename)", function () {
    var r = DrgClassify.classifyFile("/kicks/thump_layer_hat.wav", DrgClassify.DEFAULT_CATEGORIES);
    assert.ok(r && !r.excluded, "expected a match");
    assert.strictEqual(r.category, "kick");
    assert.strictEqual(r.tier, "folder");
});

test("808_hat.wav classifies as hat_closed, not kick (last-resort tier is lowest priority)", function () {
    var r = DrgClassify.classifyFile("808_hat.wav", DrgClassify.DEFAULT_CATEGORIES);
    assert.ok(r && !r.excluded, "expected a match");
    assert.strictEqual(r.category, "hat_closed");
});

test("808_snare.wav classifies as snare (longest-token-wins saves it)", function () {
    var r = DrgClassify.classifyFile("808_snare.wav", DrgClassify.DEFAULT_CATEGORIES);
    assert.ok(r && !r.excluded);
    assert.strictEqual(r.category, "snare");
});

test("bare 808_perc.wav with no other alias falls to last-resort kick", function () {
    var r = DrgClassify.classifyFile("808_bounce.wav", DrgClassify.DEFAULT_CATEGORIES);
    assert.ok(r && !r.excluded);
    assert.strictEqual(r.category, "kick");
    assert.strictEqual(r.tier, "lastresort");
});

test("/kicks/loop_hat.wav classifies by role regardless of Type mode", function () {
    // classifyFile is pure role matching now -- Type-mode gating lives in
    // rankCandidates/isEligibleForMode, not here.
    var r = DrgClassify.classifyFile("/kicks/loop_hat.wav", DrgClassify.DEFAULT_CATEGORIES);
    assert.ok(r && !r.excluded, "expected a match");
    assert.strictEqual(r.category, "kick"); // folder tier beats the filename "hat"
});

// ---- Content-type tags & Type modes ------------------------------------
//
// v0.3.0: tags still come from the FILENAME only (unchanged from v0.2.0),
// but eligibility is now gated per exclusive Type mode (One-Shots / Loops
// / Other) via isEligibleForMode, not a flat set of switches.

var STEMS_KICK = "Loop Stems/Seaside Drum Loop - 84 BPM Kick.wav";

test("a folder named 'Loop Stems' no longer excludes the one-shots inside it", function () {
    // The regression that originally motivated this: a pack had 100% of
    // its files dropped because "loop" appeared in the folder path.
    assert.ok(
        DrgClassify.isEligibleForMode(STEMS_KICK, "loops", "kick", DrgClassify.defaultModeFilters("loops")),
        "filename says loop, so it belongs to Loops mode"
    );
    assert.ok(
        !DrgClassify.isEligibleForMode(STEMS_KICK, "oneshots", "kick", DrgClassify.defaultModeFilters("oneshots")),
        "loop-tagged content is not a one-shot even though the role matches kick"
    );

    var r2 = DrgClassify.classifyFile("Loop Collection/kick_01.wav", DrgClassify.DEFAULT_CATEGORIES);
    assert.ok(r2 && !r2.excluded, "folder says loop but the FILE does not -- must survive");
    assert.strictEqual(r2.category, "kick");
    assert.ok(
        DrgClassify.isEligibleForMode("Loop Collection/kick_01.wav", "oneshots", "kick", DrgClassify.defaultModeFilters("oneshots")),
        "folder-only 'loop' must not affect Type-mode eligibility -- filename decides"
    );
});

test("tagsForFile reads the filename only, never the folders", function () {
    assert.deepStrictEqual(DrgClassify.tagsForFile(STEMS_KICK), ["loop"]);
    assert.deepStrictEqual(DrgClassify.tagsForFile("Loop Collection/kick_01.wav"), ["other"]);
});

test("a plain one-shot is eligible in One-Shots mode only, gated by its category group", function () {
    assert.deepStrictEqual(DrgClassify.tagsForFile("Kicks/kick_01.wav"), ["other"]);
    var onFilters = DrgClassify.defaultModeFilters("oneshots");
    assert.ok(DrgClassify.isEligibleForMode("Kicks/kick_01.wav", "oneshots", "kick", onFilters));
    assert.ok(!DrgClassify.isEligibleForMode("Kicks/kick_01.wav", "loops", "kick", DrgClassify.defaultModeFilters("loops")));

    var kicks808Off = DrgClassify.defaultModeFilters("oneshots");
    kicks808Off.kicks808 = false;
    assert.ok(!DrgClassify.isEligibleForMode("Kicks/kick_01.wav", "oneshots", "kick", kicks808Off), "the kick's group switch must veto it");
});

test("a disabled loop subcategory vetoes a multi-tag file", function () {
    assert.deepStrictEqual(DrgClassify.tagsForFile("X/Fill Break.wav"), ["fill", "break"]);
    var offFill = DrgClassify.defaultModeFilters("loops");
    offFill.fill = false;
    var offBreak = DrgClassify.defaultModeFilters("loops");
    offBreak.break = false;
    assert.ok(!DrgClassify.isEligibleForMode("X/Fill Break.wav", "loops", null, offFill), "Fill off must veto");
    assert.ok(!DrgClassify.isEligibleForMode("X/Fill Break.wav", "loops", null, offBreak), "Break off must veto");
    assert.ok(DrgClassify.isEligibleForMode("X/Fill Break.wav", "loops", null, DrgClassify.defaultModeFilters("loops")));
});

test("percloop and bassloop are compound tags: a base loop-family tag AND a role token", function () {
    // "perc"/"bass"/"808" alone match no TAG_DEFS alias -- the compound
    // only fires once a real loop-family tag (e.g. "loop") is present too.
    assert.deepStrictEqual(DrgClassify.tagsForFile("Perc_Loop_120.wav"), ["loop", "percloop"]);
    assert.deepStrictEqual(DrgClassify.tagsForFile("Bass_808_Loop_C.wav"), ["loop", "bassloop"]);
});

test("a generic loop with no perc/bass token is not tagged percloop or bassloop", function () {
    assert.deepStrictEqual(DrgClassify.tagsForFile("Drum_Loop_120.wav"), ["loop"]);
});

test("Percussion Loops and Bass & 808 Loops subcategories gate on the compound tags", function () {
    assert.ok(DrgClassify.subcatsForFileInMode("Perc_Loop_120.wav", "loops", null).indexOf("percloop") !== -1);
    assert.ok(DrgClassify.subcatsForFileInMode("Bass_808_Loop_C.wav", "loops", null).indexOf("bassloop") !== -1);
    var offPercLoop = DrgClassify.defaultModeFilters("loops");
    offPercLoop.percloop = false;
    assert.ok(!DrgClassify.isEligibleForMode("Perc_Loop_120.wav", "loops", null, offPercLoop));
});

test("a generic loop with no specific subcategory falls back to Full Drum Loops", function () {
    assert.deepStrictEqual(DrgClassify.subcatsForFileInMode("Drum_Loop_120.wav", "loops", null), ["full"]);
});

test("'midi' is hard-excluded regardless of category or mode", function () {
    var r = DrgClassify.classifyFile("X/midi kick.wav", DrgClassify.DEFAULT_CATEGORIES);
    assert.ok(r && r.excluded === true);
    assert.strictEqual(r.reason, "midi");
});

test("whole-segment matching holds: stopwatch.wav is not a 'top'", function () {
    assert.deepStrictEqual(DrgClassify.tagsForFile("X/stopwatch.wav"), ["other"]);
});

test("omitting a mode from rankCandidates options applies no Type-mode gating", function () {
    var files = [{ relPath: "/kicks/loop_hat.wav", durationMs: 200 }];
    var r = DrgClassify.rankCandidates(files, DrgClassify.DEFAULT_CATEGORIES, null);
    assert.strictEqual(r.byCategory.kick.candidates.length, 1, "no mode option == every role match included");
});

test("Other mode's Unclassified bucket catches files with no role and no other-family tag", function () {
    // "noise" is now a real atmo alias (verified against real library data),
    // so this fixture must avoid it -- a genuinely tag-free name instead.
    assert.deepStrictEqual(DrgClassify.subcatsForFileInMode("Mystery_Object_42.wav", "other", null), ["unclassified"]);
    // A recognizable one-shot with no other-family tag is NOT unclassified -- it belongs to One-Shots mode.
    assert.deepStrictEqual(DrgClassify.subcatsForFileInMode("Kicks/kick_01.wav", "other", "kick"), []);
});

test("subcatCounts reflect every scanned file in the active mode, unchanged by that mode's switches", function () {
    var files = [
        { relPath: STEMS_KICK, durationMs: 200 },        // filename tags: loop -> Loops/full (catch-all)
        { relPath: "Kicks/kick_01.wav", durationMs: 200 }, // not loop-family -> not counted in Loops mode
        { relPath: "X/midi kick.wav", durationMs: 200 }    // hard-excluded
    ];
    var allOn = DrgClassify.rankCandidates(files, DrgClassify.DEFAULT_CATEGORIES, null, { mode: "loops", modeFilters: DrgClassify.defaultModeFilters("loops") });
    var fullOff = DrgClassify.defaultModeFilters("loops");
    fullOff.full = false;
    var withFullOff = DrgClassify.rankCandidates(files, DrgClassify.DEFAULT_CATEGORIES, null, { mode: "loops", modeFilters: fullOff });

    assert.strictEqual(allOn.subcatCounts.full, 1);
    // Counts must NOT move when a switch flips -- the panel shows them so
    // the user can see what turning a subcategory off is costing.
    assert.deepStrictEqual(withFullOff.subcatCounts, allOn.subcatCounts);
    // ...but the candidate pool must.
    assert.strictEqual(allOn.byCategory.kick.candidates.length, 1);
    assert.strictEqual(withFullOff.byCategory.kick.candidates.length, 0);
    assert.strictEqual(allOn.midiCount, 1);
});

test("rankCandidates' maxMs option layers on top of (never loosens) a category's own maxMs", function () {
    var files = [{ relPath: "Kicks/Full_Kick_Loop.wav", durationMs: 700 }]; // kick maxMs = 800, so role-only would pass
    var looseModeCeiling = DrgClassify.rankCandidates(files, DrgClassify.DEFAULT_CATEGORIES, null, {
        mode: "loops", modeFilters: DrgClassify.defaultModeFilters("loops"), maxMs: 5000
    });
    var tightModeCeiling = DrgClassify.rankCandidates(files, DrgClassify.DEFAULT_CATEGORIES, null, {
        mode: "loops", modeFilters: DrgClassify.defaultModeFilters("loops"), maxMs: 500
    });
    assert.strictEqual(looseModeCeiling.byCategory.kick.candidates.length, 1);
    assert.strictEqual(tightModeCeiling.byCategory.kick.candidates.length, 0, "500ms mode ceiling must drop a 700ms file even though the category's own 800ms cap would allow it");
});

test("isExcluded returns false (not a crash) for a file matching no category", function () {
    // classifyFile returns null there; isExcluded used to deref it blindly.
    assert.strictEqual(DrgClassify.isExcluded("scratch.wav"), false);
});

test("plural stripping only applies to segments, never rewrites aliases", function () {
    // "toms" folder should match the "tom" alias via stripping.
    var r = DrgClassify.classifyFile("/Toms/hit_04.wav", DrgClassify.DEFAULT_CATEGORIES);
    assert.strictEqual(r.category, "tom");
});

// ---------------------------------------------------------------------
// v0.4.0: real-data findings from segment-matching the alias tables
// against 40,000 filenames in the user's actual A:\Samples_Packs library.
// ---------------------------------------------------------------------

test("a generic 'hihat' with no qualifier still falls back to closed (regression guard)", function () {
    var r = DrgClassify.classifyFile("Hihat 01.wav", DrgClassify.DEFAULT_CATEGORIES);
    assert.strictEqual(r.category, "hat_closed");
});

test("'hihat open' and 'hihat pedal' classify by their qualifier, not by the longer 'hihat' token", function () {
    // Before genericAliases existed, "hihat" (6 chars) beat "open"/"pedal"
    // under plain longest-alias-wins, silently misclassifying every
    // explicitly-qualified hi-hat in the library as closed.
    assert.strictEqual(DrgClassify.classifyFile("Hihat Open 12.wav", DrgClassify.DEFAULT_CATEGORIES).category, "hat_open");
    assert.strictEqual(DrgClassify.classifyFile("Hihat Pedal 03.wav", DrgClassify.DEFAULT_CATEGORIES).category, "hat_pedal");
    assert.strictEqual(DrgClassify.classifyFile("Open Hihat 12.wav", DrgClassify.DEFAULT_CATEGORIES).category, "hat_open");
});

test("a bare 'cymbal' with no crash/ride qualifier falls back to crash via last-resort", function () {
    var r = DrgClassify.classifyFile("Cymbal Swell 01.wav", DrgClassify.DEFAULT_CATEGORIES);
    assert.strictEqual(r.category, "crash");
    assert.strictEqual(r.tier, "lastresort");
    // An explicit "ride" still wins on the normal tier -- last-resort never overrides a real match.
    assert.strictEqual(DrgClassify.classifyFile("Cymbal Ride 01.wav", DrgClassify.DEFAULT_CATEGORIES).category, "ride");
});

test("'roll', 'noise', 'verb'/'delay', and 'zap' are real tags added from library data", function () {
    assert.deepStrictEqual(DrgClassify.tagsForFile("Snare Roll 12.wav"), ["fill"]);
    assert.deepStrictEqual(DrgClassify.tagsForFile("Vinyl Noise Texture.wav"), ["atmo"]);
    assert.deepStrictEqual(DrgClassify.tagsForFile("Reverb Verb Tail.wav"), ["wet"]);
    assert.deepStrictEqual(DrgClassify.tagsForFile("Riser Zap 01.wav"), ["fx"]);
});

console.log("\n== classify.js — ranking & pad assignment ==");

test("one tom in the library fills note 41 only; 43/45/47 reported empty", function () {
    var files = [
        { relPath: "/Toms/only_tom.wav", durationMs: 400 }
    ];
    var ranked = DrgClassify.rankCandidates(files, DrgClassify.DEFAULT_CATEGORIES, null);
    var assignments = DrgClassify.assignToPads(ranked, DrgClassify.PAD_MAP, {});
    var toms = assignments.filter(function (a) { return a.category === "tom"; });
    assert.strictEqual(toms.length, 4);
    var filled = toms.filter(function (t) { return !t.empty; });
    var empty = toms.filter(function (t) { return t.empty; });
    assert.strictEqual(filled.length, 1);
    assert.strictEqual(filled[0].note, 41);
    assert.strictEqual(empty.length, 3);
});

test("same input + same seed produces an identical kit", function () {
    var files = [
        { relPath: "/Kicks/a.wav", durationMs: 200 },
        { relPath: "/Kicks/b.wav", durationMs: 200 },
        { relPath: "/Kicks/c.wav", durationMs: 200 },
        { relPath: "/Snares/a.wav", durationMs: 200 },
        { relPath: "/Snares/b.wav", durationMs: 200 }
    ];
    var r1 = DrgClassify.rankCandidates(files, DrgClassify.DEFAULT_CATEGORIES, 42);
    var r2 = DrgClassify.rankCandidates(files, DrgClassify.DEFAULT_CATEGORIES, 42);
    assert.deepStrictEqual(r1.byCategory.kick.candidates, r2.byCategory.kick.candidates);
    assert.deepStrictEqual(r1.byCategory.snare.candidates, r2.byCategory.snare.candidates);
});

test("blank seed is purely path-sorted (deterministic, no shuffle)", function () {
    var files = [
        { relPath: "/Kicks/z.wav", durationMs: 200 },
        { relPath: "/Kicks/a.wav", durationMs: 200 },
        { relPath: "/Kicks/m.wav", durationMs: 200 }
    ];
    var r = DrgClassify.rankCandidates(files, DrgClassify.DEFAULT_CATEGORIES, null);
    assert.deepStrictEqual(r.byCategory.kick.candidates, ["/Kicks/a.wav", "/Kicks/m.wav", "/Kicks/z.wav"]);
});

test("a candidate longer than the category's max length is dropped (loop filter)", function () {
    var files = [{ relPath: "/Kicks/long_kick.wav", durationMs: 5000 }]; // kick maxMs = 800
    var r = DrgClassify.rankCandidates(files, DrgClassify.DEFAULT_CATEGORIES, null);
    assert.strictEqual(r.byCategory.kick.candidates.length, 0);
});

test("unknown duration is included and counted separately, never dropped", function () {
    var files = [{ relPath: "/Kicks/mystery.mp3", durationMs: null }];
    var r = DrgClassify.rankCandidates(files, DrgClassify.DEFAULT_CATEGORIES, null);
    assert.strictEqual(r.byCategory.kick.candidates.length, 1);
    assert.strictEqual(r.byCategory.kick.unknownDurationCount, 1);
});

test("a locked pad's sample survives reassignment", function () {
    var files = [{ relPath: "/Kicks/a.wav", durationMs: 200 }];
    var r = DrgClassify.rankCandidates(files, DrgClassify.DEFAULT_CATEGORIES, null);
    var assignments = DrgClassify.assignToPads(r, DrgClassify.PAD_MAP, { 36: "/Kicks/locked_in.wav" });
    var pad36 = assignments.filter(function (a) { return a.note === 36; })[0];
    assert.strictEqual(pad36.path, "/Kicks/locked_in.wav");
    assert.strictEqual(pad36.locked, true);
});

console.log("\n== duration.js — header parsing ==");

function fixture(name) {
    return fs.readFileSync(path.join(__dirname, "fixtures", name));
}

test("WAV fixture (44.1kHz, 16-bit, mono, exactly 0.5s of data) parses to ~500ms", function () {
    var bytes = fixture("tone_500ms.wav");
    var ms = DrgDuration.getDurationMs("tone_500ms.wav", bytes);
    assert.ok(ms !== null, "expected a parsed duration");
    assert.ok(Math.abs(ms - 500) < 2, "expected ~500ms, got " + ms);
});

test("AIFF fixture (44.1kHz, 16-bit, mono, 0.25s) parses to ~250ms", function () {
    var bytes = fixture("tone_250ms.aiff");
    var ms = DrgDuration.getDurationMs("tone_250ms.aiff", bytes);
    assert.ok(ms !== null, "expected a parsed duration");
    assert.ok(Math.abs(ms - 250) < 2, "expected ~250ms, got " + ms);
});

test("FLAC fixture (44.1kHz, 0.3s) parses to ~300ms", function () {
    var bytes = fixture("tone_300ms.flac");
    var ms = DrgDuration.getDurationMs("tone_300ms.flac", bytes);
    assert.ok(ms !== null, "expected a parsed duration");
    assert.ok(Math.abs(ms - 300) < 5, "expected ~300ms, got " + ms);
});

test("MP3 returns null (unknown, not guessed)", function () {
    var ms = DrgDuration.getDurationMs("something.mp3", Buffer.from([0, 1, 2, 3]));
    assert.strictEqual(ms, null);
});

test("a truncated/malformed WAV header returns null, never throws", function () {
    var ms = DrgDuration.getDurationMs("broken.wav", Buffer.from("RIFF"));
    assert.strictEqual(ms, null);
});

console.log("\n== scan.js — pruning walker ==");

test("dot-directories and known noise dirs are pruned", function () {
    var fakeFs = {
        "/root": { dirs: [".git", "Kicks", "node_modules", "unins000"], files: ["readme.txt"] },
        "/root/Kicks": { dirs: [], files: ["kick_01.wav", "kick_02.wav"] }
    };
    var adapter = { listDir: function (p) { return fakeFs[p] || { dirs: [], files: [] }; } };
    var isAudio = function (n) { return /\.wav$/i.test(n); };
    var scanner = DrgScan.createScanner("/root", adapter, isAudio);
    var results = scanner.runToCompletion(10);
    var paths = results.map(function (r) { return r.path; }).sort();
    assert.deepStrictEqual(paths, ["/root/Kicks/kick_01.wav", "/root/Kicks/kick_02.wav"]);
});

test("chunked step() makes progress without completing the whole tree at once", function () {
    var fakeFs = { "/root": { dirs: ["A", "B", "C"], files: [] }, "/root/A": { dirs: [], files: [] }, "/root/B": { dirs: [], files: [] }, "/root/C": { dirs: [], files: [] } };
    var adapter = { listDir: function (p) { return fakeFs[p] || { dirs: [], files: [] }; } };
    var scanner = DrgScan.createScanner("/root", adapter, function () { return false; });
    var first = scanner.step(1);
    assert.strictEqual(first.done, false);
    var second = scanner.step(10);
    assert.strictEqual(second.done, true);
});

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
