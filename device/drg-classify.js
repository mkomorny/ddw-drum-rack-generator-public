// drg-classify.js
//
// Pure classification logic for DDW Drum Rack Generator. No Max/Live
// dependency of any kind -- this file runs unmodified under plain `node`
// (see test/) and is pulled into the Max `js` runtime via include().
//
// Two independent axes, both driven by segment-matching (see below):
//   1. ROLE      -- which pad a file is a candidate for (kick/snare/hat/...),
//                    via classifyFile()'s alias matching against category
//                    definitions. Unaffected by Type mode.
//   2. TYPE MODE -- which of the three Type-tab modes (One-Shots / Loops /
//                    Other) a file's content belongs to, via tagsForFile()'s
//                    filename-token tags, gated per mode by user-editable
//                    subcategory switches (TYPE_MODES). A file can have a
//                    role AND still be excluded because it doesn't belong to
//                    the currently active mode -- e.g. "Kick_Loop_909.wav"
//                    matches the kick role but is loop-family content, so it
//                    is only eligible while Loops mode is active.
//
// Pipeline (see IMPLEMENTATION-PLAN.md "The classifier"):
//   1. segment  -- split path into lowercased alphanumeric segments
//   2. tag      -- label the file by CONTENT TYPE from its FILENAME
//                  segments (loop/fill/break/wet/full/top/fx/atmo/tonal/
//                  vocal, plus compound percloop/bassloop), else "other"
//   3. classify -- role match: folder-segment beats filename-segment;
//                  longest alias wins within a tier
//   4. gate     -- (rankCandidates only) drop the file if it doesn't belong
//                  to the active Type mode, or a subcategory switch it needs
//                  is off, or it is hard-excluded (midi)
//   5. rank     -- per category, path-sorted (or seeded-shuffled) list
//
// WHY TAGS COME FROM THE FILENAME ONLY, never the containing folders:
// a real vendor "stems" pack (every one-shot named after its parent
// loop, e.g. "Seaside Drum Loop - 84 BPM Kick.wav" inside a "Loop
// Stems" folder) got 100% of its files excluded, because the old rule
// matched "loop" anywhere in the full path. Folder names describe the
// pack/product ("... Loop Collection"); filenames describe the file.
// Only the filename gets a vote.
//
// WHY A DISABLED SUBCATEGORY VETOES: a file carrying several Type-mode
// tags ("Fill Break.wav" -> fill, break, both Loops subcategories) is
// included only if EVERY one of its matched subcategories is enabled.
// These switches exist so a user can say "no fills on my pads"; a file
// that says "fill" should not slip through on the strength of some
// other subcategory it also happens to carry.
//
// Whole-segment matching only -- never substring. Short aliases like "ch"
// or "side" would otherwise fire inside "scratch.wav" or
// "sidechain_bounce.wav". Plural normalization (a single trailing "s"
// stripped, tried in addition to the verbatim segment) exists because
// sample-pack folders are almost always named in the plural ("/Hats/",
// "/Kicks/"), and folder match is the strongest scoring signal -- without
// it, whole-segment matching would silently disable that signal.

