/**
 * @name LX Music 歌单导入
 * @id you.lx-playlist-importer
 * @version 2.0.0
 * @description 将 LX Music（洛雪音乐）的歌单导入到 SPlayer-Next。支持导入到播放队列，或创建网易云音乐歌单。
 * @author WorkBuddy
 * @apiLevel 4
 * @grant network control ui api
 * @homepage https://github.com/SPlayer-Dev/SPlayer-Next
 * @changelog v2.0.0 新增「创建网易云歌单」模式：通过 splayer.api.call 调用网易云接口创建歌单并添加歌曲；非网易云源歌曲自动搜索匹配后添加
 * @changelog v1.4.0 增强容错：未知 type 时自动探测 data/顶层 list 字段；错误信息附带实际 type、keys、数据开头预览，便于诊断
 * @changelog v1.3.0 新增支持 .lxmc 解压后的 playList_v2 和 allData_v2 格式；配套提供 lxmc_decoder.py + 解压lxmc.bat 解密工具
 * @changelog v1.2.0 降低 apiLevel 要求从 5 到 4（实际只用到 Level 4 能力），兼容更多版本
 * @changelog v1.1.0 修复 menuClick 超时问题（改为后台异步执行）；增加防重入；错误信息通过通知反馈；platform 参数校验
 */

// ============================================================
// LX Music 歌单导入插件
// ------------------------------------------------------------
// 工作原理：
// 1. 用户在插件设置里粘贴 LX Music 的歌单数据（playlist.json 全文
//    或单个歌单的 JSON），选择导入目标（播放队列 / 网易云歌单）。
// 2. 通过插件菜单「导入 LX Music 歌单」触发导入。
// 3. 插件解析歌单：
//    - 播放队列模式：逐首搜索匹配后加入 SPlayer-Next 播放队列。
//    - 网易云歌单模式：网易云源歌曲直接用原 ID，其他源歌曲搜索
//      匹配到网易云后，调用网易云 API 创建歌单并批量添加歌曲。
// 4. 支持批量分页（addToQueue 每批最多 50 首；网易云添加歌曲每批最多 1000 首）。
// ============================================================

// ---------- 常量 ----------

// 网易云添加歌曲到歌单，每批最多 1000 首
const NETEASE_TRACKS_BATCH = 500;

// LX Music 源标识 -> SPlayer-Next 平台标识
// LX: wy=网易云, tx=QQ, kg=酷狗, kw=酷我, mg=咪咕
// SPlayer-Next 内置平台: netease / qqmusic / kugou
const LX_SOURCE_TO_PLATFORM = {
  wy: "netease",
  tx: "qqmusic",
  kg: "kugou",
  kw: "netease", // 酷我无内置对应，降级到网易云搜索
  mg: "netease", // 咪咕同上
};

const PLATFORM_LABELS = {
  netease: "网易云音乐",
  qqmusic: "QQ 音乐",
  kugou: "酷狗音乐",
};

// addToQueue 单次上限 50 首
const QUEUE_BATCH_SIZE = 50;
// 搜索限流：每首之间间隔（毫秒），避免触发平台风控
const SEARCH_INTERVAL_MS = 350;
// 单首歌搜索结果上限
const SEARCH_LIMIT = 5;

// ---------- 工具函数 ----------

function parseIntervalToMs(interval) {
  // LX 的 interval 形如 "03:55"
  if (!interval || typeof interval !== "string") return null;
  const m = interval.match(/^(\d+):(\d+)$/);
  if (!m) return null;
  return (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) * 1000;
}

function normalizeText(s) {
  if (s == null) return "";
  return String(s).toLowerCase().replace(/\s+/g, " ").trim();
}

