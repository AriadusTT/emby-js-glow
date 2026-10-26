/**
 * HomeSwiper — Emby 首页轮播插件（唯一手写逻辑源码，普通 ES 模块）
 * ---------------------------------------------------------------------------
 * 构建：`.build/assemble.js` 交给 esbuild 打包（--format=iife），
 *   Swiper 库 + SWIPER_CSS + CUSTOM_CSS + 插件逻辑全部内联在一个文件里。
 * 运行时零外部文件、零网络拉取；两份 CSS 由本插件以 <style> 注入 <head>。
 *
 * 分层与职责：
 *   S1+S2 构建/样式管线 · S3 内容获取（纯数据层，顶层不触碰 DOM）·
 *   S4 轮播渲染 · S5 预告片层 · S6 媒体库条 + 设置面板。
 *
 * ===========================================================================
 * DOM / 类名契约（跨文件共享知识：styles.css 与各段实现都依赖本表）
 * ===========================================================================
 * 轮播根容器内自下而上（另加媒体库条 / 设置面板，挂点见末尾）：
 *
 *   <根容器 .hs-root>                 position:relative；透明底（露出页面背景）；禁止 overflow:hidden
 *      ├── .swiper                    z-index:1；背景透明；slide 内只放 backdrop <img>
 *      │      slide 一律标 data-pool-index（内容/配图都走它取，不拿 activeIndex 当下标）
 *      ├── <video.hs-video>           z-index:2；pointer-events:none；几何由 --hs-video-* 驱动
 *      ├── .hs-video-bar              z-index:3；页面级进度条（轮播块最底部，整行宽，2px）
 *      ├── .hs-hotzone--prev / --next z-index:3；左右边缘的自建 hover 热区（唯一交互层）
 *      │      （必须排在箭头之前入 DOM，否则同层会吃掉箭头点击）
 *      ├── .swiper-button-prev / -next  z-index:5（在信息层之上，否则被文字遮罩压暗）
 *      │      必须是 .swiper 的「兄弟元素」；类名必须保留官方名，否则 Swiper 不注入 SVG；
 *      │      显式传 navigation:{prevEl,nextEl}；pointer-events:none（点击由热区承接）
 *      ├── .hs-mute                   z-index:5；静音按钮（视频面板右下角，悬停轮播区才显示）
 *      └── .hs-info                   z-index:4；容器 pointer-events:none；内部只有按钮 auto
 *             · .hs-info__inner              **两个实例**交替，.is-active 那个可见（硬切，无过渡）
 *             · .hs-info__inner.is-active::before  文字遮罩（整块高度、左缘贴 0、左深右浅）
 *             · .hs-title-slot               标题槽（**下沿**锚定在 --hs-logo-top）
 *                    · .hs-logo (img) / .hs-title-text      双形态（Logo 按列宽缩放）
 *             · .hs-info__meta               事实行（绝对定位 top:0，固定 26px 高）
 *             · .hs-tagline                  标语（绝对定位 top:36px，固定 2 行 42px）
 *             · .hs-overview                 简介（绝对定位 top:96px → bottom:0）
 *                    · .hs-overview__track > .hs-overview__body（正文；超长时自动循环滚动）
 *             · .hs-info__actions > .hs-btn.hs-btn--play / .hs-btn--detail（绝对定位钉底）
 *             · .hs-indicator               位置刻度（44×2px，池里只有一条时不显示）
 *             · .hs-placeholder              占位文案（仅占位态可见；空池/失败都用它）
 *
 * 媒体库条（挂 Emby 顶栏中间格 .headerMiddle）：
 *      .hs-libbar > .hs-libbar__track > .hs-libbar__item(.is-active)
 * 设置入口（挂左侧抽屉 .mainDrawer 导航列表）：
 * 设置面板：
 *      .hs-panel > .hs-panel__header(.hs-panel__title / .hs-panel__close)
 *               > .hs-panel__body > .hs-panel__field(.hs-panel__label)
 *               > .hs-panel__footer
 *
 * 状态类：
 *      body.hs-home            → 仅在首页视图挂载；所有自定义选择器一律带此前缀
 *      .hs-root.is-placeholder → 占位态（底图空、仅一行占位文案）
 *      .hs-root.is-trailer     → 预告面板出现（视频/静音按钮/进度条此刻可见）
 *      .hs-root.is-video-swap  → 换源窗口期：视频与静音按钮立即不可见（防黑帧）
 *      .hs-root.is-arrows-visible → 强制显示箭头（常规由左右热区 hover 驱动）
 * ===========================================================================
 */

import Swiper from "swiper";
import { Navigation, EffectFade } from "swiper/modules";

/* ------------------------------------------------------------------ *
 * 常量区：各设置项默认值（与设置面板一一对应）
 * ------------------------------------------------------------------ */

/** 构建标记：只用于在 Console 里确认客户端跑的是哪个版本。 */
const BUILD_TAG = "__BUILD_TAG__";

/** Swiper 翻页速度，毫秒。0 = 硬切（背景直接替换，不做交叉淡入）。 */
export const SWIPER_SPEED = 0;

/** 每轮抽取的条目数（设置项 PoolSize 的默认值）。 */
export const POOL_SIZE = 20;

/** 单张图片停留时长，毫秒（设置项 ImageInterval 的默认值）。 */
export const IMAGE_INTERVAL = 10000;

/** 预告片音量，0–1（设置项 TrailerVolume 的默认值）。 */
export const TRAILER_VOLUME = 0.6;

/** 是否播放预告片（设置项 PlayTrailer 的默认值）。 */
export const PLAY_TRAILER = true;

/**
 * 从切条到开始播的最小间隔：只为等文字入场落位（约 0.58s）。
 * 取数不串行等待 —— 切条即发请求，网络耗时与文字动画重叠。
 */
export const TRAILER_MIN_START_MS = 540;

/** 视频面板淡入/淡出时长；CSS 的 transition 必须与此一致（毫秒）。 */
export const TRAILER_FADE_MS = 700;

/** 面板低于这个宽度就不播（再小看不出是视频）。 */
export const TRAILER_PANE_MIN = 680;


/** 播放态：视频占轮播块宽度的比例（固定占比，比例差交给 cover 裁切）。 */
export const TRAILER_VIDEO_SHARE = 0.78;


/**
 * 取景重心（纵向百分比，object-position 的 Y）。
 *
 * 语义：`p%` 表示"图片的 p% 高度对齐盒子的 p% 高度"。
 * 上下有溢出时 ⇒ 顶部切 p、底部切 (1−p)。
 *   · 40 = 偏上（多留天空/上部，底部切得多）
 *   · **55 = 略偏下（当前值：把取景框往下挪一点，保住底部文字）**
 *   · 70 = 更偏下（顶部切得多）
 * 只在 cover 且纵向溢出时可见；窄窗口是横向裁切，此项无效。
 */
export const TRAILER_FRAME_Y = 55;

/** 视频面板与轮播块底边的留白（0 = 贴满高度，底边与轮播块重合）。 */
export const TRAILER_INSET_BOTTOM = 0;

/** 简介超长时自动滚动的起始延迟（毫秒）：先让人读完开头两行。 */
export const OVERVIEW_SCROLL_DELAY_MS = 2600;

/** 等待首帧解码的上限：超时就当这条播不了（毫秒）。 */
export const TRAILER_READY_TIMEOUT_MS = 12000;


/**
 * 挑选策略（设置项 SelectionLogic 的默认值）。
 * 默认「随机换批」：每次换批都向服务器要一批新的随机条目，首页不容易"每天一样"。
 * 可选值见 STRATEGIES 的键。
 */
export const SELECTION_LOGIC = "shuffle";

/** 轮播与设置面板共用的默认值聚合（只读）。 */
export const DEFAULTS = Object.freeze({
  POOL_SIZE,
  IMAGE_INTERVAL,
  TRAILER_VOLUME,
  PLAY_TRAILER,
  SELECTION_LOGIC,
});

/** 设置键名后缀：完整键名为 `<userId>-swiperLibraryAccess`。 */
export const SETTINGS_KEY_SUFFIX = "-swiperLibraryAccess";

/** 新增设置的字段默认值（LibId 无默认，取「第一个库」，见 resolveLibId）。 */
export const SETTINGS_FIELD_DEFAULTS = Object.freeze({
  LibId: null,
  PoolSize: POOL_SIZE,
  ImageInterval: IMAGE_INTERVAL,
  PlayTrailer: PLAY_TRAILER,
  TrailerVolume: TRAILER_VOLUME,
  SelectionLogic: SELECTION_LOGIC,
});

/** Emby 凭据在 localStorage 的键（`modules/emby-apiclient/credentials.js` 实测）。 */
export const CREDENTIALS_STORAGE_KEY = "servercredentials3";

/** 本地池缓存的键前缀（真实键含 userId+serverId+libId）。 */
export const POOL_CACHE_PREFIX = "homeswiper.pool:";

/** 查询用 ImageTypes：逗号串（服务端真正过滤无配图条目）。 */
export const QUERY_IMAGE_TYPES = "Primary,Backdrop";

/**
 * 查询用 Fields：缺了 Overview/Taglines 标语简介会永远为空（实测）；
 * 缺了 Genres 则「标签行」永远不渲染（真机 bug：标签一直不显示，因为本列表默认不回包 Genres）。
 * 注：`ProductionYear` 不在列表接口默认返回集里（实测 0/50），必须显式列入，
 * 否则元信息的「年份」行永远为空 —— 这是相对计划书 6.2 的一处有意补充（已实测）。
 */
export const QUERY_FIELDS =
  "Taglines,Overview,Genres,ParentId,LocalTrailerCount,OfficialRating,CommunityRating,CriticRating,ProductionYear";

/** CollectionType → IncludeItemTypes 映射（其余的走宽松集合）。 */
export const INCLUDE_ITEM_TYPES = Object.freeze({
  movies: "Movie",
  tvshows: "Series",
  musicvideos: "MusicVideo",
  homevideos: "Video",
  photos: "Photo",
  boxsets: "BoxSet",
});

/** 未知 CollectionType 的宽松集合。 */
export const LOOSE_ITEM_TYPES = "Movie,Series,Episode,Video,MusicVideo,BoxSet";

/**
 * 计算某用户的设置存储键名。
 * @param {string} userId 当前用户 Id。
 * @returns {string} 形如 `<userId>-swiperLibraryAccess` 的键名。
 */
export function settingsKey(userId) {
  return String(userId == null ? "" : userId) + SETTINGS_KEY_SUFFIX;
}

/* ------------------------------------------------------------------ *
 * 环境适配层（懒访问；模块顶层绝不触碰 DOM / window / localStorage）
 * ------------------------------------------------------------------ */

/** 安全取全局对象（Node 下也返回 globalThis）。 */
function globalObj() {
  if (typeof globalThis !== "undefined") return globalThis;
  return {};
}

/** 取 document（无 DOM 时返回 null）。 */
function getDoc() {
  const g = globalObj();
  return g && g.document ? g.document : null;
}

/** 取 window（无 window 时回落 globalThis）。 */
function getWin() {
  const g = globalObj();
  if (g && g.window) return g.window;
  return g || null;
}

/** 取 MutationObserver 构造器（window → 全局）。 */
function getMutationObserver() {
  const w = getWin();
  if (w && typeof w.MutationObserver === "function") return w.MutationObserver;
  const g = globalObj();
  if (g && typeof g.MutationObserver === "function") return g.MutationObserver;
  return null;
}

/** 取 ResizeObserver 构造器（window → 全局）。 */
function getResizeObserver() {
  const w = getWin();
  if (w && typeof w.ResizeObserver === "function") return w.ResizeObserver;
  const g = globalObj();
  if (g && typeof g.ResizeObserver === "function") return g.ResizeObserver;
  return null;
}

/** 取 AbortController 构造器。 */
function getAbortController() {
  const w = getWin();
  if (w && typeof w.AbortController === "function") return w.AbortController;
  const g = globalObj();
  if (g && typeof g.AbortController === "function") return g.AbortController;
  return null;
}

/**
 * 取 Emby 的 ApiClient 单例。
 * 4.11 实测：`app.js` 置 `connectionManager.globalScopeApiClient = !0`，
 * 由 `connectionmanager.js` 的 `setCurrentApiClient()` 写入 `globalThis.ApiClient`。
 * @returns {object|null} ApiClient 实例或 null。
 */
export function getGlobalApiClient() {
  try {
    const g = globalObj();
    return (g && g.ApiClient) || null;
  } catch (e) {
    return null;
  }
}

/** 取 localStorage（不可用时返回 null）。 */
export function getStorage() {
  try {
    const g = globalObj();
    return (g && g.localStorage) || null;
  } catch (e) {
    return null;
  }
}

/** 取 fetch 实现（不可用时返回 null）。 */
export function getFetch() {
  try {
    const g = globalObj();
    if (typeof g.fetch === "function") return g.fetch.bind(g);
  } catch (e) {
    /* ignore */
  }
  return null;
}

/** 取当前页面 origin（作为直连 REST 的 base 兜底）。 */
function getLocationOrigin() {
  try {
    const g = globalObj();
    return (g.location && g.location.origin) || "";
  } catch (e) {
    return "";
  }
}

/**
 * 组装运行环境依赖（可注入，便于 Node 侧测试）。
 * 未显式传入的项从全局懒取值；模块顶层调用它不会发生。
 * @param {{apiClient?:object,storage?:object,fetchImpl?:Function,now?:Function,userId?:string,serverId?:string,token?:string,serverBase?:string}} [overrides]
 * @returns {{apiClient:object|null,storage:object|null,fetchImpl:Function|null,now:Function,userId:string|null,serverId:string|null,token:string|null,serverBase:string|null}}
 */
export function createEnv(overrides) {
  const o = overrides || {};
  const own = (k) => Object.prototype.hasOwnProperty.call(o, k);
  return {
    apiClient: own("apiClient") ? o.apiClient : getGlobalApiClient(),
    storage: own("storage") ? o.storage : getStorage(),
    fetchImpl: own("fetchImpl") ? o.fetchImpl : getFetch(),
    now: o.now || Date.now,
    userId: own("userId") ? o.userId : null,
    serverId: own("serverId") ? o.serverId : null,
    token: own("token") ? o.token : null,
    serverBase: own("serverBase") ? o.serverBase : null,
    setTimeout: own("setTimeout") ? o.setTimeout : globalObj().setTimeout || null,
    clearTimeout: own("clearTimeout") ? o.clearTimeout : globalObj().clearTimeout || null,
    requestAnimationFrame: own("requestAnimationFrame")
      ? o.requestAnimationFrame
      : getWin() && typeof getWin().requestAnimationFrame === "function"
        ? getWin().requestAnimationFrame.bind(getWin())
        : globalObj() && typeof globalObj().requestAnimationFrame === "function"
          ? globalObj().requestAnimationFrame.bind(globalObj())
          : null,
    cancelAnimationFrame: own("cancelAnimationFrame")
      ? o.cancelAnimationFrame
      : getWin() && typeof getWin().cancelAnimationFrame === "function"
        ? getWin().cancelAnimationFrame.bind(getWin())
        : globalObj() && typeof globalObj().cancelAnimationFrame === "function"
          ? globalObj().cancelAnimationFrame.bind(globalObj())
          : null,
  };
}

/* ------------------------------------------------------------------ *
 * 查询拼装（6.2）
 * ------------------------------------------------------------------ */

/**
 * CollectionType 自适应 → IncludeItemTypes 串。
 * @param {string} [collectionType]
 * @returns {string} 逗号串；未知类型返回宽松集合。
 */
export function mapIncludeItemTypes(collectionType) {
  if (!collectionType) return LOOSE_ITEM_TYPES;
  const key = String(collectionType).toLowerCase();
  return INCLUDE_ITEM_TYPES[key] || LOOSE_ITEM_TYPES;
}

/**
 * 排序预设：id 与设置项 `SelectionLogic` 的候选对齐。
 *
 * ⚠ 以后加 PlayCount / CommunityRating 这类字段时**必须带第二排序键**：
 *   它们平局极多（没看过 = 0、没评分 = 0），单键排序会得到大片并列 ⇒ 视觉上像"根本没排"。
 * @type {Object<string,{sortBy:string,sortOrder:string}>}
 */
export const SORT_PRESETS = {
  recent: { sortBy: "DateCreated", sortOrder: "Descending" },
  // 未评分 = 0，会成片并列 ⇒ 必须带 DateCreated 做第二键
  rating: { sortBy: "CommunityRating,DateCreated", sortOrder: "Descending,Descending" },
  // 从没播过的条目没有 DatePlayed ⇒ 会排在末尾，再按入库时间排
  watched: { sortBy: "DatePlayed,DateCreated", sortOrder: "Descending,Descending" },
  // ★ 真随机：服务端把整个库打乱后返回前 N 条（不是"随机起点后的连续 N 条"）
  shuffle: { sortBy: "Random", sortOrder: "Descending" },
};

/**
 * 无条件日志（不依赖 env.warn、也不依赖 hs.debug）。
 *
 * ⚠ 不要用 `env.warn`：`createEnv()` 根本没有 warn 字段 ⇒ 形如
 * `if (typeof env.warn === "function") env.warn(...)` 会永远静默（排查时被坑过一次）。
 * 只在关键链路用（每次取数 1 条），成本可忽略。
 * @param {string} msg
 */
export function logInfo(msg) {
  try {
    const g = globalObj();
    if (g && g.console && g.console.info) g.console.info("[HomeSwiper] " + msg);
  } catch (e) {
    /* ignore */
  }
}

/** 默认排序（recent）：任何回落都用它，保证"最差也能出内容"。 */
export const DEFAULT_SORT = SORT_PRESETS.recent;

/**
 * 组装 `/Users/{userId}/Items` 的查询参数（不含 userId 本身）。
 * @param {{libId:string, limit:number, includeItemTypes?:string|null, sortBy?:string, sortOrder?:string}} params
 * @returns {object} 查询对象。
 */
export function buildItemsQuery(params) {
  const p = params || {};
  const sortBy = p.sortBy || DEFAULT_SORT.sortBy;
  const sortOrder = p.sortOrder || DEFAULT_SORT.sortOrder;
  const startIndex = typeof p.startIndex === "number" && isFinite(p.startIndex) ? p.startIndex : 0;
  const query = {
    ParentId: p.libId,
    Recursive: true,
    SortBy: sortBy,
    SortOrder: sortOrder,
    Limit: p.limit,
    ImageTypes: QUERY_IMAGE_TYPES,
    Fields: QUERY_FIELDS,
  };
  if (p.includeItemTypes) {
    query.IncludeItemTypes = p.includeItemTypes;
  }
  // ★ 分页游标：**必须**下发，否则"换一批"永远取回第一页（真机：换了像没换）
  const start = typeof p.startIndex === "number" && isFinite(p.startIndex) ? p.startIndex : 0;
  if (start > 0) query.StartIndex = start;
  return query;
}

/**
 * 复刻 Emby `queryString.paramsToString`：URLSearchParams.set，跳过 null / 空串。
 * （实测 `modules/common/querystring.js`：数组经 URLSearchParams 也变逗号串。）
 * @param {object} params
 * @returns {string} query string（无前导 ?）。
 */
export function toQueryString(params) {
  const sp = new URLSearchParams();
  if (params) {
    for (const key in params) {
      if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
      const value = params[key];
      if (value === null || value === undefined || value === "") continue;
      sp.set(key, value);
    }
  }
  return sp.toString();
}

/* ------------------------------------------------------------------ *
 * 设置读写（七章；LibId 四条读取规则按序落地）
 * ------------------------------------------------------------------ */

/**
 * 从任意旧形态里抽取 LibId。
 * 旧值容错（按序）：① 字符串 ② 数组取[0] ③ Policy.EnabledFolders[0] ④ EnabledFolders[0]；
 * 对象含 LibId（新结构）则先解包再抽取。
 * @param {*} value
 * @returns {{id:string|null, allFolders:boolean}}
 */
export function extractLibId(value) {
  if (value === null || value === undefined) {
    return { id: null, allFolders: false };
  }
  if (typeof value === "string") {
    return { id: value.length ? value : null, allFolders: false };
  }
  if (typeof value === "number") {
    // 本服库 Id 是数字串（实测如 1593），JSON 里可能是 number ⇒ 归一化成字符串
    return { id: isFinite(value) ? String(value) : null, allFolders: false };
  }
  if (Array.isArray(value)) {
    const first = value.length ? value[0] : null;
    return { id: normalizeIdScalar(first), allFolders: false };
  }
  if (typeof value === "object") {
    const has = (k) => Object.prototype.hasOwnProperty.call(value, k);
    // 新结构：优先解包 LibId
    if (has("LibId")) {
      return extractLibId(value.LibId);
    }
    const policy = value.Policy;
    const allFolders =
      value.EnableAllFolders === true || (policy && policy.EnableAllFolders === true);
    const policyFolders = policy && Array.isArray(policy.EnabledFolders) ? policy.EnabledFolders : null;
    if (policyFolders && policyFolders.length) {
      return { id: normalizeIdScalar(policyFolders[0]), allFolders };
    }
    const folders = Array.isArray(value.EnabledFolders) ? value.EnabledFolders : null;
    if (folders && folders.length) {
      return { id: normalizeIdScalar(folders[0]), allFolders };
    }
    return { id: null, allFolders };
  }
  return { id: null, allFolders: false };
}

/** 把库 Id 的标量（string / number）归一化成字符串；空/非法返回 null。 */
function normalizeIdScalar(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string") return v.length ? v : null;
  if (typeof v === "number") return isFinite(v) ? String(v) : null;
  if (typeof v === "boolean") return null;
  // 其它类型（对象/数组）不当标量用
  if (typeof v === "object") return null;
  return String(v);
}

/** 取可见库列表里的第一个库 Id（无库返回 null）。 */
function firstLibraryId(libraries) {
  if (Array.isArray(libraries) && libraries.length && libraries[0]) {
    return normalizeIdScalar(libraries[0].Id);
  }
  return null;
}

/**
 * 解析 LibId（规则 2 抽取 + 规则 4 校验），是唯一的读取入口所用的解析器。
 * 可见性比较一律两侧 String(...)。
 * @param {*} rawValue 已 JSON.parse 的存储值（或原始字符串）。
 * @param {Array<{Id:string}>} [libraries] 当前可见库列表（提供才做规则 4 校验）。
 * @returns {string|null}
 */
export function resolveLibId(rawValue, libraries) {
  const extracted = extractLibId(rawValue);
  const libs = Array.isArray(libraries) ? libraries : null;
  if (extracted.id) {
    // 规则 4：校验库是否仍可见；不可见则回落第一个库
    if (libs && libs.length) {
      const visible = libs.some((l) => l && String(l.Id) === String(extracted.id));
      return visible ? extracted.id : firstLibraryId(libs);
    }
    return extracted.id;
  }
  // 无 LibId（或 EnableAllFolders 有意降级）→ 第一个库
  return firstLibraryId(libs);
}

/** 从解析值里读数值字段，非法/缺失则用默认值。 */
function pickNumber(parsed, field, fallback) {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const v = parsed[field];
    if (typeof v === "number" && isFinite(v)) return v;
  }
  return fallback;
}

/** 从解析值里读布尔字段，非法/缺失则用默认值。 */
function pickBoolean(parsed, field, fallback) {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const v = parsed[field];
    if (typeof v === "boolean") return v;
  }
  return fallback;
}

/** 从解析值里读字符串枚举字段（仅接受已注册策略 id 之外的任意非空串），非法则用默认值。 */
function pickStrategy(parsed, fallback) {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const v = parsed.SelectionLogic;
    if (typeof v === "string" && v.length) return v;
  }
  return fallback;
}

/**
 * 读取设置（唯一读取入口；迁移只写在这里）。**绝不写回**（规则 3）。
 * @param {string} userId
 * @param {object} [env]     createEnv() 结果。
 * @param {Array<{Id:string}>} [libraries] 可见库列表（提供则执行规则 4 校验）。
 * @returns {{LibId:string|null,PoolSize:number,ImageInterval:number,PlayTrailer:boolean,TrailerVolume:number,SelectionLogic:string}}
 */
export function readSettings(userId, env, libraries) {
  const e = env || createEnv();
  const key = settingsKey(userId);
  let raw = null;
  try {
    raw = e.storage ? e.storage.getItem(key) : null;
  } catch (err) {
    raw = null;
  }
  let parsed = null;
  if (raw !== null && raw !== undefined) {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      parsed = raw; // 旧的裸字符串形态：直接当字符串值
    }
  }
  return {
    LibId: resolveLibId(parsed, libraries),
    PoolSize: pickNumber(parsed, "PoolSize", SETTINGS_FIELD_DEFAULTS.PoolSize),
    ImageInterval: pickNumber(parsed, "ImageInterval", SETTINGS_FIELD_DEFAULTS.ImageInterval),
    PlayTrailer: pickBoolean(parsed, "PlayTrailer", SETTINGS_FIELD_DEFAULTS.PlayTrailer),
    TrailerVolume: pickNumber(parsed, "TrailerVolume", SETTINGS_FIELD_DEFAULTS.TrailerVolume),
    SelectionLogic: pickStrategy(parsed, SETTINGS_FIELD_DEFAULTS.SelectionLogic),
  };
}

/**
 * 写入设置（仅在显式保存时调用）。
 * @param {string} userId
 * @param {object} settings
 * @param {object} [env]
 * @returns {object} 归一化后写出的对象。
 */
export function writeSettings(userId, settings, env) {
  const e = env || createEnv();
  const s = settings || {};
  const payload = {
    LibId: s.LibId !== null && s.LibId !== undefined ? String(s.LibId) : null,
    PoolSize:
      typeof s.PoolSize === "number" && isFinite(s.PoolSize)
        ? s.PoolSize
        : SETTINGS_FIELD_DEFAULTS.PoolSize,
    ImageInterval:
      typeof s.ImageInterval === "number" && isFinite(s.ImageInterval)
        ? s.ImageInterval
        : SETTINGS_FIELD_DEFAULTS.ImageInterval,
    PlayTrailer:
      typeof s.PlayTrailer === "boolean" ? s.PlayTrailer : SETTINGS_FIELD_DEFAULTS.PlayTrailer,
    TrailerVolume:
      typeof s.TrailerVolume === "number" && isFinite(s.TrailerVolume)
        ? s.TrailerVolume
        : SETTINGS_FIELD_DEFAULTS.TrailerVolume,
    SelectionLogic:
      typeof s.SelectionLogic === "string" && s.SelectionLogic.length
        ? s.SelectionLogic
        : SETTINGS_FIELD_DEFAULTS.SelectionLogic,
  };
  try {
    if (e.storage) e.storage.setItem(settingsKey(userId), JSON.stringify(payload));
  } catch (err) {
    /* 隐私模式 / 配额：静默失败，不抛 */
  }
  return payload;
}

/* ------------------------------------------------------------------ *
 * ApiClient 接入层（多路兜底：ApiClient → 本地凭据 → 自建 fetch 直连 REST）
 * ------------------------------------------------------------------ */

/** 读取 Emby 凭据（servercredentials3）里的 Servers 数组。 */
function readCredentialServers(env) {
  try {
    const raw = env.storage ? env.storage.getItem(CREDENTIALS_STORAGE_KEY) : null;
    if (!raw) return null;
    const obj = JSON.parse(raw);
    const servers = obj && obj.Servers;
    return Array.isArray(servers) ? servers : null;
  } catch (err) {
    return null;
  }
}

/**
 * 解析当前用户 Id（ApiClient → 本地凭据 → env 覆盖）。
 * @param {object} env
 * @returns {string|null}
 */
export function resolveUserId(env) {
  const e = env || createEnv();
  if (e.userId) return String(e.userId);
  const api = e.apiClient;
  try {
    if (api && typeof api.getCurrentUserId === "function") {
      const id = api.getCurrentUserId();
      if (id) return String(id);
    }
  } catch (err) {
    /* ignore */
  }
  const servers = readCredentialServers(e);
  if (servers) {
    for (const s of servers) {
      if (s && s.UserId) return String(s.UserId);
    }
  }
  return null;
}

/**
 * 解析当前服务器 Id（ApiClient.serverId() → 本地凭据）。
 * @param {object} env
 * @returns {string|null}
 */
export function resolveServerId(env) {
  const e = env || createEnv();
  if (e.serverId) return String(e.serverId);
  const api = e.apiClient;
  try {
    if (api && typeof api.serverId === "function") {
      const id = api.serverId();
      if (id) return String(id);
    }
  } catch (err) {
    /* ignore */
  }
  const servers = readCredentialServers(e);
  if (servers) {
    for (const s of servers) {
      if (s && s.Id) return String(s.Id);
    }
  }
  return null;
}

/**
 * 解析访问令牌（ApiClient.accessToken() → 本地凭据）。
 * @param {object} env
 * @returns {string|null}
 */
export function resolveToken(env) {
  const e = env || createEnv();
  if (e.token) return String(e.token);
  const api = e.apiClient;
  try {
    if (api && typeof api.accessToken === "function") {
      const t = api.accessToken();
      if (t) return String(t);
    }
  } catch (err) {
    /* ignore */
  }
  const servers = readCredentialServers(e);
  if (servers) {
    for (const s of servers) {
      if (s && s.AccessToken) return String(s.AccessToken);
    }
  }
  return null;
}

/** 解析服务器基址（用于直连 REST 兜底）。 */
function resolveServerBase(env) {
  const e = env || createEnv();
  if (e.serverBase) return String(e.serverBase).replace(/\/+$/, "");
  const api = e.apiClient;
  try {
    if (api && typeof api.serverAddress === "function") {
      const a = api.serverAddress();
      if (a) return String(a).replace(/\/+$/, "");
    }
  } catch (err) {
    /* ignore */
  }
  const origin = getLocationOrigin();
  return origin ? String(origin).replace(/\/+$/, "") : "";
}

/**
 * 条目是否至少有一张配图（九章：无任何配图 → 跳过，不生成空 slide）。
 * @param {object} item
 * @returns {boolean}
 */
export function hasAnyImage(item) {
  if (!item || typeof item !== "object") return false;
  if (item.ImageTags && item.ImageTags.Primary) return true;
  if (Array.isArray(item.BackdropImageTags) && item.BackdropImageTags.length) return true;
  if (
    item.ParentBackdropItemId &&
    Array.isArray(item.ParentBackdropImageTags) &&
    item.ParentBackdropImageTags.length
  ) {
    return true;
  }
  return false;
}

/** 从响应里取条目数组。 */
function pickItems(resp) {
  if (resp && Array.isArray(resp.Items)) return resp.Items;
  return [];
}

/** 从响应里取 total。 */
function pickTotal(resp) {
  if (resp && typeof resp.TotalRecordCount === "number") return resp.TotalRecordCount;
  return 0;
}

/**
 * 走 ApiClient.getItems（首选）。实测 4.11：`getItems(userId, options, signal)`
 * 把 options 交给 `getUrl → paramsToString`（URLSearchParams.set），**所有参数都会透传**。
 * @param {{userId:string,query:object,signal:AbortSignal}} p
 * @param {object} env
 * @returns {Promise<object>}
 */
async function apiClientGetItems(p, env) {
  return env.apiClient.getItems(p.userId, p.query, p.signal);
}

/**
 * 自建 fetch 直连 REST（兜底）：`{base}/Users/{userId}/Items?{query}`，带 X-Emby-Token。
 * @param {{userId:string,query:object,signal:AbortSignal}} p
 * @param {object} env
 * @returns {Promise<object>}
 */
async function restGetItems(p, env) {
  if (typeof env.fetchImpl !== "function") {
    throw new Error("[HomeSwiper] 无 ApiClient 且无 fetch 可用");
  }
  if (!p.userId) {
    throw new Error("[HomeSwiper] REST 兜底缺 userId，已中止请求（不拼空 userId 的 URL）");
  }
  const base = resolveServerBase(env);
  const qs = toQueryString(p.query);
  const url = `${base}/Users/${encodeURIComponent(p.userId)}/Items?${qs}`;
  const token = resolveToken(env);
  const headers = token ? { "X-Emby-Token": token } : {};
  const resp = await env.fetchImpl(url, { signal: p.signal, headers, credentials: "include" });
  if (!resp || resp.ok === false) {
    const status = resp && resp.status;
    throw new Error("[HomeSwiper] REST 请求失败：" + status);
  }
  return resp.json();
}

/**
 * 传输层：优先 ApiClient，其次自建 fetch。
 * @param {{userId:string,query:object,signal:AbortSignal}} p
 * @param {object} env
 * @returns {Promise<object>}
 */
async function transportGetItems(p, env) {
  if (env.apiClient && typeof env.apiClient.getItems === "function") {
    return apiClientGetItems(p, env);
  }
  return restGetItems(p, env);
}

/* ------------------------------------------------------------------ *
 * fetchPage —— 挑选逻辑底座的统一取数（6.2）
 * ------------------------------------------------------------------ */

/**
 * 分页式取数底座。
 * @param {{libId:string, collectionType?:string, startIndex?:number, limit?:number, signal?:AbortSignal}} params
 * @param {object} [env]
 * @returns {Promise<{items:Array, total:number}>}
 */