(function (global) {
    "use strict";

    // ---- Default category definitions -------------------------------
    //
    // 11 predefined categories + 3 blank user categories = 14, matching
    // the manual's scheme. The pad map below gives Snare, Tom, and Perc
    // more than one pad each (2, 4, and 2 respectively) which is why 11
    // categories cover 16 pads. Shaker/tambourine aliases live in "perc"
    // rather than a 12th category -- pad 50 still defaults to "perc" and
    // simply takes the next candidate in that category's ranked list
    // after pad 48, the same way the four Tom pads share one category.
    var DEFAULT_CATEGORIES = [
        { id: "kick", label: "Kick", aliases: ["kick", "kik", "bassdrum", "bd"], maxMs: 800 },
        { id: "rim", label: "Rim / Side", aliases: ["sidestick", "rimshot", "rim", "side"], maxMs: 500 },
        { id: "snare", label: "Snare", aliases: ["snare", "sd", "sn"], maxMs: 800 },
        { id: "clap", label: "Clap / Snap", aliases: ["clap", "snap", "cp"], maxMs: 600 },
        { id: "tom", label: "Tom", aliases: ["tom", "ftom", "rtom"], maxMs: 1200 },
        // genericAliases: "hihat"/"hat" name the whole instrument, not a
        // specific position -- a file that also carries "open" or "pedal"
        // should classify there instead, even though "hihat" is the longer
        // string. See classifyFile()'s specific-before-generic pass: these
        // are only used as a fallback when no category's specific alias
        // matched anywhere in the same tier. Confirmed against real library
        // data: "Hihat Open.wav" / "Hihat Pedal.wav" were both silently
        // misclassified as closed before this existed (longest-alias-wins
        // had no way to prefer the qualifier over the generic name).
        { id: "hat_closed", label: "Hat Closed", aliases: ["closedhat", "closed", "hihat", "hat", "hh", "ch"], genericAliases: ["hihat", "hat"], maxMs: 400 },
        { id: "hat_pedal", label: "Hat Pedal", aliases: ["pedalhat", "pedal", "phh"], maxMs: 400 },
        { id: "hat_open", label: "Hat Open", aliases: ["openhat", "open", "oh"], maxMs: 1200 },
        { id: "perc", label: "Perc", aliases: ["perc", "conga", "bongo", "tambourine", "shaker", "tamb"], maxMs: 1200 },
        { id: "crash", label: "Crash", aliases: ["crash", "cr"], maxMs: 3000 },
        { id: "ride", label: "Ride", aliases: ["ride", "rd"], maxMs: 3000 },
        { id: "user1", label: "User 1", aliases: [], maxMs: 2000 },
        { id: "user2", label: "User 2", aliases: [], maxMs: 2000 },
        { id: "user3", label: "User 3", aliases: [], maxMs: 2000 }
    ];

    // Pad map: notes 36-51, Ableton's visible 4x4 (bottom-left = C1 = 36).
    // "family" pads share one category id and are filled in ascending
    // note order from that category's ranked candidate list.
    var PAD_MAP = [
        { note: 36, category: "kick" },
        { note: 37, category: "rim" },
        { note: 38, category: "snare" },
        { note: 39, category: "clap" },
        { note: 40, category: "snare" },
        { note: 41, category: "tom" },
        { note: 42, category: "hat_closed" },
        { note: 43, category: "tom" },
        { note: 44, category: "hat_pedal" },
        { note: 45, category: "tom" },
        { note: 46, category: "hat_open" },
        { note: 47, category: "tom" },
        { note: 48, category: "perc" },
        { note: 49, category: "crash" },
        { note: 50, category: "perc" },
        { note: 51, category: "ride" }
    ];

    // ---- Content-type tags -------------------------------------------
    //
    // Each tag definition is a key plus a list of filename-segment aliases
    // that trigger it (see tagsForFile). A file matching none of these is
    // tagged OTHER_TAG. "percloop" and "bassloop" are compound: they only
    // fire on TOP of an existing loop-family tag, since single-segment
    // whole-word matching can't express "a loop that is also percussive"
    // as one alias (see tagsForFile's compound pass below).
    // Alias lists verified against 40,000 real filenames from the user's
    // A:\Samples_Packs library (segment-matched, not substring) before
    // being added -- "roll"/"noise"/"verb"/"delay"/"zap" all clear real,
    // non-trivial hit counts there. "synth" and "hit" appear in
    // HANDOFF_SPEC.md's Tonal list but were deliberately left out: "synth"
    // alone matches 2300+ files in this library (most of them melodic
    // Splice content, not drum-adjacent stabs) and would flood Other mode.
    var TAG_DEFS = [
        { key: "loop", aliases: ["loop"] },
        { key: "fill", aliases: ["fill", "roll"] },
        { key: "break", aliases: ["break"] },
        { key: "wet", aliases: ["wet", "verb", "delay"] },
        { key: "full", aliases: ["full"] },
        { key: "top", aliases: ["top"] },
        { key: "fx", aliases: ["fx", "sweep", "riser", "rise", "uplifter", "downlifter", "zap"] },
        { key: "atmo", aliases: ["atmo", "atmosphere", "ambient", "texture", "vinyl", "dust", "crackle", "noise"] },
        { key: "tonal", aliases: ["chord", "stab", "tonal", "pluck"] },
        { key: "vocal", aliases: ["vocal", "vox", "chop", "glitch", "chant"] }
    ];
    var OTHER_TAG = "other";

    // Compound tags: only added when a base loop-family tag is already
    // present AND a role token also matches. Not switchable directly on
    // their own alias list -- they exist purely to let Loops mode split
    // "generic loop" into finer subcategories.
    var PERC_LOOP_TOKENS = ["perc", "percussion", "conga", "bongo"];
    var BASS_LOOP_TOKENS = ["bass", "808", "sub"];

    // Hard exclusions -- dropped no matter what mode or switches say, and
    // deliberately given no switch. (Note isAudioFile already keeps real
    // .mid files out; this catches audio files *named* "midi".)
    var HARD_EXCLUDE_TOKENS = ["midi"];

    var AUDIO_EXTS = [".wav", ".aif", ".aiff", ".flac", ".mp3", ".ogg", ".m4a"];

    // ---- Type-tab modes -------------------------------------------------
    //
    // Single source of truth for the Types tab's dropdown, subcategory
    // rows, and max-duration stepper -- shared by drg-ui.js (drawing +
    // hit-testing) and the tests, the same "one place, not duplicated"
    // discipline drg-ui.js's own TABS array follows.
    //
    // Modes are EXCLUSIVE: only the active mode's content is eligible for
    // pad-filling at all (see isEligibleForMode). oneshots' subcategories
    // reuse the existing role categories (grouped) rather than inventing a
    // parallel tagging scheme; loops/other subcategories are content tags.
    var TYPE_MODES = {
        oneshots: {
            label: "One-Shots",
            defaultMaxMs: 1200,
            subcats: [
                { id: "kicks808", label: "Kicks & 808s", categoryIds: ["kick"] },
                { id: "snaresrims", label: "Snares & Rims", categoryIds: ["snare", "rim"] },
                { id: "clapssnaps", label: "Claps & Snaps", categoryIds: ["clap"] },
                { id: "hats", label: "Hi-Hats (Clsd/Open)", categoryIds: ["hat_closed", "hat_pedal", "hat_open"] },
                { id: "toms", label: "Toms (Hi/Mid/Low)", categoryIds: ["tom"] },
                { id: "percshakers", label: "Perc & Shakers", categoryIds: ["perc"] },
                { id: "cymbals", label: "Cymbals (Crash/Ride)", categoryIds: ["crash", "ride"] }
            ]
        },
        loops: {
            label: "Loops",
            defaultMaxMs: 8000,
            subcats: [
                { id: "full", label: "Full Drum Loops", tag: "full" },
                { id: "top", label: "Top Loops (No Kick)", tag: "top" },
                { id: "percloop", label: "Percussion Loops", tag: "percloop" },
                { id: "bassloop", label: "Bass & 808 Loops", tag: "bassloop" },
                { id: "fill", label: "Drum Fills & Rolls", tag: "fill" },
                { id: "break", label: "Breaks & Vintage Chops", tag: "break" }
            ]
        },
        other: {
            label: "Other",
            defaultMaxMs: 2500,
            subcats: [
                { id: "fx", label: "FX, Sweeps & Risers", tag: "fx" },
                { id: "atmo", label: "Atmospheres & Vinyl", tag: "atmo" },
                { id: "tonal", label: "Tonal Chords & Stabs", tag: "tonal" },
                { id: "vocal", label: "Vocal Chops & Glitches", tag: "vocal" },
                { id: "wet", label: "Wet / Processed Tails", tag: "wet" },
                { id: "unclassified", label: "Unclassified Filenames", tag: null }
            ]
        }
    };
    var TYPE_MODE_ORDER = ["oneshots", "loops", "other"];

    // A file belongs to Loops/Other mode only via these tags; membership in
    // neither family (and no role match, for Other) is what "unclassified"
    // means. Order matters for loop subcategory selection: the more
    // specific tags are checked before falling back to generic "loop".
    var LOOP_FAMILY = ["loop", "full", "top", "percloop", "bassloop", "fill", "break"];
    var LOOP_SUBCAT_ORDER = ["full", "top", "percloop", "bassloop", "fill", "break"];
    var OTHER_FAMILY = ["fx", "atmo", "tonal", "vocal", "wet"];
    var OTHER_SUBCAT_ORDER = ["fx", "atmo", "tonal", "vocal", "wet"];

    // Last-resort tier: applied only to files no real alias matched.
    // "cymbal" is a genuine judgment call, flagged rather than silent --
    // a bare "Cymbal Swell.wav" gives no signal for crash vs. ride, so it
    // defaults to crash (116 real hits in the user's library carry no
    // other qualifier); any file that also says "ride" still wins on the
    // normal tier since last-resort only applies when nothing else matched.
    var LAST_RESORT = [{ token: "808", category: "kick" }, { token: "cymbal", category: "crash" }];

    // ---- Segmenting ---------------------------------------------------

    function segmentString(s) {
        return String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter(function (t) { return t.length > 0; });
    }

    function stripTrailingS(seg) {
        if (seg.length > 1 && seg.charAt(seg.length - 1) === "s") return seg.slice(0, -1);
        return seg;
    }

    // Splits a path into folder segments and filename segments separately,
    // since folder match outranks filename match. Accepts either slash style.
    function splitPathParts(fullPath) {
        var p = String(fullPath || "").replace(/\\/g, "/");
        var lastSlash = p.lastIndexOf("/");
        var dirPart = lastSlash >= 0 ? p.slice(0, lastSlash) : "";
        var basePart = lastSlash >= 0 ? p.slice(lastSlash + 1) : p;
        return {
            folderSegments: segmentString(dirPart),
            filenameSegments: segmentString(basePart)
        };
    }

    // A segment "matches" an alias if it equals the alias verbatim OR
    // with a single trailing "s" stripped (in either direction is not
    // needed -- stripping only ever applies to the segment, never to the
    // stored alias, per the plan: "Stripping is match-time only; it never
    // rewrites the stored path").
    function segmentMatchesAlias(segment, alias) {
        if (segment === alias) return true;
        if (stripTrailingS(segment) === alias) return true;
        return false;
    }

    function segmentsMatchAny(segments, tokens) {
        for (var s = 0; s < segments.length; s++) {
            for (var t = 0; t < tokens.length; t++) {
                if (segmentMatchesAlias(segments[s], tokens[t])) return true;
            }
        }
        return false;
    }

    function hasAny(list, tokens) {
        for (var i = 0; i < list.length; i++) {
            if (tokens.indexOf(list[i]) !== -1) return true;
        }
        return false;
    }

    // ---- Content-type tagging -------------------------------------------

    // Content-type tags for a file, from its FILENAME segments only.
    // Always returns at least one tag: a file matching no TAG_DEFS is
    // a plain one-shot and comes back as [OTHER_TAG]. percloop/bassloop
    // are compound -- added on top of a base loop-family tag when a role
    // token also matches (see PERC_LOOP_TOKENS / BASS_LOOP_TOKENS above).
    function tagsForFile(relPath) {
        var filenameSegments = splitPathParts(relPath).filenameSegments;
        var tags = [];
        for (var t = 0; t < TAG_DEFS.length; t++) {
            if (segmentsMatchAny(filenameSegments, TAG_DEFS[t].aliases)) tags.push(TAG_DEFS[t].key);
        }
        if (tags.length === 0) return [OTHER_TAG];

        if (hasAny(tags, LOOP_FAMILY)) {
            if (segmentsMatchAny(filenameSegments, PERC_LOOP_TOKENS)) tags.push("percloop");
            if (segmentsMatchAny(filenameSegments, BASS_LOOP_TOKENS)) tags.push("bassloop");
        }
        return tags;
    }

    // True if the file is dropped regardless of mode or any switch.
    function isHardExcluded(relPath) {
        var filenameSegments = splitPathParts(relPath).filenameSegments;
        for (var h = 0; h < HARD_EXCLUDE_TOKENS.length; h++) {
            for (var s = 0; s < filenameSegments.length; s++) {
                if (segmentMatchesAlias(filenameSegments[s], HARD_EXCLUDE_TOKENS[h])) return true;
            }
        }
        return false;
    }

    // ---- Role classification ---------------------------------------------

    // Returns one of:
    //   { excluded: true, reason: "midi" }
    //   { category: id, tier: "folder"|"filename"|"lastresort", token: alias }
    //   null   -- no match at all, not excluded
    //
    // Pure role matching -- content-type/mode gating happens separately in
    // rankCandidates, not here.
    function classifyFile(relPath, categories) {
        if (isHardExcluded(relPath)) {
            return { excluded: true, reason: "midi" };
        }

        var parts = splitPathParts(relPath);
        var allSegments = parts.folderSegments.concat(parts.filenameSegments);

        var best = null; // { category, tier, tokenLen, token, categoryIndex }

        // Two passes per tier: specific aliases first, generic aliases
        // (a category's optional genericAliases list, e.g. hat_closed's
        // "hihat"/"hat") only considered if NO specific alias matched
        // anywhere in this tier. Without this, "Hihat Open.wav" loses to
        // hat_closed just because "hihat" (6 chars) is longer than "open"
        // (4) under plain longest-alias-wins -- confirmed as a real
        // misclassification against the user's actual sample library.
        function considerTier(segments, tierName, allowGeneric) {
            var found = null;
            for (var ci = 0; ci < categories.length; ci++) {
                var cat = categories[ci];
                var aliases = cat.aliases || [];
                var generic = cat.genericAliases || [];
                for (var ai = 0; ai < aliases.length; ai++) {
                    var alias = String(aliases[ai]).toLowerCase();
                    if (!alias) continue;
                    var isGeneric = generic.indexOf(aliases[ai]) !== -1;
                    if (isGeneric && !allowGeneric) continue;
                    for (var si = 0; si < segments.length; si++) {
                        if (segmentMatchesAlias(segments[si], alias)) {
                            var candidate = { category: cat.id, tier: tierName, tokenLen: alias.length, token: alias, categoryIndex: ci };
                            if (!found) {
                                found = candidate;
                            } else if (tierBetter(candidate, found)) {
                                found = candidate;
                            }
                        }
                    }
                }
            }
            return found;
        }

        // Folder tier takes priority: only fall through to filename tier
        // if nothing matched in the folder segments at all. Within each
        // tier, specific aliases are tried before generic ones.
        best = considerTier(parts.folderSegments, "folder", false) || considerTier(parts.folderSegments, "folder", true);
        if (!best) best = considerTier(parts.filenameSegments, "filename", false) || considerTier(parts.filenameSegments, "filename", true);

        if (best) return { category: best.category, tier: best.tier, token: best.token };

        // Last resort, only when nothing above matched anything.
        for (var l = 0; l < LAST_RESORT.length; l++) {
            for (var si2 = 0; si2 < allSegments.length; si2++) {
                if (segmentMatchesAlias(allSegments[si2], LAST_RESORT[l].token)) {
                    return { category: LAST_RESORT[l].category, tier: "lastresort", token: LAST_RESORT[l].token };
                }
            }
        }

        return null;
    }

    // true if `a` should win over current best `b` within the same
    // classifyFile() call. Folder beats filename (caller already only
    // compares within one tier at a time via the two considerTier calls,
    // but this also resolves same-tier ties): longest token wins;
    // otherwise first-defined category wins (deterministic, documented).
    function tierBetter(a, b) {
        if (a.tokenLen !== b.tokenLen) return a.tokenLen > b.tokenLen;
        return a.categoryIndex < b.categoryIndex;
    }

    // Note the `r &&` guard: classifyFile returns null for a file that
    // matched no category at all, and that is not the same thing as
    // being excluded.
    function isExcluded(relPath) {
        var r = classifyFile(relPath, DEFAULT_CATEGORIES);
        return !!(r && r.excluded === true);
    }

    function isAudioFile(name) {
        var lower = String(name || "").toLowerCase();
        for (var i = 0; i < AUDIO_EXTS.length; i++) {
            if (lower.slice(-AUDIO_EXTS[i].length) === AUDIO_EXTS[i]) return true;
        }
        return false;
    }

    // ---- Type-mode gating -------------------------------------------------
    //
    // Which subcategory bucket(s) of the given mode a file belongs to,
    // independent of any switch -- same "always show the truth" principle
    // the old tagCounts followed: used to compute live per-subcategory
    // counts in the Types panel before any filter is applied. Returns [] if
    // the file has no content in this mode at all (i.e. it belongs to a
    // different mode).
    function subcatsForFileInMode(relPath, mode, categoryId) {
        var tags = tagsForFile(relPath);

        if (mode === "oneshots") {
            if (hasAny(tags, LOOP_FAMILY) || hasAny(tags, OTHER_FAMILY)) return [];
            if (!categoryId) return [];
            var group = oneshotGroupForCategory(categoryId);
            return group ? [group] : ["__ungrouped__"]; // user1-3: no switch, always eligible
        }

        if (mode === "loops") {
            if (!hasAny(tags, LOOP_FAMILY)) return [];
            var loopKeys = [];
            for (var i = 0; i < LOOP_SUBCAT_ORDER.length; i++) {
                if (tags.indexOf(LOOP_SUBCAT_ORDER[i]) !== -1) loopKeys.push(LOOP_SUBCAT_ORDER[i]);
            }
            // Generic "loop" with no more specific sub-tag falls back to
            // the "Full Drum Loops" bucket rather than being invisible.
            if (loopKeys.length === 0 && tags.indexOf("loop") !== -1) loopKeys.push("full");
            return loopKeys;
        }

        if (mode === "other") {
            if (hasAny(tags, LOOP_FAMILY)) return []; // loop-family content belongs to Loops mode only
            var otherKeys = [];
            for (var j = 0; j < OTHER_SUBCAT_ORDER.length; j++) {
                if (tags.indexOf(OTHER_SUBCAT_ORDER[j]) !== -1) otherKeys.push(OTHER_SUBCAT_ORDER[j]);
            }
            // No other-family tag and no recognizable role: genuinely
            // unclassified junk, not a plain one-shot (that belongs to
            // One-Shots mode instead).
            if (otherKeys.length === 0 && !categoryId) otherKeys.push("unclassified");
            return otherKeys;
        }

        return [];
    }

    function oneshotGroupForCategory(categoryId) {
        var subcats = TYPE_MODES.oneshots.subcats;
        for (var i = 0; i < subcats.length; i++) {
            var ids = subcats[i].categoryIds || [];
            if (ids.indexOf(categoryId) !== -1) return subcats[i].id;
        }
        return null;
    }

    // True if the file should be eligible for pad-filling under the given
    // mode and its current subcategory switches. A file carrying several
    // subcategory tags (see tagsForFile's compound pass) is included only
    // if EVERY one of them is enabled -- same veto philosophy as v0.2.0's
    // content-type filters. "__ungrouped__" (blank user1-3 categories) has
    // no switch and is always eligible.
    function isEligibleForMode(relPath, mode, categoryId, modeFilters) {
        var subcats = subcatsForFileInMode(relPath, mode, categoryId);
        if (subcats.length === 0) return false;
        modeFilters = modeFilters || {};
        for (var i = 0; i < subcats.length; i++) {
            if (subcats[i] === "__ungrouped__") continue;
            if (modeFilters[subcats[i]] === false) return false;
        }
        return true;
    }

    function defaultModeFilters(mode) {
        var f = {};
        var subcats = TYPE_MODES[mode] ? TYPE_MODES[mode].subcats : [];
        for (var i = 0; i < subcats.length; i++) f[subcats[i].id] = true;
        return f;
    }

    // ---- Seeded shuffle (mulberry32) -------------------------------------
    // Blank/undefined seed = no shuffle, purely path-sorted, deterministic.
    // A given seed reshuffles the candidate list *within each category
    // only*, so "surprise me" stays reproducible.

    function mulberry32(seed) {
        var t = seed >>> 0;
        return function () {
            t += 0x6D2B79F5;
            var r = t;
            r = Math.imul(r ^ (r >>> 15), r | 1);
            r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
            return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
        };
    }

    function seededShuffle(list, seed) {
        var arr = list.slice();
        var rand = mulberry32(seed);
        for (var i = arr.length - 1; i > 0; i--) {
            var j = Math.floor(rand() * (i + 1));
            var tmp = arr[i];
            arr[i] = arr[j];
            arr[j] = tmp;
        }
        return arr;
    }

    // ---- Ranking ----------------------------------------------------------
    //
    // files: array of { relPath, path, durationMs }  -- relPath is used for
    //        every classification decision (role, tags, mode gating);
    //        `path` (typically the absolute filesystem path) is what
    //        actually gets stored in the ranked pool and returned to the
    //        caller, since that is what a caller needs to load the file.
    //        `path` is optional -- omitted (e.g. in tests that only care
    //        about classification), the pool falls back to relPath itself.
    //        durationMs is null/undefined when unknown (MP3/OGG or
    //        unparseable header).
    // categories: array of category defs (id, aliases, maxMs)
    // seed: optional integer; blank/undefined = deterministic path order.
    // options: { mode, modeFilters, maxMs }. mode omitted/falsy = no Type
    //          gating at all (every role-matched file eligible, same as
    //          before Type modes existed) -- used by callers that only care
    //          about role classification (e.g. plain pad-map tests).
    //          maxMs, when given, is an ADDITIONAL ceiling layered on top of
    //          (never looser than) each category's own maxMs.
    //
    // Returns:
    //   {
    //     byCategory: { [id]: { candidates: [...ranked relPaths...],
    //                            unknownDurationCount: n } },
    //     excludedCount: n,       -- hard-excluded + mode-gated-out
    //     midiCount: n,
    //     unmatchedFiles: [relPath, ...],
    //     subcatCounts: { [subcatId]: n }   -- only populated when a mode is
    //                                          given; every scanned file that
    //                                          belongs to that mode, counted
    //                                          BEFORE modeFilters are applied
    //                                          (same "always show the truth"
    //                                          principle as the old tagCounts)
    //   }
    function rankCandidates(files, categories, seed, options) {
        var mode = options && options.mode;
        var modeFilters = (options && options.modeFilters) || null;
        var modeMaxMs = (options && options.maxMs !== null && options.maxMs !== undefined) ? options.maxMs : null;

        var byCategory = {};
        for (var c = 0; c < categories.length; c++) {
            byCategory[categories[c].id] = { pool: [], unknownDurationCount: 0 };
        }
        var excludedCount = 0;
        var midiCount = 0;
        var unmatchedFiles = [];

        var subcatCounts = {};
        if (mode && TYPE_MODES[mode]) {
            var subcatDefs = TYPE_MODES[mode].subcats;
            for (var sd = 0; sd < subcatDefs.length; sd++) subcatCounts[subcatDefs[sd].id] = 0;
        }

        for (var i = 0; i < files.length; i++) {
            var f = files[i];

            if (isHardExcluded(f.relPath)) {
                midiCount++;
                excludedCount++;
                continue;
            }

            var result = classifyFile(f.relPath, categories);
            var categoryId = result ? result.category : null;

            if (mode) {
                var subcats = subcatsForFileInMode(f.relPath, mode, categoryId);
                for (var s = 0; s < subcats.length; s++) {
                    if (subcatCounts.hasOwnProperty(subcats[s])) subcatCounts[subcats[s]]++;
                }
                if (!isEligibleForMode(f.relPath, mode, categoryId, modeFilters)) {
                    excludedCount++;
                    continue;
                }
            }

            if (!result) {
                unmatchedFiles.push(f.relPath);
                continue;
            }

            var cat = byCategory[categoryId];
            if (!cat) continue; // classifyFile only returns known ids, but guard anyway
            var catDef = null;
            for (var cd = 0; cd < categories.length; cd++) {
                if (categories[cd].id === categoryId) { catDef = categories[cd]; break; }
            }
            var catMaxMs = catDef ? catDef.maxMs : null;
            var effectiveMax = catMaxMs;
            if (modeMaxMs !== null) {
                effectiveMax = (catMaxMs !== null && catMaxMs !== undefined) ? Math.min(catMaxMs, modeMaxMs) : modeMaxMs;
            }

            // The pool stores the LOADABLE value (absolute path when given)
            // -- classification above ran entirely on f.relPath. Conflating
            // the two here was the v0.2.0-v0.3.1 bug: an absolute path was
            // passed in as "relPath", so a file under
            // "A:/Samples_Packs/Downloaded Packs/.../Kicks/kick.wav" had its
            // folder tier matching against "a", "samples_packs",
            // "downloaded", "packs", ... before ever reaching "kicks".
            var poolValue = f.path !== undefined && f.path !== null ? f.path : f.relPath;
            if (f.durationMs === null || f.durationMs === undefined) {
                cat.unknownDurationCount++;
                cat.pool.push(poolValue);
            } else if (effectiveMax === null || effectiveMax === undefined || f.durationMs <= effectiveMax) {
                cat.pool.push(poolValue);
            }
            // else: exceeds max length for its category/mode -- dropped
        }

        var out = {};
        for (var id in byCategory) {
            if (!byCategory.hasOwnProperty(id)) continue;
            var pool = byCategory[id].pool.slice().sort();
            if (seed !== null && seed !== undefined && seed !== "") {
                pool = seededShuffle(pool, Number(seed));
            }
            out[id] = { candidates: pool, unknownDurationCount: byCategory[id].unknownDurationCount };
        }

        return {
            byCategory: out,
            excludedCount: excludedCount,
            midiCount: midiCount,
            unmatchedFiles: unmatchedFiles,
            subcatCounts: subcatCounts
        };
    }

    // Assigns ranked candidates to pads, family-aware: pads sharing a
    // category are filled in ascending note order from that category's
    // ranked list. Pads beyond the available candidate count are left
    // empty and reported -- never silently skipped.
    //
    // Returns: [{ note, category, path|null, empty: bool }]
    function assignToPads(rankResult, padMap, lockedNotes) {
        padMap = padMap || PAD_MAP;
        lockedNotes = lockedNotes || {};
        var cursor = {}; // category id -> next index to draw
        var assignments = [];
        var sortedPads = padMap.slice().sort(function (a, b) { return a.note - b.note; });
        for (var i = 0; i < sortedPads.length; i++) {
            var pad = sortedPads[i];
            if (lockedNotes[pad.note]) {
                assignments.push({ note: pad.note, category: pad.category, path: lockedNotes[pad.note], empty: false, locked: true });
                continue;
            }
            var bucket = rankResult.byCategory[pad.category] || { candidates: [] };
            var idx = cursor[pad.category] || 0;
            var path = bucket.candidates[idx] || null;
            cursor[pad.category] = idx + 1;
            assignments.push({ note: pad.note, category: pad.category, path: path, empty: path === null });
        }
        return assignments;
    }

    var DrgClassify = {
        DEFAULT_CATEGORIES: DEFAULT_CATEGORIES,
        PAD_MAP: PAD_MAP,
        TAG_DEFS: TAG_DEFS,
        OTHER_TAG: OTHER_TAG,
        HARD_EXCLUDE_TOKENS: HARD_EXCLUDE_TOKENS,
        AUDIO_EXTS: AUDIO_EXTS,
        TYPE_MODES: TYPE_MODES,
        TYPE_MODE_ORDER: TYPE_MODE_ORDER,
        defaultModeFilters: defaultModeFilters,
        LAST_RESORT: LAST_RESORT,
        segmentString: segmentString,
        stripTrailingS: stripTrailingS,
        splitPathParts: splitPathParts,
        segmentMatchesAlias: segmentMatchesAlias,
        tagsForFile: tagsForFile,
        isHardExcluded: isHardExcluded,
        classifyFile: classifyFile,
        isExcluded: isExcluded,
        isAudioFile: isAudioFile,
        subcatsForFileInMode: subcatsForFileInMode,
        oneshotGroupForCategory: oneshotGroupForCategory,
        isEligibleForMode: isEligibleForMode,
        mulberry32: mulberry32,
        seededShuffle: seededShuffle,
        rankCandidates: rankCandidates,
        assignToPads: assignToPads
    };

    // Max's js/jsui engine has no CommonJS module system -- `include()`
    // evaluates this file in the caller's global scope instead, so the
    // functions above must land as a global. Guard the Node export so
    // this same file works unmodified in both environments.
    global.DrgClassify = DrgClassify;
    if (typeof module !== "undefined" && module.exports) {
        module.exports = DrgClassify;
    }
})(typeof globalThis !== "undefined" ? globalThis : this);
