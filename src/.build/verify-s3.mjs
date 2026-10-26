/**
 * verify-s3.mjs —— HomeSwiper S3（内容获取数据层）验证脚本
 * ---------------------------------------------------------------------------
 * 用法：  node .build/verify-s3.mjs
 *
 * 纯 Node 侧单测：设桩（localStorage / ApiClient / fetch，均带调用计数），
 * 直接 import `.build/plugin.js` 的具名导出逐用例断言。失败即 process.exitCode = 1。
 *
 * ⚠ 本脚本**不设置任何 DOM 全局**（Node 本就没有 document/window），
 *   以此证明 plugin.js 模块顶层不访问 DOM（能正常 import）。
 */

let pass = 0;
let fail = 0;

function record(okFlag, name, extra) {
  if (okFlag) {
    pass += 1;
    console.log("PASS  " + name);
  } else {
    fail += 1;
    console.log("FAIL  " + name + (extra ? "  → " + extra : ""));
    process.exitCode = 1;
  }
}

function ok(name, cond, extra) {
  record(!!cond, name, extra);
}

function deepEq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function eq(name, actual, expected) {
  record(deepEq(actual, expected), name, "actual=" + JSON.stringify(actual) + " expected=" + JSON.stringify(expected));
}

/* ------------------------------------------------------------------ *
 * 桩
 * ------------------------------------------------------------------ */

function makeStorage() {
  const map = new Map();
  return {
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      map.set(k, String(v));
    },
    removeItem(k) {
      map.delete(k);
    },
    _dump() {
      return Object.fromEntries(map);
    },
  };
}

/** 可编程的 ApiClient 桩（带调用计数）。 */
function makeApiClient(config) {
  const c = config || {};
  const state = {
    itemsCalls: [],
    viewsCalls: 0,
    getItemsImpl: c.getItemsImpl || (() => Promise.resolve({ Items: [], TotalRecordCount: 0 })),
  };
  return {
    _state: state,
    getCurrentUserId: () => c.userId || null,
    accessToken: () => c.token || null,
    serverId: () => c.serverId || null,
    serverAddress: () => c.base || "http://srv:8096",
    getItems(userId, query, signal) {
      state.itemsCalls.push({ userId, query, hasSignal: signal !== undefined && signal !== null });
      return state.getItemsImpl({ userId, query, signal });
    },
    getUserViews() {
      state.viewsCalls += 1;
      return Promise.resolve({
        Items: (c.libraries || []).map((l) => ({ Id: l.Id, Name: l.Name, CollectionType: l.CollectionType })),
        TotalRecordCount: (c.libraries || []).length,
      });
    },
  };
}

/** 极简 fake response。 */
function fakeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

function movieWithImage(id, name) {
  return {
    Id: id,
    Name: name || id,
    Type: "Movie",
    ImageTags: { Primary: "tag-" + id },
    BackdropImageTags: [],
    ParentBackdropItemId: null,
    ParentBackdropImageTags: [],
    Overview: "ov",
    Taglines: ["tl"],
  };
}

const sleep = () => new Promise((r) => setTimeout(r, 0));

/* ------------------------------------------------------------------ *
 * 0. 模块顶层不访问 DOM：无 DOM 全局下 import 必须成功
 * ------------------------------------------------------------------ */

console.log("== 0. 模块加载 ==");
ok("无 document/window 全局下，plugin.js 可被 import（顶层不访问 DOM）", typeof globalThis.document === "undefined" && typeof globalThis.window === "undefined");

const plugin = await import("./plugin.js");
const {
  HomeSwiper,
  readSettings,
  writeSettings,
  resolveLibId,
  extractLibId,
  buildItemsQuery,
  mapIncludeItemTypes,
  toQueryString,
  fetchPage,
  getPool,
  getVisibleLibraries,
  resetMemoryPools,
  poolKey,
  getStrategy,
  STRATEGIES,
  hasAnyImage,
  resolveUserId,
  resolveToken,
  createEnv,
  getGlobalApiClient,
  getStorage,
  settingsKey,
  SETTINGS_FIELD_DEFAULTS,
} = plugin;

