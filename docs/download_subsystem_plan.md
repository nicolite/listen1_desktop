# 精选歌单「下载」入口 — Phase 2 技术方案（真·音频下载）

> 上下文：Phase 1 已在精选歌单卡片加了「收藏」按钮（复用 `favoritePlaylist`）。
> 本方案是 Phase 2 —— 把歌单里的歌曲真正下载到本地文件。
> 目标：先出方案对齐范围，再动手实现。

---

## 1. 可行性结论

**可行，中等工作量（约 1 个子系统 + 多处 UI）。** 关键技术点已经摸清楚：

- 每首歌的**可播放直链**已由各 provider 的 `bootstrap_track()` 解析出来（`sound.url`），下载就是"用同一结果落盘"，**不需要重新写直链解析逻辑**。
- 桌面层已有成熟的 Node 桥：`@electron/remote` 在主进程 `enable` 了（`main.js:729`），renderer 可 `remote.require('./functions.js')` 调用跑在**主进程**的 Node 模块 —— 该模块能用 `fs`/`net`/`app.getPath('downloads')`，正是下载落盘的天然通道（已被本地音乐扫描 `readAudioTags`/`scanMusicFolder` 验证可用）。

真正的难点不在"拿 URL"，而在"把 URL 稳定下下来"：跨域 CDN 的**防盗链头**和 **CORS** 行为需要逐 provider 验证。

---

## 2. 已验证的代码事实（方案依据）

| 事实 | 位置 | 对下载的影响 |
|---|---|---|
| 播放 URL 来自 `provider.bootstrap_track(track, success, fail)` → `success({url, bitrate, platform})` | `loweb.js:402` 调用各 provider | 下载复用此调用，零新增解析 |
| 播放由 Howler.js 直接吃 `sound.url`（`setMediaURI`） | `player_thread.js:230/274`、`vendor/howler.core.min.js` | URL 是媒体直链 |
| 防盗链 Referer 注入逻辑**整段被注释掉** | `background.js:17-160`（全是 `//`） | 桌面端播放不靠它；下载头需重新实测 |
| `@electron/remote/main` 已 enable，`functions.js` 跑主进程 | `main.js:14,729`；`app/functions.js` | 下载执行器放 `functions.js` 最稳妥 |
| 既有"保存文件"范式是 renderer 端 `<a download>` blob | `navigation.js:503 downloadFile` | 可作小文件兜底，但无进度/大文件风险 |

---

## 3. 推荐架构

### 3.1 URL 解析层（复用，不新增）
- 对每个 `track` 调 `MediaService.bootstrapTrack`（即 `loweb.bootstrapTrack` → provider `bootstrap_track`），拿到 `sound.url`。
- 失败则走现有的 `failureCallback` 跨源兜底（`loweb.js:341-398`），与播放一致。

### 3.2 下载执行器（Node 侧，避开 CORS）
**为什么不用 renderer `fetch()`：** 播放用 HTML5 Audio 加载跨域媒体，CORS 豁免；但 `fetch()` 跨域读字节会被 CORS 拦截。所以下载必须在 Node 侧用 `@electron/remote` 调 `functions.js`，用 `https`/`electron.net` 抓取，**不受 CORS 限制**。

`app/functions.js` 新增：
- `downloadTrack({ url, headers, destDir, fileName, onProgress }, onDone, onError)`
  - 用 `electron.net`（与主进程一致，自动走系统代理/cert）或 Node `https` 请求 `url`，带上 `headers`（Referer/UA）。
  - 落盘到 `destDir/fileName`，按 `Content-Length` 回调 `onProgress(loaded, total)`。
  - 完成/失败经 `remote` 回调回 renderer（回调会序列化为 remote 代理，`onProgress` 频率需节流到 ~200ms 一次避免跨进程抖动）。
- `sanitizeFileName(name)`、`pickDownloadDir()`（`app.getPath('downloads')/Listen1/<歌单名>/`）。
- 文件已存在则跳过或追加序号（避免覆盖）。

