const { existsSync, mkdirSync, createWriteStream, statSync } = require("fs");
const { readdir, readFile } = require("fs/promises");
const { parseFile } = require("music-metadata");
const { basename, extname, parse, format, join } = require("path");
const { detect } = require("chardet");
const http = require("http");
const https = require("https");
const { URL } = require("url");
const os = require("os");

// Supported local music file extensions (lowercase, without dot)
const MUSIC_EXTENSIONS = [
  "flac",
  "mp3",
  "mp4",
  "ogg",
  "wav",
  "webm",
  "m4a",
];

// Recursively collect music files under `dir`.
// `depth` guards against symlink loops / absurdly deep trees.
async function walk(dir, results, depth) {
  if (depth > 20) {
    return;
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        // eslint-disable-next-line no-await-in-loop
        await walk(full, results, depth + 1);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase().replace(/^\./, "");
        if (MUSIC_EXTENSIONS.includes(ext)) {
          results.push(full);
        }
      }
    } catch (error) {
      // ignore unreadable entry and continue
    }
  }
}

module.exports = {
  async readAudioTags(filePath) {
    const fileName = basename(filePath, extname(filePath));
    try {
      const metaData = await parseFile(filePath);
      metaData.common.title ||= fileName;
      const lyric_url = format({
        ...parse(filePath),
        ext: ".lrc",
        base: undefined,
      });
      //if metadata doesn't include lyric, then try to read from local lyric file
      if (!metaData.common.lyrics && existsSync(lyric_url)) {
        metaData.common.lyrics = [];
        const fileBuffer = await readFile(lyric_url);
        const encoding = detect(fileBuffer);
        const decoder = new TextDecoder(encoding);
        metaData.common.lyrics[0] = decoder.decode(fileBuffer);
      }
      return metaData;
    } catch (error) {
      return {
        error,
        common: {
          title: fileName,
          album: "",
          artist: "",
        },
      };
    }
  },

  // Recursively scan a folder and return absolute paths of all music files.
  async scanMusicFolder(folderPath) {
    const results = [];
    await walk(folderPath, results, 0);
    return results;
  },
};

// ---------------------------------------------------------------------------
// Download subsystem (Phase 2) — download a track's media URL to local disk.
//
// Runs in the Electron MAIN process (loaded via remote.require from the
// renderer). Using Node's http/https here (instead of a renderer fetch) avoids
// the CORS trap: HTML5 <audio> can play cross-origin media, but fetch() cannot
// read cross-origin bytes. Node http/https is not subject to CORS.
//
// IMPORTANT: provider CDNs enforce anti-leech (Referer / User-Agent / cookies).
// REFERER_MAP below is a SEED derived from the (now commented-out) webRequest
// rules in listen1_chrome_extension/js/background.js. It MUST be validated
// against the real provider CDNs on a real device (valid sessions / region may
// be required). See docs/download_subsystem_plan.md (M0 spike).
// ---------------------------------------------------------------------------
const REFERER_MAP = [
  { test: /music\.163\.com|interface3?\.music\.163\.com/, referer: "https://music.163.com/", ua: "" },
  { test: /c\.y\.qq\.com|i\.y\.qq\.com|qqmusic\.qq\.com|music\.qq\.com|imgcache\.qq\.com/, referer: "https://y.qq.com/", ua: "" },
  { test: /\.kuwo\.cn/, referer: "https://www.kuwo.cn/", ua: "" },
  { test: /\.kugou\.com/, referer: "https://www.kugou.com/", ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 14_3 like Mac OS X) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30" },
  { test: /\.migu\.cn|m\.music\.migu\.cn/, referer: "https://music.migu.cn/v3/music/player/audio?from=migu", ua: "" },
  { test: /app\.c\.nf\.migu\.cn|d\.musicapp\.migu\.cn/, referer: "", ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 14_3 like Mac OS X) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30" },
  { test: /\.taihe\.com|music\.91q\.com/, referer: "https://music.taihe.com/", ua: "" },
  { test: /\.bilibili\.com|\.bilivideo\.com|\.bilivideo\.cn/, referer: "https://www.bilibili.com/", ua: "" },
  { test: /\.xiami\.com/, referer: "", ua: "" },
];

function resolveHeaders(url, extra) {
  let referer = "";
  let ua = "";
  for (const rule of REFERER_MAP) {
    if (rule.test.test(url)) {
      referer = rule.referer;
      ua = rule.ua;
      break;
    }
  }
  // Always send a browser UA: many CDNs reject requests with no User-Agent,
  // and anti-leech robustness is the top risk for this subsystem.
  const DEFAULT_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const headers = { ...(extra || {}) };
  if (!headers.Referer && referer) headers.Referer = referer;
  // Default UA is the baseline for every request; a per-host UA from REFERER_MAP
  // (e.g. kugou's mobile UA) overrides it when present.
  if (!headers["User-Agent"]) headers["User-Agent"] = ua || DEFAULT_UA;
  return headers;
}

function sanitizeFileName(name) {
  const cleaned = (name || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 200) || "untitled";
}

function pickDownloadDir() {
  let base;
  try {
    // In Electron main process this resolves to the OS Downloads folder.
    const electron = require("electron");
    base = electron.app.getPath("downloads");
  } catch (e) {
    base = os.homedir();
  }
  return join(base, "Listen1");
}

