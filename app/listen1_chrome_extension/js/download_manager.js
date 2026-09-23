/* global angular, MediaService, require */
(function () {
  "use strict";

  // DownloadManager — renderer-side orchestrator for the download subsystem.
  //
  // Responsibilities:
  //  * Keep a task list (pending / downloading / done / error) bound to the UI.
  //  * Resolve each track's playable URL via the SAME MediaService.bootstrapTrack
  //    that the player uses — so we reuse provider URL parsing for free.
  //  * Delegate the actual byte transfer to functions.js running in the Electron
  //    MAIN process (via @electron/remote), which avoids the renderer CORS trap
  //    and can write files with the right anti-leech headers.
  //
  // Mutations happen inside Node callbacks (outside Angular's digest), so we
  // schedule a safe digest via $applyAsync / $timeout after every state change.
  function DownloadManager($rootScope, $timeout) {
    const STATE = {
      PENDING: "pending",
      DOWNLOADING: "downloading",
      DONE: "done",
      ERROR: "error",
    };

    const service = {
      tasks: [],
      concurrency: 3,
      STATE: STATE,
      enqueue: enqueue,
      enqueueMany: enqueueMany,
      clearFinished: clearFinished,
      retry: retry,
      openFolder: openFolder,
    };

    let functionsMod = null;
    let running = 0;
    let nextId = 1;

    function getFunctions() {
      if (functionsMod) return Promise.resolve(functionsMod);
      // remote.require returns the module object SYNCHRONOUSLY (not a
      // Promise) — only its async methods return Promises.
      const remote = require("@electron/remote");
      functionsMod = remote.require("./functions.js");
      return Promise.resolve(functionsMod);
    }

    function refresh() {
      if ($rootScope.$applyAsync) {
        $rootScope.$applyAsync();
      } else {
        $timeout(function () {}, 0);
      }
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

    function runTask(task) {
      task.status = STATE.DOWNLOADING;
      task.loaded = 0;
      task.total = 0;
      task.error = null;
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
                  destDir: fn.pickDownloadDir(),
                  fileName: fileName,
                };
                if (response.headers) opts.headers = response.headers;
                fn.downloadTrack(
                  opts,
                  (loaded, total) => {
                    task.loaded = loaded;
                    task.total = total;
                    refresh();
                  },
                  (result) => {
                    task.status = STATE.DONE;
                    task.destPath = result.destPath;
                    task.size = result.size;
                    refresh();
                    resolve();
                  },
                  (err) => {
                    task.status = STATE.ERROR;
                    task.error = (err && err.message) || "download failed";
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
      const task = {
        id: nextId++,
        track: track,
        status: STATE.PENDING,
        loaded: 0,
        total: 0,
        error: null,
        destPath: null,
        size: 0,
      };
      service.tasks.push(task);
      refresh();
      pump();
      return task;
    }

    function enqueueMany(tracks) {
      (tracks || []).forEach((t) => enqueue(t));
    }

    function clearFinished() {
      service.tasks = service.tasks.filter(
        (t) => t.status === STATE.DOWNLOADING || t.status === STATE.PENDING
      );
      refresh();
    }

    function retry(id) {
      const task = service.tasks.find((t) => t.id === id);
      if (task && task.status === STATE.ERROR) {
        task.status = STATE.PENDING;
        task.error = null;
        refresh();
        pump();
      }
    }

    function openFolder(path) {
      try {
        const remote = require("@electron/remote");
        let dir = path;
        if (!dir) {
          const fn = functionsMod || remote.require("./functions.js");
          dir = fn.pickDownloadDir();
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

    return service;
  }

  angular
    .module("listenone")
    .service("downloadManager", ["$rootScope", "$timeout", DownloadManager]);
})();