### 3.3 关键风险：防盗链头 + CORS（必须 spike 先行）
- `background.js` 的 Referer 规则（netease `https://music.163.com/`、qq `https://y.qq.com/`、kuwo `https://www.kuwo.cn/`、kugou `https://www.kugou.com/`+移动UA、migu/taihe/bilibili 各有值）是**现成的 seed**，但要逐 provider 真网验证：哪些 CDN 裸链可下、哪些必须带 Referer/UA/登录 cookie。
- **开工第 0 步**：先写一个临时 spike（renderer 解析 URL → Node 侧用不同 header 组合试下 2-3 首 netease/qq/bilibili），把每个 provider 的"最小可用 header 集"固化成 `functions.js` 里的 `REFERER_MAP`（按 URL host 匹配），再全面铺开。

### 3.4 下载管理器（队列 + 状态）
新增 `app/listen1_chrome_extension/js/download_manager.js`（Angular service，`DownloadManager`）：
- 队列模型：`{ id, track, url, destPath, status(queued/downloading/done/error), loaded, total, error }`。
- 并发上限（默认 3）、顺序出队、单任务失败重试 1 次、可取消。
- 持久化到 localStorage（任务列表 + 状态），重启可恢复/继续。
- 暴露 `enqueue(track)` / `enqueuePlaylist(playlistTracks)` / `cancel(id)` / `retry(id)`。

---

## 4. 各 provider 直链可行性速查（待 spike 确认）

| Provider | bootstrap 返回 | 防盗链估计 | 可行性 |
|---|---|---|---|
| netease | 直 mp3（签名，约数小时~天时效） | Referer `music.163.com` + 登录 cookie | 高（需 cookie/referer，URL 有时效→按需现解） |
| qq | 直链 | Referer `y.qq.com` | 高 |
| kuwo | 直链 | Referer `kuwo.cn` | 高 |
| kugou | 直链 | Referer `kugou.com` + 移动 UA | 高 |
| migu | 直链（`+`→`%2B`） | Referer/移动 UA/`okhttp` | 高~中 |
| taihe | 直链 | Referer `music.taihe.com` | 高 |
| xiami | 上游已停服 | — | 低/未知（可能整源不可用） |
| bilibili (audio `bitrack_`) | 直 audio CDN | Referer `bilibili.com` | 高 |
| bilibili (video `bitrack_v_`) | DASH audio `baseUrl`（单文件但体积大） | Referer `bilibili.com` | 中（体积大，下的是音频轨） |
| localmusic | 本地 `file://` | 无需网络，直接复制 | 最高（复制文件即可） |

**m3u8 / HLS / DASH 多分片**：当前所有 `bootstrap_track` 返回的都是单文件直链，无 HLS。但需加一道**格式守卫**：若 `url` 指向 `.m3u8`/`.m3u` 或多分片，本阶段**优雅跳过**并提示"该音源为流媒体，暂不支持下载"（Phase 3 再考虑 ffmpeg demux；注意本工程当前无 ffmpeg 资产）。

---

## 5. UI 入口（与 Phase 1 收藏按钮视觉一致）

复用 Phase 1 已验证的双主题卡片/详情页范式（`common.css` / `common2.css` 的 `.bottom` / `.fav` 视觉语言）：

1. **歌单详情页每行歌曲**加下载图标（`ul.detail-songlist li`，两套主题 × 列表/网格视图共 4 处），`ng-click="DownloadManager.enqueue(track)"`。
2. **歌单详情页头部**加「下载全部」按钮（紧邻现有播放/收藏按钮），`ng-click="DownloadManager.enqueuePlaylist(currentTracks)"`。
3. **侧边栏**加「下载管理」入口（在"收藏的歌单"附近），打开下载管理器对话框。
4. **下载管理器对话框**：复用 `showDialog`（navigation.js）加一个 `dialog_type`，列出队列、进度条、取消/重试、已完成/失败计数。两套主题外壳都要加（`listen1.html` ~L97 / ~L2177）。

