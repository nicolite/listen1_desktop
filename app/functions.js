const { existsSync } = require("fs");
const { readdir, readFile } = require("fs/promises");
const { parseFile } = require("music-metadata");
const { basename, extname, parse, format, join } = require("path");
const { detect } = require("chardet");

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
