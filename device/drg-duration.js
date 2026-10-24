// drg-duration.js
//
// Sample-length parsing from audio file *headers only* -- never by
// loading/decoding the audio. This is what the category max-length
// filter runs against, so it needs to work before a single byte of
// audio data is touched.
//
// Works on any byte-indexable source: a Node Buffer, a plain Array of
// 0-255 ints (what Max's File.readbytes hands back), or a Uint8Array.
// No Max dependency -- runs under plain `node` for tests (see test/).

(function (global) {
    "use strict";

    function u8(bytes, i) { return bytes[i] & 0xFF; }

    function readUInt16LE(bytes, i) { return u8(bytes, i) | (u8(bytes, i + 1) << 8); }
    function readUInt32LE(bytes, i) {
        return (u8(bytes, i) | (u8(bytes, i + 1) << 8) | (u8(bytes, i + 2) << 16) | (u8(bytes, i + 3) << 24)) >>> 0;
    }
    function readUInt16BE(bytes, i) { return (u8(bytes, i) << 8) | u8(bytes, i + 1); }
    function readUInt32BE(bytes, i) {
        return ((u8(bytes, i) << 24) | (u8(bytes, i + 1) << 16) | (u8(bytes, i + 2) << 8) | u8(bytes, i + 3)) >>> 0;
    }
    function asciiAt(bytes, i, len) {
        var s = "";
        for (var k = 0; k < len; k++) s += String.fromCharCode(u8(bytes, i + k));
        return s;
    }

    // ---- WAV ----------------------------------------------------------
    // RIFF/WAVE: walk chunks looking for "fmt " (byteRate) and "data"
    // (size). ms = dataSize / byteRate * 1000. Falls back to computing
    // byteRate from sampleRate * blockAlign if the header's own byteRate
    // field is zero or missing (seen in some malformed exports).
    function parseWav(bytes) {
        if (bytes.length < 12 || asciiAt(bytes, 0, 4) !== "RIFF" || asciiAt(bytes, 8, 4) !== "WAVE") return null;
        var pos = 12;
        var byteRate = 0, sampleRate = 0, blockAlign = 0, dataSize = null;
        while (pos + 8 <= bytes.length) {
            var chunkId = asciiAt(bytes, pos, 4);
            var chunkSize = readUInt32LE(bytes, pos + 4);
            var body = pos + 8;
            if (chunkId === "fmt " && body + 16 <= bytes.length) {
                sampleRate = readUInt32LE(bytes, body + 4);
                byteRate = readUInt32LE(bytes, body + 8);
                blockAlign = readUInt16LE(bytes, body + 12);
            } else if (chunkId === "data") {
                dataSize = chunkSize;
            }
            // Chunks are word-aligned; odd sizes get a padding byte.
            pos = body + chunkSize + (chunkSize % 2);
            if (dataSize !== null && byteRate) break; // enough to compute
        }
        if (dataSize === null) return null;
        if (!byteRate && sampleRate && blockAlign) byteRate = sampleRate * blockAlign;
        if (!byteRate) return null;
        return (dataSize / byteRate) * 1000;
    }

    // ---- AIFF / AIFC ----------------------------------------------------
    // FORM/AIFF: "COMM" chunk holds numChannels(2) numSampleFrames(4)
    // sampleSize(2) sampleRate(80-bit IEEE 754 extended, big-endian).
    function ieee80ToDouble(bytes, i) {
        var expon = readUInt16BE(bytes, i) & 0x7FFF;
        var sign = (readUInt16BE(bytes, i) & 0x8000) ? -1 : 1;
        // 64-bit mantissa as two 32-bit halves (JS numbers lose precision
        // past 2^53, which is far beyond any real sample rate).
        var hi = readUInt32BE(bytes, i + 2);
        var lo = readUInt32BE(bytes, i + 6);
        if (expon === 0 && hi === 0 && lo === 0) return 0;
        var mantissa = hi * 4294967296 + lo; // hi << 32 | lo, done in float math
        var f = mantissa * Math.pow(2, expon - 16383 - 63);
        return sign * f;
    }

    function parseAiff(bytes) {
        if (bytes.length < 12 || asciiAt(bytes, 0, 4) !== "FORM") return null;
        var formType = asciiAt(bytes, 8, 4);
        if (formType !== "AIFF" && formType !== "AIFC") return null;
        var pos = 12;
        while (pos + 8 <= bytes.length) {
            var chunkId = asciiAt(bytes, pos, 4);
            var chunkSize = readUInt32BE(bytes, pos + 4);
            var body = pos + 8;
            if (chunkId === "COMM" && body + 18 <= bytes.length) {
                var numSampleFrames = readUInt32BE(bytes, body + 2);
                var sampleRate = ieee80ToDouble(bytes, body + 8);
                if (!sampleRate) return null;
                return (numSampleFrames / sampleRate) * 1000;
            }
            pos = body + chunkSize + (chunkSize % 2);
        }
        return null;
    }

    // ---- FLAC -----------------------------------------------------------
    // "fLaC" magic, then metadata blocks; block type 0 = STREAMINFO (always
    // first). Layout after the 4-byte block header: 2+2 min/max blocksize,
    // 3+3 min/max framesize, then a packed 64-bit field: sampleRate(20
    // bits) + numChannels(3 bits) + bitsPerSample(5 bits) + totalSamples
    // (36 bits).
    function parseFlac(bytes) {
        if (bytes.length < 4 || asciiAt(bytes, 0, 4) !== "fLaC") return null;
        var pos = 4;
        if (pos + 4 > bytes.length) return null;
        var blockHeader = u8(bytes, pos);
        var blockType = blockHeader & 0x7F;
        var blockLen = readUInt32BE(bytes, pos) & 0x00FFFFFF; // low 24 bits
        if (blockType !== 0) return null; // STREAMINFO must be first
        var body = pos + 4;
        if (body + blockLen > bytes.length || blockLen < 34) return null;

        // Bytes [10..17] of the STREAMINFO body hold the packed field.
        var p = body + 10;
        var b0 = u8(bytes, p), b1 = u8(bytes, p + 1), b2 = u8(bytes, p + 2),
            b3 = u8(bytes, p + 3), b4 = u8(bytes, p + 4), b5 = u8(bytes, p + 5),
            b6 = u8(bytes, p + 6), b7 = u8(bytes, p + 7);

        // Packed 64-bit field, MSB first: sampleRate(20) | channels-1(3) |
        // bitsPerSample-1(5) | totalSamples(36). b2's low nibble holds the
        // top bit of bitsPerSample-1, NOT part of totalSamples -- that top
        // nibble of totalSamples lives in b3's low nibble instead.
        var sampleRate = (b0 << 12) | (b1 << 4) | (b2 >> 4);
        var totalSamplesHigh4 = b3 & 0x0F;
        var totalSamples = totalSamplesHigh4 * Math.pow(2, 32) +
            (b4 * 16777216 + b5 * 65536 + b6 * 256 + b7);

        if (!sampleRate) return null;
        return (totalSamples / sampleRate) * 1000;
    }

    function extOf(name) {
        var lower = String(name || "").toLowerCase();
        var dot = lower.lastIndexOf(".");
        return dot >= 0 ? lower.slice(dot) : "";
    }

    // Returns a number (ms) or null if the format is unknown/unparseable.
    // MP3/OGG are deliberately not attempted here -- there is no cheap
    // exact header answer for either, so the caller treats null as
    // "unknown duration: include, count separately" per the plan, never
    // "assume it's short" or "assume it's a loop."
    function getDurationMs(filename, bytes) {
        if (!bytes || !bytes.length) return null;
        var ext = extOf(filename);
        try {
            if (ext === ".wav") return parseWav(bytes);
            if (ext === ".aif" || ext === ".aiff" || ext === ".aifc") return parseAiff(bytes);
            if (ext === ".flac") return parseFlac(bytes);
        } catch (e) {
            return null; // malformed header -- unknown, not a crash
        }
        return null;
    }

    var DrgDuration = {
        parseWav: parseWav,
        parseAiff: parseAiff,
        parseFlac: parseFlac,
        ieee80ToDouble: ieee80ToDouble,
        getDurationMs: getDurationMs
    };

    global.DrgDuration = DrgDuration;
    if (typeof module !== "undefined" && module.exports) {
        module.exports = DrgDuration;
    }
})(typeof globalThis !== "undefined" ? globalThis : this);
