/* global angular, MediaService, require */
(function () {
  "use strict";

  // DownloadManager — renderer-side orchestrator for the download subsystem.
  //
  // Responsibilities:
  //  * Keep a task list bound to the UI (pending / downloading / paused / done / error).
  //  * Resolve each track's playable URL via the SAME MediaService.bootstrapTrack
  //    that the player uses — so we reuse provider URL parsing for free.
  //  * Delegate the actual byte transfer to functions.js running in the Electron
  //    MAIN process (via @electron/remote), which avoids the renderer CORS trap
  //    and can write files with the right anti-leech headers. Pause/resume is
  //    implemented there with an AbortController + HTTP Range resume.
  //
  // Mutations happen inside Node callbacks (outside Angular's digest), so we
  // schedule a safe digest via $applyAsync / $timeout after every state change.
  function DownloadManager($rootScope, $timeout) {
    const STATE = {
      PENDING: "pending",
      DOWNLOADING: "downloading",
      PAUSED: "paused",
      DONE: "done",
      ERROR: "error",
    };

    const PLATFORM_LABEL = {
      netease: "网易",
      qq: "QQ",
      kugou: "酷狗",
      xiami: "虾米",
      baidu: "百度",
      mting: "MTV",
      local: "本地",
      migu: "咪咕",
      bilibili: "B站",
      youtube: "YouTube",
      spotify: "Spotify",
    };

    const service = {
      tasks: [],
      concurrency: 3,
      STATE: STATE,
      filter: "all",
      counts: { total: 0, active: 0, done: 0, error: 0, paused: 0, pending: 0 },
      downloadDir: getDownloadDir(),
      enqueue: enqueue,
      enqueueMany: enqueueMany,
      pause: pause,
      resume: resume,
      remove: remove,
      retry: retry,
      pauseAll: pauseAll,
      resumeAll: resumeAll,
      retryAll: retryAll,
      clearFinished: clearFinished,
      clearAll: clearAll,
      openFile: openFile,
      openFolder: openFolder,
      setFilter: setFilter,
      filtered: filtered,
      getDownloadDir: getDownloadDir,
      chooseDownloadDir: chooseDownloadDir,
      setDownloadDir: setDownloadDir,
      resetDownloadDir: resetDownloadDir,
      formatSize: formatSize,
      formatSpeed: formatSpeed,
      platformLabel: platformLabel,
    };

    let functionsMod = null;
    let running = 0;
    let nextId = 1;
    let nextRemoteId = 1;

    function getFunctions() {
      if (functionsMod) return Promise.resolve(functionsMod);
      // remote.require returns the module object SYNCHRONOUSLY (not a
      // Promise) — only its async methods return Promises.
      const remote = require("@electron/remote");
      functionsMod = remote.require("./functions.js");
      return Promise.resolve(functionsMod);
    }

    const DOWNLOAD_DIR_KEY = "download_dir";

    function defaultDownloadDir() {
      try {
        const remote = require("@electron/remote");
        const p = require("path");
        return p.join(remote.app.getPath("downloads"), "Listen1");
      } catch (e) {
        try {
          const p = require("path");
          return p.join(require("os").homedir(), "Listen1");
        } catch (e2) {
          return "Listen1";
        }
      }
    }

    function getDownloadDir() {
      let dir = null;
      try {
        dir = localStorage.getItem(DOWNLOAD_DIR_KEY);
      } catch (e) {
        /* ignore */
      }
      return dir || defaultDownloadDir();
    }

    function setDownloadDir(p) {
      if (!p) return;
      try {
        localStorage.setItem(DOWNLOAD_DIR_KEY, p);
      } catch (e) {
        /* ignore */
      }
      service.downloadDir = p;
      refresh();
    }

    function resetDownloadDir() {
      try {
        localStorage.removeItem(DOWNLOAD_DIR_KEY);
      } catch (e) {
        /* ignore */
      }
      service.downloadDir = defaultDownloadDir();
      refresh();
    }

    function chooseDownloadDir() {
      try {
        const remote = require("@electron/remote");
        const result = remote.dialog.showOpenDialogSync({
          properties: ["openDirectory", "createDirectory"],
        });
        if (result && result[0]) {
          setDownloadDir(result[0]);
        }
      } catch (e) {
        /* ignore */
      }
    }

    function refresh() {
      service.counts = computeCounts();
      if ($rootScope.$applyAsync) {
        $rootScope.$applyAsync();
      } else {
        $timeout(function () {}, 0);
      }
    }

    function computeCounts() {
      const c = {
        total: service.tasks.length,
        active: 0,
        done: 0,
        error: 0,
        paused: 0,
        pending: 0,
      };
      for (const t of service.tasks) {
        if (t.status === STATE.DOWNLOADING || t.status === STATE.PENDING) c.active++;
        else if (t.status === STATE.PAUSED) c.paused++;
        else if (t.status === STATE.DONE) c.done++;
        else if (t.status === STATE.ERROR) c.error++;
        if (t.status === STATE.PENDING) c.pending++;
      }
      return c;
    }

    function byId(id) {
      return service.tasks.find((t) => t.id === id);
    }

    function extFromUrl(url) {
      try {
        const u = new URL(url);
        const seg = u.pathname.split(".").pop();
        if (seg && /^[a-z0-9]{1,4}$/i.test(seg)) return seg;
      } catch (e) {
        /* ignore */
      }
      return "mp3";
    }

    function formatSize(bytes) {
      if (!bytes && bytes !== 0) return "";
      if (bytes < 1024) return bytes + " B";
      const units = ["KB", "MB", "GB"];
      let v = bytes / 1024;
      let i = 0;
      while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
      }
      return v.toFixed(v < 10 ? 1 : 0) + " " + units[i];
    }

    function formatSpeed(bytesPerSec) {
      if (!bytesPerSec || bytesPerSec <= 0) return "";
      return formatSize(bytesPerSec) + "/s";
    }

    function platformLabel(source) {
      if (!source) return "?";
      return PLATFORM_LABEL[source] || source.toUpperCase();
    }

    function runTask(task) {
      task.status = STATE.DOWNLOADING;
      task.loaded = task.loaded || 0;
      task.total = task.total || 0;
      task.error = null;
      task.speed = 0;
      task.lastTime = Date.now();
      task.lastLoaded = task.loaded;
      task._abortIntent = "pause"; // overridden to "cancel" by remove()
      const taskId = nextRemoteId++;
      task._remoteId = taskId;
      refresh();

      return getFunctions().then(
        (fn) =>
          new Promise((resolve) => {
            MediaService.bootstrapTrack(
              task.track,
              (response) => {
                const url = response && response.url;
                if (!url) {
                  task.status = STATE.ERROR;
                  task.error = "no url";
                  refresh();
                  return resolve();
                }
                const fileName =
                  fn.sanitizeFileName(
                    `${task.track.artist || ""} - ${task.track.title || "untitled"}`
                  ) +
                  "." +
                  extFromUrl(url);
                const opts = {
                  url: url,
                  destDir: getDownloadDir(),
                  fileName: fileName,
                  id: taskId,
                  startBytes: task.loaded || 0,
                };
                if (response.headers) opts.headers = response.headers;
                fn.downloadTrack(
                  opts,
                  (loaded, total) => {
                    const now = Date.now();
                    const dt = (now - task.lastTime) / 1000;
                    if (dt > 0) {
                      const inst = (loaded - task.lastLoaded) / dt;
                      task.speed = task.speed
                        ? task.speed * 0.6 + inst * 0.4
                        : inst;
                    }
                    task.lastTime = now;
                    task.lastLoaded = loaded;
                    task.loaded = loaded;
                    task.total = total;
                    refresh();
                  },
                  (result) => {
                    if (result && result.aborted) {
                      // Paused or canceled — handled by intent, not a failure.
                      if (task._abortIntent === "cancel") {
                        refresh();
                        return resolve();
                      }
                      task.status = STATE.PAUSED;
                      task.speed = 0;
                      refresh();
                      return resolve();
                    }
                    task.status = STATE.DONE;
                    task.destPath = result.destPath;
                    task.size = result.size;
                    task.speed = 0;
                    refresh();
                    resolve();
                  },
                  (err) => {
                    task.status = STATE.ERROR;
                    task.error = (err && err.message) || "download failed";
                    task.speed = 0;
                    refresh();
                    resolve();
                  }
                );
              },
              (err) => {
                task.status = STATE.ERROR;
                task.error = (err && err.message) || "resolve failed";
                refresh();
                resolve();
              }
            );
          })
      );
    }

    function pump() {
      if (running >= service.concurrency) return;
      const task = service.tasks.find((t) => t.status === STATE.PENDING);
      if (!task) return;
      running++;
      runTask(task).then(() => {
        running--;
        pump();
      });
      pump(); // fill any remaining slots
    }

    function enqueue(track) {
      if (!track) return null;
      // Skip an identical, still-active download (avoid double-queuing a song).
      const dup = service.tasks.find(
        (t) =>
          t.track &&
          t.track.id === track.id &&
          (t.status === STATE.PENDING ||
            t.status === STATE.DOWNLOADING ||
            t.status === STATE.PAUSED)
      );
      if (dup) return dup;
      const task = {
        id: nextId++,
        track: track,
        status: STATE.PENDING,
        loaded: 0,
        total: 0,
        size: 0,
        error: null,
        destPath: null,
        speed: 0,
        lastTime: 0,
        lastLoaded: 0,
      };
      service.tasks.push(task);
      refresh();
      pump();
      return task;
    }

    function enqueueMany(tracks) {
      (tracks || []).forEach((t) => enqueue(t));
    }

    function pause(id) {
      const t = byId(id);
      if (!t) return;
      if (t.status === STATE.DOWNLOADING) {
        t._abortIntent = "pause";
        getFunctions().then((fn) => {
          if (fn.abortDownload && t._remoteId != null) fn.abortDownload(t._remoteId);
        });
      } else if (t.status === STATE.PENDING) {
        t.status = STATE.PAUSED;
        refresh();
      }
    }

    function resume(id) {
      const t = byId(id);
      if (!t || t.status !== STATE.PAUSED) return;
      t.status = STATE.PENDING;
      t.lastTime = Date.now();
      t.lastLoaded = t.loaded || 0;
      refresh();
      pump();
    }

    function remove(id) {
      const t = byId(id);
      if (!t) return;
      if (t.status === STATE.DOWNLOADING) {
        t._abortIntent = "cancel";
        getFunctions().then((fn) => {
          if (fn.abortDownload && t._remoteId != null) fn.abortDownload(t._remoteId);
        });
      }
      service.tasks = service.tasks.filter((x) => x.id !== id);
      refresh();
    }

    function retry(id) {
      const t = byId(id);
      if (t && t.status === STATE.ERROR) {
        t.status = STATE.PENDING;
        t.loaded = 0;
        t.total = 0;
        t.error = null;
        t.lastLoaded = 0;
        refresh();
        pump();
      }
    }

    function pauseAll() {
      service.tasks.forEach((t) => {
        if (t.status === STATE.DOWNLOADING) {
          t._abortIntent = "pause";
          getFunctions().then((fn) => {
            if (fn.abortDownload && t._remoteId != null) fn.abortDownload(t._remoteId);
          });
        } else if (t.status === STATE.PENDING) {
          t.status = STATE.PAUSED;
        }
      });
      refresh();
    }

    function resumeAll() {
      service.tasks.forEach((t) => {
        if (t.status === STATE.PAUSED) {
          t.status = STATE.PENDING;
          t.lastTime = Date.now();
          t.lastLoaded = t.loaded || 0;
        }
      });
      refresh();
      pump();
    }

    function retryAll() {
      service.tasks.forEach((t) => {
        if (t.status === STATE.ERROR) {
          t.status = STATE.PENDING;
          t.loaded = 0;
          t.total = 0;
          t.error = null;
          t.lastLoaded = 0;
        }
      });
      refresh();
      pump();
    }

    function clearFinished() {
      service.tasks = service.tasks.filter((t) => t.status !== STATE.DONE);
      refresh();
    }

    function clearAll() {
      service.tasks.forEach((t) => {
        if (t.status === STATE.DOWNLOADING) {
          t._abortIntent = "cancel";
          getFunctions().then((fn) => {
            if (fn.abortDownload && t._remoteId != null) fn.abortDownload(t._remoteId);
          });
        }
      });
      service.tasks = [];
      refresh();
    }

    function setFilter(f) {
      service.filter = f;
      refresh();
    }

    function filtered() {
      if (service.filter === "active") {
        return service.tasks.filter(
          (t) =>
            t.status === STATE.DOWNLOADING ||
            t.status === STATE.PENDING ||
            t.status === STATE.PAUSED
        );
      }
      if (service.filter === "done") {
        return service.tasks.filter((t) => t.status === STATE.DONE);
      }
      if (service.filter === "error") {
        return service.tasks.filter((t) => t.status === STATE.ERROR);
      }
      return service.tasks;
    }

    function openFolder(path) {
      try {
        const remote = require("@electron/remote");
        let dir = path;
        if (!dir) {
          dir = getDownloadDir();
        }
        if (!dir) return;
        if (remote.shell && remote.shell.showItemInFolder) {
          remote.shell.showItemInFolder(dir);
        } else if (remote.shell && remote.shell.openPath) {
          remote.shell.openPath(dir);
        }
      } catch (e) {
        /* ignore */
      }
    }

    function openFile(id) {
      const t = byId(id);
      if (!t || !t.destPath) return;
      try {
        const remote = require("@electron/remote");
        if (remote.shell && remote.shell.openPath) {
          remote.shell.openPath(t.destPath);
        }
      } catch (e) {
        /* ignore */
      }
    }

    return service;
  }

  angular
    .module("listenone")
    .service("downloadManager", ["$rootScope", "$timeout", DownloadManager]);
})();