ok("具名导出齐全（HomeSwiper/readSettings/writeSettings/fetchPage/getPool/buildItemsQuery/mapIncludeItemTypes/resolveLibId/getVisibleLibraries/STRATEGIES）",
  [HomeSwiper, readSettings, writeSettings, fetchPage, getPool, buildItemsQuery, mapIncludeItemTypes, resolveLibId, getVisibleLibraries, STRATEGIES].every((x) => x !== undefined));

/* ------------------------------------------------------------------ *
 * 1. 设置读写（七章）
 * ------------------------------------------------------------------ */

console.log("== 1. 设置读写 ==");
const UID = "user-1";
const KEY = settingsKey(UID);
eq("键名 = <userId>-swiperLibraryAccess", KEY, "user-1-swiperLibraryAccess");

const LIBS = [
  { Id: "L1" },
  { Id: "L2" },
  { Id: "L3" },
  { Id: "L4" },
  { Id: "L5" },
];

// 1a 全新
{
  const storage = makeStorage();
  const env = { storage };
  const s = readSettings(UID, env, LIBS);
  eq("全新数据：LibId 回落第一个库", s.LibId, "L1");
  eq("全新数据：其余字段补默认值", [s.PoolSize, s.ImageInterval, s.PlayTrailer, s.TrailerVolume, s.SelectionLogic], [20, 10000, true, 0.6, "shuffle"]);
}

// 1b 空对象
{
  const storage = makeStorage();
  storage.setItem(KEY, "{}");
  const s = readSettings(UID, { storage }, LIBS);
  eq("空对象：LibId→第一个库 / PoolSize 默认", [s.LibId, s.PoolSize], ["L1", 20]);
}

// 1c 只有 LibId
{
  const storage = makeStorage();
  storage.setItem(KEY, JSON.stringify({ LibId: "L2" }));
  const s = readSettings(UID, { storage }, LIBS);
  eq("只有 LibId：补齐其余默认值", [s.LibId, s.PoolSize, s.SelectionLogic], ["L2", 20, "shuffle"]);
}

// 1d 旧值四种形态迁移
{
  const cases = [
    ["旧值字符串(JSON)", JSON.stringify("L3"), "L3"],
    ["旧值裸字符串", "L4", "L4"],
    ["旧值数组取[0]", JSON.stringify(["L2", "L3"]), "L2"],
    ["旧值 Policy.EnabledFolders[0]", JSON.stringify({ Policy: { EnabledFolders: ["L3"] } }), "L3"],
    ["旧值 EnabledFolders[0]", JSON.stringify({ EnabledFolders: ["L4"] }), "L4"],
  ];
  for (const [name, raw, expected] of cases) {
    const storage = makeStorage();
    storage.setItem(KEY, raw);
    const s = readSettings(UID, { storage }, LIBS);
    eq("迁移 " + name, s.LibId, expected);
  }
}

// 1e EnableAllFolders:true + EnabledFolders 空 → 第一个库
{
  const storage = makeStorage();
  storage.setItem(KEY, JSON.stringify({ EnableAllFolders: true, EnabledFolders: [] }));
  const s = readSettings(UID, { storage }, LIBS);
  eq("EnableAllFolders:true + 空 EnabledFolders → 第一个库", s.LibId, "L1");
}

// 1f 迁移失败不写回
{
  const storage = makeStorage();
  const raw = JSON.stringify({ Policy: { EnabledFolders: ["L3"] } });
  storage.setItem(KEY, raw);
  readSettings(UID, { storage }, LIBS); // 触发一次读取（内含迁移）
  eq("迁移失败不写回：localStorage 原值未改动", storage.getItem(KEY), raw);
}

// 1g LibId 不在可见库列表 → 回落第一个库
{
  const storage = makeStorage();
  storage.setItem(KEY, JSON.stringify({ LibId: "ZZZ" }));
  const s = readSettings(UID, { storage }, LIBS);
  eq("LibId 不可见 → 回落第一个库", s.LibId, "L1");
}

// 1h resolveLibId 纯函数
{
  eq("resolveLibId(null) → 第一个库", resolveLibId(null, LIBS), "L1");
  eq("resolveLibId('L5') → 保持", resolveLibId("L5", LIBS), "L5");
  eq("extractLibId({LibId:{EnabledFolders:['L4']}}) 解包", extractLibId({ LibId: { EnabledFolders: ["L4"] } }).id, "L4");
}