// 简单字符串相似度（基于字符重叠）
function similarity(a, b) {
  a = normalizeText(a);
  b = normalizeText(b);
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  // 包含关系给较高分
  if (a.includes(b) || b.includes(a)) return 0.9;
  // 编辑距离相似度
  const maxLen = Math.max(a.length, b.length);
  const dist = levenshtein(a, b);
  return 1 - dist / maxLen;
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1, // 删除
        dp[j - 1] + 1, // 插入
        prev + (a[i - 1] === b[j - 1] ? 0 : 1) // 替换
      );
      prev = tmp;
    }
  }
  return dp[n];
}

// 从一首 LX 歌曲信息构造搜索词
function buildQuery(song) {
  const name = song.name || "";
  const singer = song.singer || "";
  // 多个歌手用 / 分隔，取第一个主唱 + 歌名通常更精准
  const primarySinger = singer.split(/[\/、,，]/)[0].trim();
  return primarySinger ? `${name} ${primarySinger}` : name;
}

// 从 LX 歌曲的 source 字段决定优先平台
function pickPlatformFromSong(song, fallback) {
  const src = song.source;
  if (src && LX_SOURCE_TO_PLATFORM[src]) return LX_SOURCE_TO_PLATFORM[src];
  return fallback;
}

// 匹配评分：在搜索结果中挑出与原曲最接近的一首
function pickBestMatch(original, candidates) {
  if (!candidates || candidates.length === 0) return null;
  let best = null;
  let bestScore = -1;
  for (const track of candidates) {
    const titleSim = similarity(original.name, track.title);
    const artistStr = (track.artists || []).map((a) => a.name).join(" / ");
    const artistSim = similarity(original.singer || "", artistStr);
    // 时长接近度（差值越小越好）
    let durationScore = 0.5;
    if (original.durationMs && track.duration) {
      const diff = Math.abs(original.durationMs - track.duration);
      durationScore = Math.max(0, 1 - diff / 30000); // 30 秒内得正分
    }
    const score = titleSim * 0.55 + artistSim * 0.35 + durationScore * 0.1;
    if (score > bestScore) {
      bestScore = score;
      best = { track, score };
    }
  }
  return best;
}

// ---------- LX 歌单解析 ----------

// LX Music 的 playlist.json 是 NDJSON（每行一个 JSON 对象），
// 每行形如：{"type":"playListPart_v2","data":{...}}
// 也可能用户粘贴的是单个歌单对象或格式化后的数组。
function parseLxPlaylistData(raw) {
  if (!raw || typeof raw !== "string") {
    throw new Error("歌单数据为空");
  }
  const text = raw.trim();

  // 情况 1：整体是一个合法 JSON（对象或数组），最常见情况
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    // 整体不是合法 JSON，后面走 NDJSON 分支
  }
  if (parsed !== null) {
    if (Array.isArray(parsed)) {
      return parseArray(parsed);
    }
    if (parsed && typeof parsed === "object") {
      return parseSingleObject(parsed, text);
    }
    throw new Error("JSON 解析后得到非对象/数组类型：" + typeof parsed);
  }

  // 情况 2：NDJSON（playlist.json 原样，每行一个独立 JSON 对象）
  if (text.includes("\n")) {
    return parseNDJSON(text);
  }

  // 情况 3：单行也无法解析
  throw new Error("JSON 解析失败，数据开头：" + text.substring(0, 120).replace(/\s+/g, " "));
}