export async function fetchPage(params, env) {
  const e = env || createEnv();
  const p = params || {};
  const libId = p.libId;
  const limit = typeof p.limit === "number" && isFinite(p.limit) ? p.limit : POOL_SIZE;
  const signal = p.signal;
  const sortBy = p.sortBy || DEFAULT_SORT.sortBy;
  const sortOrder = p.sortOrder || DEFAULT_SORT.sortOrder;
  const startIndex = typeof p.startIndex === "number" && isFinite(p.startIndex) ? p.startIndex : 0;
  const userId = resolveUserId(e);
  if (!userId) {
    // fail-fast：绝不继续拼 `/Users/null/Items`（那会被解析失败静默吞掉）
    throw new Error(
      "[HomeSwiper] 无法解析 userId（ApiClient 与 localStorage 凭据均不可用），已中止取数",
    );
  }
  const includeItemTypes = mapIncludeItemTypes(p.collectionType);

  // ★ 非默认排序失败时的回落：老版本可能对某些 SortBy 值直接 400
  //   ⇒ 宁可退化成"最近入库"，也不要让首页变占位。
  let useSort = { sortBy, sortOrder };
  let first;
  try {
    first = await transportGetItems(
      {
        userId,
        query: buildItemsQuery({ libId, limit, includeItemTypes, sortBy: useSort.sortBy, sortOrder: useSort.sortOrder, startIndex }),
        signal,
      },
      e,
    );
  } catch (err) {
    if (sortBy === DEFAULT_SORT.sortBy) throw err;
    logInfo("排序 " + sortBy + " 被拒（" + (err && err.message) + "）→ 回落最近入库");
    useSort = { sortBy: DEFAULT_SORT.sortBy, sortOrder: DEFAULT_SORT.sortOrder };
    first = await transportGetItems(
      {
        userId,
        query: buildItemsQuery({ libId, limit, includeItemTypes, sortBy: useSort.sortBy, sortOrder: useSort.sortOrder, startIndex }),
        signal,
      },
      e,
    );
  }
  let items = pickItems(first);
  let total = pickTotal(first);

  // 空结果：去过滤（不带 IncludeItemTypes）重试一次
  if (!items.length && includeItemTypes) {
    const second = await transportGetItems(
      {
        userId,
        query: buildItemsQuery({
          libId,
          limit,
          includeItemTypes: null,
          sortBy: useSort.sortBy,
          sortOrder: useSort.sortOrder,
          startIndex,
        }),
        signal,
      },
      e,
    );
    items = pickItems(second);
    total = pickTotal(second);
  }

  // 丢弃无任何配图的条目
  const playable = items.filter(hasAnyImage);

  return { items: playable, total };
}

/* ------------------------------------------------------------------ *
 * 挑选策略（6.2）
 * ------------------------------------------------------------------ */

/**
 * 策略注册表：id 与设置项 `SelectionLogic` 取值对齐。
 * 每个策略声明 `endBehavior: "rewind" | "fetchMore" | "stop"` 与 `startIndex`。
 * @type {Object<string, {id:string,label:string,endBehavior:string,startIndex:number,load:Function}>}
 */
/**
 * 策略定义表：**唯一的事实来源**。
 *
 * 这里只声明"差异"（id / 标签 / 越界行为 / 用哪套排序预设），
 * load() 由工厂统一生成 —— 四个策略原本是四段几乎一样的复制粘贴，
 * 加一个排序要抄 30 行，改一处容易漏掉其它三处。
 */
const STRATEGY_DEFS = [
  {
    id: "shuffle",
    label: "随机换批",
    endBehavior: "fetchMore",
    preset: "shuffle",
    // 池子永远只有一批；越界整批替换（首批也随机）
  },
  { id: "recent", label: "最近入库", endBehavior: "rewind", preset: "recent" },
  // 未评分 = 0 ⇒ 会成片并列，预设里带 DateCreated 兜底
  { id: "rating", label: "评分最高", endBehavior: "rewind", preset: "rating" },
  // DatePlayed 只要开始播放就更新（比 PlayCount 灵敏）
  { id: "watched", label: "最近观看", endBehavior: "rewind", preset: "watched" },
];

/**
 * 策略注册表：id 与设置项 `SelectionLogic` 取值对齐。
 * @type {Object<string, {id:string,label:string,endBehavior:string,load:Function}>}
 */
export const STRATEGIES = {};
for (let i = 0; i < STRATEGY_DEFS.length; i++) {
  const def = STRATEGY_DEFS[i];
  const sort = SORT_PRESETS[def.preset] || SORT_PRESETS.recent;
  STRATEGIES[def.id] = {
    id: def.id,
    label: def.label,
    endBehavior: def.endBehavior,
    /**
     * 取一页（数量 = 设置里的「轮播数量」；排序由预设决定）。
     * @param {{libId:string,collectionType?:string,limit:number,signal?:AbortSignal}} params
     * @param {object} env
     */
    load(params, env) {
      return fetchPage(
        {
          libId: params.libId,
          collectionType: params.collectionType,
          limit: params.limit,
          signal: params.signal,
          ...sort,
        },
        env,
      );
    },
  };
}

/**
 * 取策略（未知 id 回落默认策略）。
 * @param {string} id
 * @returns {object}
 */
export function getStrategy(id) {
  if (id && Object.prototype.hasOwnProperty.call(STRATEGIES, id)) return STRATEGIES[id];
  // 回落"默认策略"而不是写死 recent：默认值改过一次，写死会导致行为与设置默认不一致
  return STRATEGIES[SELECTION_LOGIC] || STRATEGIES.recent;
}

/* ------------------------------------------------------------------ *
 * 池与缓存（6.2 / 七章）
 * ------------------------------------------------------------------ */

/** 内存池：同一 SPA 会话内同 libId 复用，不重发请求。 */
const memoryPools = new Map();

/** 组装内存池 / 缓存键（userId+serverId+libId）。 */
export function poolKey(userId, serverId, libId) {
  return `${userId == null ? "" : userId}|${serverId == null ? "" : serverId}|${
    libId == null ? "" : libId
  }`;
}

/** 本地池缓存的 localStorage 键。 */
function poolCacheStorageKey(userId, serverId, libId) {
  return POOL_CACHE_PREFIX + poolKey(userId, serverId, libId);
}

/** 覆盖写本地池缓存（只作失败兜底）。 */
function writePoolCache(storageKey, record, env) {
  try {
    if (!env.storage) return;
    env.storage.setItem(
      storageKey,
      JSON.stringify({
        libId: record.libId,
        items: record.items,
        total: record.total,
          fetchedAt: record.fetchedAt,
      }),
    );
  } catch (err) {
    /* 配额/隐私模式：静默失败 */
  }
}

/** 读本地池缓存（失败/损坏返回 null）。 */
function readPoolCache(storageKey, env) {
  try {
    if (!env.storage) return null;
    const raw = env.storage.getItem(storageKey);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.items)) return null;
    return {
      libId: obj.libId,
      items: obj.items,
      total: typeof obj.total === "number" ? obj.total : 0,
      fetchedAt: obj.fetchedAt,
    };
  } catch (err) {
    return null;
  }
}

/** 清空内存池（设置变更 / 整页刷新 / 测试用）。 */
export function resetMemoryPools() {
  memoryPools.clear();
}

/**
 * 取池（读取规则三条按序）。
 * 结局用 `source` 显式区分：`network` / `memory` / `cache` / `none`（后两者见冗余说明）。
 * @param {{libId:string, collectionType?:string, limit?:number, signal?:AbortSignal, force?:boolean, strategyId?:string}} params
 * @param {object} [env]
 * @returns {Promise<{items:Array, total:number, source:string, endBehavior:string, libId:string, error?:Error}>}
 */