// 1j 数字库 Id（本服实测：库 Id 是数字串，如 1593 而非 GUID）
{
  eq("extractLibId('1593') 字符串", extractLibId("1593").id, "1593");
  eq("extractLibId(1593) 数字 → 归一化成字符串", extractLibId(1593).id, "1593");
  eq("extractLibId(['1593']) 字符串数组", extractLibId(["1593"]).id, "1593");
  eq("extractLibId([1593]) 数字数组 → 归一化", extractLibId([1593]).id, "1593");
  eq("extractLibId({LibId:1593}) 新结构数字", extractLibId({ LibId: 1593 }).id, "1593");
  eq("extractLibId({Policy:{EnabledFolders:[1593]}}) 数字元素", extractLibId({ Policy: { EnabledFolders: [1593] } }).id, "1593");
  eq("extractLibId({EnabledFolders:[1593]}) 数字元素", extractLibId({ EnabledFolders: [1593] }).id, "1593");
  const realLibs = [{ Id: "3", Name: "2026秋季新番" }, { Id: "1589", Name: "番剧" }, { Id: "1593", Name: "剧场版" }];
  eq("resolveLibId(1593, 可见含1593) → 保持 1593", resolveLibId(1593, realLibs), "1593");
  const notVisible = [{ Id: "3", Name: "2026秋季新番" }, { Id: "1589", Name: "番剧" }];
  eq("resolveLibId(1593, 不可见) → 回落第一个库", resolveLibId(1593, notVisible), "3");
  // 迁移不丢已选库：数字串存值的读取必须命中同一库
  const storage = makeStorage();
  storage.setItem(KEY, JSON.stringify({ LibId: 1593 }));
  eq("存 {LibId:1593} → 读到 '1593'（迁移不丢库）", readSettings(UID, { storage }, realLibs).LibId, "1593");
}

// 1i writeSettings 往返
{
  const storage = makeStorage();
  const env = { storage };
  const written = writeSettings(UID, { LibId: "L3", PoolSize: 12 }, env);
  const s = readSettings(UID, env, LIBS);
  eq("writeSettings 写出并读回", [s.LibId, s.PoolSize, s.ImageInterval], ["L3", 12, 10000]);
  eq("writeSettings 归一化缺省字段", written.PlayTrailer, true);
}

/* ------------------------------------------------------------------ *
 * 2. 查询拼装（6.2）
 * ------------------------------------------------------------------ */

console.log("== 2. 查询拼装 ==");
{
  const q = buildItemsQuery({ libId: "L1", limit: 20, includeItemTypes: "Movie" });
  eq("ParentId", q.ParentId, "L1");
  eq("Recursive=true", q.Recursive, true);
  eq("SortBy=DateCreated", q.SortBy, "DateCreated");
  eq("SortOrder=Descending", q.SortOrder, "Descending");
  eq("Limit", q.Limit, 20);
  eq("ImageTypes=Primary,Backdrop", q.ImageTypes, "Primary,Backdrop");
  eq("Fields 含概况/标语/标签（含 ProductionYear、Genres，均见实测）", q.Fields, "Taglines,Overview,Genres,ParentId,LocalTrailerCount,OfficialRating,CommunityRating,CriticRating,ProductionYear");
  ok("Fields 必含 Overview/Taglines/Genres", q.Fields.indexOf("Overview") >= 0 && q.Fields.indexOf("Taglines") >= 0 && q.Fields.indexOf("Genres") >= 0);
  eq("IncludeItemTypes", q.IncludeItemTypes, "Movie");
  ok("绝不出现 DateLastSaved", JSON.stringify(q).indexOf("DateLastSaved") === -1, "query=" + JSON.stringify(q));
  ok("不请求 RemoteTrailers", JSON.stringify(q).indexOf("RemoteTrailers") === -1);
}

// IncludeItemTypes 自适应
{
  const map = [
    ["movies", "Movie"],
    ["tvshows", "Series"],
    ["musicvideos", "MusicVideo"],
    ["homevideos", "Video"],
    ["photos", "Photo"],
    ["boxsets", "BoxSet"],
  ];
  for (const [ct, exp] of map) eq("mapIncludeItemTypes(" + ct + ")", mapIncludeItemTypes(ct), exp);
  ok("未知类型 → 宽松集合", mapIncludeItemTypes("weird").indexOf("Movie") !== -1);
}