// 解析单个 JSON 对象，自动识别 LX Music 的各种歌单结构
function parseSingleObject(obj, text) {
  if (!obj || typeof obj !== "object") {
    throw new Error("解析结果不是对象");
  }
  // .lxmc 多歌单导出：{type:"playList_v2", data:[歌单数组]}
  if (obj.type === "playList_v2" && Array.isArray(obj.data)) {
    return obj.data.filter((p) => p && Array.isArray(p.list));
  }
  // .lxmc 全量备份：{type:"allData_v2", playList:[...], setting:{...}}
  if (obj.type === "allData_v2" && Array.isArray(obj.playList)) {
    return obj.playList.filter((p) => p && Array.isArray(p.list));
  }
  // 老版本：{type:"playList", data:[...]}
  if (obj.type === "playList" && Array.isArray(obj.data)) {
    return obj.data.filter((p) => p && Array.isArray(p.list));
  }
  // playlist.json 单行分片 / .lxmc 单歌单导出：{type:"playListPart_v2", data:{...}}
  if (obj.type === "playListPart_v2" && obj.data) {
    const d = obj.data;
    if (d && Array.isArray(d.list)) return [d];
    if (Array.isArray(d)) return d.filter((p) => p && Array.isArray(p.list));
  }
  // 单个 UserListInfoFull（带 list 字段）
  if (obj.id && Array.isArray(obj.list)) {
    return [obj];
  }
  // MyAllList 结构 {defaultList/loveList/userList/...}
  if (obj.defaultList || obj.loveList || obj.userList) {
    return flattenMyAllList(obj);
  }
  // 通用容错：data 是歌单对象（含 list 数组）
  if (obj.data && !Array.isArray(obj.data) && Array.isArray(obj.data.list)) {
    return [obj.data];
  }
  // 通用容错：data 是歌单数组（含 list）
  if (obj.data && Array.isArray(obj.data)) {
    const filtered = obj.data.filter((p) => p && Array.isArray(p.list));
    if (filtered.length) return filtered;
  }
  // 通用容错：顶层对象本身就是一个歌单（含 list 数组）
  if (Array.isArray(obj.list)) {
    return [obj];
  }
  const typeStr = obj.type ? obj.type : "(无 type)";
  const keysStr = Object.keys(obj).slice(0, 8).join(",");
  const preview = (text || JSON.stringify(obj)).substring(0, 120).replace(/\s+/g, " ");
  throw new Error(`无法识别的歌单 JSON 结构（type=${typeStr}, keys=[${keysStr}]）数据开头：${preview}`);
}

// 解析 JSON 数组，元素可能是 playListPart_v2、歌单对象、MyAllList 等
function parseArray(arr) {
  const result = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "playListPart_v2" && item.data) {
      if (item.data && Array.isArray(item.data.list)) result.push(item.data);
    } else if (item.id && Array.isArray(item.list)) {
      result.push(item);
    } else if (item.defaultList || item.userList) {
      result.push(...flattenMyAllList(item));
    } else if (Array.isArray(item.list)) {
      result.push(item);
    }
  }
  return result;
}

function parseNDJSON(text) {
  const result = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (e) {
      continue; // 跳过无法解析的行
    }
    if (obj && obj.type === "playListPart_v2" && obj.data) {
      result.push(obj.data);
    }
  }
  if (result.length === 0) {
    throw new Error("NDJSON 中未找到有效的 playListPart_v2 条目");
  }
  return result;
}

// 将 LX 的 MyAllList 结构（defaultList/loveList/userList）拍平成歌单列表
function flattenMyAllList(allList) {
  const result = [];
  if (allList.defaultList && allList.defaultList.list) {
    result.push({
      id: "default",
      name: "试听列表",
      list: allList.defaultList.list,
    });
  }
  if (allList.loveList && allList.loveList.list) {
    result.push({
      id: "love",
      name: "我的收藏",
      list: allList.loveList.list,
    });
  }
  if (Array.isArray(allList.userList)) {
    for (const ul of allList.userList) {
      if (ul && Array.isArray(ul.list)) {
        result.push({ id: ul.id, name: ul.name || "未命名歌单", list: ul.list });
      }
    }
  }
  return result;
}

// 把 LX 的 MusicInfo 转成统一的"待搜索歌曲"对象
function normalizeLxSong(lxSong) {
  if (!lxSong || typeof lxSong !== "object") return null;
  const meta = lxSong.meta || {};
  return {
    id: String(lxSong.id || ""),
    name: lxSong.name || "",
    singer: lxSong.singer || "",
    source: lxSong.source || "",
    interval: lxSong.interval || null,
    durationMs: parseIntervalToMs(lxSong.interval),
    albumName: meta.albumName || "",
    picUrl: meta.picUrl || null,
    raw: lxSong,
  };
}