export async function getPool(params, env) {
  const e = env || createEnv();
  const p = params || {};
  const libId = p.libId;
  const limit = typeof p.limit === "number" && isFinite(p.limit) ? p.limit : POOL_SIZE;
  const userId = resolveUserId(e);
  const serverId = resolveServerId(e);
  // ★ 键里必须带 limit 与策略 id：
  //   · limit：PoolSize 变了不能复用旧池（否则"改条数要刷新才生效"）
  //   · strategyId：换了排序不能复用旧池（否则"换排序没反应"）
  const memKey = poolKey(userId, serverId, libId) + "@" + limit + "#" + (p.strategyId || "recent");
  const strategy = getStrategy(p.strategyId);

  // ② 同会话同 libId：复用内存池（非强制刷新）
  if (!p.force && memoryPools.has(memKey)) {
    const m = memoryPools.get(memKey);
    return {
      items: m.items,
      total: m.total,
      source: "memory",
      endBehavior: strategy.endBehavior,
      libId,
    };
  }

  // ①/③ 正常路径先发请求
  try {
    const page = await strategy.load(
      { libId, collectionType: p.collectionType, limit, signal: p.signal },
      e,
    );
    const record = {
      libId,
      items: page.items,
      total: page.total,
      fetchedAt: e.now(),
    };
    memoryPools.set(memKey, record);
    writePoolCache(poolCacheStorageKey(userId, serverId, libId), record, e);
    return {
      items: page.items,
      total: page.total,
      source: "network",
      endBehavior: strategy.endBehavior,
      libId,
    };
  } catch (err) {
    // ③ 失败且无内存池（此分支必然无内存池）→ 本地缓存兜底
    const cached = readPoolCache(poolCacheStorageKey(userId, serverId, libId), e);
    if (cached && cached.items.length) {
      return {
        items: cached.items,
        total: cached.total,
        source: "cache",
        endBehavior: strategy.endBehavior,
        libId,
      };
    }
    return {
      items: [],
      total: 0,
      source: "none",
      endBehavior: strategy.endBehavior,
      libId,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

/* ------------------------------------------------------------------ *
 * 可见库列表（S3 需要；S6 的媒体库条与设置下拉共用）
 * ------------------------------------------------------------------ */

/** 把 Emby 视图项归一化成 { Id, Name, CollectionType }。 */
function toLibrary(item) {
  if (!item || typeof item !== "object") return null;
  if (item.Id === null || item.Id === undefined) return null;
  return {
    Id: String(item.Id),
    Name: item.Name != null ? String(item.Name) : "",
    CollectionType: item.CollectionType != null ? String(item.CollectionType) : null,
  };
}

/**
 * 取当前用户可见媒体库。失败返回空数组，**不抛**。
 * @param {object} [env]
 * @param {{signal?:AbortSignal}} [opts]
 * @returns {Promise<Array<{Id:string,Name:string,CollectionType:string|null}>>}
 */
export async function getVisibleLibraries(env, opts) {
  const e = env || createEnv();
  const signal = opts && opts.signal;
  try {
    let resp = null;
    if (e.apiClient && typeof e.apiClient.getUserViews === "function") {
      resp = await e.apiClient.getUserViews({}, undefined, signal);
    } else if (typeof e.fetchImpl === "function") {
      const userId = resolveUserId(e);
      if (!userId) return []; // 拒绝拼空 userId 的 Views URL
      const base = resolveServerBase(e);
      const token = resolveToken(e);
      const headers = token ? { "X-Emby-Token": token } : {};
      const r = await e.fetchImpl(`${base}/Users/${encodeURIComponent(userId)}/Views`, {
        signal,
        headers,
        credentials: "include",
      });
      if (!r || r.ok === false) return [];
      resp = await r.json();
    } else {
      return [];
    }
    const items = (resp && resp.Items) || [];
    return items.map(toLibrary).filter(Boolean);
  } catch (err) {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * S4 渲染：常量与纯函数（不访问 DOM，便于单测）
 * ------------------------------------------------------------------ */


/** 图片限宽的离散档位（每个 maxWidth 是独立缓存条目，必须离散）。 */
export const IMAGE_TIERS = [960, 1280, 1920];

/** 图片质量。 */
export const IMAGE_QUALITY = 90;

/** Logo 图最大高度（配合 CSS max-height）。 */
export const LOGO_MAX_HEIGHT = 240;

/** 元信息行里最多显示几个标签（其余折成 +N）。 */
export const GENRE_MAX = 3;

/** 补图防抖（6.10）。 */
export const IMAGE_DEBOUNCE_MS = 200;

/** 信息层交叉淡入时长（6.3）。 */

/** 方向翻转防抖（6.9）。 */
export const ORIENTATION_DEBOUNCE_MS = 300;

/** 自愈重挂上限（6.1）。 */
export const MAX_RETRIES = 20;

/** 启动自愈重试间隔（容器尚未渲染时轮询重试管容器的间隔）。 */
export const MOUNT_RETRY_MS = 300;

/** 媒体库条拖动阈值（像素）：水平位移超过它才算"拖动"，否则视为点击。 */
export const LIBBAR_DRAG_THRESHOLD_PX = 4;

/** 待拆复检窗口（毫秒）：约为 MOUNT_RETRY_MS 的一半，给"真状态后到"留出时间再判一次 isHome。 */
export const TEARDOWN_RECHECK_MS = 150;

/** 待拆复检定时器的固定键名（同键 setTimer 覆盖 ⇒ 连续的非 home 事件只留最后一次，不会堆叠）。 */
export const TEARDOWN_RECHECK_KEY = "teardown-recheck";

/**
 * 选图片档位：不小于 `容器渲染宽度 × dpr` 的最小档，上限为最大档。
 * @param {number} containerWidth
 * @param {number} dpr
 * @param {number[]} [tiers]
 * @returns {number} 离散档位值。
 */
export function chooseImageTier(containerWidth, dpr, tiers) {
  const list = Array.isArray(tiers) && tiers.length ? tiers : IMAGE_TIERS;
  const w = typeof containerWidth === "number" && isFinite(containerWidth) ? containerWidth : 0;
  const r = typeof dpr === "number" && isFinite(dpr) && dpr > 0 ? dpr : 1;
  const need = Math.max(1, Math.ceil(w * r));
  for (const t of list) {
    if (t >= need) return t;
  }
  return list[list.length - 1];
}

/**
 * 选配图来源（横屏 Backdrop → 竖屏 Primary → 父级 backdrop → Primary 兜底）。
 * @param {object} item
 * @param {boolean} [portrait]
 * @returns {{itemId:string,type:string,index?:number,tag:string}|null}
 */
export function pickImageSource(item, portrait) {
  if (!item || typeof item !== "object") return null;
  const p = !!portrait;
  const primary = item.ImageTags && item.ImageTags.Primary ? String(item.ImageTags.Primary) : null;
  if (p && primary) {
    return { itemId: String(item.Id), type: "Primary", tag: primary };
  }
  if (Array.isArray(item.BackdropImageTags) && item.BackdropImageTags.length) {
    return { itemId: String(item.Id), type: "Backdrop", index: 0, tag: String(item.BackdropImageTags[0]) };
  }
  if (
    item.ParentBackdropItemId &&
    Array.isArray(item.ParentBackdropImageTags) &&
    item.ParentBackdropImageTags.length
  ) {
    return {
      itemId: String(item.ParentBackdropItemId),
      type: "Backdrop",
      index: 0,
      tag: String(item.ParentBackdropImageTags[0]),
    };
  }
  if (primary) {
    return { itemId: String(item.Id), type: "Primary", tag: primary };
  }
  return null;
}

/**
 * 拼图片 URL（不带任何 token：<img> 无法加自定义头；实测本服图片接口匿名 200）。
 * @param {string} base 服务器基址（如 http://host:8096）。
 * @param {{itemId:string,type:string,index?:number,tag?:string,maxWidth?:number,maxHeight?:number,quality?:number}} spec
 * @returns {string}
 */
export function buildImageUrl(base, spec) {
  const b = String(base == null ? "" : base).replace(/\/+$/, "");
  const s = spec || {};
  const id = s.itemId;
  let path;
  if (s.type === "Backdrop") {
    path = `/Items/${id}/Images/Backdrop/${typeof s.index === "number" ? s.index : 0}`;
  } else {
    path = `/Items/${id}/Images/${s.type}`;
  }
  const qs = toQueryString({
    tag: s.tag,
    maxWidth: s.maxWidth,
    maxHeight: s.maxHeight,
    quality: s.quality,
  });
  return `${b}${path}${qs ? "?" + qs : ""}`;
}

/**
 * 拼预告片直链。`<video>` 不能加自定义头 ⇒ 令牌只能走 query（实测本服可播）。
 * `static=true` 走原文件直出，不需要 MediaSourceId / PlaySessionId。
 * @param {string} base 服务器基址
 * @param {string} itemId 预告片条目的 Id（不是正片的 Id）
 * @param {string|null} [token]
 * @returns {string}
 */
export function buildStreamUrl(base, itemId, token) {
  const b = String(base == null ? "" : base).replace(/\/+$/, "");
  const qs = toQueryString({ static: "true", api_key: token || undefined });
  return `${b}/Videos/${encodeURIComponent(String(itemId))}/stream${qs ? "?" + qs : ""}`;
}

/** 从 LocalTrailers 响应里取第一个可用 Id（裸数组 / {Items:[...]} 两种形态都吃）。 */
function pickTrailerId(resp) {
  const arr = Array.isArray(resp) ? resp : resp && Array.isArray(resp.Items) ? resp.Items : null;
  if (!arr || !arr.length) return null;
  for (let i = 0; i < arr.length; i++) {
    const t = arr[i];
    if (t && t.Id) return String(t.Id);
  }
  return null;
}

/**
 * 取某条目的本地预告片 Id。**失败一律返回 null，不抛**（预告片是增强项，绝不阻断轮播）。
 * 走 `/Items/{id}/LocalTrailers`（列表接口只回 LocalTrailerCount，不回预告片本身）。
 * @param {string} itemId
 * @param {object} [env]
 * @param {{signal?:AbortSignal}} [opts]
 * @returns {Promise<string|null>}
 */
export async function getLocalTrailerId(itemId, env, opts) {
  const e = env || createEnv();
  const signal = opts && opts.signal;
  if (!itemId) return null;
  if (typeof e.fetchImpl !== "function") return null;
  const base = resolveServerBase(e);
  const token = resolveToken(e);
  const headers = token ? { "X-Emby-Token": token } : {};
  const id = encodeURIComponent(String(itemId));
  const userId = resolveUserId(e) || (opts && opts.userId) || null;
  // 4.11 只有带 userId 的这条（`/Items/{id}/LocalTrailers` 实测 404）；
  // 4.7 客户端保留旧路，两条按序试，任一成功即返回。
  const urls = [];
  if (userId) urls.push(`${base}/Users/${encodeURIComponent(userId)}/Items/${id}/LocalTrailers`);
  urls.push(`${base}/Items/${id}/LocalTrailers`);
  for (let i = 0; i < urls.length; i++) {
    try {
      const resp = await e.fetchImpl(urls[i], { signal, headers, credentials: "include" });
      if (!resp) continue;
      if (typeof resp.ok === "boolean" && !resp.ok) continue;
      const data = typeof resp.json === "function" ? await resp.json() : null;
      const tid = pickTrailerId(data);
      if (tid) return tid;
      return null; // 路对了但没有预告片 ⇒ 不必再试下一条
    } catch (err) {
      /* 换下一条路 */
    }
  }
  return null;
}

/**
 * 构造评分徽章数组（最多 3 个；缺失的字段自动跳过）。
 * @param {object} item
 * @returns {Array<{kind:string,label:string,value:string}>}
 */
export function buildRatingBadges(item) {
  const out = [];
  if (!item) return out;
  const push = (kind, label, v) => {
    if (v === null || v === undefined || v === "") return;
    const num = typeof v === "number" ? v : Number(v);
    if (!isFinite(num)) return;
    out.push({ kind, label, value: num.toFixed(1) });
  };
  push("community", "评分", item.CommunityRating);
  push("critic", "影评", item.CriticRating);
  push("metascore", "MTC", item.Metascore);
  return out.slice(0, 3);
}

/**
 * 构造信息层模型（标题双形态 / 元信息 / 徽章 / 标语）。
 * @param {object} item
 * @param {{base:string, logoMaxHeight?:number}} opts
 * @returns {{title:string, logoUrl:string|null, year:string|null, cert:string|null, badges:Array, tagline:string, overview:string, genres:string[], genreExtra:number}}
 */
/**
 * 把各种来路的分级统一成日本映倫四档：G / PG12 / R15+ / R18+。
 *
 * 真机数据（全库抽样）里出现过：TV-14 / TV-MA / BR-12 / BR-L / SG-PG13 / TW-6+ /
 * PL-18 / FR-12 / AU-MA 15+ / DE:FSK 18 / US:TV-MA / ES-18 / NR / "18" /
 * "JP:PG-12 / JP:PG12 / JP:12 / JP:12+" 等十几种写法。
 *
 * 规则：先看有没有日本标记（JP: / JP-），有就按它取档；否则按串里出现的**年龄线索**
 * 从高到低匹配（18 → 15/16 → 12/13/14 → G/0/L）。认不出（如 NR）返回 null ⇒ 不显示分级。
 * @param {string} raw OfficialRating 原值
 * @returns {string|null} "G" | "PG12" | "R15+" | "R18+" | null
 */
export function toJapaneseRating(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const hasJp = /JP\s*[:\-]/i.test(s);
  const scope = hasJp ? s.replace(/(^|\/|\s)US[:\-]/gi, "$1") : s;
  // 从重到轻匹配；每一档都要能命中真机出现过的写法
  if (/R18\+|R-?18|18\s*\+|NC-?17|FSK\s*-?\s*18|\b18\b|(^|[^\d])18([^\d]|$)/i.test(scope)) return "R18+";
  if (/R15\+|R-?15|15\s*\+|\b15\b|\b16\b|NC-?16|TV-?MA|MA\s*15\+|AU-?M\b/i.test(scope)) return "R15+";
  if (/PG-?12|\b12\s*\+|\b12\b|\b13\b|\b14\b|TV-?14|PG-?13|MA\s*15/i.test(scope)) return "PG12";
  if (/\bG\b|\bL\b|全年龄|\b0\s*\+|\b0\b|\b6\s*\+|\b10\b/i.test(scope)) return "G";
  return null;
}

/**
 * 标签（Genres）清洗：本地化 + 归一 + 去重 + 挡脏值。
 *
 * 只看「番剧 / BD番剧」两个库的真实取值，问题不是脏数据，而是**同一概念多种写法**：
 * `科幻` / `Sci-Fi & Fantasy` / `科幻奇幻` 三套；另有 `War & Politics` 这类英文。
 * 另外保留一层脏值过滤（片商/发行/系列前缀、分辨率、字幕、纯数字），
 * 因为其它库（AV Hub 等）会把这些塞进 Genres；用户明确只以两个番剧库为准。
 */
const GENRE_ALIASES = {
  "sci-fi & fantasy": "科幻",
  "sci-fi": "科幻",
  "science fiction": "科幻",
  "科幻奇幻": "科幻",
  "war & politics": "战争",
  "action & adventure": "动作冒险",
  kids: "儿童",
  family: "家庭",
  animation: "动画",
};
/** 恒定出现、没有区分度的标签（两个番剧库 100% 都有「动画」）⇒ 不显示。 */
const GENRE_SKIP = { "动画": 1, "動畫": 1 };
const GENRE_JUNK = [
  /^(片商|发行|發行|系列|廠商)\s*[:：]/,
  /^(中文字幕|字幕|简体|繁体|双语|无码|有码|單體作品|单体作品|収録時間|收录时间|dvdrip)$/i,
  /^\d+(\.\d+)?$/,
  /^\d{3,4}\s*[pPiI]$/,
  /^(4K|8K|UHD|HDR|H264|H265|HEVC|AVC|X264|X265)$/i,
  /^\d+\s*小时\s*\+?$/,
];

/**
 * @param {Array} list 原始 Genres
 * @returns {string[]} 清洗后（保持原顺序、归一后去重）
 */
export function usableGenres(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = Object.create(null);
  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    if (raw === null || raw === undefined) continue;
    const s = String(raw).trim();
    if (!s) continue;
    let bad = false;
    for (let j = 0; j < GENRE_JUNK.length; j++) {
      if (GENRE_JUNK[j].test(s)) {
        bad = true;
        break;
      }
    }
    if (bad) continue;
    const mapped = GENRE_ALIASES[s.toLowerCase()] || s;
    if (GENRE_SKIP[mapped]) continue;
    if (seen[mapped]) continue;
    seen[mapped] = true;
    out.push(mapped);
  }
  return out;
}

/**
 * 构造信息层模型（标题双形态 / 元信息 / 徽章 / 标语）。
 * @param {object} item
 * @param {{base:string, logoMaxHeight?:number}} opts
 * @returns {{title:string, logoUrl:string|null, year:string|null, cert:string|null, badges:Array, tagline:string, overview:string, genres:string[], genreExtra:number}}
 */
export function buildInfoModel(item, opts) {
  const o = opts || {};
  const it = item || {};
  const logoUrl =
    it.ImageTags && it.ImageTags.Logo
      ? buildImageUrl(o.base, {
          itemId: it.Id,
          type: "Logo",
          tag: it.ImageTags.Logo,
          maxHeight: o.logoMaxHeight || LOGO_MAX_HEIGHT,
          quality: IMAGE_QUALITY,
        })
      : null;
  const taglines = Array.isArray(it.Taglines) ? it.Taglines : [];
  // ★ 标语与简介是**两个字段**，不能二选一：
  //   真机库里 179/200 条的 Taglines[0] 是「发行日期: 2026-09-19」这种元数据，
  //   真正的剧情在 Overview 里。旧写法 `Taglines[0] || Overview` 会让简介永远不出现。
  const rawTagline = taglines.length && taglines[0] ? String(taglines[0]) : "";
  // ★ 日期型标语与元信息行的「年份」是同一件事，不再重复占一行（该库 179/200 条是这种）。
  const tagline = /发行日期|首播|上映|发售|放送/.test(rawTagline) ? "" : rawTagline;
  const overview = it.Overview ? String(it.Overview) : "";
  // 标签取 Genres：真机里 Tags 字段全空（0/1152），而 Genres 装的是「动画 / 中文字幕 /
  // 1080P / 发行: HHHグループ」这类标签。最多显示 3 个，其余用 +N 收尾。
  const allGenres = usableGenres(it.Genres);
  const genres = allGenres.slice(0, GENRE_MAX).map((g) => String(g));
  const genreExtra = Math.max(0, allGenres.length - genres.length);
  return {
    title: it.Name != null ? String(it.Name) : "",
    logoUrl,
    year: it.ProductionYear ? String(it.ProductionYear) : null,
    cert: toJapaneseRating(it.OfficialRating),
    badges: buildRatingBadges(it),
    tagline,
    overview,
    genres,
    genreExtra,
  };
}

/* ------------------------------------------------------------------ *
 * 样式注入（唯一的运行时副作用之一）
 * ------------------------------------------------------------------ */

/** SWIPER_CSS 的 <style> 元素 id（幂等注入用）。 */
const STYLE_ID_SWIPER = "hs-swiper-css";

/** CUSTOM_CSS 的 <style> 元素 id（幂等注入用）。 */
const STYLE_ID_CUSTOM = "hs-custom-css";

/**
 * 幂等地注入一份 <style> 到 <head>。
 * 若同 id 已存在则原地更新内容，绝不重复叠加。
 * @param {string} id   <style> 元素 id。
 * @param {string} css  CSS 文本。
 * @returns {void}
 */
function injectStyleOnce(id, css) {
  const doc = document;
  let el = doc.getElementById(id);
  if (!el) {
    el = doc.createElement("style");
    el.id = id;
    el.setAttribute("data-hs", "true");
    (doc.head || doc.documentElement).appendChild(el);
  }
  if (el.textContent !== css) {
    el.textContent = css;
  }
}

/**
 * 注入两份样式（SWIPER_CSS + CUSTOM_CSS），幂等安全。
 * @param {{ swiperCss?: string, customCss?: string }} bundle 两份 CSS 文本。
 * @returns {void}
 */
export function injectStyles(bundle) {
  const swiperCss = (bundle && bundle.swiperCss) || "";
  const customCss = (bundle && bundle.customCss) || "";
  if (swiperCss) {
    injectStyleOnce(STYLE_ID_SWIPER, swiperCss);
  }
  if (customCss) {
    injectStyleOnce(STYLE_ID_CUSTOM, customCss);
  }
}

/* ------------------------------------------------------------------ *
 * DOM 小工具
 * ------------------------------------------------------------------ */

/** 创建元素并设 class（无 DOM 时返回最小占位对象）。 */
function el(tag, cls) {
  const doc = getDoc();
  const e = doc ? doc.createElement(tag) : null;
  if (!e) {
    throw new Error("[HomeSwiper] 无 document，无法创建元素");
  }
  if (cls) e.className = cls;
  return e;
}

/** 清空节点子元素。 */
function clearNode(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** 数值兜底：number 直接用；纯数字串转数值；否则回退 fallback。 */
function toNumber(x, fallback) {
  if (typeof x === "number" && isFinite(x)) return x;
  if (typeof x === "string" && x.trim() !== "") {
    const n = Number(x);
    if (isFinite(n)) return n;
  }
  return fallback;
}

/** 非空字符串兜底：空串/空值回退 fallback。 */
function nonEmpty(x, fallback) {
  if (x !== null && x !== undefined && String(x) !== "") return String(x);
  return fallback;
}

/** ancestor 是否包含 node（含直接父；对无 contains 的实现退化为父指针比较）。 */
function isWithin(ancestor, node) {
  if (!ancestor || !node) return false;
  if (node.parentNode === ancestor) return true;
  if (typeof ancestor.contains === "function") return ancestor.contains(node);
  return false;
}

/** 诊断用：节点的 `tagName.className`（className 截断前 60 字符）。 */
function nodeLabel(node) {
  if (!node) return "null";
  let cls = "";
  try {
    cls = node.className != null ? String(node.className) : "";
  } catch (e) {
    cls = "";
  }
  const tag = node.tagName ? String(node.tagName) : "?";
  return "{" + tag + (cls ? "." + cls.slice(0, 60) : "") + "}";
}

/** 环绕下标（rewind 循环用）。 */
function wrapIndex(i, n) {
  if (!n) return 0;
  return ((i % n) + n) % n;
}

/** 通过 Function 包装的动态 import，避免打包器静态解析裸说明符（运行期走 Emby importmap）。 */
function loadPlaybackManager() {
  try {
    const f = new Function("spec", "return import(spec)");
    return Promise.resolve(f("playbackManager")).then((m) => (m && m.default) || m);
  } catch (e) {
    return Promise.resolve(null);
  }
}

/** 一次性警告（避免刷屏）。 */
let warnedOnce = false;
function warnOnce(msg) {
  if (warnedOnce) return;
  warnedOnce = true;
  try {
    if (typeof console !== "undefined" && console.warn) console.warn("[HomeSwiper]", msg);
  } catch (e) {
    /* ignore */
  }
}

/** 测试钩子：复位一次性警告状态（生产运行不使用）。 */
export function __resetWarnState() {
  warnedOnce = false;
}

/* ------------------------------------------------------------------ *
 * 插件主体（S4 轮播主体 + S5 预告片层 + S6 媒体库条与设置面板）
 * ------------------------------------------------------------------ */

/**
 * 首页轮播插件主类。
 * 生命周期与内容组织见计划书四章「代码组织」。
 */
export class HomeSwiper {
  /**
   * @param {{ SwiperCtor?: any, modules?: any[], settings?: object, userId?: string, env?: object }} [options]
   *        依赖注入入口（便于测试）；缺省时使用本模块 import 的 Swiper 与模块。
   */
  constructor(options) {
    const opts = options || {};
    /** Swiper 构造函数。 */
    this.SwiperCtor = opts.SwiperCtor || Swiper;
    /** 启用的 Swiper 模块：core + Navigation + EffectFade + Autoplay。 */
    this.modules = opts.modules || [Navigation, EffectFade];
    /** 当前生效设置（默认值先占位，S6 从存储合并）。 */
    this.settings = Object.assign({}, DEFAULTS, opts.settings || {});
    /** 是否已从存储读过真实设置（设置页可能从未挂载过 ⇒ 面板不能拿默认值糊弄）。 */
    this.settingsLoaded = false;
    this._panelOpening = false;
    /** 当前用户 Id（缺省时由 env 解析）。 */
    this.userId = opts.userId || null;
    /** 运行环境依赖（缺省时懒建）。 */
    this.env = opts.env || null;

    // 运行态
    this.bootstrapped = false;
    this.swiper = null;
    this.swiperParams = null;
    this.root = null;
    this.mountContainer = null;
    this.hostView = null;
    this._resumeId = null;
    this._videoAspect = 16 / 9; // 当前预告片的宽高比（元数据到达后更新）
    this._insetBottom = TRAILER_INSET_BOTTOM;
    this.gutterEl = null;
    this._sbW = null;
    this._resizeWatch = null;
    this._resizeTarget = null;
    this._resizeHandler = null;
    this._resizeHandler = null;
    this.mounted = false;
    this.mounting = false;
    this.mountPromise = null;
    this.epoch = 0;
    this.abortController = null;
    this.running = false;

    // 数据
    this.libraries = [];
    this.pool = [];
    this.poolResult = null;
    this.collectionType = null;
    this.serverBase = "";
    this.placeholder = false;
    this.poolReady = false;

    // DOM 引用
    this.swiperEl = null;
    this.wrapperEl = null;
    this.slideEls = [];
    this.imgEls = [];
    this.hotPrev = null;
    this.hotNext = null;
    this.prevBtn = null;
    this.nextBtn = null;
    this.infoLayer = null;
    this.infoNodes = [];
    this.visibleNodeIndex = 0;
    this.shownInfoIndex = -1;
    this.prevPoolIndex = -1;
    this.placeholderEl = null;
    // 视频层（S5）：单个 <video> 共享实例 + 左缘蒙版融合
    this.videoEl = null;
    this.videoBarEl = null;
    this.videoBarFill = null;
    this._videoW = 0; // 当前视频面板宽（px，0 = 不启用）
    this._videoH = 0;
    this._videoIndex = -1; // 正在播的池下标；-1 = 没在播
    this._trailerIds = Object.create(null); // itemId → 预告片 Id / null（null = 查过没有，防重试风暴）
    // ★ 默认**有声**：用户没有手动静音过，就一直尝试带声音播放
    //   （浏览器自动播放策略可能拦，那时才降级静音并等手势，见 playMutedAndArmUnmute）
    this.userMuted = false;
    this._phaseRaf = 0; // 图片阶段计时的 rAF id（0 = 未运行）
    this._windowTotal = 0; // 当前库条目总数（换批时用来算随机偏移范围）
    this._swapping = false; // 换批锁：连续快速翻页只发一次请求


    // 定时器登记表（6.10：所有异步源挂同一张表）
    this.timers = new Map();
    this.observer = null;
    this.retries = 0;
    this.mountRetries = 0;
    this.mqlPortrait = null;
    this._orientationHandler = null;
    this._viewHandler = null;
    // hero（顶部一屏）布局态
    // 库条随滚动收起（唯一的滚动职责；轮播本身跟随原生滚动）
    this._libBarScrollHandler = null;
    this._libBarDocScrollHandler = null;
    this._libBarScrollEl = null;
    this._libBarPending = false;
    this._libBarOut = false;

    // S6：媒体库条 / 设置入口 / 设置面板
    this.libBarEl = null;
    this.libBarTrack = null;
    this.libBarHover = null;
    this.libBarHost = null;
    this.libBarObserver = null;
    this.libBarObservedHost = null;
    this._libBarTop = null; // 已写入的 --hs-libbar-* 值（去重用）
    this._libBarH = null;
    this._libBarLeft = null;
    this._headerBtn = null;
    this._headerObserver = null;
    this._headerObservedHost = null;
    this.panelEl = null;
    this.panelFields = {};
    this.panelCloseBtn = null;
    this.panelSaveBtn = null;
    this.panelHintEl = null;
    this._panelKeyHandler = null;
    this._lastFocusedEl = null;
    this._libBarDragHandlers = null;
    this._libBarSuppressClick = false;
    // 热区点击句柄（箭头 pointer-events:none ⇒ 点击靠热区；撤离时成对摘除）
    this._hotPrevClick = null;
    this._hotNextClick = null;
    this._slidePending = false;
  }

  /** 取运行环境（缺省懒建，避免构造期触碰 window）。 */
  getEnv() {
    if (!this.env) this.env = createEnv();
    return this.env;
  }

  // ---- 启动与生命周期（6.1） -----------------------------------------

  /**
   * 引导：挂视图事件监听（全局、跨视图，撤离去不掉）+ 启动自查。
   *
   * ⚠ 入口门用 **DOM 判定**，绝不用 `e.detail.type === "home"`：
   *   真机取证 —— 4.7 客户端（Emby Theater，Chromium 100）自带前端里 `type:"home"` 出现 0 次；
   *   `viewmanager.js` 的 `dispatchViewEvent` 取 detail 自 `view.getAttribute("data-type")`，
   *   客户端首页视图的 `data-type` **不是** `"home"` ⇒ 以 type 字符串当唯一入口在客户端上永久不触发。
   *   故同时挂 `viewbeforeshow` / `pagebeforeshow` / `viewshow` 三个事件，**任何 type 都尝试一次**，
   *   挂载与否完全由 `isHome()` + `resolveMountContainer()` 决定。
   * 监听**只挂一次**（bootstrapped 守卫）；撤离时**不移除**（否则再也回不到首页）。
   */
  bootstrap() {
    const doc = getDoc();
    if (!doc || typeof doc.addEventListener !== "function") return;
    if (this.bootstrapped) return;
    this.bootstrapped = true;
    this._viewHandler = () => {
      // 重置点：视图事件（含切 tab）→ 清重试计数
      this.retries = 0;
      this.mountRetries = 0;
      const home = this.isHome();
      this.dbg(() => "视图事件 → isHome=" + home + (home ? " → start()" : " → 延迟复检待拆"));
      // 设置入口只在 dashboard 页出现；这里每次导航都判一次（进入/离开都要生效）
      if (home) {
        // 判真 ⇒ 取消待拆（同键清掉），并**先摘掉「视觉收起」标记**再 start——
        //   若上次导航的 teardown 被跳过/延后，`hs-leaving` 会卡在 body 上，
        //   而 start() 在 mounted 仍真时是早返回的，永远走不到 mount() 里的清除 ⇒
        //   轮播+库条被 visibility:hidden 藏着（真机：「回主页变成磨砂屏、轮播消失」）。
        if (doc && doc.body && doc.body.classList && typeof doc.body.classList.remove === "function") {
          doc.body.classList.remove("hs-leaving");
        }
        this.clearTimer(TEARDOWN_RECHECK_KEY);
        this.start();
      } else {
        // 判假 ⇒ **不立即拆**：viewbeforeshow 在新视图渲染前派发，此刻 hash 可能还没变、
        //   首页 .view 可能仍带 page-hidden ⇒ 立即拆会在延迟窗口内误拆、且再没事件叫回来。
        //   但**视觉要立刻收起**：库条/轮播是 fixed 浮层，等 150ms 复检再拆的话，
        //   进设置页等非首页时它们会在屏幕上多留一瞬间（真机反馈："选框消失有延迟"）。
        this.hideForNavigation();
        this.scheduleTeardownRecheck();
      }
    };
    doc.addEventListener("viewbeforeshow", this._viewHandler);
    doc.addEventListener("pagebeforeshow", this._viewHandler);
    doc.addEventListener("viewshow", this._viewHandler);
    const w = getWin();
    // 第四个触发源：hashchange（4.11 走 hash 路由 ⇒ 导航一定会派发；挂在 window 上）。
    // 复用同一个 _viewHandler；按既有"全局资源、撤离不移除"约定，避免"回不来"。
    if (w && typeof w.addEventListener === "function") {
      try {
        w.addEventListener("hashchange", this._viewHandler);
      } catch (e) {
        /* ignore */
      }
    }
    const loc = (w && w.location) || {};
    this.dbg(
      () =>
        "bootstrap(): readyState=" +
        (doc.readyState || "?") +
        " hash=" +
        (loc.hash || "") +
        " pathname=" +
        (loc.pathname || "") +
        " 容器=" +
        !!this.resolveMountContainer() +
        " isHome=" +
        this.isHome(),
    );
    this.start(); // 启动自查一次（脚本可能在首页渲染完、也可能渲染前才注入）
    // ★ 设置入口是全局资源（要出现在设置页 #!/dashboard 的左侧栏）⇒ 在 bootstrap 级挂一次，
    //   不随首页 mount/teardown 起落；抽屉若尚未渲染，观察器/后续 mount 会自愈补上。
  }

  /** 启动：幂等（自检与视图事件多触发不能双挂载）。 */
  start() {
    if (this.mounting) return this.mountPromise;
    if (this.mounted) {
      // ★ 不再盲信 mounted：必须"挂在**当前解析出的容器**里"才算正常（旧视图隐藏不动会滞留）。
      const target = this.resolveMountContainer();
      const okInDom = !!(this.root && this.root.parentNode);
      const okInRightHost = okInDom && (!target || this.root.parentNode === target);
      if (okInRightHost) {
        // 诊断：这条就是过去"静默返回"的旧分支，现在带上 className 与是否等于当前宿主
        this.dbg(
          () =>
            "start(): 根容器仍在 DOM 且宿主正确 → 正常返回（root.parent=" +
            nodeLabel(this.root.parentNode) +
            " = target=" +
            (target && this.root.parentNode === target),
        );
        return this.mountPromise;
      }
      this.dbg(
        () =>
          "start(): mounted 陈旧 → okInDom=" +
          okInDom +
          " root.parent=" +
          (this.root ? nodeLabel(this.root.parentNode) : "null") +
          " target=" +
          nodeLabel(target),
      );
      this.ensureRootAttached(); // 补插 / 搬迁回当前宿主
      const fixed = !!(this.root && this.root.parentNode && (!target || this.root.parentNode === target));
      if (fixed) {
        this.dbg(() => "start(): mounted 陈旧但已补插/搬迁 → 正常返回");
        return this.mountPromise;
      }
      this.dbg(() => "start(): mounted 陈旧且无法归位 → 复位 mounted 走正常挂载");
      this.mounted = false;
    }
    // 容器还没渲染出来 → 进入有上限的启动自愈重试（**不论 isHome 判定**；
    // 4.11 早注入时 hash/pathname 都还没就绪，若此时按 isHome 直接返回就会永久静默）。
    const container = this.resolveMountContainer();
    if (!container) {
      this.dbg(() => "start(): 容器缺失 → 排重试（isHome=" + this.isHome() + "）");
      this.scheduleMountRetry();
      return null;
    }
    if (!this.isHome()) {
      this.dbg(() => "start(): isHome 为假 → 不挂载（容器在，等视图事件）");
      return null;
    }
    this.mounting = true;
    this.dbg(() => "start(): 开始挂载");
    this.mountPromise = this.mount().then(
      (ok) => {
        this.mounting = false;
        if (ok) this.mountRetries = 0;
        return ok;
      },
      (err) => {
        this.mounting = false;
        this.warn(err);
        return false;
      },
    );
    return this.mountPromise;
  }

  /**
   * 有上限的启动自愈重试：容器尚未出现时，用 timer 登记表排一次 MOUNT_RETRY_MS 后重试，
   * 最多 MAX_RETRIES 次（≈6s）；超限停手并只 warn 一次。绝不用裸 setInterval、绝不 observe body。
   */
  scheduleMountRetry() {
    if (this.mountRetries >= MAX_RETRIES) {
      // 降噪：非首页注入时不该给普通用户看到 warn ⇒ 走 dbg（默认关闭时静默）。
      // 计划书要求的"一次性 console.warn"保留给观察器自愈超限那条。
      this.dbg(() => "启动自愈重试超限（>" + MAX_RETRIES + " 次，容器始终未出现），已停止");
      return;
    }
    this.mountRetries += 1;
    this.dbg(() => "scheduleMountRetry(): 第 " + this.mountRetries + " 次");
    this.setTimer(
      "mount-retry",
      () => {
        if (this.mounted || this.mounting) return;
        if (this.isHome()) {
          this.start();
          return;
        }
        if (this.resolveMountContainer()) {
          // 容器在、但被判"不在首页" ⇒ 明确不在首页，停手（靠视图事件兜底）
          this.dbg(() => "mount-retry: 容器在但非首页 → 停手");
          return;
        }
        this.scheduleMountRetry();
      },
      MOUNT_RETRY_MS,
    );
  }

  /**
   * 待拆复检：判定"非 home"时**不立即 teardown**，排一个 TEARDOWN_RECHECK_MS 的短定时器，
   * 到点**再判一次** isHome()，仍为假才拆（避免 viewbeforeshow 早到 + hash/隐藏态未就绪导致误拆）。
   *
   * 固定键 TEARDOWN_RECHECK_KEY ⇒ setTimer 同键覆盖，连续的非 home 事件只留最后一次，不会堆叠。
   * ⚠ 该定时器走 timer 登记表 ⇒ `bumpEpoch()` / `teardown()` 的 `clearAllTimers()` 会清掉它 ——
   *   **清掉 = 不拆，是安全的**（宁可少拆一次，也不要误拆后回不来）。
   */
  scheduleTeardownRecheck() {
    this.setTimer(
      TEARDOWN_RECHECK_KEY,
      () => {
        if (this.isHome()) {
          this.dbg(() => "teardown-recheck: 复检为 home → 不拆");
          return;
        }
        this.dbg(() => "teardown-recheck: 复检仍非 home → teardown()");
        this.teardown();
      },
      TEARDOWN_RECHECK_MS,
    );
  }

  /**
   * 判断「在首页」。判据（按序）：
   *   1) **hash 非空 → 权威裁决**：命中 `/home/i` 才算首页（4.7 hash 路由 `#!/home`；
   *      4.11 实测 `#!/home`；库页 = `#!/list/list.html?parentId=…`）。
   *      **绝不落入 DOM 兜底**：4.11 网页端的媒体库/详情等页面 DOM 里也存在**可见**的
   *      `.tabContent[data-index="0"]`，旧版"可见容器即首页"的兜底会在库页误判，
   *      导致轮播被搬进媒体库页（真机 bug）。
   *   2) hash 空、pathname 非空且**不是入口壳**（…/index.html，两端恒定、不含路由信息）
   *      → 命中 `/\/home(\.html)?\/?$/` 才算首页（history 路由兜底，如 `/web/home`）。
   *   3) 其余（hash 空 + pathname 是壳或全空 = 早注入窗口）→ DOM 兜底：容器存在且
   *      祖先链无隐藏标记 → true（此时不可能已路由到库页 ⇒ 兜底安全）。
   *
   * ⚠ 4.7 客户端切视图是 `classList.add("hide")`、4.11 是 `classList.add("page-hidden")`
   *   且**都不 remove** ⇒ DOM 兜底必须认这两种隐藏标记（isHiddenInViewTree）。
   */
  isHome() {
    const w = getWin();
    const loc = (w && w.location) || {};
    const hash = String(loc.hash || "");
    const pathname = String(loc.pathname || "");
    if (hash) return /home/i.test(hash);
    if (pathname && !/\/index\.html?\/?$/i.test(pathname)) {
      return /\/home(\.html)?\/?$/i.test(pathname);
    }
    // 早注入窗口（路由信息为空/仅入口壳）才允许 DOM 兜底，且用与 resolveMountContainer 同一套解析（可见优先）
    const container = this.resolveMountContainer();
    if (!container) return false;
    if (this.isHiddenInViewTree(container)) return false;
    return true;
  }

  /**
   * 从容器沿**祖先链**判断是否处于被隐藏的视图里（同时认两端标记）。
   * 用 `classList.contains`，不用 `closest(".view.hide")`（4.11 无 `hide`，且 4.7 的
   * `.mainDrawer` 自身也带 `hide`）。只走祖先链、不扫全文档；classList/parentNode 都有守卫。
   * @param {object} node
   * @returns {boolean}
   */
  isHiddenInViewTree(node) {
    let p = node;
    while (p) {
      const cl = p.classList;
      if (cl && typeof cl.contains === "function") {
        if (cl.contains("hide") || cl.contains("page-hidden")) return true;
      }
      p = p.parentNode;
    }
    return false;
  }

  /**
   * 取挂载宿主（按序候选）。
   *
   * ⚠ 真机取证：`.tabContent[data-index="0"]` 就是 Emby 自己的 sections 容器
   *   （祖先链带 `emby-scroller scrollY … homeSectionsContainer`），**Emby 会重写它**
   *   ⇒ 把根容器挂进去会在异步取数窗口里被抹掉。故优先挂到**路由创建的稳定节点**
   *   最近祖先 `.view`（4.11 上带 `view-home home` 类），它不会被 Emby 重写。
   *   候选顺序：① 最近的 `.view` 祖先 → ② `.tabContent` 内的 `.sections` → ③ `.tabContent` 自身。
   * @returns {object|null}
   */
  resolveMountContainer() {
    const doc = getDoc();
    if (!doc || typeof doc.querySelectorAll !== "function") return null;
    this.hostView = null;
    const tabs = doc.querySelectorAll('.tabContent[data-index="0"]');
    if (!tabs || !tabs.length) return null;
    // ★ 真机根因：Emby 旧视图只加隐藏类、从不移除 ⇒ 文档里可能并存多个首页视图。
    //   优先返回"祖先链未被隐藏"的那个（= 当前真正可见的首页视图），否则会锁死在塌陷的旧视图上。
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      if (!this.isHiddenInViewTree(tab)) {
        const v = this.pickHostFrom(tab);
        this.hostView = v;
        return this.resolveContentHost(v);
      }
    }
    // 全都隐蔽（过渡窗口）：取最后一个（最近渲染的那个）兜底，保持旧行为
    const v = this.pickHostFrom(tabs[tabs.length - 1]);
    this.hostView = v;
    return this.resolveContentHost(v);
  }

  /**
   * 从首页视图里取**滚动内容层**作为挂载点（B 方案：轮播进文档流）。
   * 顺序：视图内的滚动容器（.emby-scroller 等）→ 它的内容层 .scrollSlider/.scrollSliderY → 容器本身。
   * 为什么不是 .view：进文档流后轮播是"一块内容"，必须挂在滚动内容里，滚动、高度、滚动条都交给浏览器。
   * @param {object|null} view
   * @returns {object|null}
   */
  resolveContentHost(view) {
    if (!view) return null;
    if (typeof view.querySelector !== "function") return view;
    // ★ 必须是**纵向可滚**的那个容器：4.11 网页端首页是 .view > (.scrollFrameY.tabContent 可滚 + 我们的块)，
    //   挂错层就会出现"轮播在滚动容器外面 ⇒ 页面滚不动"（真机数据：根父节点 = .view，滚动容器是它的兄弟）。
    const sels = [".scrollFrameY", ".emby-scroller", ".overflowYScroll", ".overflowScroll"];
    let scroller = null;
    try {
      for (let i = 0; i < sels.length && !scroller; i++) {
        const list = typeof view.querySelectorAll === "function" ? view.querySelectorAll(sels[i]) : null;
        if (list && list.length) {
          for (let k = 0; k < list.length; k++) {
            if (this.canScrollVertically(list[k])) { scroller = list[k]; break; }
          }
        }
        if (!scroller) {
          const one = view.querySelector(sels[i]);
          if (one && this.canScrollVertically(one)) scroller = one;
        }
      }
    } catch (e) {
      /* ignore */
    }
    if (!scroller) {
      // 还量不出滚动性（刚建 DOM）：退回第一个存在的候选，后续 ensureRootAttached 会再往深里搬
      for (let i = 0; i < sels.length && !scroller; i++) scroller = view.querySelector(sels[i]);
    }
    if (!scroller) return view;
    if (typeof scroller.querySelector === "function") {
      const slider = scroller.querySelector(".scrollSlider, .scrollSliderY");
      if (slider) return slider;
    }
    return scroller;
  }

  /**
   * 从某个 `.tabContent[data-index="0"]` 里选挂载宿主。
   * 候选：① 最近的 `.view` 祖先（路由创建的稳定节点，Emby 不重写）→ ② `.sections` → ③ tab 自身。
   * @param {object} tab
   * @returns {object|null}
   */
  pickHostFrom(tab) {
    if (!tab) return null;
    const view = this.findViewAncestor(tab);
    if (view) return view;
    if (typeof tab.querySelector === "function") {
      const sections = tab.querySelector(".sections");
      if (sections) return sections;
    }
    return tab;
  }

  /** 从节点的祖先链里找最近的 `.view`（不含节点自身）。 */
  findViewAncestor(node) {
    let p = node ? node.parentNode : null;
    while (p) {
      const cl = p.classList;
      if (cl && typeof cl.contains === "function" && cl.contains("view")) return p;
      p = p.parentNode;
    }
    return null;
  }

  /**
   * 复检根容器是否在**当前解析出的宿主**里；不在则重插 / 搬迁过去。
   * 真机根因：Emby 旧视图只隐藏不移除 ⇒ 根容器可能滞留在隐藏/塌陷的旧宿主里，必须搬回来。
   * @returns {boolean} 根容器是否已归位。
   */
  ensureRootAttached() {
    if (!this.root) return false;
    // ★ 非首页绝不搬迁/重插：任何调用方（start() 陈旧分支 / applySettingsLive / 自愈）
    //   都不能把根容器搬进媒体库页等其它视图（真机 bug：轮播出现在库页）。
    //   isHome() 已路由权威化，此处守卫是第二道闸（搬迁是破坏性操作，宁可少搬）。
    if (!this.isHome()) {
      this.dbg(() => "ensureRootAttached(): 非首页 → 不搬迁");
      return false;
    }
    const target = this.resolveMountContainer();
    const c = target || this.mountContainer;
    if (!c) return false;
    // ★ 只认直接父节点：用 contains 会把"根在 .view 里、但真宿主是它内部的滚动容器"判成在位，
    //   于是永远不搬 ⇒ 真机症状"轮播在滚动容器外面，页面滚不动"。
    const inPlace = this.root.parentNode === c;
    if (inPlace) {
      if (target && this.mountContainer !== target) this.mountContainer = target; // 同步解析结果
      return true;
    }
    if (typeof c.insertBefore !== "function") return false;
    this.moveRootTo(c);
    return true;
  }

  /**
   * 把根容器搬迁/重插到 `target` 宿主。宿主确实变了时迁移 `hs-host` 类并更新 `this.mountContainer`。
   * @param {object} target 目标宿主
   * @param {boolean} [skipHeroSetup] true 则不在此调用 setupHero()（由调用方显式重算，避免重入）
   * @returns {boolean}
   */
  moveRootTo(target, skipHeroSetup) {
    if (!target || !this.root || typeof target.insertBefore !== "function") return false;
    const changed = this.mountContainer !== target;
    if (this.root.parentNode && typeof this.root.parentNode.removeChild === "function") {
      this.root.parentNode.removeChild(this.root);
    }
    target.insertBefore(this.root, target.firstChild);
    if (changed) {
      if (
        this.mountContainer &&
        this.mountContainer.classList &&
        typeof this.mountContainer.classList.remove === "function"
      ) {
        this.mountContainer.classList.remove("hs-host");
      }
      if (target.classList && typeof target.classList.add === "function") target.classList.add("hs-host");
    }
    this.mountContainer = target;
    this.dbg(
      () => "moveRootTo(): " + (changed ? "宿主已换 → 搬迁根容器 " : "根容器重插 ") + nodeLabel(target),
    );
    if (changed) {
      // ★ 宿主换了 ⇒ 观察器必须跟到新宿主，否则自愈（重插/markHeroPush）与高度重算对新宿主彻底失效。
      //   （this.mountContainer 已在上面更新，两个 setup 都读它）
      this.setupObservers();
    }
    void skipHeroSetup;
    return true;
  }

  /**
   * 量「轮播块顶边 → 滚动容器底边」的高度写进行内样式。
   * 为什么不能写死 100vh：文档流里的内容起点在顶栏下方（约 60px），
   * 而 100vh 是整窗高 ⇒ 底部会多出一截，按钮被切（真机反馈）。
   * 滚动中不量（此时 top 是负值，会把高度算小）。
   */
  applyHeroHeight() {
    const w = getWin();
    if (!this.root || !w || typeof this.root.getBoundingClientRect !== "function") return;
    if (!this.isHome()) return;
    const sc = this.findScrollContainer();
    // ★ 不再"滚动中跳过测量"：那样切全屏/改窗口会被跳过、高度永远停在旧值（真机：全屏下轮播只剩一条）。
    //   正确做法是把滚动量补回去：内容里的自然位置 = rect.top + scrollTop。
    const scrollTop = sc && typeof sc.scrollTop === "number" ? sc.scrollTop : 0;
    let rr = null;
    try {
      rr = this.root.getBoundingClientRect();
    } catch (e) {
      return;
    }
    if (!rr) return;
    let bottom = 0;
    try {
      const sr = sc && typeof sc.getBoundingClientRect === "function" ? sc.getBoundingClientRect() : null;
      bottom = sr && sr.height > 0 ? sr.bottom : w.innerHeight || 0;
    } catch (e) {
      bottom = w.innerHeight || 0;
    }
    // ★ 块在文档流里的起点在顶栏下方（约 60px）⇒ 顶栏背后没有图，看起来"顶部缺一截"。
    //   把块自身向上提一个 offset，高度按"到视口底"算：视觉上回到覆盖层时代的满屏，但仍是文档流。
    //   ★ 幂等：rect.top 会被我们自己写下的 marginTop 改变 ⇒ 先把已应用的 margin 补偿回"自然起点"，
    //     否则第二次量到 0 就会把 marginTop 清空、与第一次互相抵消（实测 -60px → "" → -60px 振荡）。
    // ★ 上移量 = **顶栏高度**（确定量），不再从 rect.top 反推。
    //   反推要依赖“上一次写的 margin + 当前布局 + 解析到的滚动容器”，三者任一漂移就会左右摆
    //   （真机：缩放后视频面板一会儿贴着顶栏、一会儿又在它下方）。
    let offset = 0;
    try {
      const doc2 = getDoc();
      const hdr = doc2 && doc2.querySelector ? doc2.querySelector(".skinHeader") : null;
      if (hdr && typeof hdr.getBoundingClientRect === "function") {
        offset = Math.max(0, Math.min(240, Math.round(hdr.getBoundingClientRect().height)));
      }
    } catch (e) {
      offset = 0;
    }
    // 兜底（量不到顶栏，例如测试桩/极早期）：仍用反推法，保证不会顶不上去
    if (!offset) {
      let applied = 0;
      try {
        const cur = this.root.style && this.root.style.marginTop;
        const n = cur ? parseFloat(cur) : 0;
        applied = isFinite(n) ? n : 0;
      } catch (e) {
        applied = 0;
      }
      offset = Math.max(0, Math.round(rr.top - applied + scrollTop));
    }
    // ★ 露一条：让下一个分区露出 PEEK 像素 —— "下面还有内容"最强的信号（行业通行做法）。
    //   守则：下一个兄弟没有高度（空首页/加载中）时不露，否则会留一条死白边。
    let peek = 0;
    try {
      const pEl = this.root.parentNode;
      const ks = pEl && pEl.children ? pEl.children : null;
      let idx = -1;
      if (ks) {
        for (let i = 0; i < ks.length; i++) {
          if (ks[i] === this.root) { idx = i; break; }
        }
      }
      // ★ 只认「可见行」：4.7 会插隐藏空分区（h=0/top=0），网页端行内还有 h=0 的滚动按钮。
      //   取前两个可见行之间的间距 = 这一行实际占的高度（与结构、层级都无关）。
      const vis = [];
      if (ks) {
        for (let i = idx + 1; i < ks.length && vis.length < 2; i++) {
          const el = ks[i];
          if (!el || typeof el.getBoundingClientRect !== "function") continue;
          const r = el.getBoundingClientRect();
          if (r.height > 24 && r.top > 0) vis.push({ el: el, r: r });
        }
      }
      // ★ 优先看「第一个兄弟内部」：
      //   客户端 root 的兄弟是 [.sections(包住所有行), .padded-bottom-page]，
      //   拿兄弟间距会算成 2866（整页高）⇒ 被夹到上限 ⇒ 多露一截下一行。
      let inner = 0;
      try {
        const first = vis[0] && vis[0].el;
        const cs = first && first.children ? first.children : null;
        if (cs) {
          const sub = [];
          for (let j = 0; j < cs.length && sub.length < 2; j++) {
            const el2 = cs[j];
            if (!el2 || typeof el2.getBoundingClientRect !== "function") continue;
            const r2 = el2.getBoundingClientRect();
            if (r2.height > 24 && r2.top > 0) sub.push(r2);
          }
          if (sub.length >= 2) inner = Math.round(sub[1].top - sub[0].top);
          else if (sub.length === 1) inner = Math.round(sub[0].height);
        }
      } catch (e2) {
        inner = 0;
      }
      let rowH = 0;
      if (inner > 24) rowH = inner;
      else if (vis.length >= 2) rowH = Math.round(vis[1].r.top - vis[0].r.top);
      else if (vis.length === 1) rowH = Math.round(vis[0].r.height);
      const gap = 0;
      // ★ 比例为主、测量只做微调：
      //   多轮真机证明「量第一行高度」不可靠（同一 DOM 在不同渲染时刻能量出 130 / 256 / 2828）。
      //   所以以「视口 23%」为基准，测量值只在 ±(20%~28%) 区间内微调，超出就被夹住。
      //   结果：两端一致、无跳变；露出量永远在一行左右。
      const base = Math.round(bottom * 0.23);
      const lo = Math.round(bottom * 0.2);
      const hi = Math.round(bottom * 0.28);
      const measured = rowH > 24 ? rowH : base;
      peek = Math.max(lo, Math.min(measured, hi));
      // ★ 夹紧之后还要保证「整行放得下 + 8px 呼吸」：
      //   否则行高 > 28% 时（比如 320px 行 / 1000 视口），行底会被屏幕切掉，
      //   标签就贴着窗口边缘甚至被遮住（真机反馈）。
      if (rowH > 24) {
        const need = rowH + 8;
        peek = Math.max(peek, Math.min(need, Math.round(bottom * 0.4)));
      }
      this._lastPeek = peek;
    } catch (e) {
      peek = this._lastPeek || 0;
    }
    const h = Math.max(320, Math.round(bottom) - peek);
    if (this.root.style && typeof this.root.style === "object") {
      this.root.style.marginTop = offset > 0 ? -offset + "px" : "";
      this.root.style.height = h + "px";
      // ★ 取景重心：番剧背景图的人脸基本在上半部，而 cover 默认上下各裁一半。
      //   窗口越扁（全屏超宽）裁得越多 ⇒ 越往上取；接近 16:9 时回中，竖屏也回中。
      const heroW = sc && typeof sc.clientWidth === "number" && sc.clientWidth > 0 ? sc.clientWidth : w.innerWidth || 0;
      // ★ 必须用**轮播盒子的实际高度** h：cover 的裁切只由这个盒子决定。
      //   之前用视口高 ⇒ 露出下方一行后轮播变矮、比例被算小 ⇒ 取景回中、人脸又被裁。
      //   （objY 不影响 peek，peek 也不影响 objY，不存在反馈）
      const ratio = heroW > 0 && h > 0 ? heroW / h : 0;
      // 真机反馈「头顶被裁」⇒ 阈值整体上移（窗口一宽就明显偏上），并把档位拉密：
      // 1.9 倍以下保持居中；之后每 0.3 一档，最多偏到 18%（基本贴顶）。
      let objY = 50;
      if (ratio > 3.0) objY = 18;
      else if (ratio > 2.7) objY = 24;
      else if (ratio > 2.4) objY = 30;
      else if (ratio > 2.1) objY = 34;
      else if (ratio > 1.9) objY = 40;
      if (typeof this.root.style.setProperty === "function") {
        this.root.style.setProperty("--hs-obj-y", objY + "%");
      }
      // 视频面板几何跟着轮播块走：能占多少占多少，但左列必须留住最小可读宽度
      this.layoutVideo(h, heroW);
    }
    this.dbg(
      () =>
        "applyHeroHeight(): offset=" + offset + " bottom=" + Math.round(bottom) + " peek=" + peek + " → height=" + h + "px",
    );
    // ★ 一次性版本行：贴错/没更新的情况一眼能看出来（客户端调试用）
    try {
      if (typeof console !== "undefined" && console.info) {
        console.info(
          "[HomeSwiper] " + BUILD_TAG + " hero=" + h + "px peek=" + peek + "px vh=" + Math.round(bottom),
        );
      }
    } catch (e) {
      /* ignore */
    }
  }

  /** rAF 节流的高度重量（Emby 的分区是后渲染的，DOM 变了就得重量）。 */
  scheduleHeroHeight() {
    if (this._heroHeightPending) return;
    this._heroHeightPending = true;
    const done = () => {
      this._heroHeightPending = false;
      try {
        this.applyHeroHeight();
      } catch (e) {
        this.warn(e);
      }
    };
    try {
      const id = this.requestFrame(done);
      if (id === null || id === undefined) done();
    } catch (e) {
      this._heroHeightPending = false;
    }
  }

  /** 尺寸变化 ⇒ 重量高度 + 重测顶栏几何（库条 is-too-narrow 靠它）。 */
  setupResizeWatch() {
    const RO = getResizeObserver();
    const target = this.hostView || this.mountContainer;
    if (!RO || !target || typeof RO !== "function") return;
    this.teardownResizeWatch();
    this._resizeTarget = target;
    const onResize = () => {
      this.syncScrollbarWidth();
      this.ensureGutterStrip();
      this.applyHeroHeight();
      this.measureLibBarGeometry();
    };
    this._resizeWatch = new RO(onResize);
    if (this._resizeWatch && typeof this._resizeWatch.observe === "function") {
      try {
        this._resizeWatch.observe(target);
      } catch (e) {
        /* ignore */
      }
    }
    // ★ 兜底：RO 在某些宿主/嵌套滚动结构下不一定回调，window.resize 再挂一道。
    //   ⚠ 这里**不做 120ms 防抖**：拖动窗口时每一帧都要重判"放不下"，
    //   否则等防抖结束时条早被压到图标上了，回收动画也会来得莫名其妙。
    //   只用 rAF 合帧（同一帧多次 resize 只量一次），耗时是几次 getBoundingClientRect。
    const w = getWin();
    if (w && typeof w.addEventListener === "function") {
      this._resizeHandler = () => {
        if (this._resizePending) return;
        this._resizePending = true;
        const run = () => {
          this._resizePending = false;
          try {
            onResize();
          } catch (e) {
            this.warn(e);
          }
        };
        try {
          const id = this.requestFrame(run);
          if (id === null || id === undefined) run();
        } catch (e) {
          this._resizePending = false;
          run();
        }
      };
      try {
        w.addEventListener("resize", this._resizeHandler);
      } catch (e) {
        /* ignore */
      }
    }
    this.dbg(() => "setupResizeWatch(): 已观察 " + nodeLabel(target));
  }

  /** 断开尺寸监听。 */
  teardownResizeWatch() {
    const w = getWin();
    if (this._resizeHandler && w && typeof w.removeEventListener === "function") {
      try {
        w.removeEventListener("resize", this._resizeHandler);
      } catch (e) {
        /* ignore */
      }
    }
    this._resizeHandler = null;
    this._resizePending = false;
    if (this._resizeWatch && typeof this._resizeWatch.disconnect === "function") {
      try {
        this._resizeWatch.disconnect();
      } catch (e) {
        /* ignore */
      }
    }
    this._resizeWatch = null;
    this._resizeTarget = null;
  }

  /**
   * 量滚动条占位宽写进 --hs-sb-w（缝垫层的宽度）。
   * 触摸端 CSS 已把滚动条隐藏 ⇒ 这里量到 0 ⇒ 垫层自动消失，不需要分支。
   */
  syncScrollbarWidth() {
    const doc = getDoc();
    const el = doc && doc.documentElement;
    if (!el || !el.style || typeof el.style.setProperty !== "function") return;
    const sc = this.findScrollContainer();
    let w = 0;
    if (sc && typeof sc.offsetWidth === "number" && typeof sc.clientWidth === "number") {
      w = sc.offsetWidth - sc.clientWidth;
    }
    if (!isFinite(w) || w < 0) w = 0;
    if (w > 64) w = 64; // 异常值夹住（缩放/DPR 下可能量出离谱的数）
    if (w === this._sbW) return;
    this._sbW = w;
    el.style.setProperty("--hs-sb-w", w + "px");
    this.dbg(() => "syncScrollbarWidth(): --hs-sb-w=" + w + "px");
    // ★ 量到 0 只可能是"渲染还没到位"（真有滚动条时 offset−client 必然 > 0）
    //   ⇒ 排两次延迟重试，避免一次失败就永久停在 0。
    if (w === 0 && !this._sbRetry) {
      this._sbRetry = 0;
      const retry = () => {
        this._sbRetry += 1;
        this._sbW = null; // 强制重算
        this.syncScrollbarWidth();
        this.ensureGutterStrip();
        if (this._sbW === 0 && this._sbRetry < 3) this.setTimer("sb-retry", retry, 400);
        else this._sbRetry = 0;
      };
      this.setTimer("sb-retry", retry, 400);
    }
  }

  /** 缝垫层：插在宿主（.view）首位，z-index:-1 ⇒ 在滚动容器之下、滚动条仍在它上面。 */
  ensureGutterStrip() {
    const doc = getDoc();
    const view = this.hostView;
    // 放回 .view 首位 + z-index:-1（真机观感最好的一版）；几何由 CSS 向外伸出
    const host = view;
    if (!doc || !host || typeof host.insertBefore !== "function") return;
    if (!this.gutterEl) this.gutterEl = el("div", "hs-gutter");
    if (this.gutterEl.parentNode === host) return;
    if (this.gutterEl.parentNode) this.gutterEl.parentNode.removeChild(this.gutterEl);
    host.insertBefore(this.gutterEl, host.firstChild || null);
    this.dbg(() => "ensureGutterStrip(): 补块已插到视图之前");
  }

  /** 移除缝垫层并清掉 --hs-sb-w。 */
  removeGutterStrip() {
    if (this.gutterEl && this.gutterEl.parentNode) this.gutterEl.parentNode.removeChild(this.gutterEl);
    const doc = getDoc();
    const el = doc && doc.documentElement;
    if (el && el.style && typeof el.style.removeProperty === "function") el.style.removeProperty("--hs-sb-w");
    this._sbW = null;
    this._sbRetry = 0;
  }

  // ---- 滚动联动：只保留「滚过一屏 ⇒ 收起库条」 --------------------------

  /**
   * 轮播进文档流后，滚动由浏览器完成，不再需要 JS 跟随（省掉满屏层的每帧 transform）。
   * 唯一仍需要滚动位置的是**媒体库条**：它是 fixed 浮层，滚过一屏必须收起。
   * 监听挂在滚动容器的 scroll 上（元素 + document 捕获双保险），rAF 节流。
   */
  attachLibBarScroll() {
    const sc = this.findScrollContainer();
    if (!sc || typeof sc.addEventListener !== "function") {
      this.dbg(() => "attachLibBarScroll(): 无滚动容器 → 跳过");
      return;
    }
    this.detachLibBarScroll();
    // ⚠ 绝不在这里拆尺寸监听：attachLibBarScroll() 在 mount() 末尾被调用，
    //   一旦顺手 teardownResizeWatch()，刚装好的 RO + window.resize 全没了
    //   ⇒ 只有挂载那一帧判定生效，手动拖窄不重测（真机：缩窗后条照样压图标）。
    this._libBarScrollEl = sc;
    const handler = (e) => this.onLibBarScrollEvent(e);
    this._libBarScrollHandler = handler;
    try {
      sc.addEventListener("scroll", handler, { passive: true });
    } catch (e) {
      sc.addEventListener("scroll", handler);
    }
    const doc = getDoc();
    if (doc && typeof doc.addEventListener === "function") {
      this._libBarDocScrollHandler = handler;
      try {
        doc.addEventListener("scroll", handler, { capture: true, passive: true });
      } catch (e) {
        /* ignore */
      }
    }
    this.syncLibBarVisibility();
    this.dbg(() => "attachLibBarScroll(): 已挂 " + nodeLabel(sc));
  }

  /** 摘掉库条滚动监听（元素 + document）。 */
  detachLibBarScroll() {
    const sc = this._libBarScrollEl;
    if (sc && this._libBarScrollHandler && typeof sc.removeEventListener === "function") {
      try {
        sc.removeEventListener("scroll", this._libBarScrollHandler);
      } catch (e) {
        /* ignore */
      }
    }
    const doc = getDoc();
    if (doc && this._libBarDocScrollHandler && typeof doc.removeEventListener === "function") {
      try {
        doc.removeEventListener("scroll", this._libBarDocScrollHandler, true);
      } catch (e) {
        /* ignore */
      }
    }
    this._libBarScrollHandler = null;
    this._libBarDocScrollHandler = null;
    this._libBarScrollEl = null;
    this._libBarPending = false;
  }

  /** 滚动事件：Emby 可能换节点 ⇒ 目标变了就记住新的，再节流同步。 */
  onLibBarScrollEvent(e) {
    const t = e && e.target;
    if (t && t !== this._libBarScrollEl && typeof t.scrollTop === "number") this._libBarScrollEl = t;
    this.scheduleLibBarSync();
  }

  /** rAF 节流：锁必须在任何情况下都能解开。 */
  scheduleLibBarSync() {
    if (this._libBarPending) return;
    this._libBarPending = true;
    let ran = false;
    const done = () => {
      if (ran) return;
      ran = true;
      this._libBarPending = false;
      try {
        this.syncLibBarVisibility();
      } catch (e) {
        this.warn(e);
      }
    };
    try {
      const id = this.requestFrame(done);
      if (id === null || id === undefined) done();
    } catch (e) {
      this._libBarPending = false;
      try {
        this.syncLibBarVisibility();
      } catch (e2) {
        this.warn(e2);
      }
    }
  }

  /** 滚过一屏 ⇒ 库条加 is-hero-out（fixed 浮层不能在滚动后继续压住内容）。 */
  syncLibBarVisibility() {
    const sc = this._libBarScrollEl;
    if (!sc) return;
    const top = typeof sc.scrollTop === "number" ? sc.scrollTop : 0;
    const h = typeof sc.clientHeight === "number" ? sc.clientHeight : 0;
    const out = h > 0 && top >= h;
    if (this.libBarEl && this.libBarEl.classList) {
      if (out) this.libBarEl.classList.add("is-hero-out");
      else this.libBarEl.classList.remove("is-hero-out");
    }
    if (out !== this._libBarOut) {
      this.dbg(() => "syncLibBarVisibility(): is-hero-out → " + out);
      this._libBarOut = out;
    }
  }

  /** 取一帧调度器（env/window 的 rAF，缺省退化为 setTimeout 16ms）。 */
  requestFrame(fn) {
    const env = this.getEnv();
    const raf = env.requestAnimationFrame;
    if (typeof raf === "function") {
      try {
        return raf(fn);
      } catch (e) {
        /* ignore */
      }
    }
    const w = getWin();
    if (w && typeof w.requestAnimationFrame === "function") {
      try {
        return w.requestAnimationFrame(fn);
      } catch (e2) {
        /* ignore */
      }
    }
    if (typeof setTimeout !== "undefined") return setTimeout(fn, 16);
    try {
      fn();
    } catch (e3) {
      /* ignore */
    }
    return null;
  }

  /** 取滚动容器（优先可垂直滚的那个；找不到再退 document.scrollingElement）。 */
  findScrollContainer() {
    const el = this.findScrollerHost();
    if (el && this.canScrollVertically(el)) return el;
    const doc = getDoc();
    const se = doc && doc.scrollingElement;
    if (se && se !== el && this.canScrollVertically(se)) return se;
    return el || null;
  }

  /** 元素当前能否垂直滚动。 */
  canScrollVertically(el) {
    if (!el) return false;
    const sh = el.scrollHeight;
    const ch = el.clientHeight;
    return typeof sh === "number" && typeof ch === "number" && sh > ch;
  }

  /**
   * 找宿主内 Emby 的滚动容器（**滚轮与 hero 共用**）。
   * 候选：emby-scroller → .scrollFrameY → .overflowScroll → .overflowYScroll → .scrollSlider → .tabContent[data-index="0"]。
   * 优先级：a) 第一个可垂直滚的候选 → b) 第一个"有尺寸"(clientHeight>0 || scrollHeight>0)的候选
   *        → c) 可滚的 document.scrollingElement（兜底）→ d) 第一个存在的候选（可能 0 尺寸）→ e) document.scrollingElement。
   * ★ 真机日志出现过 `sh=0 ch=0` 的命中：塌陷/隐藏视图的滚动容器尺寸为 0 ⇒ 兜底必须避开 0 尺寸节点。
   * @returns {object|null}
   */
  findScrollerHost() {
    const doc = getDoc();
    // ★ 挂载点现在是 .view 内部的 .scrollSlider，从它往下找会找不到 .emby-scroller，
    //   所以作用域优先用首页视图（hostView），没有才退回挂载点/文档。
    const scope = this.hostView || this.mountContainer || doc;
    const sels = [
      ".emby-scroller",
      ".scrollFrameY",
      ".overflowScroll",
      ".overflowYScroll",
      ".scrollSlider",
      '.tabContent[data-index="0"]',
    ];
    let firstExisting = null;
    let firstSized = null;
    if (scope && typeof scope.querySelector === "function") {
      for (let i = 0; i < sels.length; i++) {
        const el = scope.querySelector(sels[i]);
        if (!el) continue;
        if (!firstExisting) firstExisting = el;
        if (!firstSized && this.hasSize(el)) firstSized = el;
        if (this.canScrollVertically(el)) {
          this.dbg(
            () =>
              "findScrollerHost(): 命中可滚 " +
              sels[i] +
              " sh=" +
              el.scrollHeight +
              " ch=" +
              el.clientHeight,
          );
          return el;
        }
      }
    }
    if (firstSized) {
      this.dbg(
        () =>
          "findScrollerHost(): 无可滚候选 → 第一个有尺寸的（sh=" +
          firstSized.scrollHeight +
          " ch=" +
          firstSized.clientHeight +
          "）",
      );
      return firstSized;
    }
    // 没有"有尺寸/可滚"的候选：优先可滚的页面滚动元素，别把 0 尺寸的塌陷节点当滚动容器
    const se = (doc && doc.scrollingElement) || null;
    if (se && se !== firstExisting && this.canScrollVertically(se)) {
      this.dbg(() => "findScrollerHost(): 无尺寸候选 → 可滚的 document.scrollingElement 兜底");
      return se;
    }
    if (firstExisting) {
      this.dbg(
        () =>
          "findScrollerHost(): 无可滚候选 → 第一个存在的（sh=" +
          firstExisting.scrollHeight +
          " ch=" +
          firstExisting.clientHeight +
          "）",
      );
      return firstExisting;
    }
    this.dbg(() => "findScrollerHost(): 无候选 → " + (se ? "document.scrollingElement" : "null"));
    return se;
  }

  /** 元素是否有尺寸（clientHeight>0 或 scrollHeight>0）。 */
  hasSize(el) {
    if (!el) return false;
    const ch = el.clientHeight;
    const sh = el.scrollHeight;
    return (typeof ch === "number" && ch > 0) || (typeof sh === "number" && sh > 0);
  }

  /** 挂载轮播区（DOM 建好、取池、建 Swiper、预置首屏）。 */
  async mount() {
    const container = this.resolveMountContainer();
    if (!container) return false;
    this.mountContainer = container;
    // 给宿主打标记类（.hs-host；现在宿主是滚动内容层，轮播是它的一块内容）
    if (container.classList && typeof container.classList.add === "function") {
      container.classList.add("hs-host");
    }
    // ★ 视图也必须打：.hs-host 的 isolation 是缝垫层（z-index:-1）留在视图上下文里的前提。
    //   B 方案后宿主变成 .scrollSlider，若只在滑块上加，负层会逃到根上下文、被 .backgroundContainer 压住
    //   （真机症状：右侧那条缝一直发亮）。
    if (
      this.hostView &&
      this.hostView !== container &&
      this.hostView.classList &&
      typeof this.hostView.classList.add === "function"
    ) {
      this.hostView.classList.add("hs-host");
    }

    const doc = getDoc();
    if (doc && doc.body && doc.body.classList) {
      doc.body.classList.add("hs-home");
      doc.body.classList.add("hs-immersive"); // 背景压暗只在"轮播真的在显示"时生效
      doc.body.classList.remove("hs-leaving"); // 回到首页：撤掉「视觉收起」标记，轮播/库条恢复可见
    }

    this.epoch = 0;
    this.bumpEpoch();
    this.poolReady = false;
    this.placeholder = false;
    this.shownInfoIndex = -1;
    this.prevPoolIndex = -1;

    this.buildRootShell(); // 根容器
    this.setupResizeWatch(); // 尺寸变化 ⇒ 重量高度 + 重测库条几何
    this.syncScrollbarWidth();
    this.ensureGutterStrip();
    // ★ 分区是 Emby 后渲染的：挂载那一刻量不到"下一行"，peek 会停在最小值。
    //   每次 mutation 都（rAF 节流）重量一次，分区一出现就能把整行露出来。
    this.scheduleHeroHeight();
    this.setupObservers(); // ★ 观察器提前挂：异步取数窗口里的任何 wipe 都会被捕获（挂晚了会错过）

    await this.loadPool();

    // ★ 从详情页返回：按上次条目的 Id 找回下标（池子可能重排，找不到就从 0 开始）
    let start = 0;
    if (this._resumeId && this.pool && this.pool.length) {
      for (let i = 0; i < this.pool.length; i++) {
        if (this.pool[i] && this.pool[i].Id === this._resumeId) {
          start = i;
          break;
        }
      }
      this.dbg(() => "mount(): 恢复轮播下标=" + start + "（resumeId=" + this._resumeId + "）");
    }
    // 建轮播 + 起播（两条路径共用，见 rebuildCarousel）
    await this.rebuildCarousel(start);

    this.syncScrollbarWidth();
    this.ensureGutterStrip();
    this.measureLibBarGeometry();
    // ★ 声明 mounted 前再复检一次
    this.ensureRootAttached();
    this.setupOrientation();
    this.mounted = true;
    this.running = true;
    // ★ 从设置页/库页返回时，Emby 的分区是**后渲染**的：首帧量不到"下一行" ⇒ 轮播占满整屏。
    //   补三次延迟重量（幂等、极便宜），把"分区渲染完成"这个时间点兜住。
    [300, 900, 1800].forEach((ms, i) =>
      this.setTimer("hero-fit-" + i, () => this.applyHeroHeight(), ms),
    );
    // S6：库条（顶栏 .headerMiddle）+ 设置入口（抽屉 .mainDrawer）。缺宿主时各自跳过，绝不抛。
    this.mountLibBar();
    this.attachLibBarScroll(); // 只保留"滚过一屏收起库条"这一个滚动职责
    this.ensureHeaderSettingsBtn(); // 顶栏快捷入口（右侧图标组最左）
    this.setupHeaderSettingsObserver();
    this.dbg(
      () =>
        "mount(): 完成 pool=" +
        this.pool.length +
        " source=" +
        (this.poolResult && this.poolResult.source) +
        " placeholder=" +
        this.placeholder,
    );
    return true;
  }

  /**
   * 取设置 + 可见库 + 池（S3 数据层）。
   * @returns {Promise<void>}
   */
  async loadPool(opts) {
    const force = !!(opts && opts.force);
    const env = this.getEnv();
    try {
      this.userId = this.userId || resolveUserId(env);
      const signal = this.abortController ? this.abortController.signal : undefined;
      this.serverBase = resolveServerBase(env);

      let libs = [];
      try {
        libs = await getVisibleLibraries(env, { signal });
      } catch (e) {
        libs = [];
      }
      this.libraries = libs;

      const s = readSettings(this.userId, env, libs);
      this.settings = Object.assign({}, this.settings, s);
      this.settingsLoaded = true;
      const libId = s.LibId;
      this.libId = libId;
      this.dbg(() => "loadPool(): userId=" + this.userId + " 可见库=" + libs.length + " libId=" + libId);

      if (!libId) {
        this.poolResult = { items: [], source: "none", libId: null };
        this.pool = [];
        this.dbg(() => "loadPool(): 无 LibId → 占位(source=none)");
        return;
      }
      const lib = libs.filter((l) => String(l.Id) === String(libId))[0] || null;
      this.collectionType = lib ? lib.CollectionType : null;

      const res = await getPool(
        {
          libId,
          collectionType: this.collectionType,
          limit: s.PoolSize,
          signal,
          force, // 改设置后强制重新取数（否则会命中"同库内存池"，条数不变）
          strategyId: s.SelectionLogic,
        },
        env,
      );
      this.poolResult = res;
      this.pool = res && Array.isArray(res.items) ? res.items : [];
      // 换批需要知道"库里一共有多少条"才能算随机偏移范围
      this._windowTotal = res && typeof res.total === "number" && res.total > 0 ? res.total : this.pool.length;
      this.dbg(() => "loadPool(): items=" + this.pool.length + " source=" + (res && res.source));
      if (!this.pool.length) {
        // 空池要"吵"一下：区分「库为空」与「取数挂了」——否则全程静默无法排查
        this.dbg(() => "loadPool(): 池子为空（source=" + (res && res.source) + "）→ 将进入占位态");
      }
    } catch (err) {
      // 不把异常吞成"空池"而不留痕迹
      this.dbg(() => "loadPool() 异常：" + (err && err.message ? err.message : err));
      this.warn(err);
      this.poolResult = { items: [], source: "none", libId: this.libId || null, error: err };
      this.pool = [];
    }
  }

  /** 是否占位态（来源 none 或池为空 —— 九章）。 */
  isPlaceholder() {
    const res = this.poolResult || {};
    return res.source === "none" || !this.pool.length;
  }

  // ---- DOM 构建 ------------------------------------------------------

  /** 建根容器并插入挂载容器。 */
  buildRootShell() {
    const root = el("div", "hs-root");
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "首页轮播");
    root.setAttribute("aria-live", "off");
    this.root = root;


    const container = this.mountContainer;
    if (container && typeof container.insertBefore === "function") {
      container.insertBefore(root, container.firstChild);
    }
  }

  /** 建轮播层（swiper/slide/热区/箭头/信息层/进度/占位）。 */
  buildCarousel() {
    const root = this.root;
    const items = this.pool;

    // —— 底图层 .swiper（背景透明；slide 内只放 backdrop <img>）
    const swiperEl = el("div", "swiper");
    const wrapperEl = el("div", "swiper-wrapper");
    this.slideEls = [];
    this.imgEls = [];
    for (let i = 0; i < items.length; i++) {
      const slide = el("div", "swiper-slide");
      slide.setAttribute("data-pool-index", String(i));
      const img = el("img");
      img.setAttribute("data-src", this.imageUrlFor(items[i]));
      img.setAttribute("alt", "");
      img.setAttribute("draggable", "false");
      slide.appendChild(img);
      wrapperEl.appendChild(slide);
      this.slideEls.push(slide);
      this.imgEls.push(img);
    }
    swiperEl.appendChild(wrapperEl);
    this.swiperEl = swiperEl;
    this.wrapperEl = wrapperEl;

    // —— 左右边缘热区（必须排在箭头之前入 DOM，否则同层会吃掉箭头点击）
    const hotPrev = el("div", "hs-hotzone hs-hotzone--prev");
    hotPrev.setAttribute("aria-hidden", "true");
    const hotNext = el("div", "hs-hotzone hs-hotzone--next");
    hotNext.setAttribute("aria-hidden", "true");
    this.hotPrev = hotPrev;
    this.hotNext = hotNext;
    // 热区是唯一交互层（箭头已 pointer-events:none，不参与 hit-test）⇒ 导航点击绑在热区上
    this.bindHotzoneClicks();

    // —— 箭头（保留官方类名，否则 Swiper 不注入 SVG）
    const prevBtn = el("div", "swiper-button-prev");
    prevBtn.setAttribute("tabindex", "0");
    prevBtn.setAttribute("role", "button");
    prevBtn.setAttribute("aria-label", "上一个");
    const nextBtn = el("div", "swiper-button-next");
    nextBtn.setAttribute("tabindex", "0");
    nextBtn.setAttribute("role", "button");
    nextBtn.setAttribute("aria-label", "下一个");
    this.prevBtn = prevBtn;
    this.nextBtn = nextBtn;

    // —— 信息 / 控件层 .hs-info（容器穿透）
    const infoLayer = el("div", "hs-info");
    const nodeA = el("div", "hs-info__inner");
    const nodeB = el("div", "hs-info__inner");
    nodeA.classList.add("is-active");
    this.infoNodes = [nodeA, nodeB];
    this.visibleNodeIndex = 0;
    infoLayer.appendChild(nodeA);
    infoLayer.appendChild(nodeB);

    // 占位文案（仅占位态可见；内容由 setPlaceholder() 填）
    const placeholderEl = el("div", "hs-placeholder");
    this.placeholderEl = placeholderEl;
    infoLayer.appendChild(placeholderEl);
    this.infoLayer = infoLayer;

    // —— 按契约顺序插入
    root.appendChild(swiperEl);
    root.appendChild(hotPrev);
    root.appendChild(hotNext);
    root.appendChild(prevBtn);
    root.appendChild(nextBtn);
    root.appendChild(infoLayer);

    // —— 视频层（单元素；DOM 位置无关紧要，分层靠 z-index:2）
    this.ensureVideoElement();
  }

  /**
   * 建（或复用）唯一的 <video> + 左缘蒙版 + 进度条 + 静音按钮。
   * 不播时宽高为 0 且 opacity:0 ⇒ 不占位、不参与 hit-test。
   * @returns {HTMLVideoElement|null}
   */
  ensureVideoElement() {
    if (this.videoEl && this.videoEl.parentNode) return this.videoEl;
    const doc = getDoc();
    if (!doc || !this.root || typeof this.root.insertBefore !== "function") return null;
    let v = null;
    try {
      v = doc.createElement("video");
    } catch (e) {
      return null;
    }
    if (!v) return null;
    v.className = "hs-video";
    // ★ 不再预置 muted：参考实现（emby-swiper-trailer.js）从不设 muted、只设 autoplay，
    //   在客户端里能直接带声音起播。我们照它来；被浏览器拦时再降级（见 playTrailer）。
    v.setAttribute("playsinline", "");
    v.setAttribute("preload", "auto");
    v.autoplay = true;
    try {
      v.volume = this.trailerVolume(); // 起播前就把音量定好，避免"先满音量再跳"
    } catch (e) {
      /* ignore */
    }
    v.setAttribute("aria-hidden", "true");
    v.setAttribute("tabindex", "-1");
    v.muted = false;
    // ★ 播完不自动翻页：先收回面板，再由 autoplay 正常接手（两件事不能撞一起）
    v.addEventListener("ended", () => this.onTrailerEnded());
    // 进度条：timeupdate 频率足够（约 4 次/秒），不需要 rAF
    v.addEventListener("timeupdate", () => this.syncVideoBar(v));
    v.addEventListener("play", () => this.startBarLoop(v));
    v.addEventListener("pause", () => this.stopBarLoop());
    this.videoEl = v;

    // 视频层的过渡只有两种：左缘蒙版（透明化）+ 顶部覆盖层（压暗到顶栏），没有额外的遮挡层
    // 进度条：细、低饱和（用户要求"不要特别亮"）
    const bar = el("div", "hs-video-bar");
    bar.setAttribute("aria-hidden", "true");
    const fill = el("i", "hs-video-bar__fill");
    bar.appendChild(fill);
    this.videoBarEl = bar;
    this.videoBarFill = fill;
    // 静音按钮：挂在视频面板右下角（z-index 5，在信息层之上）
    const mute = el("button", "hs-mute");
    mute.setAttribute("type", "button");
    mute.setAttribute("aria-pressed", "false");
    mute.setAttribute("aria-label", "静音");
    mute.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M11 5 6 9H3v6h3l5 4z"/>' +
      '<path class="hs-mute__wave" d="M15.5 8.5a5 5 0 0 1 0 7"/>' +
      '<path class="hs-mute__wave" d="M18.2 6.2a9 9 0 0 1 0 11.6"/>' +
      '<path class="hs-mute__slash" d="M16.5 9.5l5 5M21.5 9.5l-5 5"/>' +
      "</svg>";
    this.muteBtn = mute;
    mute.addEventListener("click", (ev) => {
      if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
      this.toggleTrailerMute();
    });
    // 顺序无关紧要：视频/进度条/静音按钮都靠 z-index 分层（2 / 3 / 5）
    this.root.appendChild(v);
    this.root.appendChild(bar);
    this.root.appendChild(mute);
    return v;
  }

  /** 创建并配置 Swiper（fade + crossFade / loop:false + rewind / 显式 navigation）。 */
  createSwiper(startIndex) {
    const reduced = this.prefersReducedMotion();
    const start = typeof startIndex === "number" && startIndex > 0 ? startIndex : 0;
    const on = {
      slideChange: () => this.onSlideChange(),
      slideChangeTransitionStart: () => this.onSlideChangeTransitionStart(),
    };
    const params = {
      modules: this.modules,
      effect: "fade",
      fadeEffect: { crossFade: true },
      loop: false,
      rewind: !this.isShuffleMode(),
      initialSlide: start, // 从详情返回时停在原条目，而不是第一条
      speed: reduced ? 0 : SWIPER_SPEED,
      simulateTouch: false, // 鼠标拖拽关（fade 下无意义）
      touchAngle: 45, // 只吃近水平手势，不抢页面纵向滚动
      touchStartPreventDefault: false,
      preventInteractionOnTransition: true,
      navigation: { prevEl: this.prevBtn, nextEl: this.nextBtn },
      // ⚠ 有意偏离计划书 6.4 的 pauseOnMouseEnter:true —— 按用户要求改为不因悬停暂停。
      //   理由：轮播铺满整个首页视图，光标几乎永远在其上 ⇒ 悬停暂停等于禁用自动播放。
      //   并且按用户要求**彻底移除暂停入口**（既关悬停暂停、也删掉原常显暂停按钮）
      //   ⇒ 这是对计划书八章"常显暂停控件"与验收 #31 的**有意偏离**；
      //   代价：自动播放将没有任何应用内暂停入口（只能靠浏览器/系统层面）。
      // ★ 不用 Swiper 的 autoplay：切页是 speed:0（瞬时），它收不到 transitionend 就不续命。
      //   计时与翻页统一由 startImagePhase() 负责（单一时间源），这里必须关掉，否则会双翻页。
      autoplay: false,
      on,
    };
    this.tlog(
      () =>
        "swiper: 策略=" + (this.settings && this.settings.SelectionLogic) +
        " rewind=" + params.rewind +
        " 批大小=" + (this.pool ? this.pool.length : 0) +
        " 库总数=" + this._windowTotal,
    );
    this.swiperParams = params;
    this.swiper = new this.SwiperCtor(this.swiperEl, params);
    this.bindControls();
    return this.swiper;
  }

  /**
   * 绑定箭头的事件与键盘可达性。
   * ⚠ **不再给箭头绑 click**：箭头已 `pointer-events:none`（永不参与 hit-test），
   *   鼠标点击统一由 `.hs-hotzone` 承接（见 bindHotzoneClicks）。保留 keydown 供键盘可达性。
   */
  bindControls() {
    const self = this;
    if (this.prevBtn) {
      this.prevBtn.addEventListener("keydown", (e) => self.onArrowKey(e, -1));
    }
    if (this.nextBtn) {
      this.nextBtn.addEventListener("keydown", (e) => self.onArrowKey(e, 1));
    }
  }

  /**
   * 给左右热区绑导航点击（热区是唯一交互层；箭头 pointer-events:none 不抢点击 ⇒ 点不动的问题在此修复）。
   * 句柄存实例，撤离/重建时成对摘除。
   */
  bindHotzoneClicks() {
    if (this.hotPrev) {
      this._hotPrevClick = () => this.goPrev();
      this.hotPrev.addEventListener("click", this._hotPrevClick);
    }
    if (this.hotNext) {
      this._hotNextClick = () => this.goNext();
      this.hotNext.addEventListener("click", this._hotNextClick);
    }
  }

  /** 摘掉热区点击监听（成对）。 */
  unbindHotzoneClicks() {
    if (this.hotPrev && this._hotPrevClick && typeof this.hotPrev.removeEventListener === "function") {
      try {
        this.hotPrev.removeEventListener("click", this._hotPrevClick);
      } catch (e) {
        /* ignore */
      }
    }
    if (this.hotNext && this._hotNextClick && typeof this.hotNext.removeEventListener === "function") {
      try {
        this.hotNext.removeEventListener("click", this._hotNextClick);
      } catch (e) {
        /* ignore */
      }
    }
    this._hotPrevClick = null;
    this._hotNextClick = null;
  }


  /**
   * 切页方向：+1 前进 / -1 后退（含 rewind 首尾环绕）。首帧（prev<0）返回 0 = 不做动画。
   * @param {number} prev 上一页池下标
   * @param {number} next 当前池下标
   */
  swapDirection(prev, next) {
    const n = this.pool ? this.pool.length : 0;
    if (prev < 0 || next < 0 || prev === next || n < 2) return 0;
    // 用「模距离」判方向：相邻、跳格、首尾环绕都能判出来。
    // 之前用精确匹配（+1 / -1 / 环绕）⇒ 一旦出现过一次非相邻跳转就永远返回 0 ⇒ 不再动画。
    const d = (next - prev + n) % n;
    if (!d) return 0;
    return d <= n / 2 ? 1 : -1;
  }

  /**
   * 前进一页。到批尾不是回卷，而是**换一批新的**（随机偏移取样，允许重复）。
   * 所有前进路径（热区 / 键盘 / 自动轮播 / 预告片播完）都必须走这里。
   */
  goNext() {
    const sw = this.swiper;
    if (!sw || this._swapping) return;
    const idx = this.navIndex();
    const last = (this.pool ? this.pool.length : 0) - 1;
    if (idx >= last) {
      this.tlog(() => "nav: 前进越界 idx=" + idx + "/" + last + " shuffle=" + this.isShuffleMode());
      if (this.isShuffleMode()) this.swapWindow(1);
      else if (typeof sw.slideNext === "function") sw.slideNext(); // rewind 回卷
      return;
    }
    if (typeof sw.slideNext === "function") sw.slideNext();
  }

  /** 后退一页。到批首同样是**换一批新的**（落在新批最后一条）。 */
  goPrev() {
    const sw = this.swiper;
    if (!sw || this._swapping) return;
    const idx = this.navIndex();
    if (idx <= 0) {
      this.tlog(() => "nav: 后退越界 idx=" + idx + " shuffle=" + this.isShuffleMode());
      if (this.isShuffleMode()) this.swapWindow(-1);
      else if (typeof sw.slidePrev === "function") sw.slidePrev(); // rewind 回卷
      return;
    }
    if (typeof sw.slidePrev === "function") sw.slidePrev();
  }

  /** 导航用的下标：优先 data-pool-index，取不到时退回 Swiper 的 activeIndex。 */
  navIndex() {
    const idx = this.activePoolIndex();
    if (typeof idx === "number" && idx >= 0) return idx;
    const sw = this.swiper;
    return sw && typeof sw.activeIndex === "number" ? sw.activeIndex : 0;
  }

  /** 当前是否"随机换批"模式（越界换整批，而不是回卷）。 */
  isShuffleMode() {
    const st = getStrategy(this.settings && this.settings.SelectionLogic);
    return !!(st && st.endBehavior === "fetchMore");
  }

  /**
   * 换一批新的（窗口模型：池子永远只有一批，越界即替换，不保留历史）。
   *
   * 取法：在当前排序结果里**随机挑一段**（startIndex = 随机偏移），长度 = 批大小。
   *  - 前进越界 ⇒ 落在新批第 1 条；后退越界 ⇒ 落在新批最后一条；
   *  - 允许与上一批重复（库越大重复越少：期望 N²/M 条）；
   *  - 库很小时（total ≤ 批大小）不换批，停在原地。
   * @param {number} dir 1 = 前进，-1 = 后退
   */
  async swapWindow(dir) {
    if (this._swapping) return;
    const size = this.pool ? this.pool.length : 0;
    const total = this._windowTotal || 0;
    if (!size || total <= size) return; // 只有一批，没得换
    this._swapping = true;
    try {
      const st = getStrategy(this.settings && this.settings.SelectionLogic);
      const preset = SORT_PRESETS[st && st.id] || SORT_PRESETS.recent;
      // ★ 随机模式靠服务端 SortBy=Random 打乱整个库（不是"随机起点 + 连续 N 条"）
      const offset = 0;
      const page = await fetchPage(
        {
          libId: this.libId,
          collectionType: this.collectionType,
          limit: size,
          startIndex: offset,
          ...preset,
        },
        this.getEnv(),
      );
      let items = page && Array.isArray(page.items) ? page.items : [];
      if (!items.length) {
        this._swapping = false;
        return;
      }
      // 服务端若不认 Random（静默忽略）会退回默认排序 ⇒ 客户端再打乱一次兜底
      items = items.slice().sort(() => Math.random() - 0.5);
      if (typeof page.total === "number" && page.total > 0) this._windowTotal = page.total;
      this.tlog(() => "swapWindow(): 取回=" + items.length + " 条（SortBy=" + preset.sortBy + "）方向=" + dir);
      this.replaceWindow(items);
      const land = dir > 0 ? 0 : Math.max(0, this.pool.length - 1);
      if (this.swiper && typeof this.swiper.slideTo === "function") this.swiper.slideTo(land, 0, false);
      this._swapping = false;
      this.playSwapShift(dir); // 换批也算一次切条：手动补推入动画
      this.shownInfoIndex = -1;
      this.updateInfoLayer(land);
      this.stopTrailer("window-swap");
      this.scheduleTrailer(land);
      this.startImagePhase(land);
      this.prevPoolIndex = land;
    } catch (err) {
      this._swapping = false;
      this.warn(err);
    }
  }

  /** 用新一批条目**就地替换**已有 slide 的内容（不重建 Swiper，避免闪一下）。 */
  replaceWindow(items) {
    this.pool = items;
    if (this.poolResult) this.poolResult.items = items;
    const n = items.length;
    for (let i = 0; i < n; i++) {
      const slide = this.slideEls && this.slideEls[i];
      const img = this.imgEls && this.imgEls[i];
      if (slide && slide.setAttribute) slide.setAttribute("data-pool-index", String(i));
      if (img && img.setAttribute) {
        img.setAttribute("data-src", this.imageUrlFor(items[i]));
        // ★ 必须先清 src：assignSlideImage 有"已赋值就跳过"的守卫，不清会继续显示旧图
        img.removeAttribute("src");
      }
    }
    this.presetImages();
    this.updateImageSlots(0);
  }

  /**
   * 切条位移：背景已瞬间替换，新内容从侧面推入（前进右、后退左）。
   *
   * 用 **Web Animations API** 而不是 class + CSS animation：
   * class 方案依赖"移除 → 重排 → 再加"的时机，任何一个环节被别的定时器/重排影响就会静默失效
   * （真机表现：手动切有动画、自动轮播没有）。WAAPI 每次调用都是独立动画对象，不受此影响。
   */
  playSwapShift(dir) {
    if (!dir) return;
    if (this.prefersReducedMotion()) return;
    const el = this.root;
    if (!el) return;
    const from = dir < 0 ? -64 : 64;
    // 先撤掉上一次的动画，连点也不叠加
    if (this._swapAnim && typeof this._swapAnim.cancel === "function") {
      try {
        this._swapAnim.cancel();
      } catch (e) {
        /* ignore */
      }
    }
    this._swapAnim = null;
    if (typeof el.animate === "function") {
      try {
        this._swapAnim = el.animate(
          [{ transform: "translateX(" + from + "px)" }, { transform: "translateX(0px)" }],
          { duration: 520, easing: "cubic-bezier(0.22, 0.61, 0.36, 1)" },
        );
        this.dbg(() => "swapShift: dir=" + dir + "（WAAPI）");
        return;
      } catch (e) {
        /* 降级到 class 方案 */
      }
    }
    // 回退：class + CSS animation（老环境）
    if (el.classList) {
      el.classList.remove("is-swap-next", "is-swap-prev");
      void el.offsetWidth;
      el.classList.add(dir < 0 ? "is-swap-prev" : "is-swap-next");
      this.setTimer(
        "swap-shift",
        () => {
          if (el.classList) el.classList.remove("is-swap-next", "is-swap-prev");
        },
        620,
      );
    }
  }

  /** 箭头键盘：Enter / Space。 */
  onArrowKey(e, dir) {
    if (!e) return;
    const k = e.key;
    if (k === "Enter" || k === " " || k === "Spacebar") {
      if (typeof e.preventDefault === "function") e.preventDefault();
      const sw = this.swiper;
      if (!sw) return;
      if (dir < 0) this.goPrev();
      else if (dir > 0) this.goNext();
    }
  }

  // ---- 切页副作用（6.10 收口） ---------------------------------------

  /** 当前池下标：用 activeIndex 定位 slide 元素，再读 data-pool-index（不拿 activeIndex 当下标）。 */
  activePoolIndex() {
    const sw = this.swiper;
    const ai = sw && typeof sw.activeIndex === "number" ? sw.activeIndex : 0;
    const slide = this.slideEls[ai];
    if (slide && typeof slide.getAttribute === "function") {
      const raw = slide.getAttribute("data-pool-index");
      if (raw !== null && raw !== undefined && raw !== "") {
        const n = parseInt(raw, 10);
        if (isFinite(n)) return n;
      }
    }
    return ai;
  }

  /** slideChangeTransitionStart：把新页内容写入隐藏节点并触发交叉淡入（与底图 crossFade 同步）。 */
  onSlideChangeTransitionStart() {
    this.updateInfoLayer(this.activePoolIndex());
  }

  /** slideChange：位移 → bumpEpoch → updateInfoLayer → updateImageSlots → notifyVideoLayer → 图片阶段计时。 */
  onSlideChange() {
    if (!this.swiper) return;
    const idx = this.activePoolIndex();
    // ★ 切条位移放在这里统一触发：自动轮播 / 兜底翻页 / 手动点击 都会经过 slideChange。
    //   之前只挂在热区与键盘上，所以"自动轮播的图片页"完全没有推入动画（真机反馈）。
    this.playSwapShift(this.swapDirection(this.prevPoolIndex, idx));
    this.bumpEpoch();
    this.updateInfoLayer(idx);
    this.updateImageSlots(idx);
    this.notifyVideoLayer(this.prevPoolIndex, idx);
    this.prevPoolIndex = idx;
    // 图片阶段放最后：即便它出问题也不能打断上面的视频链路
    try {
      this.startImagePhase(idx);
    } catch (e) {
      this.warn(e);
    }
  }


  /** 切条时通知视频层：先收（无动画），再给新条排一次"延时开播"。 */
  notifyVideoLayer(prevIdx, idx) {
    void prevIdx;
    this.tlog(() => "切条：idx=" + idx + " 有预告片=" + this.itemHasTrailer(idx));
    this.stopTrailer("slide-change", false);
    this.scheduleTrailer(idx);
  }

  /**
   * 算右侧视频面板的尺寸并写进 CSS 变量（幂等，每次量高都会走）。
   * 规则：宽度按**固定占比**（`TRAILER_VIDEO_SHARE`）+ 下限（视频 ≥680）；
   * 窗口不够宽就整体归零（宁可不播）。
   * @param {number} heroH 轮播块高（px）
   * @param {number} heroW 轮播块宽（px）
   */
  layoutVideo(heroH, heroW) {
    const st = this.root && this.root.style;
    if (!st || typeof st.setProperty !== "function") return;
    // 信息块的标题锚点：**按实测高度算 px**，不写百分比。
    //   旧版式（视频只占中间）用 52% 才平衡；现在是左文字/右视频的满高分栏，
    //   视频从顶边开始，文字却从中线开始 ⇒ 标题看着"沉在中间"。
    //   取 36% 并夹在 [210, 520] px：矮窗不撞顶栏，高窗也不会越拉越靠下。
    if (heroH > 0) {
      const logoTop = Math.round(Math.min(560, Math.max(240, heroH * 0.42)));
      st.setProperty("--hs-logo-top", logoTop + "px");
    }
    let vw = 0;
    let vh = 0;
    const on = !!(this.settings && this.settings.PlayTrailer);
    // 填充方式：默认裁剪（铺满），极端比例退回缩放（避免把画面切坏）。
    //   1.2–2.4 是「裁一点看不出来」的区间；竖屏/超宽银幕裁了会毁构图。
    const ar0 = this._videoAspect > 0 ? this._videoAspect : 16 / 9;
    let fit0 = "cover";
    if (on && heroH >= 360) {
      // 上下各留一点：底部留白让渐隐落在页面底色上；顶部留白让顶栏渐变吃掉切口
      vh = Math.round(heroH) - TRAILER_INSET_BOTTOM;
      // 面板宽度 = **按高度反推的视频自然宽**（高度 × 比例），再用「文字净区」兜住上限。
      //   这样 16:9 的片在任意窗口下比例都稳定在 16:9，不会随窗口变成 1.57 的长条；
      //   超宽银幕放不下时才被兜住（此时比例偏差大，退 contain 留边而不是硬裁）。
      // 宽度按**固定占比**切（用户偏好：视频占 80%），比例差异交给 cover 裁切；
      //   只有这样网页端与客户端才看起来一致（高度驱动会让两端大小不同）。
      vw = Math.round(heroW * TRAILER_VIDEO_SHARE);
      if (vw < TRAILER_PANE_MIN) vw = Math.min(TRAILER_PANE_MIN, Math.round(heroW)); // 视频保底
      if (vw > heroW) vw = Math.round(heroW);
      // ★ 面板始终满高、按 78% 宽铺满；**能放就播**，裁切多少由几何决定（cover）。
      //   不再用"裁切超上限就不播"的规则：半屏状态下那样会直接没有预告片（真机反馈），
      //   而满铺 + 裁切至少还有画面。只有放不下（< TRAILER_PANE_MIN / 太矮）才不播。
      if (vw < TRAILER_PANE_MIN || vh < 300) {
        vw = 0;
        vh = 0;
      }
    }
    // 填充方式：**默认 cover（裁切铺满）**，但差额过大时改 contain（保构图）。
    //   · 拉伸（fill）永不使用：会改变像素宽高比，人脸直接变形；
    //   · 阈值来自实测：16:9 片在 16:9 屏 dev≈1.28（裁 22%）仍可接受；
    //     2.39 宽银幕在 16:9 屏 dev≈1.72（裁 42%）必须留边；
    //     4:3 老片在 21:9 屏 dev≈0.72（上下裁 28%）同样必须留边。
    // 盒子高度已按视频比例收缩 ⇒ 横向不会再裁，只有"宽度撑满高度"的宽屏才会上下裁。
    // 竖屏素材仍然 contain（塞进横向盒子里硬裁会把人物切掉）。
    fit0 = ar0 < 1.2 ? "contain" : "cover";
    // 下发填充方式（CSS 变量）
    if (typeof st.setProperty === "function") {
      st.setProperty("--hs-video-fit", fit0);
      st.setProperty("--hs-video-pos", fit0 === "cover" ? "center " + TRAILER_FRAME_Y + "%" : "center center");
    }
    if (fit0 !== this._videoFit) {
      this._videoFit = fit0;
      this.tlog(() => "layoutVideo(): 填充方式=" + fit0 + "（视频比例 " + ar0.toFixed(2) + "）");
    }
    this.fitInfoNodes();
    // 只在"几何/填充"真的变了时打日志：ResizeObserver 与 window.resize 会各触发一次，
    // 不去重就会看到重复的同一行（容易误判为"重复布局"）。
    const boxARNow = vw > 0 && vh > 0 ? vw / vh : 0;
    let cropTxt = "";
    if (boxARNow > 0) {
      if (boxARNow < ar0) {
        // 盒子更窄 ⇒ 切左右
        cropTxt = "左右共裁 " + Math.round((1 - boxARNow / ar0) * 100) + "%";
      } else if (boxARNow > ar0) {
        cropTxt = "上下共裁 " + Math.round((1 - ar0 / boxARNow) * 100) + "%";
      } else {
        cropTxt = "无裁切";
      }
      if (fit0 === "contain") cropTxt = "留边（不裁）";
    }
    const geoKey = vw + "x" + vh + "|" + fit0 + "|" + Math.round(ar0 * 100);
    if (geoKey !== this._geoKey) {
      this._geoKey = geoKey;
      this.tlog(
        () =>
          "layoutVideo(): hero=" + Math.round(heroW) + "x" + Math.round(heroH) +
          " 面板=" + vw + "x" + vh +
          (boxARNow > 0 ? "（盒子比 " + boxARNow.toFixed(2) + "）" : "") +
          " 视频比 " + ar0.toFixed(2) +
          " 填充=" + fit0 +
          (cropTxt ? " " + cropTxt : "") +
          (vw ? "" : "（不开播：设置关 / 轮播太窄 / 面板太矮）"),
      );
    }
    const hadRoom = this._videoW > 0;
    const changed = vw !== this._videoW || vh !== this._videoH;
    this._videoW = vw;
    this._videoH = vh;
    void changed;
    st.setProperty("--hs-video-w", vw + "px");
    st.setProperty("--hs-video-h", vh ? vh + "px" : "0px");
    // 满高、贴顶：不需要垂直留白
    st.setProperty("--hs-video-top", "0px");
    this.syncVideoVisibility();
    // 位置没了（窗口太窄/关掉预告片）才收；**尺寸变化不收** ——
    // 面板宽高是 CSS 变量，video 会自己跟着缩放，停播反而让画面闪没（真机 bug）。
    if (!vw) {
      this.stopTrailer("no-room");
    } else if (!hadRoom) {
      // ★ 从「放不下」恢复到「放得下」：给**当前这张**重新排队。
      //   否则拖大窗口后视频不会回来，只能等下一张（真机反馈）。
      this.scheduleTrailer(this.activePoolIndex());
    }
  }

  /** 排一次"停留 N 毫秒后开播"（静态封面先露脸）。 */
  scheduleTrailer(idx) {
    this.tlog(() => "scheduleTrailer(): idx=" + idx + " videoW=" + this._videoW + " play=" + !!(this.settings && this.settings.PlayTrailer));
    if (!this.settings || !this.settings.PlayTrailer) return;
    if (!this._videoW) return;
    const item = this.pool && this.pool[idx];
    if (!item) return;
    this.tlog(
      () => "scheduleTrailer(): 条目=" + item.Name + " LocalTrailerCount=" + item.LocalTrailerCount,
    );
    // ★ 只有「明确为 0」才跳过；字段缺失（旧池缓存没这个字段）要照试一次，
    //   否则老缓存会让 S5 永远不触发（真机排查过一轮）。
    const cnt = item.LocalTrailerCount;
    const known = cnt !== undefined && cnt !== null;
    if (known && !(Number(cnt) > 0)) {
      this.tlog(() => "scheduleTrailer(): 本条明确无预告片 → 跳过（" + item.Name + "）");
      return;
    }
    // 已缓存过 Id ⇒ 不必再等网络，短延迟起播
    this._tQueue = this.nowMs();
    // 立刻去取 Id：网络耗时与「底图淡入 + 文字入场」并行，不再串行等待。
    // 真正起播时刻由 playTrailer 里的 TRAILER_MIN_START_MS 控制。
    this.startTrailer(idx);
  }

  /** 真正开播（预告片 Id 走缓存；查过没有的记 null，不重试）。 */
  startTrailer(idx) {
    this._tStart = this.nowMs();
    const waited = this._tQueue ? Math.round(this._tStart - this._tQueue) : -1;
    this.tlog(
      () => "startTrailer(): idx=" + idx + " isHome=" + this.isHome() + " videoW=" + this._videoW + " 排队=" + waited + "ms",
    );
    if (!this.root || !this.isHome()) return;
    if (!this._videoW) {
      // 尺寸还没算过（例如定时器比量高先到）⇒ 现场补算一次，别静默放弃
      try {
        this.layoutVideo(this.root.clientHeight, this.root.clientWidth);
      } catch (e) {
        /* ignore */
      }
    }
    if (!this._videoW) {
      this.tlog(() => "startTrailer(): 面板尺寸为 0 → 跳过");
      return;
    }
    if (this._videoIndex === idx) return;
    const item = this.pool && this.pool[idx];
    if (!item) return;
    const cnt2 = item.LocalTrailerCount;
    if (cnt2 !== undefined && cnt2 !== null && !(Number(cnt2) > 0)) return;
    const key = String(item.Id);
    const cached = this._trailerIds[key];
    if (cached === undefined) {
      const epoch = this.epoch;
      this.tlog(() => "startTrailer(): 取预告片 Id …（userId=" + this.userId + "）");
      getLocalTrailerId(key, this.getEnv(), { userId: this.userId })
        .then((tid) => {
          this.tlog(() => "startTrailer(): 取到 trailerId=" + tid);
          this._trailerIds[key] = tid || null;
          if (epoch !== this.epoch) return;
          if (this.activePoolIndex() !== idx) return;
          if (tid) this.playTrailer(idx, tid);
        })
        .catch((err) => {
          this.tlog(() => "startTrailer(): 取预告片失败 → " + (err && err.message));
          this._trailerIds[key] = null;
        });
      return;
    }
    if (cached) this.playTrailer(idx, cached);
    else this.tlog(() => "startTrailer(): 缓存里没有预告片 → 跳过");
  }

  /**
   * 挂源并等首帧：`loadeddata` 之后才挂 .is-trailer（否则第一帧是黑的，比不播还难看）。
   * @param {number} idx 池下标
   * @param {string} trailerId 预告片条目 Id
   */
  playTrailer(idx, trailerId) {
    // ★ 最小起播时刻：取数可能 20ms（局域网）也可能 300ms（公网），
    //   这里把它"对齐"到文字入场之后，而不是在取数之后再加固定延迟。
    const since = this._tQueue ? this.nowMs() - this._tQueue : 0;
    const wait = Math.round(TRAILER_MIN_START_MS - since);
    if (wait > 30) {
      this.setTimer(
        "trailer-minstart",
        () => {
          if (this.activePoolIndex() !== idx) return;
          this.playTrailer(idx, trailerId);
        },
        wait,
      );
      return;
    }
    this.clearTimer("trailer-minstart");
    this._tPlay = this.nowMs();
    const fetchMs = this._tStart ? Math.round(this._tPlay - this._tStart) : -1;
    this.tlog(() => "playTrailer(): 挂源 trailerId=" + trailerId + " 取数=" + fetchMs + "ms");
    this._videoAspect = 16 / 9; // 先按 16:9 摆，拿到元数据再按真实比例校正
    const v = this.ensureVideoElement();
    if (!v) {
      this.tlog(() => "playTrailer(): 没有 video 元素 → 退出");
      return;
    }
    const epoch = this.epoch;
    const retryKey = String(trailerId);
    const retried = !!(this._retried && this._retried[retryKey]);
    if (!this._retried) this._retried = {};
    // ★ 关键：上一次 stopTrailer 排的 "trailer-src-clear" 必须取消，
    //   否则它会在新视频还在加载时把新 src 清掉 ⇒ 那条永远出不来（真机：时好时坏）。
    this.clearTimer("trailer-src-clear");
    // ★ 换源窗口：先让元素彻底不可见，避免"淡出到一半被换源"露出黑帧
    if (this.root && this.root.classList) {
      this.root.classList.add("is-video-swap");
    }
    const url = buildStreamUrl(this.serverBase, trailerId, resolveToken(this.getEnv()));
    let settled = false;
    const commit = () => {
      if (settled) return;
      settled = true;
      this.clearTimer("trailer-ready");
      if (epoch !== this.epoch) return;
      if (this.activePoolIndex() !== idx) return;
      const tCommit = this.nowMs();
      const decodeMs = this._tPlay ? Math.round(tCommit - this._tPlay) : -1;
      const totalMs = this._tQueue ? Math.round(tCommit - this._tQueue) : -1;
      this.tlog(
        () => "loadeddata → 面板出现 | 解码=" + decodeMs + "ms 总计=" + totalMs + "ms",
      );
      this.tlog(() => "playTrailer(): loadeddata → 挂 .is-trailer（面板应出现），videoIndex=" + idx);
      // 实测一次：视频元素 vs 轮播块，用来定位"横线"（视频没铺满 ⇒ 下缘露出底图）
      try {
        const vr = v.getBoundingClientRect();
        const rr2 = this.root.getBoundingClientRect();
        this.tlog(
          () =>
            "面板实测 video=" + Math.round(vr.top) + ".." + Math.round(vr.bottom) +
            " h=" + Math.round(vr.height) +
            " | root=" + Math.round(rr2.top) + ".." + Math.round(rr2.bottom) +
            " h=" + Math.round(rr2.height) +
            " | cssH=" + this._videoH + " cssW=" + this._videoW,
        );
      } catch (e) {
        /* ignore */
      }
      this._videoIndex = idx;
      if (this.root.classList) {
        // 先退出换源窗口并强制重排，保证淡入过渡真的从 0 开始跑
        this.root.classList.remove("is-video-swap");
        void this.root.offsetWidth;
        this.root.classList.add("is-trailer");
      }
      // 播片期间停掉图片阶段计时（进度条改由视频驱动）
      this.stopImagePhase();
      this.setBarVisible(true);
      // ★ 先尝试**带声音**播放。浏览器自动播放策略通常会拦（NotAllowedError），
      //   被拦后降级为静音播放，并挂一次性手势监听：用户第一次点击/按键就补上声音。
      try {
        const vol = this.trailerVolume();
        // 默认有声：只有用户手动静音过才沿用静音。
        // 这里显式写 false（而不是依赖上一个视频留下的状态）。
        const wantMuted = this.userMuted === true;
        v.muted = wantMuted;
        v.volume = wantMuted ? 0 : vol;
        this.syncMuteButton();
        if (v.muted) {
          this.tlog(() => "playTrailer(): 沿用用户静音设置");
          const pm = v.play();
          if (pm && typeof pm.then === "function") {
            pm.then(() => this.tlog(() => "playTrailer(): 已静音播放（用户设置）"))
              .catch(() => this.stopTrailer("play-rejected"));
          }
          return;
        }
        const p = v.play();
        if (p && typeof p.then === "function") {
          p.then(() => this.tlog(() => "playTrailer(): play() 成功（有声，音量 " + vol + "）"))
            .catch((err) => {
              const name = err && err.name;
              const g = globalObj();
              const ua = g && g.navigator && g.navigator.userActivation;
              const activated = !!(ua && ua.hasBeenActive);
              this.tlog(
                () =>
                  "playTrailer(): 有声播放被拒（" + name + "）hasBeenActive=" + activated +
                  " → " + (activated ? "300ms 后重试" : "降级静音 + 等手势"),
              );
              if (!activated) {
                this.playMutedAndArmUnmute(v, vol);
                return;
              }
              // 用户已经交互过（站内点过任何地方）⇒ 有些情况下这是瞬时拒绝，重试一次通常就能有声。
              // 仍失败才降级，避免白白静音。
              this.setTimer(
                "trailer-audio-retry",
                () => {
                  if (this._videoIndex !== idx || !v || v !== this.videoEl) return;
                  try {
                    v.muted = false;
                    v.volume = vol;
                    const p3 = v.play();
                    if (p3 && typeof p3.then === "function") {
                      p3.then(() => {
                        this.syncMuteButton();
                        this.tlog(() => "playTrailer(): 重试成功，已开启声音");
                      }).catch(() => {
                        this.tlog(() => "playTrailer(): 重试仍被拒 → 降级静音 + 等手势");
                        this.playMutedAndArmUnmute(v, vol);
                      });
                    }
                  } catch (e) {
                    this.playMutedAndArmUnmute(v, vol);
                  }
                },
                300,
              );
            });
        }
      } catch (e) {
        this.stopTrailer("play-threw");
      }
    };
    try {
      v.addEventListener("loadeddata", commit, { once: true });
      v.addEventListener("error", () => {
        const err = v.error || {};
        this.tlog(() => "playTrailer(): video error code=" + (err.code || "?") + " msg=" + (err.message || ""));
        if (!settled) {
          settled = true;
          this.stopTrailer("video-error");
          // 自动重试一次：偶发的网络中断/解码器拒绝，重挂通常就好了
          if (!retried) {
            this._retried[retryKey] = true;
            this.tlog(() => "playTrailer(): 重试一次 " + retryKey);
            this.setTimer(
              "trailer-retry",
              () => {
                if (this.activePoolIndex() !== idx) return;
                this.playTrailer(idx, trailerId);
              },
              350,
            );
          }
        }
      });
      v.addEventListener("stalled", () => this.tlog(() => "playTrailer(): stalled（网络卡住）"));
      v.addEventListener(
        "loadedmetadata",
        () => {
          const w0 = v.videoWidth || 0;
          const h0 = v.videoHeight || 0;
          if (w0 > 0 && h0 > 0) {
            const ar = w0 / h0;
            // 夹在 1.0–2.6：竖屏/异常比例不做成一条细缝，也不做成一堵墙
            this._videoAspect = Math.max(1.0, Math.min(2.6, ar));
            this.tlog(
              () =>
                "playTrailer(): 视频比例 " + ar.toFixed(2) +
                (ar !== this._videoAspect ? " → 夹到 " + this._videoAspect.toFixed(2) : "") +
                "（面板宽高由布局决定，不跟视频比例走）",
            );
            try {
              this.layoutVideo(this.root.clientHeight, this.root.clientWidth);
            } catch (e) {
              /* ignore */
            }
          }
        },
        { once: true },
      );
    } catch (e) {
      /* ignore：极老内核不支持 options 时下面照样能播 */
    }
    // 初始静音只是"安全默认"：commit 时会先尝试有声（见 playTrailer），
    // 被自动播放策略拦下才降级静音，并在用户第一次手势时补上声音。
    v.muted = true;
    try {
      v.volume = 0;
      v.src = url;
      // 显式 kick 一次加载（部分内核 preload 变更后不会自动开始）
      if (typeof v.load === "function") v.load();
    } catch (e) {
      this.stopTrailer("src-failed");
      return;
    }
    // 已经缓存过、首帧就绪 ⇒ 不必等事件
    if (typeof v.readyState === "number" && v.readyState >= 2) {
      this.tlog(() => "playTrailer(): readyState=" + v.readyState + " 已就绪 → 直接提交");
      commit();
      return;
    }
    this.setTimer(
      "trailer-ready",
      () => {
        if (settled) return;
        settled = true;
        this.tlog(() => "playTrailer(): 12s 内没解出首帧（readyState=" + v.readyState + "）");
        this.stopTrailer("ready-timeout");
        if (!retried) {
          this._retried[retryKey] = true;
          this.tlog(() => "playTrailer(): 超时后重试一次 " + retryKey);
          this.setTimer(
            "trailer-retry",
            () => {
              if (this.activePoolIndex() !== idx) return;
              this.playTrailer(idx, trailerId);
            },
            350,
          );
        }
      },
      TRAILER_READY_TIMEOUT_MS,
    );
  }


  /**
   * 声音渐隐后再暂停。
   * 场景：窗口被拖窄到放不下面板 —— 画面有 CSS 淡出，声音却会瞬间消失，
   * 听觉上比视觉突兀得多。这里让音量在 450ms 内线性降到 0，再 pause。
   * @returns {boolean} true 表示已接管暂停
   */
  fadeOutAudio() {
    const v = this.videoEl;
    if (!v || v.paused) return false;
    const win = getWin() || {};
    const clock = win.performance && win.performance.now ? win.performance : null;
    const now = () => (clock ? clock.now() : Date.now());
    const t0 = now();
    const from = typeof v.volume === "number" ? v.volume : 1;
    let steps = 0;
    const step = () => {
      steps++;
      const k = Math.min(1, (now() - t0) / 450);
      try {
        v.volume = Math.max(0, from * (1 - k));
      } catch (e) {
        /* ignore */
      }
      if (k < 1 && steps < 120) {
        if (win.requestAnimationFrame) win.requestAnimationFrame(step);
        else this.setTimer("trailer-fade", step, 30);
      } else {
        try {
          v.pause();
        } catch (e) {
          /* ignore */
        }
      }
    };
    step();
    return true;
  }

  /**
   * 可见性自愈：**正在播放且面板有尺寸**时，必须同时满足
   *   · 没有 is-video-swap（否则 opacity:0 ⇒ 有声音没画面）
   *   · 有 is-trailer（否则面板不显示）
   * 播放期间每帧调用一次（只是几次 classList.contains，成本可忽略），
   * 目的是把"偶发漏加/漏删类"在 1 帧内修回来，而不是靠调用顺序保证。
   */
  syncVideoVisibility() {
    const cls = this.root && this.root.classList;
    if (!cls) return;
    const shouldShow = this._videoIndex >= 0 && this._videoW > 0;
    if (!shouldShow) return;
    if (cls.contains("is-video-swap")) {
      cls.remove("is-video-swap");
      this.tlog(() => "自愈：清掉残留的 is-video-swap（视频重新可见）");
    }
    if (!cls.contains("is-trailer")) {
      cls.add("is-trailer");
      this.tlog(() => "自愈：补上缺失的 is-trailer");
    }
  }

  /** 逐帧驱动进度条：timeupdate 只有 ~4Hz，配合 CSS 过渡仍有台阶感。 */
  startBarLoop(v) {
    this.stopBarLoop();
    const w = getWin();
    if (!w || typeof w.requestAnimationFrame !== "function") return;
    const tick = () => {
      if (!this.videoEl || this.videoEl !== v || this._videoIndex < 0 || v.paused) return;
      this.syncVideoVisibility();
      this.syncVideoBar(v);
      this._barRaf = w.requestAnimationFrame(tick);
    };
    this._barRaf = w.requestAnimationFrame(tick);
  }

  /** 停掉逐帧驱动。 */
  stopBarLoop() {
    const w = getWin();
    if (this._barRaf && w && typeof w.cancelAnimationFrame === "function") {
      try {
        w.cancelAnimationFrame(this._barRaf);
      } catch (e) {
        /* ignore */
      }
    }
    this._barRaf = 0;
  }

  /** 同步视频进度条（低饱和、细条；播完归零由 stopTrailer 负责）。 */
  syncVideoBar(v) {
    const fill = this.videoBarFill;
    const d = typeof v.duration === "number" && isFinite(v.duration) ? v.duration : 0;
    if (fill && fill.style) {
      const pct = d > 0 ? Math.max(0, Math.min(1, v.currentTime / d)) * 100 : 0;
      fill.style.width = pct.toFixed(2) + "%";
    }

  }

  /** 毫秒时钟（诊断计时用）。 */
  nowMs() {
    try {
      const w = getWin();
      if (w && w.performance && typeof w.performance.now === "function") return w.performance.now();
    } catch (e) {
      /* ignore */
    }
    return Date.now();
  }

  /** 该条目是否可能有预告片（数量大于 0，或缓存在案）。 */
  itemHasTrailer(idx) {
    const item = this.pool && this.pool[idx];
    if (!item) return false;
    const cached = this._trailerIds[String(item.Id)];
    if (cached) return true;
    const cnt = item.LocalTrailerCount;
    return cnt === undefined || cnt === null ? true : Number(cnt) > 0;
  }

  /** 取预告片音量（设置项 TrailerVolume，0–1）。 */
  trailerVolume() {
    const v = this.settings && this.settings.TrailerVolume;
    const n = typeof v === "number" && isFinite(v) ? v : TRAILER_VOLUME;
    return Math.max(0, Math.min(1, n));
  }

  /**
   * 静音开关：用户手动切换后**记住选择**，后续预告片沿用。
   * 用户主动静音时，同时解除"首次手势自动补声"的监听（否则一动鼠标又响）。
   */
  toggleTrailerMute() {
    const v = this.videoEl;
    if (!v) return;
    const next = !v.muted;
    v.muted = next;
    this.userMuted = next;
    this.setHintOnMute(false); // 用户自己动了按钮 ⇒ 提示已完成使命
    if (next) {
      if (typeof this._unmuteHandler === "function") this._unmuteHandler();
      this.tlog(() => "静音按钮：用户静音");
    } else {
      try {
        v.volume = this.trailerVolume();
        if (v.paused && typeof v.play === "function") v.play().catch(() => {});
      } catch (e) {
        /* ignore */
      }
      this.tlog(() => "静音按钮：用户取消静音");
    }
    this.syncMuteButton();
  }

  /**
   * 静音按钮的"点击开启声音"提示态。
   * 触发条件：浏览器因自动播放策略拒绝有声播放（不是用户自己点的静音）。
   * 清除：用户点了按钮 / 收到手势补声 / 视频退场。
   * @param {boolean} on
   */
  setHintOnMute(on) {
    const b = this.muteBtn;
    if (!b || !b.classList) return;
    if (on) b.classList.add("is-hint");
    else b.classList.remove("is-hint");
  }

  /** 把当前 muted 状态同步到按钮（图标 + aria）。 */
  syncMuteButton() {
    const b = this.muteBtn;
    const v = this.videoEl;
    if (!b) return;
    const muted = !!(v && v.muted);
    if (b.classList) {
      if (muted) b.classList.add("is-muted");
      else b.classList.remove("is-muted");
    }
    try {
      b.setAttribute("aria-pressed", muted ? "true" : "false");
      b.setAttribute("aria-label", muted ? "取消静音" : "静音");
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * 有声播放被浏览器拦下时的降级：先静音播起来（至少画面在），
   * 再挂一次性手势监听——用户第一次点击/按键时把声音补上。
   */
  playMutedAndArmUnmute(v, vol) {
    v.muted = true;
    this.syncMuteButton();
    // 提示用户"点一下就有声音"：否则他们只会觉得"这插件没声音"
    this.setHintOnMute(true);
    try {
      const p2 = v.play();
      if (p2 && typeof p2.then === "function") {
        p2.then(() => this.tlog(() => "playTrailer(): 已静音播放")).catch(() => this.stopTrailer("play-rejected"));
      }
    } catch (e) {
      this.stopTrailer("play-threw");
      return;
    }
    const doc = getDoc();
    const w = getWin();
    const target = doc || w;
    if (!target || typeof target.addEventListener !== "function") return;
    const unmute = (ev) => {
      // 点在静音按钮上时交给按钮自己处理，避免"补声 + toggle"两次生效
      const t = ev && ev.target;
      if (t && this.muteBtn && typeof this.muteBtn.contains === "function" && this.muteBtn.contains(t)) return;
      disarm();
      const el = this.videoEl;
      if (!el || this._videoIndex < 0) return;
      try {
        el.muted = false;
        el.volume = vol;
        if (el.paused && typeof el.play === "function") el.play().catch(() => {});
        this.syncMuteButton();
        this.setHintOnMute(false);
        this.tlog(() => "playTrailer(): 收到用户手势 → 已补上声音");
      } catch (e) {
        /* ignore */
      }
    };
    const disarm = () => {
      try {
        target.removeEventListener("pointerdown", unmute, true);
        target.removeEventListener("keydown", unmute, true);
      } catch (e) {
        /* ignore */
      }
      this._unmuteHandler = null;
    };
    this._unmuteHandler = disarm;
    try {
      target.addEventListener("pointerdown", unmute, true);
      target.addEventListener("keydown", unmute, true);
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * 收回视频面板。`src` 延后清 —— 同帧销毁会让最后一帧闪黑。
   * @param {string} [reason] 仅用于调试
   */
  /**
   * @param {string} [reason] 仅用于日志
   * @param {boolean} [keepPaused] true = 不要立刻恢复自动翻页（"播完看一眼封面"那条路径用）
   */
  stopTrailer(reason, keepPaused) {
    this.clearTimer("trailer-start");
    this.clearTimer("trailer-ready");
    const cls = this.root && this.root.classList;
    const playing = this._videoIndex >= 0 || !!(cls && cls.contains("is-trailer"));
    if (!playing) {
      // ★ 没有东西可收时**绝不能**加 is-video-swap：
      //   它是 opacity:0 且无过渡，一旦留下，下一次预告片"有声音没画面"（真机偶发）。
      //   同时顺手清掉可能残留的该类（自愈）。
      if (cls) cls.remove("is-video-swap");
      this.stopBarLoop();
      this.resetPageBar();
      return;
    }
    // 退出**瞬时**：进入才淡入，退出一律同帧消失（is-video-swap = opacity 0 且无过渡）
    if (cls) cls.add("is-video-swap");
    this.stopBarLoop();
    this.resetPageBar();
    if (typeof this._unmuteHandler === "function") {
      try {
        this._unmuteHandler();
      } catch (e) {
        /* ignore */
      }
    }
    this.tlog(() => "stopTrailer(): " + (reason || ""));
    this._videoIndex = -1;
    this.setHintOnMute(false); // 视频退场：提示随之消失
    if (this.root && this.root.classList) this.root.classList.remove("is-trailer");
    // ★ 必须在这里恢复自动翻页：否则任何"非正常结束"（缩放、切条、被拦）
    //   都会让轮播停在暂停态，进度条卡住不动（真机 bug）。
    if (!keepPaused && this.swiper) {
      // 视频退场后回到图片阶段：重启这一条的计时/进度条（切条路径随后会再重启一次，无害）
      this.startImagePhase(this.activePoolIndex());
    }
    const v = this.videoEl;
    if (!v) return;
    // 切条（手动或自动）：0.2s 快速退场，避免大面积亮面板硬切
    // 窗口缩到放不下：声音渐隐后再停（画面那边有 CSS 淡出，声音不能瞬间消失）
    if (reason === "no-room" && this.fadeOutAudio()) {
      /* 已接管暂停 */
    } else {
      try {
        v.pause();
      } catch (e) {
        /* ignore */
      }
    }
    const srcAtStop = v.currentSrc || v.src || "";
    this.setTimer(
      "trailer-src-clear",
      () => {
        if (this._videoIndex >= 0) return;
        // 期间又挂了新源 ⇒ 不是这条的收尾，清掉会打断新视频的加载
        if (srcAtStop && (v.currentSrc || v.src) !== srcAtStop) return;
        try {
          v.removeAttribute("src");
          if (typeof v.load === "function") v.load();
        } catch (e) {
          /* ignore */
        }
      },
      TRAILER_FADE_MS,
    );
  }

  /**
   * 预告片播完：收回面板 → 短暂停留（看一眼封面）→ **直接翻到下一个**。
   * 为什么不是"恢复自动翻页"：那样会把 30 秒计时重新起算，等于播完还要再等 30 秒；
   * 预告片本身已经占用了这一条的展示时间。
   */
  onTrailerEnded() {
    this.stopTrailer("ended", true); // 先保持暂停，避免下面翻页时与自动播放打架
    this.setTimer(
      "trailer-resume",
      () => {
        const sw = this.swiper;
        const canAutoplay = !!(this.settings && Number(this.settings.ImageInterval) > 0);
        if (canAutoplay && sw) {
          this.dbg(() => "预告片播完 → 翻到下一个");
          this.goNext();
        }
      },
      700,
    );
  }

  // ---- 信息层（6.3） -------------------------------------------------

  /**
   * 两层节点交替交叉淡入。幂等：同一 idx 不重复淡入。
   * @param {number} idx 池下标
   */
  updateInfoLayer(idx) {
    if (this.shownInfoIndex === idx) return;
    const item = this.pool[idx];
    if (!item || this.infoNodes.length < 2) return;
    const visIdx = this.visibleNodeIndex;
    const incIdx = 1 - visIdx;
    const vis = this.infoNodes[visIdx];
    const inc = this.infoNodes[incIdx];
    this.fillInfoNode(inc, buildInfoModel(item, { base: this.serverBase }), item, {
      index: idx,
      total: this.pool.length,
    });
    // ★ 诊断（#3 DETAIL 错位）：记录"这次填充写进的是哪个 item"，与点击日志对照即可定位错位发生在哪一环。
    this.dbg(
      () =>
        "updateInfoLayer(): 填充 inc 节点[" +
        incIdx +
        "] idx=" +
        idx +
        " item=" +
        item.Id +
        "「" +
        (item.Name != null ? String(item.Name) : "") +
        "」",
    );
    // ★ 旧节点转为隐藏后必须停掉它的简介滚动：否则两个节点会同时滚（白费 rAF）
    if (vis) {
      this.stopOverviewScroll(vis);
      const oldTrack = vis.querySelector ? vis.querySelector(".hs-overview__track") : null;
      this.clearOverviewClone(oldTrack);
      if (oldTrack && oldTrack.style) oldTrack.style.transform = "";
    }
    if (vis && vis.classList) vis.classList.remove("is-active");
    if (inc && inc.classList) inc.classList.add("is-active");
    this.visibleNodeIndex = incIdx;
    this.shownInfoIndex = idx;
  }

  /**
   * 用模型填充一个信息层节点。结构固定为三段 + 位置刻度：
   *   ① .hs-title-slot  标题槽（Logo 或文字标题，槽高固定 ⇒ 相邻条目上下沿不动）
   *   ② .hs-middle      标语 → 元信息（评分胶囊 / 分级胶囊 / 年份 / 类型）→ 简介（吃剩余高度）
   *   ③ .hs-info__actions 按钮行（播放 = 主，详情 = 次）
   * ④ .hs-indicator     位置刻度（池里只有一条时不显示）
   * @param {HTMLElement} node 目标 .hs-info__inner
   * @param {object} model buildInfoModel 的产出
   * @param {object} item 原始条目（按钮闭包要用）
   * @param {{index:number,total:number}} [pos] 当前段与总数
   */
  fillInfoNode(node, model, item, pos) {
    clearNode(node);
    const self = this;

    // ① 标题槽
    const slot = el("div", "hs-title-slot");
    if (model.logoUrl) {
      const logo = el("img", "hs-logo");
      logo.setAttribute("src", model.logoUrl);
      logo.setAttribute("alt", model.title);
      logo.setAttribute("draggable", "false");
      slot.appendChild(logo);
    } else {
      const title = el("div", "hs-title-text");
      title.textContent = model.title;
      slot.appendChild(title);
    }
    node.appendChild(slot);

    // ② 中段：标语 → 元信息 → 简介
    const mid = el("div", "hs-middle");

    if (model.tagline) {
      const p = el("p", "hs-tagline");
      p.textContent = model.tagline;
      mid.appendChild(p);
    }

    // 元信息一行：评分 → 分级 → 年份 → 类型；前两类是胶囊，后两类是裸文字。
    const meta = el("div", "hs-info__meta");
    for (let i = 0; i < model.badges.length; i++) {
      const b = model.badges[i];
      const pill = el("span", "hs-pill hs-pill--rating");
      pill.setAttribute("data-kind", b.kind);
      pill.setAttribute("title", b.label);
      pill.setAttribute("aria-label", b.label + " " + b.value);
      const star = el("span", "hs-pill__star");
      star.setAttribute("aria-hidden", "true");
      star.textContent = "★";
      pill.appendChild(star);
      const val = el("span", "hs-pill__value");
      val.textContent = b.value;
      pill.appendChild(val);
      meta.appendChild(pill);
    }
    if (model.cert) {
      const c = el("span", "hs-pill hs-pill--cert");
      c.setAttribute("data-rating", model.cert); // 语义钩子，配色已统一，不再按档上色
      c.textContent = model.cert;
      meta.appendChild(c);
    }
    if (model.year) {
      const y = el("span", "hs-meta-plain");
      y.textContent = model.year;
      meta.appendChild(y);
    }
    for (let gi = 0; gi < model.genres.length; gi++) {
      const gEl = el("span", "hs-meta-plain");
      gEl.textContent = model.genres[gi];
      meta.appendChild(gEl);
    }
    if (model.genreExtra > 0) {
      const more = el("span", "hs-meta-plain");
      more.textContent = "+" + model.genreExtra;
      meta.appendChild(more);
    }
    if (meta.firstChild) mid.appendChild(meta);

    // 简介：固定起点 + 溢出截断；超长时由 startOverviewScroll 循环滚动
    if (model.overview) {
      const p = el("div", "hs-overview");
      const track = el("div", "hs-overview__track");
      const body = el("div", "hs-overview__body");
      p.appendChild(track);
      track.appendChild(body);
      // ★ 保留源数据里的换行：按空行/换行拆段，段间由 CSS 给 0.6em 间距。
      //   长文靠"段落断开"比靠行距更有效，也更像编辑过的文案。
      // 只在**空行**处分段；单个换行视作行内空格（否则一句话被拆成一行一段）
      const parts = String(model.overview)
        .split(/\r?\n\s*\r?\n/)
        .map((s) => s.replace(/\r?\n/g, " ").replace(/\s{2,}/g, " ").trim())
        .filter(Boolean);
      if (parts.length > 1) {
        for (let pi = 0; pi < parts.length; pi++) {
          const seg = el("div", "hs-overview__p");
          seg.textContent = parts[pi];
          body.appendChild(seg);
        }
      } else {
        body.textContent = model.overview;
      }
      mid.appendChild(p);
    }
    node.appendChild(mid);

    // PLAY / DETAIL
    const actions = el("div", "hs-info__actions");
    const play = el("button", "hs-btn hs-btn--play");
    play.setAttribute("type", "button");
    play.textContent = "播放";
    play.addEventListener("click", () => {
      self.dbg(() => "点击：PLAY");
      self.playItem(item);
    });
    const detail = el("button", "hs-btn hs-btn--detail");
    detail.setAttribute("type", "button");
    detail.textContent = "详情";
    detail.addEventListener("click", () => {
      // ★ 诊断（#3）：打出这个按钮闭包里实际捕获的 item——若与当前显示的标题不符，即为绑定错位。
      self.dbg(
        () =>
          "点击：DETAIL item=" +
          item.Id +
          "「" +
          (item.Name != null ? String(item.Name) : "") +
          "」",
      );
      self.openDetail(item);
    });
    actions.appendChild(play);
    actions.appendChild(detail);
    node.appendChild(actions);

    // ④ 位置刻度：池里只有一条时不显示（没有「第几条」这回事）
    const total = pos && typeof pos.total === "number" && pos.total > 0 ? pos.total : 0;
    const at = pos && typeof pos.index === "number" ? pos.index : 0;
    const ind = el("div", "hs-indicator");
    const fill = el("i", "hs-indicator__fill");
    if (total > 1) {
      if (ind.classList) ind.classList.add("is-on");
      if (fill.style) fill.style.width = Math.round(((at + 1) / total) * 100) + "%";
    }
    ind.appendChild(fill);
    node.appendChild(ind);
    // 布局完成后按可用高度决定简介是否显示
    const w = getWin();
    if (w && typeof w.requestAnimationFrame === "function") {
      w.requestAnimationFrame(() => this.fitInfoNode(node));
    } else {
      this.fitInfoNode(node);
    }
  }

  /**
   * 空间不足时的降级：**标语/元信息固定不动，简介先缩、再直接隐藏**。
   * 用实测高度判断（clientHeight 为 0 时说明还没布局，直接跳过——jsdom 下也不会误伤）。
   */
  fitInfoNodes() {
    const list = this.infoNodes || [];
    for (let i = 0; i < list.length; i++) this.fitInfoNode(list[i]);
  }

  /** 单个信息节点：可用高度 < 两行简介时，把简介整块隐藏。 */
  fitInfoNode(node) {
    if (!node || typeof node.querySelector !== "function") return;
    const mid = node.querySelector(".hs-middle");
    const ov = node.querySelector(".hs-overview");
    if (!mid || !ov) return;
    const avail = mid.clientHeight || 0;
    if (!avail) return; // 尚未布局（或测试环境）
    // 简介起点固定在 96px（评分 26 + 标语 42 + 间距 28），可用高度 = 中段高 − 96
    const room = avail - 96;
    let lineH = 28;
    try {
      const g = getWin();
      if (g && typeof g.getComputedStyle === "function") {
        const lh = parseFloat(g.getComputedStyle(ov).lineHeight);
        if (isFinite(lh) && lh > 0) lineH = lh;
      }
    } catch (e) {
      /* ignore */
    }
    if (room < lineH * 2) {
      if (ov.style.display !== "none") ov.style.display = "none";
      node.__hsOvSig = -1;
      this.stopOverviewScroll(node);
      const track0 = ov.querySelector(".hs-overview__track");
      this.clearOverviewClone(track0);
      return;
    }
    if (ov.style.display === "none") ov.style.display = "";
    this.startOverviewScroll(node);
  }

  /**
   * 简介溢出时**自动循环滚动**（提词器效果）：
   * 先静置 OVERVIEW_SCROLL_DELAY_MS（2.6s）让人读完开头，
   * 再以 12px/s 上滚；到底后留 2.5 行空白，副本首行从下方接上（无缝循环）。
   * 不溢出则清掉克隆并复位；减弱动效时不滚。
   */
  startOverviewScroll(node) {
    const ov = node && node.querySelector ? node.querySelector(".hs-overview") : null;
    if (!ov) return;
    const body = ov.querySelector(".hs-overview__body");
    if (!body) return;
    const w = getWin();
    if (!w || typeof w.requestAnimationFrame !== "function") return;
    const track = ov.querySelector(".hs-overview__track");
    if (!track) return;

    // ★ 用**内容签名**做幂等（长度 + 可视高），而不是实测正文高：
    //   实测高在字体/布局未就绪时会变，用它做签名会让"同一段内容"被反复重启或干脆不启。
    const sig = (body.textContent ? body.textContent.length : 0) + ":" + (ov.clientHeight || 0);
    // ★ 只把"真的在跑"当作幂等条件。之前把 __hsOvPending 也算进来，
    //   而 pending 的定时器会被 bumpEpoch() 的 clearAllTimers() 清掉却不复位 ⇒
    //   切走再切回时签名相同 + pending 恒真 ⇒ 永远不再启动（真机：第二次显示不滚）。
    if (node.__hsOvSig === sig && node.__hsScrollRaf) return;

    this.stopOverviewScroll(node);
    this.clearOverviewClone(track);
    track.style.transform = "";
    node.__hsOvSig = sig;
    node.__hsOvY = 0;

    // 立刻粗判：完全不溢出就不必等 2.6s
    const H0 = body.offsetHeight || 0;
    const C0 = ov.clientHeight || 0;
    if (!H0 || !C0 || H0 <= C0 + 8) {
      this.dbg(() => "简介滚动: 不溢出（H=" + Math.round(H0) + " C=" + Math.round(C0) + "）");
      node.__hsOvSig = -1;
      return;
    }

    // ★ 用节点自带的 setTimeout：走共享定时器表会被 bumpEpoch() 整表清掉，
    //   而那时 pending 已置真 ⇒ 该节点此后永久不启动。
    node.__hsOvPending = true;
    node.__hsOvTimer = w.setTimeout(() => {
      node.__hsOvTimer = 0;
      node.__hsOvPending = false;
      this.beginOverviewScroll(node, ov, body, track, w);
    }, OVERVIEW_SCROLL_DELAY_MS);
    this.dbg(() => "简介滚动: 溢出 " + Math.round(H0 - C0) + "px，" + OVERVIEW_SCROLL_DELAY_MS / 1000 + "s 后开始循环");
  }

  /** 延迟结束后**重新测量**再启动（布局/字体此时才稳定，避免用陈旧高度建克隆）。 */
  beginOverviewScroll(node, ov, body, track, w, tries) {
    if (!node || this._videoIndex === undefined) return;
    this.clearOverviewClone(track);
    const H = body.offsetHeight || 0;
    const C = ov.clientHeight || 0;
    if (!H || !C) {
      // 布局还没落定（隐藏→可见的瞬间可能量到 0）：别直接放弃，最多再等 10 帧。
      const n = (tries || 0) + 1;
      if (n <= 10) {
        node.__hsOvRaf = w.requestAnimationFrame(() => this.beginOverviewScroll(node, ov, body, track, w, n));
        return;
      }
      node.__hsOvSig = -1;
      return;
    }
    if (H <= C + 8) {
      node.__hsOvSig = -1;
      return;
    }
    let lineH = 28;
    try {
      const g = getWin();
      if (g && typeof g.getComputedStyle === "function") {
        const lh = parseFloat(g.getComputedStyle(body).lineHeight);
        if (isFinite(lh) && lh > 0) lineH = lh;
      }
    } catch (e) {
      /* ignore */
    }
    const gapPx = Math.max(24, Math.round(lineH * 2.5));
    const gap = el("div", "hs-overview__gap");
    gap.style.height = gapPx + "px";
    const clone = body.cloneNode(true);
    clone.className = "hs-overview__body hs-overview__clone";
    clone.setAttribute("aria-hidden", "true");
    track.appendChild(gap);
    track.appendChild(clone);

    const cycle = H + gapPx;
    const speed = 12; // px/s
    let y = 0;
    let last = 0;
    let started = false;
    const tick = (ts) => {
      if (!started) {
        last = ts;
        started = true;
        node.__hsScrollRaf = w.requestAnimationFrame(tick);
        return;
      }
      const dt = Math.min(0.1, (ts - last) / 1000);
      last = ts;
      y += speed * dt;
      if (y >= cycle) y -= cycle; // 无缝：副本与开头位置重合
      node.__hsOvY = y;
      // 按设备像素取整：小数位移会让文字每帧重新栅格化 ⇒ 滚动闪烁
      const dpr = w.devicePixelRatio || 1;
      track.style.transform = "translate3d(0," + Math.round(-y * dpr) / dpr + "px,0)";
      node.__hsScrollRaf = w.requestAnimationFrame(tick);
    };
    node.__hsScrollRaf = w.requestAnimationFrame(tick);
  }

  /** 清掉循环用的 gap / clone。 */
  clearOverviewClone(track) {
    if (!track || !track.querySelectorAll) return;
    const junk = track.querySelectorAll(".hs-overview__clone, .hs-overview__gap");
    for (let i = 0; i < junk.length; i++) {
      if (junk[i] && junk[i].parentNode) junk[i].parentNode.removeChild(junk[i]);
    }
  }

  /** 停掉所有信息节点的简介滚动（撤离 / 拆除轮播时用，防止 rAF 泄漏）。 */
  stopAllOverviewScrolls() {
    const list = this.infoNodes || [];
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (!n) continue;
      this.stopOverviewScroll(n);
      const track = n.querySelector ? n.querySelector(".hs-overview__track") : null;
      this.clearOverviewClone(track);
      if (track && track.style) track.style.transform = "";
    }
  }

  /** 停掉某节点的简介自动滚动（切条/重新布局时调用）。 */
  stopOverviewScroll(node) {
    if (!node) return;
    node.__hsOvPending = false;
    const w0 = getWin();
    if (node.__hsOvTimer && w0 && typeof w0.clearTimeout === "function") {
      try {
        w0.clearTimeout(node.__hsOvTimer);
      } catch (e) {
        /* ignore */
      }
    }
    node.__hsOvTimer = 0;
    const w = getWin();
    if (node.__hsScrollRaf && w && typeof w.cancelAnimationFrame === "function") {
      try {
        w.cancelAnimationFrame(node.__hsScrollRaf);
      } catch (e) {
        /* ignore */
      }
    }
    node.__hsScrollRaf = 0;
    node.__hsOvPending = false;
  }

  /**
   * **唯一建轮播入口**：mount 与设置变更都走这里。
   * 以前两条路径各抄一遍，导致每加一个功能都要改两处（漏一处就是静默 bug：
   * 例如改设置后预告片不起播、进度条卡住）。
   *
   * ⚠ 顺序有依赖：createSwiper → 铺图 → 文字 → autoplay
   *   → applyHeroHeight（写 --hs-video-w）→ 图片阶段计时 → scheduleTrailer。
   * @param {number} startIdx 起始池下标
   */
  async rebuildCarousel(startIdx) {
    // 异步回来后先复检根容器是否仍在宿主里（Emby 可能在取数期间重写了宿主）
    this.ensureRootAttached();

    this.buildCarousel();

    if (this.isPlaceholder()) {
      this.setPlaceholder();
      return;
    }

    const n = this.pool ? this.pool.length : 0;
    let start = typeof startIdx === "number" && startIdx > 0 ? startIdx : 0;
    if (!n || start >= n) start = 0;

    this.createSwiper(start);
    this.presetImages();
    // 从详情/播放器返回可能停在 >1 的位置：presetImages 只铺了 0/1，这里补当前页 + 邻域
    this.updateImageSlots(start);
    this.updateInfoLayer(start);
    // 预告片依赖面板尺寸：必须先量高（layoutVideo 写 --hs-video-w）
    this.applyHeroHeight();
    this.startImagePhase(start);
    this.scheduleTrailer(start);
  }

  /**
   * 取 Emby 路由器并回调（两段式）：
   * ① 4.7 客户端：`self.Emby.Page`（apploader.js 建 `self.Emby={}`，approuter.js 末尾挂上）；
   * ② 4.11 网页端：**没有** `self.Emby.Page`（实测 grep 零命中）⇒ 只能 AMD `require(["appRouter"])`。
   * 回调同步或异步都可能；返回 false 表示两条路都不可用（调用方自行兜底 hash）。
   */
  embyRouter(cb) {
    const g = globalObj();
    const p = g && g.Emby && g.Emby.Page;
    if (p && typeof p.showItem === "function") {
      cb(p);
      return true;
    }
    return this.amdRequire(["appRouter"], (m) => {
      const r = m && (m.default || m);
      if (r && typeof r.showItem === "function") cb(r);
    });
  }

  /** AMD 取模块：alameda 会挂全局 `require`/`requirejs`。成功提交返回 true（回调可能同步/异步）。 */
  amdRequire(names, cb) {
    const g = globalObj();
    const r =
      g && (typeof g.require === "function" ? g.require : typeof g.requirejs === "function" ? g.requirejs : null);
    if (!r) return false;
    try {
      r(names, cb);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 记录当前 serverId 的 URL 后缀（4.7 路由需要 `&serverId=`）。 */
  serverIdSuffix() {
    return this.serverId ? "&serverId=" + encodeURIComponent(String(this.serverId)) : "";
  }

  /** DETAIL：优先走 Emby 路由器 showItem（接受字符串 id）；否则回落 hash（带 serverId）。 */
  openDetail(item) {
    if (!item || item.Id === undefined) return;
    // ★ 先视觉收起自己（不拆 DOM）：库条/轮播立即消失（不等 150ms 复检），且原生首页不会闪现。
    this.hideForNavigation();
    this.dbg(
      () => "点击：DETAIL item=" + item.Id + "「" + (item.Name != null ? String(item.Name) : "") + "」",
    );
    // 路由器两段式（4.7 = Emby.Page / 4.11 = AMD appRouter），失败才落 hash（带 serverId）。
    const go = (r) => {
      if (r && typeof r.showItem === "function") {
        try {
          r.showItem(item.Id);
          this.dbg(() => "openDetail(): showItem(" + item.Id + ") 已调用");
          return;
        } catch (e) {
          this.dbg(() => "openDetail(): showItem 抛错 → hash 兜底");
        }
      } else {
        this.dbg(() => "openDetail(): 无路由器可用 → hash 兜底");
      }
      this.navigateHash("!/item?id=" + encodeURIComponent(String(item.Id)) + this.serverIdSuffix());
    };
    if (!this.embyRouter(go)) go(null);
  }

  /**
   * PLAY：按序尝试 playbackManager（带续播位置），全部失败才回落详情页。
   * ① AMD `require(["playbackManager"])`（真机两端都靠它）→ ② 动态 import → ③ 全局 → ④ 详情页。
   */
  playItem(item) {
    if (!item || item.Id === undefined) return;
    // ★ PLAY **不做**视觉收起（与 DETAIL/库条不同）：
    //   Emby Theater 起播时会把 WebView 变透明让原生视频层透出来，视频第一帧接上之前透出的是桌面；
    //   此时任何"藏起我们这层"（visibility/teardown 都一样）只会**扩大透出桌面的面积**。
    //   保持轮播这层不透明地盖着，直到视频面接手，把透明洞压到最小。
    // ① AMD（alameda 挂全局 require/requirejs）；回调可能同步
    const amdAccepted = this.amdRequire(["playbackManager"], (pm) => {
      if (!this.tryPlayModule(pm, item)) this.playViaFallback(item);
    });
    if (amdAccepted) return; // 已交给 AMD 链（同步回调已起播，或稍后回调）
    this.playViaFallback(item);
  }

  /** 播放器回落链：② 动态 import → ③ 全局 playbackManager → ④ 详情页。 */
  playViaFallback(item) {
    let p;
    try {
      p = loadPlaybackManager();
    } catch (e) {
      p = Promise.resolve(null);
    }
    Promise.resolve(p)
      .catch(() => null)
      .then((pm) => {
        if (this.tryPlayModule(pm, item)) return;
        const g = globalObj();
        if (this.tryPlayModule(g && g.playbackManager, item)) return;
        this.dbg(() => "playItem(): 播放器不可用 → 回落详情页（这不是期望行为，请上报）");
        this.openDetail(item);
      });
  }

  /**
   * 导航/起播离开始发时，先**视觉收起**自己（隐藏，但不拆 DOM）：
   * - 立即隐藏轮播与库条（不等 150ms 复检）⇒ 消除「库条退出有延迟」；
   * - **不移除 `body.hs-home`、不删根容器** ⇒ 我们注入的 CSS 继续生效，原生首页不会闪现；
   * - 真正的 teardown 仍由视图事件（isHome=false → 复检）负责；回到首页时由 `mount()` 摘掉本标记。
   * 真机教训：若在这里直接 `teardown()`，`hs-home` 一摘、CSS 一失效，而 `showItem()` 内部还要异步
   * 取一次条目才路由 ⇒ 这一瞬间会闪出原生首页（用户实测「闪一瞬间媒体库页面」）。
   */
  /** 记住「当前正在看哪一条」：从详情页返回时据此恢复，而不是从第一条重来。 */
  rememberResume() {
    try {
      const idx =
        this.swiper && typeof this.swiper.activeIndex === "number" ? this.swiper.activeIndex : this.activePoolIndex();
      const it = this.pool && this.pool[idx];
      if (it && it.Id) this._resumeId = it.Id;
    } catch (e) {
      /* ignore */
    }
  }

  hideForNavigation() {
    this.rememberResume();
    // 沉浸底色必须跟手摘掉：否则进设置页后 body.hs-home 还在（设计如此），背景会一起变暗。
    try {
      const d = getDoc();
      if (d && d.body && d.body.classList) d.body.classList.remove("hs-immersive");
    } catch (e) {
      /* ignore */
    }
    if (!this.mounted) return;
    const doc = getDoc();
    if (doc && doc.body && doc.body.classList && typeof doc.body.classList.add === "function") {
      doc.body.classList.add("hs-leaving");
    }
    this.dbg(() => "hideForNavigation(): 视觉收起轮播/库条（DOM 保留，teardown 仍由视图事件负责）");
  }

  /** 尝试用模块起播（`pm.default || pm` 上找 play）；成功 true。返回 promise 则吞掉其 rejection。 */
  tryPlayModule(pm, item) {
    if (!pm) return false;
    const player = pm.default || pm;
    if (!player || typeof player.play !== "function") return false;
    try {
      const ret = player.play({ items: [item] });
      if (ret && typeof ret.catch === "function") ret.catch(() => {});
    } catch (e) {
      return false;
    }
    return true;
  }

  /** 写 location.hash（Emby 路由）。 */
  navigateHash(hash) {
    const w = getWin();
    if (w && w.location && typeof w.location === "object") {
      try {
        w.location.hash = hash;
      } catch (e) {
        /* ignore */
      }
    }
  }

  // ---- 自建懒加载 + 图片档位（6.3 / 6.9） ----------------------------

  /** 当前图片档位（离散）。 */
  imageTier() {
    return chooseImageTier(this.containerWidth(), this.dpr());
  }

  /** 容器渲染宽度（回落 innerWidth）。 */
  containerWidth() {
    if (this.root && typeof this.root.clientWidth === "number" && this.root.clientWidth > 0) {
      return this.root.clientWidth;
    }
    const w = getWin();
    if (w && typeof w.innerWidth === "number") return w.innerWidth;
    return 1280;
  }

  /** 设备像素比。 */
  dpr() {
    const w = getWin();
    if (w && typeof w.devicePixelRatio === "number" && w.devicePixelRatio > 0) return w.devicePixelRatio;
    return 1;
  }

  /** 某条目当前应加载的图片 URL（横竖屏 + 档位）。 */
  imageUrlFor(item) {
    const spec = pickImageSource(item, this.isPortrait());
    if (!spec) return "";
    return buildImageUrl(
      this.serverBase,
      Object.assign({}, spec, { maxWidth: this.imageTier(), quality: IMAGE_QUALITY }),
    );
  }

  /** 首屏预置前 2 张（Swiper 初始化后还会补当前页，见 mount）。 */
  presetImages() {
    this.assignSlideImage(0);
    this.assignSlideImage(1);
  }

  /** 补当前页（立即）+ 防抖补 ±1 窗口。 */
  updateImageSlots(idx) {
    this.assignSlideImage(idx);
    this.scheduleImageWindow(idx);
  }

  /** 200ms 防抖后补 [i-1,i,i+1]（翻动中只补当前页、不做 ±1）。 */
  scheduleImageWindow(idx) {
    this.setTimer("image-window", () => this.assignImageWindow(idx), IMAGE_DEBOUNCE_MS);
  }

  /** 给 [i-1,i,i+1] 三槽赋 src（rewind 环绕；已赋过不重复）。 */
  assignImageWindow(idx) {
    const n = this.pool.length;
    if (!n) return;
    const windowIndices = [wrapIndex(idx - 1, n), idx, wrapIndex(idx + 1, n)];
    const seen = {};
    for (let k = 0; k < windowIndices.length; k++) {
      const j = windowIndices[k];
      if (seen[j]) continue;
      seen[j] = true;
      this.assignSlideImage(j);
    }
  }

  /** 给单个 slide 赋 src（已赋过不重复）。 */
  assignSlideImage(i) {
    if (i < 0 || i >= this.pool.length) return;
    const img = this.imgEls[i];
    if (!img || typeof img.getAttribute !== "function") return;
    if (img.getAttribute("src")) return; // 已赋过不重复
    const ds = img.getAttribute("data-src");
    if (!ds) return;
    img.setAttribute("src", ds);
  }

  // ---- 进度条（6.4） -------------------------------------------------

  /**
   * 图片阶段自己计时：驱动进度条；到点前若 Swiper 的 autoplay 没翻页，兜底推进一格。
   * 为什么不用 Swiper 的 autoplayTimeLeft：切页 speed=0 收不到 transitionend，
   * 它的内部计时链会断，表现为「第二张起进度条完全不动」。
   * @param {number} idx 当前池下标
   */
  startImagePhase(idx) {
    this.stopImagePhase();
    this._phaseIdx = idx;
    // 诊断/测试用：本次启动计数（环境没有 rAF 时 _phaseIdx 会被复位，靠它判断"有没有启动过"）
    this._phaseStarts = (this._phaseStarts || 0) + 1;
    const total =
      this.settings && typeof this.settings.ImageInterval === "number" ? this.settings.ImageInterval : 0;
    if (!total || total <= 0 || this.prefersReducedMotion()) {
      this._phaseIdx = -1;
      this.setBarVisible(false);
      return;
    }
    this.setBarVisible(true);
    this.resetPageBar();
    const w = getWin();
    if (!w || typeof w.requestAnimationFrame !== "function") {
      this._phaseIdx = -1;
      return;
    }

    // ★ 单一时间源：不再有 Swiper 的 autoplay 并存（它收不到 transitionend 就不续命，
    //   留着只会造成"双翻页"和"翻页忽快忽慢"）。这里到 100% 直接翻页。
    let startMs = this.nowMs();
    let pausedAt = 0;

    // 切后台要暂停：否则回到前台时 elapsed 早已超时，会立刻翻页（Swiper 的 autoplay 原本自带这个）。
    const doc = getDoc();
    if (doc && typeof doc.addEventListener === "function") {
      this._phaseVisHandler = () => {
        if (doc.hidden) {
          if (!pausedAt) pausedAt = this.nowMs();
        } else if (pausedAt) {
          startMs += this.nowMs() - pausedAt; // 把暂停时长补回去
          pausedAt = 0;
        }
      };
      doc.addEventListener("visibilitychange", this._phaseVisHandler);
    }

    const tick = () => {
      if (!this.swiper || this.activePoolIndex() !== idx) return; // 已切走
      if (this._videoIndex >= 0) return; // 视频接管进度条
      if (pausedAt) {
        this._phaseRaf = w.requestAnimationFrame(tick);
        return;
      }
      const p = Math.min(1, (this.nowMs() - startMs) / total);
      this.setPageBar(p);
      if (p >= 1) {
        this.goNext();
        return;
      }
      this._phaseRaf = w.requestAnimationFrame(tick);
    };
    this._phaseRaf = w.requestAnimationFrame(tick);
  }

  /** 停掉图片阶段计时（切到视频 / 撤离 / 停用自动翻页时）。 */
  stopImagePhase() {
    this.clearTimer("image-advance");
    const doc = getDoc();
    if (this._phaseVisHandler && doc && typeof doc.removeEventListener === "function") {
      try {
        doc.removeEventListener("visibilitychange", this._phaseVisHandler);
      } catch (e) {
        /* ignore */
      }
    }
    this._phaseVisHandler = null;
    const w = getWin();
    if (this._phaseRaf && w && typeof w.cancelAnimationFrame === "function") {
      try {
        w.cancelAnimationFrame(this._phaseRaf);
      } catch (e) {
        /* ignore */
      }
    }
    this._phaseRaf = 0;
    this._phaseIdx = -1;
  }

  /**
   * 瞬时归零：临时关掉 width 的过渡。否则会从 100% 倒着走 0.3s，
   * 而新一页的计时已经开始 ⇒ 看起来起点不是 0（真机反馈）。
   */
  resetPageBar() {
    const fill = this.videoBarFill;
    if (!fill || !fill.style) return;
    fill.style.transition = "none";
    fill.style.width = "0%";
    try {
      void fill.offsetWidth; // 强制应用，避免被合并成一次样式计算
    } catch (e) {
      /* ignore */
    }
    fill.style.transition = "";
  }

  /** 写进度条（0–1）。两个驱动源（图片阶段计时 / video）都走这里。 */
  setPageBar(p01) {
    const fill = this.videoBarFill;
    if (!fill || !fill.style) return;
    const v = Math.max(0, Math.min(1, typeof p01 === "number" && isFinite(p01) ? p01 : 0));
    fill.style.width = (v * 100).toFixed(2) + "%";
  }

  /** 显示/隐藏整条进度条（图片阶段的倒计时也需要它）。 */
  setBarVisible(on) {
    if (!this.root || !this.root.classList) return;
    if (on) this.root.classList.add("is-bar");
    else this.root.classList.remove("is-bar");
  }


  // ---- 占位（九章） ---------------------------------------------------


  /**
   * 进入占位态（底图留空、信息层只显示一行占位文案；PLAY/DETAIL/进度条/箭头由 CSS 隐藏）。
   * @param {string} [text]
   */
  setPlaceholder(text) {
    this.placeholder = true;
    if (this.root && this.root.classList) this.root.classList.add("is-placeholder");
    this.stopImagePhase();
    if (this.placeholderEl) {
      const res = this.poolResult || {};
      this.placeholderEl.textContent =
        text || (res.source === "none" ? "加载失败，可重试" : "暂无可展示的内容");
    }
  }

  // ---- 定时器登记表 / epoch 令牌（6.10） -----------------------------

  /** 注册一个定时器（同 key 覆盖）。 */
  setTimer(key, fn, ms) {
    this.clearTimer(key);
    const env = this.getEnv();
    const st = env.setTimeout || (typeof setTimeout !== "undefined" ? setTimeout : null);
    if (!st) return null;
    const id = st(() => {
      this.timers.delete(key);
      try {
        fn();
      } catch (e) {
        this.warn(e);
      }
    }, ms);
    this.timers.set(key, id);
    return id;
  }

  /** 清除单个定时器。 */
  clearTimer(key) {
    const id = this.timers.get(key);
    if (id === undefined) return;
    const env = this.getEnv();
    const ct = env.clearTimeout || (typeof clearTimeout !== "undefined" ? clearTimeout : null);
    if (ct) {
      try {
        ct(id);
      } catch (e) {
        /* ignore */
      }
    }
    this.timers.delete(key);
  }

  /** 清空所有定时器。 */
  clearAllTimers() {
    const keys = Array.from(this.timers.keys());
    for (let i = 0; i < keys.length; i++) this.clearTimer(keys[i]);
  }

  /** epoch++ 并 abort 在飞请求 + 清全部定时器。 */
  bumpEpoch() {
    this.epoch += 1;
    if (this.abortController) {
      try {
        this.abortController.abort();
      } catch (e) {
        /* ignore */
      }
    }
    const AC = getAbortController();
    this.abortController = AC ? new AC() : null;
    this.clearAllTimers();
    return this.epoch;
  }

  // ---- 自愈观察器（6.1） ---------------------------------------------

  /** 观察持久容器自身（childList + subtree:false）；绝不 observe document.body。幂等：重调不会留下第二个观察器。 */
  setupObservers() {
    const MO = getMutationObserver();
    if (!MO || !this.mountContainer || typeof this.mountContainer.appendChild !== "function") return;
    // ★ 已存在先断开并置空：搬迁路径（moveRootTo）会重调本方法，否则会留下观察旧宿主的僵尸观察器
    if (this.observer) {
      try {
        if (typeof this.observer.disconnect === "function") this.observer.disconnect();
      } catch (e) {
        /* ignore */
      }
      this.observer = null;
    }
    this.retries = 0;
    this.observer = new MO(() => this.onObserve());
    if (typeof this.observer.observe === "function") {
      // 只观察容器自身（subtree:false）；额外监听自身 class 变化（hide/page-hidden 增删）作为"回得来"兜底
      this.observer.observe(this.mountContainer, {
        childList: true,
        subtree: false,
        attributes: true,
        attributeFilter: ["class"],
      });
    }
  }

  /** 观察回调：只做幂等存在性检查（节点在 → 归零；不在 → 重挂）。 */
  onObserve() {
    if (!this.mounted) return;
    // 顶栏行几何可能随字号/布局变化，跟着 mutation 复量
    this.measureLibBarGeometry();
    // ★ 挂载那一刻滚动容器可能还没渲染 ⇒ 量到 0 并被缓存（真机症状：垫层宽度 0，缝一直在）。
    //   每次 mutation 重量一次很便宜（值没变时 setProperty 都不会调用）。
    this.syncScrollbarWidth();
    this.ensureGutterStrip();
    // ★ 分区是 Emby **后渲染**的：挂载那一刻量不到"下一行"，peek 会停在最小值（真机：客户端露出不够）。
    //   每次 mutation 都 rAF 节流重量一次，分区一出现就能把整行露出来。
    this.scheduleHeroHeight();
    // 先按当前结构重新解析并归位（网页端真宿主可能在 .view 内部更深的位置）
    try {
      this.ensureRootAttached();
    } catch (e) {
      this.warn(e);
    }
    const container = this.mountContainer;
    const present = !!(container && this.root && this.root.parentNode === container);
    if (present) {
      this.retries = 0;
      return;
    }
    this.retries = (this.retries || 0) + 1;
    if (this.retries > MAX_RETRIES) {
      this.disconnectObservers();
      warnOnce("自愈重挂超限（>" + MAX_RETRIES + "），已停止观察");
      return;
    }
    if (container && this.root && typeof container.insertBefore === "function") {
      container.insertBefore(this.root, container.firstChild);
      this.retries = 0; // ★ 重插后归零：避免 Emby 一次性多次 mutation 白吃上限
      this.dbg(() => "onObserve(): 根容器被抹掉 → 已重插");
      this.attachLibBarScroll();
    }
  }

  /** 断开自愈观察器（根容器 + 库条 + 抽屉，统一管理）。 */
  disconnectObservers() {
    if (this.observer) {
      try {
        if (typeof this.observer.disconnect === "function") this.observer.disconnect();
      } catch (e) {
        /* ignore */
      }
      this.observer = null;
    }
    if (this.libBarObserver) {
      try {
        if (typeof this.libBarObserver.disconnect === "function") this.libBarObserver.disconnect();
      } catch (e) {
        /* ignore */
      }
      this.libBarObserver = null;
    }
    // ★ 抽屉观察器**不断开**：设置入口是全局资源（要在设置页 #!/dashboard 的左侧栏存活），
    //   撤离首页后它还得继续自愈。它与 libBar/root 观察器不同，不属于挂载态。
  }

  // ---- 方向翻转（6.9） -----------------------------------------------

  /** 用 matchMedia('(orientation: portrait)') 监听（不注册 window.resize）。 */
  setupOrientation() {
    const w = getWin();
    if (!w || typeof w.matchMedia !== "function") return;
    try {
      this.mqlPortrait = w.matchMedia("(orientation: portrait)");
    } catch (e) {
      this.mqlPortrait = null;
      return;
    }
    const handler = () => {
      this.setTimer("orientation", () => this.applyOrientation(), ORIENTATION_DEBOUNCE_MS);
    };
    this._orientationHandler = handler;
    if (this.mqlPortrait && typeof this.mqlPortrait.addEventListener === "function") {
      this.mqlPortrait.addEventListener("change", handler);
    } else if (this.mqlPortrait && typeof this.mqlPortrait.addListener === "function") {
      this.mqlPortrait.addListener(handler);
    }
  }

  /** 方向翻转（300ms 防抖）：只改未渲染槽位；已渲染的同步更新 src。 */
  applyOrientation() {
    if (this.shouldDeferImageSwap()) return;
    for (let i = 0; i < this.pool.length; i++) {
      const img = this.imgEls[i];
      if (!img || typeof img.setAttribute !== "function") continue;
      const url = this.imageUrlFor(this.pool[i]);
      img.setAttribute("data-src", url);
      if (img.getAttribute("src")) img.setAttribute("src", url); // 同步当前 src，避免"换了 data-src 页面还是旧图"
    }
  }

  /** 是否推迟换图（S4 恒 false；S5 改为"有预告片在播则 true"）。 */
  shouldDeferImageSwap() {
    return false;
  }

  /** 是否竖屏。 */
  isPortrait() {
    if (this.mqlPortrait && typeof this.mqlPortrait.matches === "boolean") {
      return this.mqlPortrait.matches;
    }
    const w = getWin();
    if (w && typeof w.innerWidth === "number" && typeof w.innerHeight === "number") {
      return w.innerWidth < w.innerHeight;
    }
    return false;
  }

  /** 断开方向监听。 */
  disconnectOrientation() {
    if (!this.mqlPortrait) return;
    try {
      if (typeof this.mqlPortrait.removeEventListener === "function") {
        this.mqlPortrait.removeEventListener("change", this._orientationHandler);
      } else if (typeof this.mqlPortrait.removeListener === "function") {
        this.mqlPortrait.removeListener(this._orientationHandler);
      }
    } catch (e) {
      /* ignore */
    }
    this.mqlPortrait = null;
    this._orientationHandler = null;
  }

  /** prefers-reduced-motion: reduce。 */
  prefersReducedMotion() {
    const w = getWin();
    try {
      if (w && typeof w.matchMedia === "function") {
        const m = w.matchMedia("(prefers-reduced-motion: reduce)");
        return !!(m && m.matches);
      }
    } catch (e) {
      /* ignore */
    }
    return false;
  }

  // ---- 撤离（6.1） ---------------------------------------------------

  /** 移除视频元素（S5 才有元素；方法先写全，保证撤离契约完整）。 */
  removeVideoElement() {
    if (!this.root || typeof this.root.querySelector !== "function") return;
    const v = this.root.querySelector(".hs-video");
    if (v) {
      try {
        if (typeof v.pause === "function") v.pause();
      } catch (e) {
        /* ignore */
      }
      try {
        if (typeof v.removeAttribute === "function") v.removeAttribute("src");
      } catch (e) {
        /* ignore */
      }
      try {
        if (typeof v.load === "function") v.load();
      } catch (e) {
        /* ignore */
      }
      if (v.parentNode && typeof v.parentNode.removeChild === "function") v.parentNode.removeChild(v);
    }
    const seam = this.root.querySelector(".hs-video-seam");
    if (seam && seam.parentNode && typeof seam.parentNode.removeChild === "function") {
      seam.parentNode.removeChild(seam);
    }
    this.videoEl = null;
    this._videoIndex = -1;
    this._videoW = 0;
    this._videoH = 0;
  }

  /**
   * 撤离首页：整块拆掉挂载态资源；**保留**全局资源（viewbeforeshow 监听 / 已注入 <style> / bootstrap 守卫）。
   * 否则插件再也回不到首页。
   */
  teardown() {
    this.rememberResume();
    this.dbg(() => "teardown(): 拆卸挂载态资源（保留 viewbeforeshow/pagebeforeshow/viewshow 监听）");
    this.clearAllTimers();
    this.teardownResizeWatch();
    // 视频层先收：暂停 + 摘类（元素随后由 removeVideoElement 整体移除）
    this.stopImagePhase();
    this.stopAllOverviewScrolls(); // 否则 rAF 会跟着已移除的节点一直跑
    this.stopTrailer("teardown");
    this.clearTimer("trailer-src-clear");    // 旧版会在设置页侧栏插入口；现在只保留顶栏按钮 ⇒ 兜底清掉可能残留的节点
    try {
      const doc = getDoc();
      const stale = doc && doc.querySelectorAll ? doc.querySelectorAll(".hs-settings-entry") : null;
      if (stale) for (let i = 0; i < stale.length; i++) {
        const n = stale[i];
        if (n.parentNode) n.parentNode.removeChild(n);
      }
    } catch (e) {
      /* ignore */
    }
    this.removeGutterStrip();
    this.epoch += 1;
    if (this.abortController) {
      try {
        this.abortController.abort();
      } catch (e) {
        /* ignore */
      }
    }
    this.disconnectObservers();
    this.disconnectOrientation();

    this.unbindHotzoneClicks();
    this.detachLibBarScroll();
    this.removeHeaderSettingsBtn();
    this.removeVideoElement();
    this.teardownSettingsUi(); // 库条 / 设置入口 / 面板 / body.hs-libbar（观察器已由 disconnectObservers 断开）

    if (this.root && this.root.parentNode) {
      this.root.parentNode.removeChild(this.root);
    }
    // 移除宿主标记类
    if (
      this.mountContainer &&
      this.mountContainer.classList &&
      typeof this.mountContainer.classList.remove === "function"
    ) {
      this.mountContainer.classList.remove("hs-host");
    }
    if (this.hostView && this.hostView.classList && typeof this.hostView.classList.remove === "function") {
      this.hostView.classList.remove("hs-host");
    }
    const doc = getDoc();
    if (doc && doc.body && doc.body.classList) {
      doc.body.classList.remove("hs-home");
      doc.body.classList.remove("hs-immersive");
      doc.body.classList.remove("hs-leaving"); // 撤离时一并清掉「视觉收起」标记
    }

    if (this.swiper && typeof this.swiper.destroy === "function") {
      try {
        this.swiper.destroy();
      } catch (e) {
        /* ignore */
      }
    }

    // 复位挂载态
    this.root = null;
    this.swiper = null;
    this.swiperEl = null;
    this.wrapperEl = null;
    this.slideEls = [];
    this.imgEls = [];
    this.hotPrev = null;
    this.hotNext = null;
    this.prevBtn = null;
    this.nextBtn = null;
    this.infoLayer = null;
    this.infoNodes = [];
    this.visibleNodeIndex = 0;
    this.shownInfoIndex = -1;
    this.prevPoolIndex = -1;
    this.placeholderEl = null;
    this.mountContainer = null;
    this.pool = [];
    this.poolResult = null;
    this.placeholder = false;
    this.poolReady = false;
    this.timers = new Map();
    this.mounted = false;
    this.mounting = false;
    this.mountPromise = null;
    this.mountRetries = 0;
    this.running = false;
    // 注意：不动 this.bootstrapped / this._viewHandler（全局资源，撤离后仍要能再回首页）
  }

  /** 记录警告（一次性）。 */
  warn(err) {
    warnOnce(err && err.message ? err.message : err);
  }

  /**
   * 运行时诊断开关（默认关闭；真机排查只需在 Console 跑
   * `localStorage.setItem('hs.debug','1')` 再刷新，**无需重新贴脚本**）：
   * `globalThis.HS_DEBUG === true` 或 `localStorage["hs.debug"] === "1"`。
   */
  debugEnabled() {
    try {
      const g = globalObj();
      if (g && g.HS_DEBUG === true) return true;
      const st = getStorage();
      if (st && typeof st.getItem === "function" && st.getItem("hs.debug") === "1") return true;
    } catch (e) {
      /* ignore */
    }
    return false;
  }

  /**
   * 预告片链路的**无条件**日志（不依赖 hs.debug）。
   * 理由：这条链路出问题时用户往往没开调试，而它每张图最多 5 行，成本可忽略。
   * @param {string|Function} msg
   */
  tlog(msg) {
    try {
      const s = typeof msg === "function" ? msg() : msg;
      if (typeof console !== "undefined" && console.info) console.info("[HomeSwiper:trailer]", s);
    } catch (e) {
      /* ignore */
    }
  }

  /** 诊断日志：开关关闭时**零开销**（不构造消息、不打印）。传函数以避免拼接开销。 */
  dbg(factory) {
    try {
      if (!this.debugEnabled()) return;
      const msg = typeof factory === "function" ? factory() : factory;
      if (typeof console !== "undefined" && console.warn) console.warn("[HomeSwiper]", msg);
    } catch (e) {
      /* 日志绝不影响主流程 */
    }
  }

  // ---- 内容获取（S3 数据层委托） -------------------------------------

  /**
   * 读取设置（唯一入口；传入 libraries 触发规则 4 校验）。
   * @param {Array<{Id:string}>} [libraries]
   */
  readSettings(libraries) {
    return readSettings(this.userId, this.getEnv(), libraries);
  }

  /** 写入设置（仅显式保存时）。 */
  writeSettings(settings) {
    return writeSettings(this.userId, settings, this.getEnv());
  }

  /** 取可见库列表。 */
  getVisibleLibraries(opts) {
    return getVisibleLibraries(this.getEnv(), opts);
  }

  // ---- 设置面板（S6） ------------------------------------------------

  // ---- 媒体库条（挂 .headerMiddle；功能 12 / 6.7） -------------------

  /**
   * 取顶栏中间格（按序候选链；找不到返回 null）。
   * ⚠ 一律走兜底链、找不到就跳过不抛；只出现在首页（body.hs-home 前缀控制）。
   * @returns {object|null}
   */
  findHeaderMiddle() {
    const doc = getDoc();
    if (!doc || typeof doc.querySelector !== "function") return null;
    const sels = [".headerMiddle", ".headerMiddle.headerSection", ".skinHeader .headerMiddle"];
    for (let i = 0; i < sels.length; i++) {
      const e = doc.querySelector(sels[i]);
      if (e) return e;
    }
    return null;
  }

  /**
   * 建媒体库条 DOM（.hs-libbar > .hs-libbar__track > .hs-libbar__item）。
   * 点击某一项 = 切换轮播所用库（走统一收口 applySettingsLive）。
   * @returns {object} 库条根节点。
   */
  buildLibBar() {
    const bar = el("div", "hs-libbar");
    // ★ 抽屉回收用的裁剪层：只包住 track。
    //   之前把 clip-path 加在 `.hs-libbar` 上 ⇒ 把「向上探到顶栏最顶边」的悬停高亮层一起裁掉了
    //   （真机："高亮的指示框没有了"）。裁剪必须只作用于条目区。
    const clip = el("div", "hs-libbar__clip");
    const track = el("div", "hs-libbar__track");
    clip.appendChild(track);
    bar.appendChild(clip);
    this.libBarTrack = track;
    this.libBarClip = clip;
    // 悬停高亮层：放在条这一层、在裁剪层之外（否则向上探出的 3px 指示条会被裁掉）
    const hover = el("div", "hs-libbar__hover");
    bar.appendChild(hover);
    this.libBarHover = hover;
    this.renderLibBarItems(track);
    this.enableLibBarDrag(track); // 监听只挂一次（track 元素在重绘条目时存活）
    if (typeof bar.addEventListener === "function") {
      bar.addEventListener("mouseleave", () => this.hideLibBarHover());
    }
    return bar;
  }

  /** 悬停到某个库名：把高亮层对齐到它的左缘/宽度（相对条），并亮起。 */
  showLibBarHover(item) {
    const hover = this.libBarHover;
    if (!hover || !hover.style || !item) return;
    const left = typeof item.offsetLeft === "number" ? item.offsetLeft : 0;
    const width = typeof item.offsetWidth === "number" ? item.offsetWidth : 0;
    if (!(width > 0)) return; // 未布局（隐藏/测量期）⇒ 不动
    hover.style.left = left + "px";
    hover.style.width = width + "px";
    if (hover.classList && typeof hover.classList.add === "function") hover.classList.add("is-on");
  }

  /** 鼠标移出整条：熄灭悬停高亮。 */
  hideLibBarHover() {
    const hover = this.libBarHover;
    if (hover && hover.classList && typeof hover.classList.remove === "function") {
      hover.classList.remove("is-on");
    }
  }

  /** 按 this.libraries + 当前 LibId 重绘库条项（当前库加 .is-active）。 */
  renderLibBarItems(track) {
    if (!track) return;
    clearNode(track);
    const libs = this.libraries || [];
    const activeId = this.settings && this.settings.LibId != null ? String(this.settings.LibId) : null;
    for (let i = 0; i < libs.length; i++) {
      const lib = libs[i] || {};
      const item = el("button", "hs-libbar__item");
      item.setAttribute("type", "button");
      item.setAttribute("data-lib-id", lib.Id != null ? String(lib.Id) : "");
      item.textContent = lib.Name != null ? String(lib.Name) : String(lib.Id == null ? "" : lib.Id);
      if (lib.Id != null && String(lib.Id) === activeId) item.classList.add("is-active");
      item.addEventListener("click", () => this.onLibBarItemClick(lib));
      // 悬停：把条级高亮层对齐到当前库名（键盘 focus 也给同样的反馈）
      item.addEventListener("mouseenter", () => this.showLibBarHover(item));
      item.addEventListener("focus", () => this.showLibBarHover(item));
      // 键盘 Tab 到溢出项时保证可见（拿不到 scrollIntoView 就跳过）
      item.addEventListener("focus", () => {
        if (typeof item.scrollIntoView === "function") {
          try {
            item.scrollIntoView({ block: "nearest", inline: "nearest" });
          } catch (e) {
            /* ignore */
          }
        }
      });
      track.appendChild(item);
    }
  }

  /** 重绘库条项（库列表或选中项变化后）。 */
  refreshLibBar() {
    if (this.libBarTrack) this.renderLibBarItems(this.libBarTrack);
    // 条目变了 ⇒ 宽度变了，必须立刻重判"放不下"（否则新增库后会一直压到图标上）
    this.measureLibBarGeometry();
  }

  /**
   * 挂载媒体库条到 .headerMiddle。成功时给 body 加 hs-libbar（顶栏让位规则依赖它）。
   * 找不到宿主就跳过、不抛。
   */
  mountLibBar() {
    const host = this.findHeaderMiddle();
    if (!host) {
      this.dbg(() => "mountLibBar(): 无 .headerMiddle → 跳过");
      return;
    }
    this.libBarHost = host;
    if (!this.libBarEl) this.libBarEl = this.buildLibBar();
    else this.refreshLibBar();
    if (this.libBarEl.parentNode) this.libBarEl.parentNode.removeChild(this.libBarEl);
    if (typeof host.appendChild === "function") host.appendChild(this.libBarEl);
    const doc = getDoc();
    if (doc && doc.body && doc.body.classList) doc.body.classList.add("hs-libbar");
    this.setupLibBarObserver(host);
    this.measureLibBarGeometry(); // 量第一行几何写入 --hs-libbar-top/-h
    // 字体/图标字形到位后条目宽度会变 → 再量一次（只多一帧，避免"首帧看着放得下"）
    this.setTimer("libbar-measure", () => this.measureLibBarGeometry(), 120);
    this.dbg(() => "mountLibBar(): 已挂 " + (this.libraries || []).length + " 项");
  }

  /** 观察 .headerMiddle（childList）：Emby 导航后会清空它 ⇒ 重新 append。绝不 observe body。 */
  setupLibBarObserver(host) {
    const MO = getMutationObserver();
    const target = host || this.libBarHost;
    if (!MO || !target || typeof target.appendChild !== "function") return;
    if (this.libBarObserver) {
      try {
        if (typeof this.libBarObserver.disconnect === "function") this.libBarObserver.disconnect();
      } catch (e) {
        /* ignore */
      }
    }
    this.libBarObserver = new MO(() => this.healLibBar());
    this.libBarObservedHost = target;
    if (typeof this.libBarObserver.observe === "function") {
      this.libBarObserver.observe(target, { childList: true, subtree: false });
    }
  }

  /** 库条自愈：发现 .hs-libbar 不在 .headerMiddle 内就重新 append（宿主被换则重挂观察器）。 */
  healLibBar() {
    if (!this.mounted) return;
    const host = this.findHeaderMiddle() || this.libBarHost;
    if (!host || typeof host.appendChild !== "function") return;
    if (this.libBarEl && isWithin(host, this.libBarEl)) return;
    if (!this.libBarEl) this.libBarEl = this.buildLibBar();
    if (this.libBarEl.parentNode) this.libBarEl.parentNode.removeChild(this.libBarEl);
    host.appendChild(this.libBarEl);
    this.libBarHost = host;
    if (this.libBarObservedHost !== host) this.setupLibBarObserver(host);
    this.measureLibBarGeometry();
    this.dbg(() => "healLibBar(): 重挂");
  }

  /** 沿祖先链找 `.skinHeader`（库条所在顶栏），最多 8 层；找不到返回 null。 */
  findSkinHeader(el) {
    let p = el;
    let guard = 0;
    while (p && guard++ < 8) {
      const cl = p.classList;
      if (cl && typeof cl.contains === "function" && cl.contains("skinHeader")) return p;
      p = p.parentNode;
    }
    return null;
  }

  /**
   * 量「顶栏第一行」（logo / 右侧图标所在行）的 top 与行高，写入 `--hs-libbar-top/-h`。
   *
   * 依据：`.skinHeader` 有 `contain: strict`（paint ⇒ 是 fixed 后代的包含块），
   * 它的 `padding-top = max(1.2em, safe-area)` 与 `.headerLeft/.headerRight` 的
   * `min-height: 3.127em` 都随字号/缩放/安全区变化，行高还可能被内容撑高
   * ⇒ 任何手写的 top/height 都会错位，只能运行时量。
   * 参考元素优先 `.headerRight`（图标行），退 `.headerLeft`。
   */
  measureLibBarGeometry() {
    if (!this.libBarHost) return;
    const header = this.findSkinHeader(this.libBarHost);
    // ★ 早返回时也必须跑一次 fit 判定：行几何量不到（未布局 / 顶栏被临时隐藏 / 结构变化）
    //   不代表"放不下"的判定可以跳过——否则窗口变窄时会一直不回收（真机：条压在头像上）。
    if (!header || typeof header.getBoundingClientRect !== "function" || typeof header.querySelector !== "function") {
      this.syncLibBarFit(NaN);
      return;
    }
    const leftEl = header.querySelector(".headerLeft");
    const rightEl = header.querySelector(".headerRight");
    const ref = rightEl || leftEl; // 行高/行顶参考：优先右侧图标行
    let hr = null;
    let rr = null;
    try {
      hr = header.getBoundingClientRect();
      rr = ref && typeof ref.getBoundingClientRect === "function" ? ref.getBoundingClientRect() : null;
    } catch (e) {
      hr = null;
      rr = null;
    }
    const rowOk = !!(hr && rr && rr.height > 0 && rr.top - hr.top >= 0);
    // 横向：铺满「logo 区右缘」到「右侧图标区左缘」之间的整段（真机反馈："为什么不占满整个中间"）。
    // ⚠ 不能用容器盒子当边界：`.headerRight` 是 `width:20%` + `justify-content:flex-end`，
    //   窗口变窄时图标放不下会**向左溢出**（且绘制在条之上）⇒ 用容器 left 会把条画到图标下面（真机重叠）。
    //   故取「容器盒子」与「内容实际包围盒」的交集：左边界取更靠右者、右边界取更靠左者。
    const kidsSpan = (box) => {
      const kids = box && box.children ? box.children : null;
      if (!kids || !kids.length) return null;
      let minL = Infinity;
      let maxR = -Infinity;
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i];
        if (!k || typeof k.getBoundingClientRect !== "function") continue;
        let kr = null;
        try {
          kr = k.getBoundingClientRect();
        } catch (e) {
          continue;
        }
        if (!kr || !(kr.width > 0)) continue;
        if (kr.left < minL) minL = kr.left;
        if (kr.right > maxR) maxR = kr.right;
      }
      if (!isFinite(minL) || !isFinite(maxR)) return null;
      return { left: minL, right: maxR };
    };
    let avail = NaN; // logo 右缘 → 图标左缘之间的空隙（判"放不下"用）
    let leftPx = NaN; // 左对齐起点：从 logo 右缘往外 8px（真机："从 emby 的 logo 右侧延伸出来"）
    let rightBound = NaN; // 图标簇左缘（px，视口坐标）；判重叠的最后依据
    if (leftEl || rightEl) {
      try {
        const lr = leftEl ? leftEl.getBoundingClientRect() : null;
        const rr2 = rightEl ? rightEl.getBoundingClientRect() : null;
        const lbSpan = leftEl ? kidsSpan(leftEl) : null;
        const rbSpan = rightEl ? kidsSpan(rightEl) : null;
        // ★ 边界优先取**内容实际边**（logo 右缘 / 图标左缘），容器盒子只作兜底：
        //   容器是 20% 的固定格，远比内容宽；用容器边会平白吃掉一大截空隙 ⇒ "消失太早"（真机反馈）。
        const leftBound = lbSpan ? lbSpan.right : lr && lr.width > 0 ? lr.right : NaN;
        rightBound = rbSpan ? rbSpan.left : rr2 && rr2.width > 0 ? rr2.left : NaN;
        if (isFinite(leftBound) && hr) leftPx = Math.round(leftBound - hr.left) + 8;
        if (isFinite(leftBound) && isFinite(rightBound)) avail = Math.round(rightBound - leftBound);
      } catch (e) {
        rightBound = NaN;
        /* ignore：横向量不出来就不判"放不下"，按居中兜底显示 */
      }
    }
    this._libBarRightBound = rightBound;
    this._libBarLeftPx = leftPx;
    this.setLibBarVars(rowOk ? Math.round(rr.top - hr.top) : null, rowOk ? Math.round(rr.height) : null, leftPx);
    this.syncLibBarFit(avail);
  }

  /** 取轨道内按钮的实际总宽（子节点包围盒；量不到时退回 scrollWidth）。 */
  libBarContentWidth(track) {
    if (!track) return 0;
    let minL = Infinity;
    let maxR = -Infinity;
    const kids = track.children ? track.children : null;
    if (kids && kids.length) {
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i];
        if (!k || typeof k.getBoundingClientRect !== "function") continue;
        let kr = null;
        try {
          kr = k.getBoundingClientRect();
        } catch (e) {
          continue;
        }
        if (!kr || !(kr.width > 0)) continue;
        if (kr.left < minL) minL = kr.left;
        if (kr.right > maxR) maxR = kr.right;
      }
      if (isFinite(minL) && isFinite(maxR) && maxR > minL) return maxR - minL;
    }
    return typeof track.scrollWidth === "number" ? track.scrollWidth : 0;
  }

  /**
   * 放不下 ⇒ 整条隐藏（真机反馈："要遮盖到 emby 标志和右侧设置等按钮时就消失"）。
   * 判据：**按钮总宽 > logo 与右侧图标之间的可用空隙**（不看条自身宽度，避免宽度变量陈旧时漏判）。
   * ⚠ 用 `visibility` 隐藏而不是 `display:none`：保留布局才能继续量子节点宽度，
   *   窗口变宽后自动恢复（display:none 时量不到，会永久隐藏）。
   */
  syncLibBarFit(avail) {
    const bar = this.libBarEl;
    if (!bar || !bar.classList || typeof bar.classList.add !== "function") return;
    const track = this.libBarTrack;
    const need = this.libBarContentWidth(track);
    const space = typeof avail === "number" ? avail : NaN;
    // 迟滞：已回收时，要多让出 24px 才恢复显示（否则在阈值附近拖动会反复显隐、动画看着像"闪"）
    let wasHidden = false;
    try {
      wasHidden = !!(bar.classList.contains && bar.classList.contains("is-too-narrow"));
    } catch (e) {
      wasHidden = false;
    }
    const slack = wasHidden ? 24 : 0;
    let tooNarrow = false;
    if (isFinite(space)) {
      tooNarrow = !(space > 0) || (need > 0 && need >= space - slack);
    }
    // ★ 实际几何校验（**无论 space 是否有限都做**）：条的真实右缘越过图标簇左缘 ⇒ 一定在压图标。
    //   只靠 space 不够——space 可能来自陈旧量测 / 结构变化，而这条不依赖任何布局推算，是"最后一道真话"。
    if (!tooNarrow) {
      try {
        const br = bar.getBoundingClientRect ? bar.getBoundingClientRect() : null;
        if (br && br.width > 0) {
          // 回收态自己带 translateX(−6px)：量到的右缘比"真实占位"少 6px，
          // 直接拿来判会让条在阈值附近反复显隐（藏起来→不重叠→又显示）。
          // ⇒ 先把那 6px 加回去，判据永远基于"未偏移的右缘"。
          const shift = wasHidden ? 6 : 0;
          let bound = this._libBarRightBound;
          if (!(typeof bound === "number" && isFinite(bound))) {
            const doc = getDoc();
            const right = doc && doc.querySelector ? doc.querySelector(".headerRight") : null;
            const rr = right && right.getBoundingClientRect ? right.getBoundingClientRect() : null;
            if (rr && rr.width > 0) bound = rr.left;
          }
          if (typeof bound === "number" && isFinite(bound) && br.right + shift > bound - 8 - slack) tooNarrow = true;
        }
      } catch (e) {
        /* ignore */
      }
    }
    try {
      if (tooNarrow) bar.classList.add("is-too-narrow");
      else bar.classList.remove("is-too-narrow");
    } catch (e) {
      /* ignore */
    }
  }

  /** 写 `--hs-libbar-top/-h`（px；同值跳过）。`left` 有效时另写 `--hs-libbar-left` + `--hs-libbar-tx:0px`（左对齐）。 */
  setLibBarVars(top, h, left) {
    const doc = getDoc();
    const el = doc && doc.documentElement;
    if (!el || !el.style) return;
    // top / h 传 null 表示"这一帧行几何量不到，保持旧值不写"。
    const hasRow = typeof top === "number" && isFinite(top) && top >= 0 && typeof h === "number" && isFinite(h) && h > 0;
    const t = hasRow ? Math.max(0, Math.round(top)) : null;
    const hh = hasRow ? Math.max(0, Math.round(h)) : null;
    const hasLeft = typeof left === "number" && isFinite(left) && left >= 0 && left < 4000;
    const l = hasLeft ? Math.round(left) : null;
    if (t === this._libBarTop && hh === this._libBarH && l === this._libBarLeft) return;
    try {
      if (typeof el.style.setProperty === "function") {
        if (hasRow) {
          el.style.setProperty("--hs-libbar-top", t + "px");
          el.style.setProperty("--hs-libbar-h", hh + "px");
        }
        if (hasLeft) {
          el.style.setProperty("--hs-libbar-left", l + "px");
          el.style.setProperty("--hs-libbar-tx", "0px"); // 有左起点就别再 -50% 居中
        } else {
          el.style.removeProperty("--hs-libbar-left");
          el.style.removeProperty("--hs-libbar-tx");
        }
      } else {
        if (hasRow) {
          el.style["--hs-libbar-top"] = t + "px";
          el.style["--hs-libbar-h"] = hh + "px";
        }
        if (hasLeft) {
          el.style["--hs-libbar-left"] = l + "px";
          el.style["--hs-libbar-tx"] = "0px";
        } else {
          delete el.style["--hs-libbar-left"];
          delete el.style["--hs-libbar-tx"];
        }
      }
      if (hasRow) {
        this._libBarTop = t;
        this._libBarH = hh;
      }
      this._libBarLeft = l;
    } catch (e) {
      /* ignore */
    }
  }

  /** 清 `--hs-libbar-*`（撤离首页时）。 */
  clearLibBarVars() {
    const doc = getDoc();
    const el = doc && doc.documentElement;
    this._libBarTop = null;
    this._libBarH = null;
    this._libBarLeft = null;
    this._libBarRightBound = null;
    this._libBarLeftPx = null;
    if (!el || !el.style) return;
    try {
      if (typeof el.style.removeProperty === "function") {
        el.style.removeProperty("--hs-libbar-top");
        el.style.removeProperty("--hs-libbar-h");
        el.style.removeProperty("--hs-libbar-left");
        el.style.removeProperty("--hs-libbar-tx");
      } else {
        delete el.style["--hs-libbar-top"];
        delete el.style["--hs-libbar-h"];
        delete el.style["--hs-libbar-left"];
        delete el.style["--hs-libbar-tx"];
      }
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * 媒体库条鼠标拖动横向滚动（Pointer Events 同时覆盖鼠标与触屏）。
   * 监听只挂一次（挂在存活的 track 上）；句柄存实例，撤离时成对摘除。
   * @param {object} track .hs-libbar__track
   */
  enableLibBarDrag(track) {
    if (!track || typeof track.addEventListener !== "function") return;
    if (this._libBarDragHandlers) return; // 只挂一次
    const self = this;
    const state = { dragging: false, moved: false, startX: 0, startScrollLeft: 0 };

    const applyMove = (e) => {
      if (!state.dragging) return;
      const x = e && typeof e.clientX === "number" ? e.clientX : state.startX;
      const dx = x - state.startX;
      if (!state.moved && Math.abs(dx) > LIBBAR_DRAG_THRESHOLD_PX) state.moved = true;
      if (typeof track.scrollLeft === "number") track.scrollLeft = state.startScrollLeft - dx;
    };

    const finish = () => {
      if (!state.dragging) return; // 幂等：track 与 window 两处监听都会触发，第二 Traverse 直接返回
      state.dragging = false;
      if (track.classList) track.classList.remove("is-dragging");
      if (state.moved) {
        // 一次性抑制紧随其后的 click（否则"拖一下"会误切库）；消费者在 onLibBarItemClick 里清掉
        self._libBarSuppressClick = true;
      }
    };

    const onDown = (e) => {
      if (!e || e.button !== 0) return; // 只认主键
      self._libBarSuppressClick = false; // 每次新手势复位抑制标记
      state.dragging = true;
      state.moved = false;
      state.startX = typeof e.clientX === "number" ? e.clientX : 0;
      state.startScrollLeft = typeof track.scrollLeft === "number" ? track.scrollLeft : 0;
      if (track.classList) track.classList.add("is-dragging");
      // 有意不 preventDefault：否则点击会被掐断
    };

    // ★★ 真机事故（点击全灭的根因）：原实现在此处 `track.setPointerCapture(...)`。
    //   指针捕获会把后续 pointerup 重定向到 track，而浏览器派发 click 的目标是
    //   「pointerdown 与 pointerup 目标的最近公共祖先」＝ track 本身
    //   ⇒ **条目按钮上的 click 监听永远收不到** ⇒ 点击全灭。
    //   测试是直接往按钮派发 click，绕过了浏览器的目标计算 ⇒ 测试全绿、真机全灭
    //   （与 rAF 的 `this` 问题同类：桩环境不复现真机语义）。
    //   ⇒ 弃用捕获；move/up/cancel 同时挂 track（测试可派发）与 window（拖出条也能继续收），
    //     双处重复触发由 state.dragging 幂等兜住。
    track.addEventListener("pointerdown", onDown);
    track.addEventListener("pointermove", applyMove);
    track.addEventListener("pointerup", finish);
    track.addEventListener("pointercancel", finish);
    const handlers = { track: track, down: onDown, move: applyMove, up: finish };
    const w = getWin();
    if (w && typeof w.addEventListener === "function") {
      try {
        w.addEventListener("pointermove", applyMove);
        w.addEventListener("pointerup", finish);
        w.addEventListener("pointercancel", finish);
        handlers.win = w;
      } catch (err) {
        /* ignore */
      }
    }
    this._libBarDragHandlers = handlers;
  }

  /** 摘掉媒体库条的 pointer 监听（撤离时成对移除；含 window 侧）。 */
  teardownLibBarDrag() {
    const h = this._libBarDragHandlers;
    this._libBarDragHandlers = null;
    if (!h) return;
    const rm = (target, type, fn) => {
      try {
        if (target && typeof target.removeEventListener === "function") target.removeEventListener(type, fn);
      } catch (e) {
        /* ignore */
      }
    };
    const t = h.track;
    rm(t, "pointerdown", h.down);
    rm(t, "pointermove", h.move);
    rm(t, "pointerup", h.up);
    rm(t, "pointercancel", h.up);
    if (h.win) {
      rm(h.win, "pointermove", h.move);
      rm(h.win, "pointerup", h.up);
      rm(h.win, "pointercancel", h.up);
    }
  }

  /**
   * 点击库条某一项 = **进入该媒体库**（导航，不是切轮播库）。
   * 优先 Emby 路由器 `showItem`（文件夹类条目由 Emby 自己走 list 路由）；否则回落 list 路由 hash。
   * 轮播用哪个库由设置面板决定 ⇒ **不再**改 `settings.LibId` / `writeSettings` / `applySettingsLive`。
   */
  onLibBarItemClick(lib) {
    this.dbg(
      () =>
        "点击：库条 " +
        (lib && lib.Name != null ? String(lib.Name) : "") +
        " id=" +
        (lib && lib.Id != null ? String(lib.Id) : "?"),
    );
    if (this._libBarSuppressClick) {
      this._libBarSuppressClick = false; // 一次性：清掉并直接 return
      return;
    }
    if (!lib || lib.Id === null || lib.Id === undefined) return;
    // ★ 先视觉收起自己（不拆 DOM）：进库时库条/轮播立即消失，且原生首页不会闪现。
    this.hideForNavigation();
    // 路由器两段式（4.7 = Emby.Page / 4.11 = AMD appRouter），失败才落 list 路由 hash。
    const go = (r) => {
      if (r && typeof r.showItem === "function") {
        try {
          r.showItem(lib.Id);
          this.dbg(() => "onLibBarItemClick(): showItem(" + lib.Id + ") 已调用（文件夹由 Emby 走 list 路由）");
          return;
        } catch (e) {
          this.dbg(() => "onLibBarItemClick(): showItem 抛错 → hash 兜底");
        }
      } else {
        this.dbg(() => "onLibBarItemClick(): 无路由器可用 → hash 兜底");
      }
      this.navigateHash("!/list/list.html?parentId=" + encodeURIComponent(String(lib.Id)) + this.serverIdSuffix());
    };
    if (!this.embyRouter(go)) go(null);
  }

  // ---- 设置面板（功能 13 / 6.8） --------------------------

  /**
   * 顶栏快捷入口：在右侧图标组（.headerRight）**最左边**插一个轮播设置按钮。
   * - 只在首页（hs-home）出现；非首页由 teardown 移除。
   * - 图标用 tune（调节滑杆）而不是齿轮：右上角已有 Emby 自己的齿轮，双齿轮会点错；
   *   tune 的线宽也与旁边的投屏/搜索一致（movie/theaters 那类实心方块会显得很重）。
   * - 幂等：已存在且仍是 headerRight 的第一个子节点就直接返回（Emby 重渲染后自愈）。
   */
  ensureHeaderSettingsBtn() {
    const doc = getDoc();
    if (!doc || typeof doc.querySelector !== "function") return;
    const right = doc.querySelector(".headerRight");
    if (!right || typeof right.insertBefore !== "function") {
      this.dbg(() => "ensureHeaderSettingsBtn(): 无 .headerRight → 跳过");
      return;
    }
    if (!this._headerBtn) {
      const btn = el("button", "hs-header-settings");
      btn.setAttribute("type", "button");
      btn.setAttribute("title", "首页轮播设置");
      btn.setAttribute("aria-label", "首页轮播设置");
      // 线性 SVG 走 CSS mask：图标字体在 22px 下只有实心字重，做不出 2px 描边的手感
      const icon = el("span", "hs-ico hs-ico--carousel");
      icon.setAttribute("aria-hidden", "true");
      btn.appendChild(icon);
      btn.addEventListener("click", (e) => {
        if (e && typeof e.stopPropagation === "function") e.stopPropagation();
        this.openPanel();
      });
      this._headerBtn = btn;
    }
    const kids = right.children || [];
    if (this._headerBtn.parentNode === right && kids[0] === this._headerBtn) return;
    if (this._headerBtn.parentNode) this._headerBtn.parentNode.removeChild(this._headerBtn);
    right.insertBefore(this._headerBtn, kids[0] || null);
    this.dbg(() => "ensureHeaderSettingsBtn(): 已插入顶栏右侧最左");
  }

  /** 观察顶栏（subtree:true）：Emby 重渲染 headerRight 时把按钮补回来。 */
  setupHeaderSettingsObserver() {
    const doc = getDoc();
    const header = doc && typeof doc.querySelector === "function" ? doc.querySelector(".skinHeader") : null;
    if (!header) return;
    if (this._headerObserver && this._headerObservedHost === header) return;
    if (this._headerObserver) {
      try {
        if (typeof this._headerObserver.disconnect === "function") this._headerObserver.disconnect();
      } catch (e) {
        /* ignore */
      }
    }
    const MO = getMutationObserver();
    if (!MO) return;
    this._headerObserver = new MO(() => this.ensureHeaderSettingsBtn());
    this._headerObservedHost = header;
    if (typeof this._headerObserver.observe === "function") {
      this._headerObserver.observe(header, { childList: true, subtree: true });
    }
  }

  /** 移除顶栏快捷入口（撤离时）。 */
  removeHeaderSettingsBtn() {
    if (this._headerBtn && this._headerBtn.parentNode) {
      this._headerBtn.parentNode.removeChild(this._headerBtn);
    }
    if (this._headerObserver) {
      try {
        if (typeof this._headerObserver.disconnect === "function") this._headerObserver.disconnect();
      } catch (e) {
        /* ignore */
      }
    }
    this._headerObserver = null;
    this._headerObservedHost = null;
  }

  /**
   * 建设置入口。**必须是 Emby 原生导航项的结构与类名**，否则在设置页里就是一个
   * 没样式的大白按钮（真机截图：设置侧栏底部一条白条）。
   *   原生形态：<a class="navMenuOption"><i class="md-icon navMenuOptionIcon">…</i>
   *                    <span class="navMenuOptionText">名称</span></a>
   * 图标用 Material Icons 的连字（Emby 自带该字体），这里取 "movie"。
   */
  /**
   * 打开设置面板。**面板初值一律取 this.settings（= readSettings 的返回值），面板绝不自己读 localStorage。**
   */
  openPanel() {
    if (this.panelEl) {
      this.focusPanel();
      return;
    }
    // ★ 从设置页打开时可能**从未挂载过**（用户直接进 dashboard）：
    //   此时 this.settings 还是默认值、this.libraries 为空 ⇒ 面板会显示默认值并把用户设置覆盖掉。
    //   先把真实设置与可见库读进来，再建面板。
    if (this.settingsLoaded) {
      this.openPanelNow();
      return Promise.resolve();
    }
    if (this._panelOpening) return Promise.resolve();
    this._panelOpening = true;
    return Promise.resolve()
      .then(() => this.refreshPanelData())
      .catch(() => {})
      .then(() => {
        this._panelOpening = false;
        this.openPanelNow();
      });
  }

  /** 面板数据兜底加载：设置页在未挂载时要自己取一次设置与可见库。 */
  async refreshPanelData() {
    const env = this.getEnv();
    try {
      this.userId = this.userId || resolveUserId(env);
      this.serverBase = resolveServerBase(env);
      let libs = this.libraries;
      if (!libs || !libs.length) {
        try {
          libs = await getVisibleLibraries(env, {});
        } catch (e) {
          libs = libs || [];
        }
      }
      this.libraries = Array.isArray(libs) ? libs : [];
      if (this.userId) {
        this.settings = Object.assign({}, this.settings, readSettings(this.userId, env, this.libraries));
      }
      this.settingsLoaded = true;
    } catch (e) {
      this.dbg(() => "refreshPanelData(): " + (e && e.message ? e.message : e));
    }
  }

  /** 真正建面板并挂到 body（原 openPanel 的主体）。 */
  openPanelNow() {
    const doc = getDoc();
    if (!doc || typeof doc.createElement !== "function") return;
    this._lastFocusedEl = doc.activeElement || null;
    const panel = this.buildPanel();
    this.panelEl = panel;
    const scrim = el("div", "hs-panel__scrim");
    scrim.addEventListener("click", () => this.closePanel());
    this.panelScrim = scrim;
    if (doc.body && typeof doc.body.appendChild === "function") doc.body.appendChild(scrim);
    if (doc.body && typeof doc.body.appendChild === "function") doc.body.appendChild(panel);
    this.syncTrailerVolumeVisibility();
    this._panelKeyHandler = (e) => this.onPanelKeydown(e);
    if (typeof doc.addEventListener === "function") {
      doc.addEventListener("keydown", this._panelKeyHandler, true);
    }
    this.focusPanel();
  }

  /** 建面板 DOM（.hs-panel > __header > __body > __footer）。 */
  buildPanel() {
    const panel = el("div", "hs-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "首页轮播设置");

    const header = el("div", "hs-panel__header");
    const badge = el("span", "hs-ico hs-ico--carousel hs-panel__badge");
    badge.setAttribute("aria-hidden", "true");
    const title = el("div", "hs-panel__title");
    title.textContent = "首页轮播设置";
    const close = el("button", "hs-panel__close");
    close.setAttribute("type", "button");
    close.setAttribute("aria-label", "关闭");
    close.textContent = "×";
    close.addEventListener("click", () => this.closePanel());
    this.panelCloseBtn = close;
    const headText = el("div", "hs-panel__heading");
    headText.appendChild(title);
    const sub = el("div", "hs-panel__subtitle");
    sub.textContent = "只对本客户端生效";
    headText.appendChild(sub);
    header.appendChild(badge);
    header.appendChild(headText);
    header.appendChild(close);

    const body = this.buildPanelBody();

    const footer = el("div", "hs-panel__footer");
    const hint = el("span", "hs-panel__hint");
    this.panelHintEl = hint;
    const save = el("button", "hs-panel__save");
    save.setAttribute("type", "button");
    save.textContent = "保存";
    save.addEventListener("click", () => this.onPanelSave());
    this.panelSaveBtn = save;
    footer.appendChild(hint);
    footer.appendChild(save);

    panel.appendChild(header);
    panel.appendChild(body);
    panel.appendChild(footer);
    return panel;
  }

  /** 建面板主体：六个字段（键名逐字对齐 settings）。 */
  buildPanelBody() {
    const body = el("div", "hs-panel__body");
    const s = this.settings || {};
    this.panelFields = {};
    const libOptions = (this.libraries || []).map((l) => ({
      value: l && l.Id != null ? String(l.Id) : "",
      label: l && l.Name != null ? String(l.Name) : String((l && l.Id) || ""),
    }));
    body.appendChild(this.buildField("LibId", "媒体库", this.makeSelectControl("LibId", libOptions, s.LibId)));
    body.appendChild(
      this.buildField(
        "SelectionLogic",
        "挑选方式",
        this.makeSelectControl("SelectionLogic", this.strategyOptions(), s.SelectionLogic),
      ),
    );
    const sizeField = this.buildField(
      "PoolSize",
      "轮播数量",
      this.makeNumberControl("PoolSize", s.PoolSize, { min: 1, step: 1 }),
    );
    body.appendChild(sizeField);
    // 只在「随机换批」模式下显示：那两种模式里它是"每批向服务器请求的条数"，
    // 其它模式里它是"池子总量"，含义不同，常驻显示反而会误导。
    const sizeHint = this.buildHint("选「随机换批」时，这个数量 = 每次向服务器请求的条数。");
    sizeField.appendChild(sizeHint);
    this._sizeHint = sizeHint;
    const selControl = this.panelFields && this.panelFields.SelectionLogic
      ? this.panelFields.SelectionLogic.control
      : null;
    const syncHint = () => {
      const isShuffle = !!selControl && String(selControl.value) === "shuffle";
      if (sizeHint.style) sizeHint.style.display = isShuffle ? "" : "none";
    };
    if (selControl && typeof selControl.addEventListener === "function") {
      selControl.addEventListener("change", syncHint);
    }
    syncHint();
    body.appendChild(
      this.buildField(
        "ImageInterval",
        "每张停留（秒）",
        this.makeNumberControl("ImageInterval", this.secondsOf(s.ImageInterval), { min: 1, step: 1 }),
      ),
    );
    body.appendChild(
      this.buildField("PlayTrailer", "播放预告片", this.makeToggleControl("PlayTrailer", s.PlayTrailer)),
    );
    body.appendChild(
      this.buildField(
        "TrailerVolume",
        "预告片音量（0–1）",
        this.makeNumberControl("TrailerVolume", s.TrailerVolume, { min: 0, max: 1, step: 0.1 }),
      ),
    );
    return body;
  }

  /** 建一行字段下方的说明文字（不参与表单值）。 */
  buildHint(text) {
    const hint = el("div", "hs-panel__hint");
    hint.textContent = text;
    return hint;
  }

  /** 建一个 .hs-panel__field 字段行（label + 控件），并登记到 this.panelFields。 */
  buildField(name, labelText, control) {
    const field = el("div", "hs-panel__field");
    field.setAttribute("data-field", name);
    const label = el("label", "hs-panel__label");
    label.textContent = labelText;
    field.appendChild(label);
    field.appendChild(control);
    this.panelFields[name] = { field: field, label: label, control: control };
    return field;
  }

  /** 已注册策略 → 下拉选项（{value:id,label}）。 */
  strategyOptions() {
    const out = [];
    const keys = Object.keys(STRATEGIES || {});
    for (let i = 0; i < keys.length; i++) {
      const s = STRATEGIES[keys[i]] || {};
      out.push({ value: s.id || keys[i], label: s.label || s.id || keys[i] });
    }
    return out;
  }

  /**
   * 保守判据：原生自定义元素（emby-select/emby-input/paper-toggle-button）构造后**未必已升级**。
   * 只有当它存在目标属性（value/checked）且能派发事件时才用原生，否则退回普通控件。
   */
  canUseNativeEl(tag, prop) {
    const doc = getDoc();
    if (!doc || typeof doc.createElement !== "function") return false;
    try {
      const e = doc.createElement(tag);
      return !!e && typeof e.dispatchEvent === "function" && prop in Object(e);
    } catch (err) {
      return false;
    }
  }

  /** 下拉控件（原生 emby-select 不可用则退回 select）。 */
  makeSelectControl(name, options, value) {
    const node = this.canUseNativeEl("emby-select", "value") ? el("emby-select", "") : el("select", "");
    this.fillSelect(node, options, value);
    node.addEventListener("change", () => this.onControlChange(name));
    return node;
  }

  /** 数字控件（原生 emby-input 不可用则退回 input[type=number]）。 */
  makeNumberControl(name, value, opts) {
    const o = opts || {};
    const node = this.canUseNativeEl("emby-input", "value") ? el("emby-input", "") : el("input", "");
    node.setAttribute("type", "number");
    if (o.min !== undefined) node.setAttribute("min", String(o.min));
    if (o.max !== undefined) node.setAttribute("max", String(o.max));
    if (o.step !== undefined) node.setAttribute("step", String(o.step));
    node.value = value !== null && value !== undefined ? String(value) : "";
    node.addEventListener("change", () => this.onControlChange(name));
    return node;
  }

  /** 开关控件（原生 paper-toggle-button 不可用则退回 input[type=checkbox]）。 */
  makeToggleControl(name, value) {
    const node = this.canUseNativeEl("paper-toggle-button", "checked")
      ? el("paper-toggle-button", "")
      : el("input", "");
    if (node.tagName && String(node.tagName).toLowerCase() === "input") {
      node.setAttribute("type", "checkbox");
    }
    node.checked = !!value;
    node.addEventListener("change", () => this.onControlChange(name));
    return node;
  }

  /** 填充下拉选项并选中 value。 */
  fillSelect(node, options, value) {
    const list = options || [];
    for (let i = 0; i < list.length; i++) {
      const opt = el("option", "");
      const v = list[i] && list[i].value != null ? String(list[i].value) : "";
      opt.value = v;
      opt.textContent = list[i] && list[i].label != null ? String(list[i].label) : v;
      if (v === String(value)) opt.selected = true;
      node.appendChild(opt);
    }
    node.value = value !== null && value !== undefined ? String(value) : "";
  }

  /** 控件变化：PlayTrailer 联动 TrailerVolume 行可见性。 */
  onControlChange(name) {
    if (name === "PlayTrailer") this.syncTrailerVolumeVisibility();
  }

  /** PlayTrailer=false ⇒ TrailerVolume 行隐藏（inline display + hidden 属性双写）。 */
  syncTrailerVolumeVisibility() {
    const tv = this.panelFields.TrailerVolume;
    if (!tv || !tv.field) return;
    const pt = this.panelFields.PlayTrailer;
    const on = pt && pt.control ? !!pt.control.checked : true;
    if (on) {
      tv.field.style.display = "";
      if (typeof tv.field.removeAttribute === "function") tv.field.removeAttribute("hidden");
    } else {
      tv.field.style.display = "none";
      if (typeof tv.field.setAttribute === "function") tv.field.setAttribute("hidden", "");
    }
  }

  /** 毫秒 → 秒（面板展示用）。 */
  secondsOf(ms) {
    const v = typeof ms === "number" && isFinite(ms) ? ms : 0;
    return Math.round(v / 1000);
  }

  /** 从面板控件收集六个字段（ImageInterval 秒 → 毫秒）。 */
  collectPanelSettings() {
    const s = this.settings || {};
    const val = (name) => {
      const f = this.panelFields[name];
      return f && f.control ? f.control.value : undefined;
    };
    const pt = this.panelFields.PlayTrailer;
    const playTrailer = pt && pt.control ? !!pt.control.checked : !!s.PlayTrailer;
    const secs = toNumber(val("ImageInterval"), this.secondsOf(s.ImageInterval));
    const libRaw = val("LibId");
    return {
      LibId:
        libRaw !== undefined && libRaw !== null && String(libRaw) !== ""
          ? String(libRaw)
          : s.LibId != null
            ? String(s.LibId)
            : null,
      SelectionLogic: nonEmpty(val("SelectionLogic"), s.SelectionLogic),
      PoolSize: Math.round(toNumber(val("PoolSize"), s.PoolSize)),
      ImageInterval: Math.round(secs * 1000),
      PlayTrailer: playTrailer,
      TrailerVolume: toNumber(val("TrailerVolume"), s.TrailerVolume),
    };
  }

  /** 保存：collect → writeSettings → applySettingsLive → 提示。 */
  onPanelSave() {
    this.saveAndRebuild(this.collectPanelSettings());
    this.notifySaved();
  }

  /** 保存并重建（写存储 + 立即生效）。 */
  saveAndRebuild(settings) {
    const next = settings || {};
    this.writeSettings(next);
    this.settings = Object.assign({}, this.settings, next);
    return this.applySettingsLive();
  }

  /** 保存提示：优先 Emby 原生 toast，拿不到就面板内一行轻提示；**绝不 alert**。 */
  notifySaved() {
    const g = globalObj();
    try {
      if (g && typeof g.toast === "function") {
        g.toast({ text: "已保存" });
        return;
      }
      if (g && g.Emby && typeof g.Emby.toast === "function") {
        g.Emby.toast({ text: "已保存" });
        return;
      }
    } catch (e) {
      /* ignore */
    }
    if (this.panelHintEl) this.panelHintEl.textContent = "已保存";
  }

  /** 关闭面板：摘 keydown、移除 DOM、焦点回到入口。 */
  closePanel() {
    const doc = getDoc();
    if (this._panelKeyHandler && doc && typeof doc.removeEventListener === "function") {
      try {
        doc.removeEventListener("keydown", this._panelKeyHandler, true);
      } catch (e) {
        /* ignore */
      }
    }
    this._panelKeyHandler = null;
    if (this.panelEl && this.panelEl.parentNode) this.panelEl.parentNode.removeChild(this.panelEl);
    this.panelEl = null;
    if (this.panelScrim && this.panelScrim.parentNode) this.panelScrim.parentNode.removeChild(this.panelScrim);
    this.panelScrim = null;
    this.panelFields = {};
    this.panelCloseBtn = null;
    this.panelSaveBtn = null;
    this.panelHintEl = null;
    const back = this._lastFocusedEl;
    this._lastFocusedEl = null;
    if (back && typeof back.focus === "function") {
      try {
        back.focus();
      } catch (e) {
        /* ignore */
      }
    }
  }

  /** 面板键盘：Esc 关闭；Tab 不跑出面板。 */
  onPanelKeydown(e) {
    if (!e) return;
    const k = e.key;
    if (k === "Escape" || k === "Esc") {
      if (typeof e.preventDefault === "function") e.preventDefault();
      this.closePanel();
      return;
    }
    if (k === "Tab") this.trapTab(e);
  }

  /** 焦点陷阱：Tab 到边界时回绕（无 activeElement 的实现下安全 no-op）。 */
  trapTab(e) {
    const doc = getDoc();
    if (!doc || !this.panelEl || typeof this.panelEl.querySelectorAll !== "function") return;
    const focusables = this.panelEl.querySelectorAll("button");
    if (!focusables || !focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = doc.activeElement || null;
    if (!e.shiftKey && active === last) {
      if (typeof e.preventDefault === "function") e.preventDefault();
      if (first && typeof first.focus === "function") first.focus();
    } else if (e.shiftKey && active === first) {
      if (typeof e.preventDefault === "function") e.preventDefault();
      if (last && typeof last.focus === "function") last.focus();
    }
  }

  /** 打开时焦点移入面板（关闭按钮）。 */
  focusPanel() {
    if (!this.panelEl || typeof this.panelEl.querySelector !== "function") return;
    const target = this.panelCloseBtn || this.panelEl.querySelector(".hs-panel__close");
    if (target && typeof target.focus === "function") {
      try {
        target.focus();
      } catch (e) {
        /* ignore */
      }
    }
  }

  // ---- 统一收口：按当前设置立即重建（面板保存 / 库条切库共用） --------

  /**
   * 幂等重建：bumpEpoch（清定时器 + abort 在飞请求）→ 重抽池 → 销毁并重建 slide/Swiper → 重启自动播放。
   * `this.mounted === false`（不在首页）时只更新设置后直接返回（设置已由调用方写入 this.settings）。
   * @returns {Promise<boolean>}
   */
  applySettingsLive() {
    if (this.mounted === false) {
      this.dbg(() => "applySettingsLive(): 未挂载 → 仅更新设置，下次进首页生效");
      return Promise.resolve(false);
    }
    this.bumpEpoch(); // 先清定时器 + abort 在飞请求，避免旧请求回来污染新池
    this.stopImagePhase(); // 旧 Swiper 即将销毁：先停掉图片阶段计时/进度条
    // ★ 换库/改设置要**立刻收掉正在播的预告片**：否则旧视频会一直播到结束（真机 bug）
    this.stopTrailer("pool-change");
    this._trailerIds = {};
    this.poolReady = false;
    this.placeholder = false;
    this.shownInfoIndex = -1;
    this.prevPoolIndex = -1;
    if (this.swiper && typeof this.swiper.destroy === "function") {
      try {
        this.swiper.destroy();
      } catch (e) {
        /* ignore */
      }
    }
    this.swiper = null;
    this.removeCarouselDom();
    return Promise.resolve(this.loadPool({ force: true }))
      .then(() => {
        // 与 mount 共用同一个建轮播入口（不要再各抄一遍：漏一步就是静默 bug）
        return this.rebuildCarousel(0);
      })
      .then(() => {
        this.refreshLibBar();
        this.dbg(() => "applySettingsLive(): 重建完成 pool=" + this.pool.length);
        return true;
      })
      .catch((err) => {
        this.warn(err);
        return false;
      });
  }

  /** 移除 buildCarousel 建立的轮播 DOM（保留 root / 库条 / 设置入口）。 */
  removeCarouselDom() {
    this.stopAllOverviewScrolls(); // 节点即将被移除：先停 rAF，否则闭包会一直持有它们
    this.unbindHotzoneClicks(); // ★ 先摘热区点击监听（此时节点仍在），再移除节点
    const nodes = [this.swiperEl, this.hotPrev, this.hotNext, this.prevBtn, this.nextBtn, this.infoLayer];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n && n.parentNode && typeof n.parentNode.removeChild === "function") n.parentNode.removeChild(n);
    }
    this.swiperEl = null;
    this.wrapperEl = null;
    this.hotPrev = null;
    this.hotNext = null;
    this.prevBtn = null;
    this.nextBtn = null;
    this.infoLayer = null;
    this.infoNodes = [];
    this.placeholderEl = null;
    this.slideEls = [];
    this.imgEls = [];
  }

  /** 撤离设置 UI：面板（若开）/ 入口 / 库条 / body.hs-libbar。观察器由 disconnectObservers 断开。 */
  teardownSettingsUi() {
    this.closePanel();
    // ★ 只拆「首页态」的资源：库条（含 pointer 监听）与 body.hs-libbar。
    //   设置入口是**全局资源**（要出现在设置页 #!/dashboard 的左侧栏，跟视图事件监听同类）——
    //   **撤离时不摘**，否则一离开首页入口就没了，用户到设置页根本看不到（真机教训）。
    this.teardownLibBarDrag();
    this._libBarSuppressClick = false;
    if (this.libBarEl && this.libBarEl.parentNode) this.libBarEl.parentNode.removeChild(this.libBarEl);
    this.libBarEl = null;
    this.libBarTrack = null;
    this.libBarHover = null;
    this.libBarHost = null;
    this.libBarObservedHost = null;
    this.clearLibBarVars(); // 清 --hs-libbar-top/-h
    const doc = getDoc();
    if (doc && doc.body && doc.body.classList) doc.body.classList.remove("hs-libbar");
  }

}

/* ------------------------------------------------------------------ *
 * 引导入口：由生成的临时入口 .entry.mjs 调用 startBootstrap({SWIPER_CSS,CUSTOM_CSS})
 * ------------------------------------------------------------------ */

/** bootstrap 单例守卫（同一段代码被重复执行时不重复挂）。 */
let globalBootstrapDone = false;

/**
 * 引导：注入两份样式 + 挂生命周期（viewbeforeshow）并启动自查。
 * @param {{ SWIPER_CSS?: string, CUSTOM_CSS?: string }} cssBundle 两份 CSS 文本。
 * @returns {void}
 */
export function startBootstrap(cssBundle) {
  const bundle = cssBundle || {};
  injectStyles({ swiperCss: bundle.SWIPER_CSS, customCss: bundle.CUSTOM_CSS });

  if (globalBootstrapDone) return;
  globalBootstrapDone = true;

  const app = new HomeSwiper();
  app.bootstrap();
}