// toQueryString 跳过 null/空
{
  const qs = toQueryString({ A: 1, B: null, C: "", D: true, E: "x,y" });
  ok("toQueryString 跳过 null/空串，其余保留", qs.indexOf("A=1") !== -1 && qs.indexOf("B=") === -1 && qs.indexOf("C=") === -1 && qs.indexOf("D=true") !== -1 && qs.indexOf("E=x%2Cy") !== -1, "qs=" + qs);
}

/* ------------------------------------------------------------------ *
 * 3. fetchPage（形状 + 去过滤重试 + 丢无图条目）
 * ------------------------------------------------------------------ */

console.log("== 3. fetchPage ==");
await (async () => {
  // 3a 正常一页
  const api = makeApiClient({
    userId: "U1",
    serverId: "S1",
    getItemsImpl: () => Promise.resolve({ Items: [movieWithImage("a"), movieWithImage("b")], TotalRecordCount: 2 }),
  });
  const env = { apiClient: api, userId: "U1", serverId: "S1", now: () => 1 };
  const page = await fetchPage({ libId: "L1", collectionType: "movies", limit: 20 }, env);
  eq("fetchPage.items 数量", page.items.length, 2);
  eq("fetchPage.total", page.total, 2);
  eq("fetchPage 不再返回无用的 nextStartIndex（游标按调用方传入）", page.nextStartIndex, undefined);
  eq("一次请求即结束（调用数=1）", api._state.itemsCalls.length, 1);
  eq("首个请求带 IncludeItemTypes=Movie", api._state.itemsCalls[0].query.IncludeItemTypes, "Movie");
})();

// 3b 空结果 → 去过滤重试一次（调用数=2）
await (async () => {
  let n = 0;
  const api = makeApiClient({
    userId: "U1",
    serverId: "S1",
    getItemsImpl: () => {
      n += 1;
      if (n === 1) return Promise.resolve({ Items: [], TotalRecordCount: 0 });
      return Promise.resolve({ Items: [movieWithImage("c")], TotalRecordCount: 1 });
    },
  });
  const env = { apiClient: api, userId: "U1", serverId: "S1" };
  const page = await fetchPage({ libId: "L1", collectionType: "movies", limit: 20 }, env);
  eq("空结果去过滤重试：调用数=2", api._state.itemsCalls.length, 2);
  eq("第一次带 IncludeItemTypes", api._state.itemsCalls[0].query.IncludeItemTypes, "Movie");
  ok("第二次不带 IncludeItemTypes", api._state.itemsCalls[1].query.IncludeItemTypes === undefined);
  eq("重试后拿到 1 条", page.items.length, 1);
})();

// 3c 丢弃无任何配图的条目
await (async () => {
  const noImg = { Id: "x", Name: "x", ImageTags: {}, BackdropImageTags: [], ParentBackdropItemId: null, ParentBackdropImageTags: [] };
  const parentImg = { Id: "y", Name: "y", ImageTags: {}, BackdropImageTags: [], ParentBackdropItemId: "P", ParentBackdropImageTags: ["t"] };
  const api = makeApiClient({
    userId: "U1",
    serverId: "S1",
    getItemsImpl: () => Promise.resolve({ Items: [movieWithImage("a"), noImg, parentImg], TotalRecordCount: 3 }),
  });
  const env = { apiClient: api, userId: "U1", serverId: "S1" };
  const page = await fetchPage({ libId: "L1", collectionType: "movies", limit: 20 }, env);
  eq("丢弃无配图条目（保留 Primary + 父级 backdrop 两种）", page.items.map((i) => i.Id), ["a", "y"]);
  ok("hasAnyImage 判定", hasAnyImage(movieWithImage("z")) && hasAnyImage(parentImg) && !hasAnyImage(noImg));
})();

/* ------------------------------------------------------------------ *
 * 4. 内存池复用 + 失败兜底
 * ------------------------------------------------------------------ */

console.log("== 4. 池与缓存 ==");