// ---------- 网易云歌单操作 ----------

// 从 LX 歌曲对象提取网易云歌曲 ID（纯数字）
// LX 的 wy 源歌曲 id 形如 "wy_156846"，meta.songId 是 156846
function extractNeteaseSongId(lxSong) {
  if (!lxSong) return null;
  const meta = lxSong.meta || {};
  // 优先用 meta.songId（纯数字）
  if (meta.songId && /^\d+$/.test(String(meta.songId))) {
    return String(meta.songId);
  }
  // 从 id 字段提取 "wy_数字" 中的数字
  const idStr = String(lxSong.id || "");
  const m = idStr.match(/^wy[_-]?(\d+)$/i);
  if (m) return m[1];
  return null;
}

// 调用网易云 API 创建歌单，返回歌单 ID
// 文档：/playlist/create  参数 name, privacy(0公开/10私密)
async function createNeteasePlaylist(name, privacy) {
  const result = await splayer.api.call("netease", "playlist_create", {
    name: name,
    privacy: privacy,
  });
  if (!result.ok) {
    throw new Error("创建歌单接口调用失败：" + result.error);
  }
  const body = result.body;
  if (!body || body.code !== 200) {
    throw new Error(
      "创建歌单失败：" + (body && body.msg ? body.msg : "code=" + (body && body.code))
    );
  }
  // 返回结构：{ code:200, playlist:{ id:xxx, name:xxx } }
  const pid = body.playlist && body.playlist.id;
  if (!pid) throw new Error("创建歌单成功但未返回歌单 ID");
  splayer.log.info(`网易云歌单创建成功：${body.playlist.name} (id=${pid})`);
  return pid;
}

// 调用网易云 API 批量添加歌曲到歌单
// 文档：/playlist/tracks  参数 op:add, pid:歌单ID, tracks:逗号分隔的歌曲ID
async function addTracksToNeteasePlaylist(pid, trackIds) {
  if (!trackIds || trackIds.length === 0) return 0;
  let added = 0;
  for (let i = 0; i < trackIds.length; i += NETEASE_TRACKS_BATCH) {
    const batch = trackIds.slice(i, i + NETEASE_TRACKS_BATCH);
    const tracksStr = batch.join(",");
    try {
      const result = await splayer.api.call("netease", "playlist_tracks", {
        op: "add",
        pid: pid,
        tracks: tracksStr,
      });
      if (!result.ok) {
        splayer.log.error(`添加歌曲到歌单失败（第 ${Math.floor(i / NETEASE_TRACKS_BATCH) + 1} 批）：` + result.error);
        break;
      }
      const body = result.body;
      if (body && body.code === 200) {
        added += batch.length;
        splayer.log.info(`已添加第 ${i + 1}-${i + batch.length} 首到网易云歌单`);
      } else {
        // body 可能含 body.code 502 = 歌曲不存在, 512 = 重复添加等
        splayer.log.warn(
          `添加歌曲到歌单返回异常（第 ${Math.floor(i / NETEASE_TRACKS_BATCH) + 1} 批）：` +
            (body && body.message ? body.message : "code=" + (body && body.code))
        );
        // 部分成功也算成功
        if (body && (body.code === 502 || body.code === 512)) {
          added += batch.length;
        }
      }
    } catch (e) {
      splayer.log.error(`添加歌曲到歌单出错（第 ${Math.floor(i / NETEASE_TRACKS_BATCH) + 1} 批）：`, errStr(e));
      break;
    }
    // 批次间稍作等待
    if (i + NETEASE_TRACKS_BATCH < trackIds.length) {
      await sleep(500);
    }
  }
  return added;
}

