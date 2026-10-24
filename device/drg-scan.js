// drg-scan.js
//
// Chunked, pruning directory walker. Pure logic -- the actual filesystem
// access is injected as an "adapter" so this runs under plain `node`
// (fs-based adapter, see test/) with zero Live/Max involvement, and under
// Max's `js` engine (Folder/File-based adapter in drg-main.js) unmodified.
//
// Chunked because this file's code runs on Live's main thread: walking a
// whole sample library in one synchronous pass would freeze the UI. A
// scanner instance processes a bounded number of directory entries per
// `.step()` call so the caller can drive it from a Max `Task` tick.
//
// Adapter contract (only method the walker needs):
//   adapter.listDir(fullPath) -> { dirs: [names], files: [names] }
//     names are bare entries (no path prefix); fullPath uses "/" or "\\",
//     doesn't matter which, this module only ever appends "/".
//
// Pruning: dot-directories, VCS/build noise, and installer leftovers are
// skipped outright, same intent as app/genius_client.py's library
// walkers -- but unlike search_user_samples() in that file (which binds
// `_dirs` and discards it), pruning here is real and unbounded results
// are the point: a kit builder must see every candidate, not the first N.

(function (global) {
    "use strict";

    var SKIP_DIR_EXACT = { ".git": 1, "node_modules": 1, "__pycache__": 1, ".svn": 1, ".hg": 1, "$RECYCLE.BIN": 1, "System Volume Information": 1 };

    function shouldSkipDir(name) {
        if (!name) return true;
        if (name.charAt(0) === ".") return true;
        if (SKIP_DIR_EXACT.hasOwnProperty(name)) return true;
        if (/^unins/i.test(name)) return true;
        return false;
    }

    function joinPath(a, b) {
        if (!a) return b;
        var sep = a.charAt(a.length - 1) === "/" || a.charAt(a.length - 1) === "\\" ? "" : "/";
        return a + sep + b;
    }

    // isAudioFile is injected rather than imported so this module has no
    // hard dependency on drg-classify.js; drg-main.js wires the two
    // together, and tests can pass a trivial stub.
    function createScanner(rootPath, adapter, isAudioFile) {
        var stack = [rootPath];
        var results = []; // [{ path, relPath }]
        var visitedDirs = 0;
        var done = false;

        function relativeTo(fullPath) {
            if (fullPath.indexOf(rootPath) === 0) {
                return fullPath.slice(rootPath.length).replace(/^[\\/]+/, "");
            }
            return fullPath;
        }

        // Processes up to `budget` filesystem entries (dirs popped +
        // files seen) and returns { done, results, visitedDirs } so far.
        // Call repeatedly (e.g. from a Task) until `done` is true.
        function step(budget) {
            var spent = 0;
            while (stack.length > 0 && spent < budget) {
                var dir = stack.pop();
                visitedDirs++;
                spent++;
                var listing;
                try {
                    listing = adapter.listDir(dir);
                } catch (e) {
                    continue; // unreadable directory -- skip, don't abort the whole scan
                }
                if (!listing) continue;
                var dirs = listing.dirs || [];
                for (var i = 0; i < dirs.length; i++) {
                    if (!shouldSkipDir(dirs[i])) stack.push(joinPath(dir, dirs[i]));
                }
                var files = listing.files || [];
                for (var f = 0; f < files.length; f++) {
                    spent++;
                    if (isAudioFile(files[f])) {
                        var fullPath = joinPath(dir, files[f]);
                        results.push({ path: fullPath, relPath: relativeTo(fullPath) });
                    }
                }
            }
            done = stack.length === 0;
            return { done: done, results: results, visitedDirs: visitedDirs };
        }

        function runToCompletion(budgetPerStep) {
            var guard = 0;
            while (!done) {
                step(budgetPerStep || 500);
                guard++;
                if (guard > 1000000) break; // pathological-input safety valve
            }
            return results;
        }

        return {
            step: step,
            runToCompletion: runToCompletion,
            isDone: function () { return done; },
            getResults: function () { return results; }
        };
    }

    var DrgScan = {
        shouldSkipDir: shouldSkipDir,
        joinPath: joinPath,
        createScanner: createScanner
    };

    global.DrgScan = DrgScan;
    if (typeof module !== "undefined" && module.exports) {
        module.exports = DrgScan;
    }
})(typeof globalThis !== "undefined" ? globalThis : this);