const activeDownloads = {};

function abortDownload(id) {
  const rec = activeDownloads[id];
  if (rec) {
    rec.aborted = true;
    if (rec.ac && rec.ac.abort) rec.ac.abort();
  }
}

function downloadTrack(opts, onProgress, onDone, onError) {
  const {
    url,
    headers,
    destDir,
    fileName,
    timeout = 30000,
    id = null,
    startBytes = 0,
  } = opts || {};
  if (!url) {
    const e = new Error("downloadTrack: missing url");
    if (onError) onError(e);
    return Promise.reject(e);
  }
  const dir = destDir || pickDownloadDir();
  mkdirSync(dir, { recursive: true });
  const safeName = sanitizeFileName(fileName || "download");
  const destPath = join(dir, safeName);
  const reqHeaders = resolveHeaders(url, headers);

  const ac = new AbortController();
  if (id != null) activeDownloads[id] = { ac, aborted: false };

  // Resume support: re-request a byte range to continue a partial file. Progress
  // reports are throttled, so the bytes already on disk are the authoritative
  // resume point — use the larger of the caller's hint and the actual file size.
  let resumeFrom = startBytes || 0;
  try {
    const st = statSync(destPath);
    if (st.isFile() && st.size > resumeFrom) resumeFrom = st.size;
  } catch (e) {
    /* no partial file yet */
  }
  let append = resumeFrom > 0;
  if (append) {
    reqHeaders["Range"] = `bytes=${resumeFrom}-`;
  }

  return new Promise((resolve, reject) => {
    let lastReport = 0;
    let loaded = resumeFrom;
    let total = 0;
    let out = null;

    const cleanup = () => {
      if (id != null) delete activeDownloads[id];
    };

    const ensureStream = (wantAppend) => {
      if (out) {
        try {
          out.destroy();
        } catch (e) {
          /* ignore */
        }
      }
      out = createWriteStream(destPath, { flags: wantAppend ? "a" : "w" });
    };

    const report = (ld, tt) => {
      const now = Date.now();
      if (now - lastReport >= 200 || (tt && ld >= tt)) {
        lastReport = now;
        if (onProgress) onProgress(ld, tt);
      }
    };

    const tryRequest = (targetUrl, depth) => {
      if (depth > 5) {
        const e = new Error("downloadTrack: too many redirects");
        if (onError) onError(e);
        reject(e);
        return;
      }
      let parsed;
      try {
        parsed = new URL(targetUrl);
      } catch (e) {
        if (onError) onError(e);
        reject(e);
        return;
      }
      const client = parsed.protocol === "http:" ? http : https;
      const req = client.get(
        targetUrl,
        { headers: reqHeaders, timeout, signal: ac.signal },
        (res) => {
          // Server ignored our Range request (or a redirect dropped it): restart
          // cleanly from the beginning.
          if (append && res.statusCode === 200) {
            append = false;
            loaded = 0;
            ensureStream(false);
          } else if (!out) {
            ensureStream(append);
          }

          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            res.resume(); // consume the redirect response body
            const next = new URL(res.headers.location, targetUrl).href;
            tryRequest(next, depth + 1);
            return;
          }
          if (res.statusCode !== 200 && res.statusCode !== 206) {
            res.resume();
            const e = new Error(
              `downloadTrack: HTTP ${res.statusCode} for ${targetUrl}`
            );
            if (onError) onError(e);
            reject(e);
            return;
          }

          total = parseInt(res.headers["content-length"] || "0", 10);
          if (append && res.statusCode === 206) {
            const rangeTotal = parseInt(
              (res.headers["content-range"] || "").split("/").pop() || "0",
              10
            );
            if (rangeTotal) total = rangeTotal;
          }

          if (!out) ensureStream(append);
          res.on("data", (chunk) => {
            loaded += chunk.length;
            report(loaded, total);
          });
          out.on("error", (e) => {
            if (ac.signal.aborted) return;
            if (onError) onError(e);
            reject(e);
          });
          res.pipe(out);
          out.on("finish", () => {
            if (ac.signal.aborted) return; // abort races the finish event
            if (onProgress) onProgress(loaded, total);
            const result = { destPath, fileName: safeName, size: loaded };
            cleanup();
            if (onDone) onDone(result);
            resolve(result);
          });
        }
      );
      req.on("error", (e) => {
        if (ac.signal.aborted) {
          // Surface the abort to the caller via onDone so the orchestrator can
          // decide between pause vs cancel — never treat it as a hard error.
          if (onDone) onDone({ aborted: true, destPath, fileName: safeName });
          cleanup();
          resolve({ aborted: true });
          return;
        }
        if (onError) onError(e);
        cleanup();
        reject(e);
      });
      req.on("timeout", () => {
        req.destroy();
        const e = new Error("downloadTrack: request timeout");
        if (onError) onError(e);
        reject(e);
      });
    };

    tryRequest(url, 0);
  });
}

module.exports = {
  ...module.exports,
  downloadTrack,
  abortDownload,
  sanitizeFileName,
  pickDownloadDir,
  resolveHeaders,
};