// 网易云歌单导入模式：创建歌单并添加歌曲
// 策略：wy 源歌曲直接用原 ID；其他源歌曲搜索匹配网易云后取 ID
async function importToNeteasePlaylist(allSongs, options) {
  const { playlistName, privacy, defaultPlatform, minScore, intervalMs } = options;

  // 第一步：收集网易云歌曲 ID
  splayer.log.info("开始收集网易云歌曲 ID...");
  await safeNotify(`开始导入到网易云歌单「${playlistName}」，共 ${allSongs.length} 首待处理`);

  const neteaseIds = []; // 已确定的网易云歌曲 ID
  const needSearch = []; // 需要搜索匹配的歌曲
  let directCount = 0;

  for (const song of allSongs) {
    if (song.source === "wy") {
      const nid = extractNeteaseSongId(song.raw);
      if (nid) {
        neteaseIds.push(nid);
        directCount++;
        continue;
      }
    }
    needSearch.push(song);
  }

  splayer.log.info(`网易云源直接匹配 ${directCount} 首，需搜索匹配 ${needSearch.length} 首`);

  // 第二步：搜索匹配非网易云源的歌曲
  let searchMatched = 0;
  let searchFailed = 0;
  for (let i = 0; i < needSearch.length; i++) {
    const song = needSearch[i];
    const query = buildQuery(song);
    if (!query) {
      splayer.log.warn(`[${i + 1}/${needSearch.length}] 跳过：无法构造搜索词`, song);
      searchFailed++;
      continue;
    }
    try {
      const result = await splayer.music.searchOnline({
        platform: "netease",
        query,
        limit: SEARCH_LIMIT,
      });
      const best = pickBestMatch(song, result.tracks || []);
      if (best && best.score >= minScore && best.track) {
        // 从搜索结果提取网易云歌曲 ID
        const nid = extractTrackNeteaseId(best.track);
        if (nid) {
          neteaseIds.push(nid);
          searchMatched++;
          splayer.log.info(
            `[${i + 1}/${needSearch.length}] ✓ ${song.name} - ${song.singer} -> ${best.track.title}（${(best.score * 100).toFixed(0)}%）`
          );
        } else {
          searchFailed++;
          splayer.log.warn(`[${i + 1}/${needSearch.length}] 匹配成功但无网易云 ID：${song.name}`);
        }
      } else {
        searchFailed++;
        splayer.log.warn(
          `[${i + 1}/${needSearch.length}] ✗ 未匹配到 ${song.name} - ${song.singer}` +
            (best ? `（最佳 ${(best.score * 100).toFixed(0)}%）` : "")
        );
      }
    } catch (e) {
      searchFailed++;
      splayer.log.error(`[${i + 1}/${needSearch.length}] 搜索出错 ${song.name}:`, errStr(e));
      const msg = errStr(e);
      if (msg.includes("PERMISSION") || msg.includes("permission")) {
        await safeNotify("搜索权限被拒绝，请在插件详情中开启 network 权限");
        return;
      }
    }
    if (i < needSearch.length - 1) {
      await sleep(intervalMs);
    }
    // 每搜索 20 首通知一次进度
    if ((i + 1) % 20 === 0) {
      await safeNotify(`搜索匹配中：${i + 1}/${needSearch.length}（已匹配 ${searchMatched}）`);
    }
  }

  splayer.log.info(`歌曲 ID 收集完成：直接 ${directCount} + 搜索 ${searchMatched} = ${neteaseIds.length} 首`);

  if (neteaseIds.length === 0) {
    await safeNotify("没有可导入的歌曲（0 首匹配成功）");
    return;
  }

  // 第三步：创建网易云歌单
  await safeNotify(`正在创建网易云歌单「${playlistName}」...`);
  let pid;
  try {
    pid = await createNeteasePlaylist(playlistName, privacy);
  } catch (e) {
    splayer.log.error("创建歌单失败：", errStr(e));
    await safeNotify("创建网易云歌单失败：" + errStr(e) + "（请确认已登录网易云账号）");
    return;
  }

  // 第四步：批量添加歌曲到歌单
  await safeNotify(`歌单已创建，正在添加 ${neteaseIds.length} 首歌曲...`);
  const added = await addTracksToNeteasePlaylist(pid, neteaseIds);

  const msg = `网易云歌单「${playlistName}」创建完成，已添加 ${added} 首歌曲（共匹配 ${neteaseIds.length}/${allSongs.length}）`;
  splayer.log.info(msg);
  await safeNotify(msg);
}