// 4a 内存池复用（同 libId 两次 → 请求次数不增）
await (async () => {
  resetMemoryPools();
  const storage = makeStorage();
  const api = makeApiClient({
    userId: "U1",
    serverId: "S1",
    getItemsImpl: () => Promise.resolve({ Items: [movieWithImage("a")], TotalRecordCount: 1 }),
  });
  const env = { apiClient: api, storage, userId: "U1", serverId: "S1", now: () => 1 };
  const p1 = await getPool({ libId: "L1", collectionType: "movies", limit: 20 }, env);
  const p2 = await getPool({ libId: "L1", collectionType: "movies", limit: 20 }, env);
  eq("首次取池 source=network", p1.source, "network");
  eq("二次取池 source=memory（命中内存池）", p2.source, "memory");
  eq("同 libId 复用：请求次数仍为 1", api._state.itemsCalls.length, 1);
  eq("默认策略（随机换批）⇒ endBehavior=fetchMore", p1.endBehavior, "fetchMore");
  // 缓存键含 userId+serverId+libId
  eq("内存池键格式", poolKey("U1", "S1", "L1"), "U1|S1|L1");
})();

// 4b 失败兜底：无内存池 + 有缓存 → source=cache
await (async () => {
  resetMemoryPools();
  const storage = makeStorage();
  const api = makeApiClient({
    userId: "U1",
    serverId: "S1",
    getItemsImpl: () => Promise.reject(new Error("boom")),
  });
  const env = { apiClient: api, storage, userId: "U1", serverId: "S1", now: () => 1 };
  // 先塞一份缓存（键含 userId+serverId+libId）
  const cacheKey = "homeswiper.pool:U1|S1|Lc";
  storage.setItem(cacheKey, JSON.stringify({ libId: "Lc", items: [movieWithImage("cached")], total: 1, nextStartIndex: null, fetchedAt: 1 }));
  const p = await getPool({ libId: "Lc", collectionType: "movies", limit: 20 }, env);
  eq("拉取失败 + 有缓存 → source=cache", p.source, "cache");
  eq("缓存兜底条目数", p.items.length, 1);
})();

// 4c 失败兜底：无内存池 + 无缓存 → source=none
await (async () => {
  resetMemoryPools();
  const storage = makeStorage();
  const api = makeApiClient({
    userId: "U1",
    serverId: "S1",
    getItemsImpl: () => Promise.reject(new Error("boom")),
  });
  const env = { apiClient: api, storage, userId: "U1", serverId: "S1", now: () => 1 };
  const p = await getPool({ libId: "Lnocache", collectionType: "movies", limit: 20 }, env);
  eq("拉取失败 + 无缓存 → source=none", p.source, "none");
  eq("source=none 时 items 为空", p.items.length, 0);
  ok("source=none 携带 error", p.error instanceof Error);
})();

// 4d force=true 绕过内存池
await (async () => {
  resetMemoryPools();
  const storage = makeStorage();
  const api = makeApiClient({
    userId: "U1",
    serverId: "S1",
    getItemsImpl: () => Promise.resolve({ Items: [movieWithImage("a")], TotalRecordCount: 1 }),
  });
  const env = { apiClient: api, storage, userId: "U1", serverId: "S1", now: () => 1 };
  await getPool({ libId: "L1", collectionType: "movies", limit: 20 }, env);
  const p2 = await getPool({ libId: "L1", collectionType: "movies", limit: 20, force: true }, env);
  eq("force=true 重新拉取（source=network，调用数=2）", [p2.source, api._state.itemsCalls.length], ["network", 2]);
})();

/* ------------------------------------------------------------------ *
 * 5. 直连 REST 兜底（无 ApiClient）
 * ------------------------------------------------------------------ */

console.log("== 5. REST 兜底 ==");
await (async () => {
  const captured = [];
  const fetchImpl = (url, opts) => {
    captured.push({ url, opts });
    return Promise.resolve(fakeResponse(200, { Items: [movieWithImage("r1")], TotalRecordCount: 1 }));
  };
  const env = createEnv({ apiClient: null, fetchImpl, storage: makeStorage(), userId: "U9", serverBase: "http://srv:8096", token: "TOKEN123" });
  const page = await fetchPage({ libId: "Lrest", collectionType: "movies", limit: 20 }, env);
  eq("REST 兜底返回条目", page.items.length, 1);
  const u = captured[0].url;
  ok("URL 命中 /Users/U9/Items", u.indexOf("/Users/U9/Items?") !== -1, u);
  ok("URL 含 ParentId=Lrest", u.indexOf("ParentId=Lrest") !== -1, u);
  ok("URL 含 SortBy=DateCreated", u.indexOf("SortBy=DateCreated") !== -1, u);
  ok("URL 含 Recursive=true", u.indexOf("Recursive=true") !== -1, u);
  ok("URL 含 ImageTypes=Primary%2CBackdrop", u.indexOf("ImageTypes=Primary%2CBackdrop") !== -1, u);
  ok("URL 含 Fields=", u.indexOf("Fields=") !== -1, u);
  ok("带 X-Emby-Token 头", captured[0].opts.headers["X-Emby-Token"] === "TOKEN123");
  ok("透传 signal（此处 undefined 也接受）", "signal" in captured[0].opts);
})();