> 注意记忆里的 UI 雷区：详情页 `ul.detail-songlist .playlist-search` 是绝对定位浮在歌单上方，前面插块会重叠；新入口只能放在行内或头部，不能插在 `<ul>` 前。搜索框偏移 black `top:-30px` / black2 `top:-50px`，预留 ≥52px。

---

## 6. i18n 新增键（6 语言：zh-CN/zh-TC/en-US/fr-FR/ko-KR/pt-BR）

`_DOWNLOAD`、`_DOWNLOAD_ALL`、`_DOWNLOADING`、`_DOWNLOADS`、`_DOWNLOAD_COMPLETE`、`_DOWNLOAD_FAILED`、`_DOWNLOAD_MANAGER`、`_DOWNLOAD_CANCEL`、`_DOWNLOAD_RETRY`、`_DOWNLOAD_STREAM_UNSUPPORTED`（流媒体不支持）。
需逐语言补，保持各文件 185 键一致；新键同时显式绑 `$rootScope` 兜底。

---

## 7. 文件改动清单

| 文件 | 改动 |
|---|---|
| `app/functions.js` | 新增 `downloadTrack` / `sanitizeFileName` / `pickDownloadDir` / `REFERER_MAP` |
| `app/listen1_chrome_extension/js/download_manager.js` | 新增 `DownloadManager` service（队列/并发/持久化/回调） |
| `js/controller/*.js`（导航/歌单详情） | 注入 `DownloadManager`，接 URL 解析与按钮 |
| `listen1.html` | 行内下载图标 ×4（双主题×列表/网格）、头部"下载全部" ×2（双主题）、下载管理器对话框 ×2 |
| `css/common.css` / `css/common2.css` | 下载按钮/进度条/对话框样式（对齐 `.fav`/`.bottom` 视觉） |
| `i18n/*.json` ×6 | 新增下载相关键 |

---

## 8. 分阶段实施里程碑

- **M0 — Spike（必做，阻断后续）**：临时脚本逐 provider 验证"最小可用 header 集"，固化 `REFERER_MAP`。
- **M1 — 执行器 + 管理器**：`functions.js` 下载落盘 + `DownloadManager` 队列/持久化（先命令行/手动触发验证）。
- **M2 — 单首下载 UI**：详情页行内下载图标（双主题×视图）。
- **M3 — 批量 + 管理器对话框**：头部"下载全部"、侧栏入口、对话框（双主题）。
- **M4 — i18n + 收尾**：6 语言补全、格式守卫、边界（限速 URL、m3u8 跳过、localmusic 复制）。

---

## 9. 验证方案

- 每 milestone 用 Edge headless 双主题**隔离渲染**截图，确认按钮几何/进度条（沿用 Phase 1 的 harness 方法）。
- 真机（MI 9 SE）验证：从精选歌单进详情 → 下载一首 netease/qq/bilibili → 文件出现在 `下载/Listen1/` → 可正常播放；再试"下载全部"与取消/重试；`pm clear` 前先验证持久化恢复。
- Electron GUI 无法在沙箱跑，真机验证交给真机（按你既定流程）。

---

## 10. 风险与边界

- **限速/签名 URL**：netease 等 URL 有时效，必须"点下载时再解析"，不能缓存 URL。
- **防盗链**：以 spike 结果为准，seed 来自 `background.js` 注释段，不臆测。
- **CORS**：下载执行器放 Node 侧规避；renderer `fetch` 仅作小文件兜底（仍可能 CORS 失败）。
- **流媒体**：m3u8/DASH 多分片本阶段跳过，留 Phase 3。
- **法律/ToS**：个人本地播放用途；不内置破解/批量盗抓，遵循各平台合理使用边界（由你最终把控）。

---

### 下一步
确认范围后即按 M0→M4 推进。建议先把 **M0 spike** 跑出来，把 `REFERER_MAP` 实测固化，这一步决定了后续所有 provider 的可用性，是最该先做的。是否开工 M0？