// 从 SPlayer-Next 搜索结果 Track 提取网易云歌曲 ID
// Track 结构见官方文档，网易云歌曲的 id 字段是歌曲 ID
function extractTrackNeteaseId(track) {
  if (!track) return null;
  // Track.id 通常是平台内的歌曲 ID
  if (track.id && /^\d+$/.test(String(track.id))) {
    return String(track.id);
  }
  // 某些情况下 ID 可能带前缀
  const idStr = String(track.id || "");
  const m = idStr.match(/(\d+)/);
  if (m) return m[1];
  return null;
}

// ---------- 主流程 ----------

async function importPlaylist() {
  let rawData;
  try {
    rawData = splayer.getSetting("playlistJson") || "";
  } catch (e) {
    splayer.log.error("读取设置失败：", e);
    await safeNotify("读取插件设置失败：" + errStr(e));
    return;
  }
  const target = splayer.getSetting("target") || "queue";
  const defaultPlatform = splayer.getSetting("platform") || "netease";
  const minScore = Number(splayer.getSetting("minScore") ?? 0.6);
  const intervalMs = Number(splayer.getSetting("interval") ?? SEARCH_INTERVAL_MS);

  if (!rawData || !rawData.trim()) {
    splayer.log.error("歌单数据为空，请在插件设置中粘贴 LX Music 歌单 JSON");
    await safeNotify("请在插件设置中粘贴 LX Music 歌单 JSON");
    return;
  }

  splayer.log.info("开始解析 LX Music 歌单数据...");
  let playlists;
  try {
    playlists = parseLxPlaylistData(rawData);
  } catch (e) {
    splayer.log.error("解析失败：", errStr(e));
    await safeNotify("歌单解析失败：" + errStr(e));
    return;
  }

  if (playlists.length === 0) {
    await safeNotify("未找到任何歌单");
    return;
  }

  splayer.log.info(`解析到 ${playlists.length} 个歌单`);
  for (const pl of playlists) {
    splayer.log.info(`  - ${pl.name || pl.id}（${(pl.list || []).length} 首）`);
  }

  const allSongs = [];
  for (const pl of playlists) {
    const list = pl.list || [];
    for (const lxSong of list) {
      const song = normalizeLxSong(lxSong);
      if (song && song.name) allSongs.push(song);
    }
  }

  if (allSongs.length === 0) {
    await safeNotify("歌单中没有有效歌曲");
    return;
  }

  // 根据目标分发
  if (target === "neteasePlaylist") {
    // 网易云歌单模式
    let playlistName = (splayer.getSetting("neteasePlaylistName") || "").trim();
    if (!playlistName) {
      // 留空则用第一个歌单的名字
      playlistName = playlists[0] && playlists[0].name ? playlists[0].name : "LX Music 导入";
    }
    const privacy = splayer.getSetting("neteasePrivacy") === "private" ? 10 : 0;
    await importToNeteasePlaylist(allSongs, {
      playlistName,
      privacy,
      defaultPlatform,
      minScore,
      intervalMs,
    });
  } else {
    // 播放队列模式
    const position = splayer.getSetting("position") || "end";
    await importToQueue(allSongs, { defaultPlatform, minScore, intervalMs, position });
  }
}