// 5b ApiClient 挂载点实测路径：getGlobalApiClient / getStorage
{
  const fakeApi = { tag: "api" };
  globalThis.ApiClient = fakeApi;
  ok("getGlobalApiClient() 读 globalThis.ApiClient（4.11 实测挂载点）", getGlobalApiClient() === fakeApi);
  const st = makeStorage();
  globalThis.localStorage = st;
  ok("getStorage() 读 globalThis.localStorage", getStorage() === st);
  delete globalThis.ApiClient;
  delete globalThis.localStorage;
  ok("未挂载时 getGlobalApiClient() 返回 null", getGlobalApiClient() === null);
}

/* ------------------------------------------------------------------ *
 * 6. getVisibleLibraries + 策略注册表
 * ------------------------------------------------------------------ */

console.log("== 6. 库列表 + 策略 ==");
await (async () => {
  const api = makeApiClient({ userId: "U1", libraries: [{ Id: "V1", Name: "电影", CollectionType: "movies" }, { Id: "V2", Name: "剧集", CollectionType: "tvshows" }] });
  const libs = await getVisibleLibraries({ apiClient: api, userId: "U1" });
  eq("getVisibleLibraries 返回 {Id,Name,CollectionType}", libs, [{ Id: "V1", Name: "电影", CollectionType: "movies" }, { Id: "V2", Name: "剧集", CollectionType: "tvshows" }]);
})();
await (async () => {
  const badApi = { getUserViews: () => Promise.reject(new Error("nope")) };
  const libs = await getVisibleLibraries({ apiClient: badApi, userId: "U1" });
  eq("getVisibleLibraries 失败 → 空数组、不抛", libs, []);
})();
{
  eq("STRATEGIES.recent.endBehavior=rewind", STRATEGIES.recent.endBehavior, "rewind");
  eq("策略不再有冗余的 startIndex 字段（游标由 fetchPage 参数决定）", STRATEGIES.recent.startIndex, undefined);
  eq("getStrategy 未知 id 回落默认策略（随机换批）", getStrategy("nope"), STRATEGIES.shuffle);
  ok("策略 id 与默认选择逻辑对齐（shuffle）", Object.prototype.hasOwnProperty.call(STRATEGIES, "shuffle") && SETTINGS_FIELD_DEFAULTS.SelectionLogic === "shuffle");
}

/* ------------------------------------------------------------------ *
 * 7. resolveUserId / resolveToken（ApiClient → 本地凭据兜底）
 * ------------------------------------------------------------------ */

console.log("== 7. 凭据兜底 ==");
{
  const storage = makeStorage();
  storage.setItem("servercredentials3", JSON.stringify({ Servers: [{ Id: "SRV", UserId: "U42", AccessToken: "TK42" }] }));
  const env = { storage };
  eq("resolveUserId 从 servercredentials3 兜底", resolveUserId(env), "U42");
  eq("resolveToken 从 servercredentials3 兜底", resolveToken(env), "TK42");
  const api = { getCurrentUserId: () => "UAPI", accessToken: () => "TKAPI" };
  eq("resolveUserId 优先 ApiClient", resolveUserId({ apiClient: api, storage }), "UAPI");
  eq("resolveToken 优先 ApiClient", resolveToken({ apiClient: api, storage }), "TKAPI");
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

await sleep();
console.log("\n== 汇总 ==");
console.log("PASS=" + pass + "  FAIL=" + fail);
if (fail > 0) {
  console.log("结果：FAILED");
  process.exitCode = 1;
} else {
  console.log("结果：ALL PASS");
}