// 播放队列导入模式
async function importToQueue(allSongs, options) {
  const { defaultPlatform, minScore, intervalMs, position } = options;

  splayer.log.info(`共 ${allSongs.length} 首歌待导入，开始搜索匹配...`);
  await safeNotify(`开始导入 ${allSongs.length} 首歌，请稍候`);

  const matched = [];
  let failed = 0;
  for (let i = 0; i < allSongs.length; i++) {
    const song = allSongs[i];
    const query = buildQuery(song);
    if (!query) {
      splayer.log.warn(`[${i + 1}/${allSongs.length}] 跳过：无法构造搜索词`, song);
      failed++;
      continue;
    }
    const platform = validPlatform(pickPlatformFromSong(song, defaultPlatform));
    try {
      const result = await splayer.music.searchOnline({
        platform,
        query,
        limit: SEARCH_LIMIT,
      });
      const best = pickBestMatch(song, result.tracks || []);
      if (best && best.score >= minScore) {
        matched.push(best.track);
        splayer.log.info(
          `[${i + 1}/${allSongs.length}] ✓ ${song.name} - ${song.singer} -> ${best.track.title}（${(best.score * 100).toFixed(0)}%）`
        );
      } else {
        failed++;
        splayer.log.warn(
          `[${i + 1}/${allSongs.length}] ✗ 未匹配到 ${song.name} - ${song.singer}` +
            (best ? `（最佳 ${(best.score * 100).toFixed(0)}%）` : "")
        );
      }
    } catch (e) {
      failed++;
      splayer.log.error(`[${i + 1}/${allSongs.length}] 搜索出错 ${song.name}:`, errStr(e));
      const msg = errStr(e);
      if (msg.includes("PERMISSION") || msg.includes("permission")) {
        await safeNotify("搜索权限被拒绝，请在插件详情中开启 network 权限");
        return;
      }
    }
    if (i < allSongs.length - 1) {
      await sleep(intervalMs);
    }
    if ((i + 1) % 20 === 0) {
      await safeNotify(`队列导入中：${i + 1}/${allSongs.length}（已匹配 ${matched.length}）`);
    }
  }

  splayer.log.info(`匹配完成：成功 ${matched.length}，失败 ${failed}`);

  if (matched.length === 0) {
    await safeNotify("没有匹配到任何歌曲（" + failed + " 首失败/未匹配）");
    return;
  }

  // 分批加入队列（每批最多 50 首）
  let added = 0;
  let queueError = null;
  for (let i = 0; i < matched.length; i += QUEUE_BATCH_SIZE) {
    const batch = matched.slice(i, i + QUEUE_BATCH_SIZE);
    try {
      const res = await splayer.player.addToQueue(batch, position);
      added += (res && res.count) || batch.length;
    } catch (e) {
      queueError = e;
      splayer.log.error(`入队失败（第 ${Math.floor(i / QUEUE_BATCH_SIZE) + 1} 批）:`, errStr(e));
      const msg = errStr(e);
      if (msg.includes("PERMISSION") || msg.includes("permission")) {
        await safeNotify("入队权限被拒绝，请在插件详情中开启 control 权限");
        return;
      }
      break;
    }
  }

  if (queueError && added === 0) {
    await safeNotify("入队失败：" + errStr(queueError));
    return;
  }

  const msg = `已导入 ${added} 首到播放队列（匹配 ${matched.length}/${allSongs.length}）`;
  splayer.log.info(msg);
  await safeNotify(msg);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 安全的通知封装，notify 本身可能失败（权限关闭/系统不支持）
async function safeNotify(msg) {
  try {
    await splayer.notify(msg);
  } catch (e) {
    splayer.log.warn("通知发送失败：", e);
  }
}

// 把任意错误对象转成可读字符串
function errStr(e) {
  if (!e) return "未知错误";
  if (typeof e === "string") return e;
  if (e.message) return e.message;
  try {
    return JSON.stringify(e);
  } catch (_) {
    return String(e);
  }
}

// 校验 platform 值合法
function validPlatform(p) {
  return p === "netease" || p === "qqmusic" || p === "kugou" ? p : "netease";
}

// ---------- 注册 ----------

splayer.register({
  controls: true,
  settings: [
    {
      key: "playlistJson",
      type: "text",
      label: "LX Music 歌单 JSON",
      default: "",
      placeholder:
        "粘贴 LX Music 的 playlist.json 全文，或单个歌单的 JSON。位置：%APPDATA%/lx-music-desktop/playlist.json",
    },
    {
      key: "target",
      type: "select",
      label: "导入目标",
      default: "queue",
      description:
        "播放队列：导入到 SPlayer-Next 当前播放队列；网易云歌单：在网易云音乐创建新歌单并添加歌曲（需已登录网易云账号）。",
      options: [
        { label: "播放队列", value: "queue" },
        { label: "网易云歌单（新建）", value: "neteasePlaylist" },
      ],
    },
    {
      key: "neteasePlaylistName",
      type: "text",
      label: "网易云歌单名称",
      default: "",
      placeholder: "留空则使用 LX 歌单原名",
      description: "仅在「导入目标」选择「网易云歌单」时生效。",
    },
    {
      key: "neteasePrivacy",
      type: "select",
      label: "网易云歌单隐私",
      default: "private",
      description: "仅在「导入目标」选择「网易云歌单」时生效。",
      options: [
        { label: "私密", value: "private" },
        { label: "公开", value: "public" },
      ],
    },
    {
      key: "platform",
      type: "select",
      label: "默认搜索平台",
      default: "netease",
      description:
        "播放队列模式下，当歌曲来源无法对应内置平台时使用。网易云歌单模式下固定搜索网易云。LX 的 wy→网易云、tx→QQ、kg→酷狗会自动映射。",
      options: [
        { label: "网易云音乐", value: "netease" },
        { label: "QQ 音乐", value: "qqmusic" },
        { label: "酷狗音乐", value: "kugou" },
      ],
    },
    {
      key: "minScore",
      type: "number",
      label: "最低匹配分（0-1）",
      default: 0.6,
      min: 0,
      max: 1,
      description: "低于此分的搜索结果不会被导入。提高可减少错配，降低可增加导入率。",
    },
    {
      key: "interval",
      type: "number",
      label: "搜索间隔（毫秒）",
      default: SEARCH_INTERVAL_MS,
      min: 0,
      max: 5000,
      description: "每首歌搜索之间的等待时间，避免触发平台风控。",
    },
    {
      key: "position",
      type: "select",
      label: "入队位置",
      default: "end",
      description: "仅在「导入目标」选择「播放队列」时生效。",
      options: [
        { label: "队列末尾", value: "end" },
        { label: "当前歌曲之后", value: "next" },
      ],
    },
  ],
  menus: [
    {
      id: "import-lx-playlist",
      label: "导入 LX Music 歌单",
    },
  ],
});

// 导入任务后台执行，避免 menuClick 处理器超时（官方限时 15 秒）
let importRunning = false;

splayer.on("menuClick", ({ menuId }) => {
  if (menuId !== "import-lx-playlist") return { toast: "未知操作" };
  if (importRunning) {
    return { toast: "上一次导入还在进行中，请等待完成" };
  }
  // 立即返回，长任务后台异步执行
  importRunning = true;
  importPlaylist()
    .catch((e) => {
      splayer.log.error("导入任务异常：", e);
      splayer
        .notify("导入异常：" + (e && e.message ? e.message : String(e)))
        .catch(() => {});
    })
    .finally(() => {
      importRunning = false;
    });
  return { toast: "LX 歌单导入任务已启动，进度请查看通知" };
});

splayer.log.info("LX Music 歌单导入插件已加载");
