/**
 * verify-s4.mjs —— HomeSwiper S4（轮播主体）验证脚本
 * ---------------------------------------------------------------------------
 * 用法：  node .build/verify-s4.mjs
 *
 * 用「桩 DOM + 桩 Swiper」端到端跑 挂载 / 翻页 / 撤离，逐用例打印 PASS/FAIL；
 * 失败时 process.exitCode = 1。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log("PASS  " + name);
  } else {
    fail += 1;
    console.log("FAIL  " + name + (extra ? "  → " + extra : ""));
    process.exitCode = 1;
  }
}
function eq(name, a, b) {
  ok(name, JSON.stringify(a) === JSON.stringify(b), "actual=" + JSON.stringify(a) + " expected=" + JSON.stringify(b));
}

/* ------------------------------------------------------------------ *
 * 极简桩 DOM
 * ------------------------------------------------------------------ */

function matches(node, sel) {
  const s = String(sel).trim();
  const tagM = /^([a-zA-Z]+)/.exec(s);
  const classM = s.match(/\.([\w-]+)/);
  const attrM = s.match(/\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/);
  if (tagM && node.tagName !== tagM[1].toUpperCase()) return false;
  if (classM && !node._classes.has(classM[1])) return false;
  if (attrM) {
    const k = attrM[1];
    const v = attrM[2] !== undefined ? attrM[2] : attrM[3] !== undefined ? attrM[3] : attrM[4];
    if (!node.attributes.has(k)) return false;
    if (v !== undefined && node.attributes.get(k) !== v) return false;
  }
  return true;
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this._classes = new Set();
    this.style = {
      setProperty(k, v) {
        this[k] = String(v);
      },
      getPropertyValue(k) {
        return this[k] === undefined ? "" : String(this[k]);
      },
      removeProperty(k) {
        const v = this[k];
        delete this[k];
        return v;
      },
    };
    this._text = "";
    this._listeners = new Map();
    this.id = "";
  }
  set className(v) {
    this._classes = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get className() {
    return Array.from(this._classes).join(" ");
  }
  get classList() {
    const self = this;
    return {
      add(...cs) {
        cs.forEach((c) => self._classes.add(c));
      },
      remove(...cs) {
        cs.forEach((c) => self._classes.delete(c));
      },
      contains(c) {
        return self._classes.has(c);
      },
      toggle(c, f) {
        const on = f === undefined ? !self._classes.has(c) : !!f;
        if (on) self._classes.add(c);
        else self._classes.delete(c);
        return on;
      },
    };
  }
  set textContent(v) {
    this._text = String(v);
    this.childNodes = [];
  }
  get textContent() {
    if (this._text) return this._text;
    return this.childNodes.map((c) => c.textContent).join("");
  }
  setAttribute(k, v) {
    this.attributes.set(k, String(v));
  }
  getAttribute(k) {
    return this.attributes.has(k) ? this.attributes.get(k) : null;
  }
  removeAttribute(k) {
    this.attributes.delete(k);
  }
  hasAttribute(k) {
    return this.attributes.has(k);
  }
  appendChild(c) {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  insertBefore(c, ref) {
    if (c.parentNode) c.parentNode.removeChild(c);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(c);
    else this.childNodes.splice(i, 0, c);
    c.parentNode = this;
    return c;
  }
  removeChild(c) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  get firstChild() {
    return this.childNodes[0] || null;
  }
  get children() {
    return this.childNodes.filter((c) => c instanceof El);
  }
  contains(n) {
    let p = n;
    while (p) {
      if (p === this) return true;
      p = p.parentNode;
    }
    return false;
  }
  addEventListener(t, fn) {
    if (!this._listeners.has(t)) this._listeners.set(t, []);
    this._listeners.get(t).push(fn);
  }
  removeEventListener(t, fn) {
    const a = this._listeners.get(t);
    if (a) {
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    }
  }
  dispatch(t, ev) {
    (this._listeners.get(t) || []).slice().forEach((fn) => fn(ev || { type: t }));
  }
  click() {
    this.dispatch("click", { type: "click" });
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c instanceof El) {
          if (matches(c, sel)) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
}

class Doc {
  constructor() {
    this.body = new El("body");
    this.head = new El("head");
    this.documentElement = new El("html");
    this._listeners = new Map();
  }
  createElement(t) {
    return new El(t);
  }
  _all() {
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c instanceof El) {
          out.push(c);
          walk(c);
        }
      }
    };
    walk(this.body);
    walk(this.head);
    return out;
  }
  getElementById(id) {
    const all = this._all();
    for (const e of all) if (e.id === id || e.getAttribute("id") === id) return e;
    return null;
  }
  get scrollingElement() {
    return this.documentElement;
  }
  querySelector(sel) {
    return this.body.querySelector(sel) || this.head.querySelector(sel) || null;
  }
  querySelectorAll(sel) {
    return [].concat(this.body.querySelectorAll(sel), this.head.querySelectorAll(sel));
  }
  addEventListener(t, fn) {
    if (!this._listeners.has(t)) this._listeners.set(t, []);
    this._listeners.get(t).push(fn);
  }
  removeEventListener(t, fn) {
    const a = this._listeners.get(t);
    if (a) {
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    }
  }
  dispatch(t, ev) {
    (this._listeners.get(t) || []).slice().forEach((fn) => fn(ev || { type: t }));
  }
  listenerCount(t) {
    return (this._listeners.get(t) || []).length;
  }
}

/* ------------------------------------------------------------------ *
 * 桩：定时器 / AbortController / MutationObserver / Swiper
 * ------------------------------------------------------------------ */

function makeTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      const id = ++seq;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    runAll() {
      const items = Array.from(pending.entries());
      pending.clear();
      for (const [, t] of items) t.fn();
    },
    count() {
      return pending.size;
    },
  };
}

class FakeAbortController {
  constructor() {
    this.signal = { aborted: false };
  }
  abort() {
    this.signal.aborted = true;
  }
}

class FakeMutationObserver {
  constructor(cb) {
    this.cb = cb;
    this.disconnected = false;
  }
  observe() {}
  disconnect() {
    this.disconnected = true;
  }
}

/** 记录 observe 目标 / disconnect 的 MutationObserver 桩（§20：验证观察器是否跟到新宿主）。 */
class TrackingMO {
  constructor(cb) {
    this.cb = cb;
    this.target = null;
    this.disconnected = false;
    TrackingMO.instances.push(this);
  }
  observe(target) {
    this.target = target;
  }
  disconnect() {
    this.disconnected = true;
  }
  fire() {
    if (!this.disconnected && typeof this.cb === "function") this.cb([]);
  }
  static reset() {
    TrackingMO.instances = [];
  }
  static active() {
    return TrackingMO.instances.filter((o) => !o.disconnected);
  }
}
TrackingMO.instances = [];

/** 记录 observe 目标 / disconnect 的 ResizeObserver 桩。 */
class TrackingRO {
  constructor(cb) {
    this.cb = cb;
    this.target = null;
    this.disconnected = false;
    TrackingRO.instances.push(this);
  }
  observe(target) {
    this.target = target;
  }
  disconnect() {
    this.disconnected = true;
  }
  fire() {
    if (!this.disconnected && typeof this.cb === "function") this.cb([]);
  }
  static reset() {
    TrackingRO.instances = [];
  }
  static active() {
    return TrackingRO.instances.filter((o) => !o.disconnected);
  }
}
TrackingRO.instances = [];

class FakeSwiper {
  constructor(element, params) {
    this.el = element;
    this.params = params;
    // 桩也要认 initialSlide（真 Swiper 会用它决定起始页）
    this.activeIndex = typeof params.initialSlide === "number" ? params.initialSlide : 0;
    this.destroyed = false;
    this._handlers = params.on || {};
    this.slides = element.querySelectorAll(".swiper-slide");
    const self = this;
    this.autoplay = {
      running: false,
      start() {
        self.autoplay.running = true;
      },
      stop() {
        self.autoplay.running = false;
      },
    };
    FakeSwiper.instances.push(this);
  }
  emit(name) {
    const h = this._handlers[name];
    if (typeof h === "function") h(this);
  }
  _go(delta) {
    const n = Math.max(1, this.slides.length);
    this.activeIndex = (this.activeIndex + delta + n) % n;
    this.emit("slideChangeTransitionStart");
    this.emit("slideChange");
  }
  slideNext() {
    this._go(1);
  }
  slideTo(index) {
    this.slideToCalls = (this.slideToCalls || []).concat(index);
    this.activeIndex = index;
  }
  slidePrev() {
    this._go(-1);
  }
  destroy() {
    this.destroyed = true;
  }
}
FakeSwiper.instances = [];

/* ------------------------------------------------------------------ *
 * 环境装配
 * ------------------------------------------------------------------ */

const plugin = await import("./plugin.js");
const { HomeSwiper, IMAGE_TIERS, chooseImageTier, buildImageUrl, SWIPER_SPEED, buildRatingBadges, buildInfoModel, toJapaneseRating, usableGenres, QUERY_FIELDS, buildItemsQuery, settingsKey, resetMemoryPools, fetchPage, __resetWarnState, createEnv, readSettings, SORT_PRESETS, STRATEGIES } = plugin;

function makeItem(id, opts) {
  const o = opts || {};
  return {
    Id: String(id),
    Name: "作品" + id,
    Type: "Movie",
    ImageTags: { Primary: "p" + id, Logo: o.noLogo ? undefined : "l" + id },
    BackdropImageTags: o.noBackdrop ? [] : ["b" + id],
    Overview: "简介" + id,
    Taglines: o.taglines || [],
    Genres: o.genres || [],
    OfficialRating: o.cert || "JP:G / JP:0 / JP:0+",
    ProductionYear: 2025,
    CommunityRating: o.rating === undefined ? 7.5 : o.rating,
    LocalTrailerCount: 0,
    UserData: { PlaybackPositionTicks: 0 },
  };
}

function makeState(cfg) {
  const c = cfg || {};
  resetMemoryPools(); // 用例隔离：清内存池（模块级）
  __resetWarnState(); // 用例隔离：复位一次性警告
  const doc = new Doc();
  const timers = makeTimers();
  const storage = new Map();
  const patchStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };
  const tab = new El("div");
  tab.className = "tabContent";
  tab.setAttribute("data-index", "0");
  // 模拟 Emby：视图容器包住 tabContent（切视图时给祖先加 hide/page-hidden）
  const view = new El("div");
  view.className = "view";
  view.appendChild(tab);
  if (!c.noTabContent) {
    if (c.noViewWrapper) doc.body.appendChild(tab);
    else doc.body.appendChild(view);
  }

  const state = {
    doc,
    timers,
    storage,
    tab,
    view,
    reducedMotion: !!c.reducedMotion,
    portrait: !!c.portrait,
    mqls: [],
    items: c.items || [makeItem(1), makeItem(2), makeItem(3), makeItem(4), makeItem(5)],
    libraries: c.libraries || [{ Id: "1593", Name: "剧场版", CollectionType: "movies" }],
  };

  const win = {
    location: {
      hash: c.hash === undefined ? "#!/home" : c.hash,
      pathname: c.pathname === undefined ? "/web/index.html" : c.pathname,
    },
    devicePixelRatio: c.dpr || 1,
    innerWidth: c.innerWidth || 1600,
    innerHeight: c.innerHeight || 900,
    matchMedia(q) {
      const m = {
        _q: q,
        matches: false,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
      };
      if (q.indexOf("prefers-reduced-motion") >= 0) m.matches = !!state.reducedMotion;
      if (q.indexOf("orientation: portrait") >= 0) m.matches = !!state.portrait;
      state.mqls.push(m);
      return m;
    },
    MutationObserver: FakeMutationObserver,
    AbortController: FakeAbortController,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    addEventListener() {},
  };

  globalThis.document = doc;
  globalThis.window = win;
  globalThis.localStorage = patchStorage;

  // ApiClient 桩
  const apiClient = {
    getItemsCalls: [],
    getCurrentUserId: () => "U1",
    accessToken: () => "TK",
    serverId: () => "S1",
    serverAddress: () => "http://srv:8096",
    getItems(userId, query) {
      apiClient.getItemsCalls.push({ userId, query });
      if (c.getItemsImpl) return c.getItemsImpl({ userId, query });
      return Promise.resolve({ Items: state.items, TotalRecordCount: state.items.length });
    },
    getUserViews() {
      return Promise.resolve({
        Items: state.libraries.map((l) => ({ Id: l.Id, Name: l.Name, CollectionType: l.CollectionType })),
        TotalRecordCount: state.libraries.length,
      });
    },
  };
  state.apiClient = apiClient;
  state.win = win;
  state.timers = timers;
  state.rawStorage = patchStorage;

  // 设置：默认选中第一个库
  if (c.settings !== null) {
    patchStorage.setItem(
      settingsKey("U1"),
      JSON.stringify(c.settings || { LibId: state.libraries[0].Id }),
    );
  }

  state.env = {
    apiClient,
    storage: patchStorage,
    fetchImpl: null,
    userId: "U1",
    serverId: "S1",
    serverBase: "http://srv:8096",
    now: () => 1,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    requestAnimationFrame: (fn) => {
      fn();
      return 0;
    },
    cancelAnimationFrame: () => {},
  };
  return state;
}

function makeApp(state, opts) {
  const o = opts || {};
  return new HomeSwiper(
    Object.assign(
      { SwiperCtor: FakeSwiper, env: state.env, userId: "U1" },
      o,
    ),
  );
}

/** 造一个 Emby 式滚动容器（挂在宿主里，供滚轮转发命中）。 */
function addScrollFrame(state, sh, ch, top) {
  const el = new El("div");
  el.className = "scrollFrameY";
  el.scrollHeight = sh;
  el.clientHeight = ch;
  el.scrollTop = top;
  state.view.appendChild(el);
  return el;
}

/** 造一个任意类名的元素并挂到 parent 下（候选链测试用）。 */
function addEl(parent, className, sh, ch, top) {
  const el = new El("div");
  el.className = className;
  if (sh !== undefined) el.scrollHeight = sh;
  if (ch !== undefined) el.clientHeight = ch;
  if (top !== undefined) el.scrollTop = top;
  parent.appendChild(el);
  return el;
}

const sleep = () => new Promise((r) => setTimeout(r, 0));

/* ------------------------------------------------------------------ *
 * 纯函数
 * ------------------------------------------------------------------ */

console.log("== 0. 纯函数 ==");
{
  // 随机换批：策略声明 + 越界语义
  {
    // 随机换批模式：Swiper 必须关掉 rewind（否则越界被 Swiper 先回卷，插件收不到）
    FakeSwiper.instances = [];
    const state = makeState({ settings: { SelectionLogic: "shuffle" } });
    const app = makeApp(state);
    await app.start();
    ok("随机换批：isShuffleMode() 为真", app.isShuffleMode() === true);
    eq("随机换批：Swiper rewind = false", app.swiperParams.rewind, false);
    app.teardown();
    FakeSwiper.instances = [];
    const state2 = makeState({});
    const app2 = makeApp(state2);
    await app2.start();
    eq("默认（随机换批）：isShuffleMode 为真、rewind = false", [app2.isShuffleMode(), app2.swiperParams.rewind], [true, false]);
    app2.teardown();
  }
  {
    // 随机换批：边缘导航必须真的换一批（而不是交给 Swiper）
    FakeSwiper.instances = [];
    const state = makeState({ settings: { SelectionLogic: "shuffle", PoolSize: 20, LibId: "1593" } });
    const queries = [];
    let callNo = 0;
    state.env.apiClient = {
      getItems: (uid, q) => {
        queries.push(q);
        callNo += 1;
        const items = Array.from({ length: 20 }, (_, k) => ({
          Id: "c" + callNo + "_" + k,
          Name: "x",
          ImageTags: { Primary: "p" },
          BackdropImageTags: ["b"],
        }));
        return { Items: items, TotalRecordCount: 134 };
      },
    };
    const app = makeApp(state);
    await app.start();
    app._windowTotal = 134;
    const sw = FakeSwiper.instances[0];
    app.activePoolIndex = () => 19; // 站在批尾
    const before = app.pool.map((i) => i.Id).join(",");
    let swapErr = null;
    try {
      await app.swapWindow(1);
    } catch (e) {
      swapErr = e;
    }
    await sleep();
    ok("随机换批：边缘前进触发了取数", queries.length >= 1, "queries=" + queries.length + " err=" + (swapErr && swapErr.message) + " total=" + app._windowTotal + " size=" + app.pool.length);
    eq("随机换批：靠服务端 SortBy=Random", queries[queries.length - 1].SortBy, "Random");
    eq("随机换批：不再用 startIndex 偏移", queries[queries.length - 1].StartIndex, undefined);
    ok("随机换批：整批被替换", app.pool.map((i) => i.Id).join(",") !== before);
    eq("随机换批：落在新批第 1 条", sw.slideToCalls[sw.slideToCalls.length - 1], 0);
    app.teardown();
  }
  ok("随机换批：endBehavior = fetchMore", STRATEGIES.shuffle.endBehavior === "fetchMore" && STRATEGIES.shuffle.label === "随机换批");
  ok("其它三种仍是 rewind", STRATEGIES.recent.endBehavior === "rewind" && STRATEGIES.rating.endBehavior === "rewind" && STRATEGIES.watched.endBehavior === "rewind");
  ok("换批取用 SortBy=Random（真随机抽样，不是连续段）", SORT_PRESETS.shuffle.sortBy === "Random");
}

{
  // fetchPage：排序要真的到查询里；被拒时回落，不抛
  const calls = [];
  const mkEnv = (failFirst) => {
    let n = 0;
    return {
      userId: "U1",
      serverId: "S1",
      serverBase: "http://srv:8096",
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      apiClient: {
        getItems: (uid, params) => {
          calls.push(params.SortBy);
          n += 1;
          if (failFirst && n === 1) throw new Error("400 Bad Request");
          return { Items: [{ Id: "1", Name: "a", ImageTags: { Primary: "x" }, BackdropImageTags: [] }], TotalRecordCount: 1 };
        },
      },
      now: () => 1,
    };
  };
  await fetchPage({ libId: "L1", limit: 5, sortBy: "PremiereDate,DateCreated", sortOrder: "Descending,Descending" }, mkEnv(false));
  ok("fetchPage 能把自定义 SortBy 传给服务端", calls[0] === "PremiereDate,DateCreated");
  const okEnv = mkEnv(true);
  const res = await fetchPage({ libId: "L1", limit: 5, sortBy: "PremiereDate,DateCreated", sortOrder: "Descending,Descending" }, okEnv);
  ok("排序被拒（400）时回落最近入库并照常返回内容", calls[calls.length - 1] === "DateCreated" && res.items.length === 1);
}

{
  // v1.1 · 排序选项：预设表 + 查询透传 + 池键隔离
  ok("排序预设 recent 保持 DateCreated↓（不改变 v1.0 行为）", SORT_PRESETS.recent.sortBy === "DateCreated" && SORT_PRESETS.recent.sortOrder === "Descending");
  const q1 = buildItemsQuery({ libId: "L1", limit: 20 });
  ok("buildItemsQuery 默认仍是 DateCreated", q1.SortBy === "DateCreated" && q1.SortOrder === "Descending");
  const q2 = buildItemsQuery({ libId: "L1", limit: 20, sortBy: "PremiereDate,DateCreated", sortOrder: "Descending,Descending" });
  ok("buildItemsQuery 透传排序", q2.SortBy === "PremiereDate,DateCreated" && q2.SortOrder === "Descending,Descending");
{
  // 数量必须跟着设置走：limit 原样透传，不做放大取样
  const seen = [];
  const env2 = {
    userId: "U1",
    serverId: "S1",
    serverBase: "http://srv:8096",
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    apiClient: {
      getItems: (uid, params) => {
        seen.push([params.SortBy, params.Limit]);
        return { Items: [{ Id: "1", Name: "a", ImageTags: { Primary: "x" }, BackdropImageTags: [] }], TotalRecordCount: 1 };
      },
    },
    now: () => 1,
  };
  await STRATEGIES.rating.load({ libId: "L1", limit: 7 }, env2);
  await STRATEGIES.watched.load({ libId: "L1", limit: 9 }, env2);
  ok("评分最高：Limit 与 SortBy 都按设置透传", seen[0][0] === "CommunityRating,DateCreated" && seen[0][1] === 7, JSON.stringify(seen[0]));
  ok("最近观看：Limit 与 SortBy 都按设置透传", seen[1][0] === "DatePlayed,DateCreated" && seen[1][1] === 9, JSON.stringify(seen[1]));
}
  ok("策略表：随机换批（默认）/ 最近入库 / 评分最高 / 最近观看（顺序即下拉顺序）", Object.keys(STRATEGIES).join(",") === "shuffle,recent,rating,watched");
  ok("评分最高预设带第二键（未评分多为 0）", SORT_PRESETS.rating.sortBy === "CommunityRating,DateCreated");
  ok("最近观看预设按 DatePlayed 倒序", SORT_PRESETS.watched.sortBy === "DatePlayed,DateCreated" && SORT_PRESETS.watched.sortOrder === "Descending,Descending");
  ok("三个策略标签正确", STRATEGIES.recent.label === "最近入库" && STRATEGIES.rating.label === "评分最高" && STRATEGIES.watched.label === "最近观看");
}

{
  // 契约测试：信息层消费的每个字段都必须在 Fields 里，缺一个就会静默空着
  // （真机 bug：Genres 没进 Fields ⇒ 标签行永远不渲染）
  const needed = ["Overview", "Taglines", "Genres", "OfficialRating", "CommunityRating", "CriticRating", "ProductionYear"];
  const list = QUERY_FIELDS.split(",");
  eq("信息层消费的字段全部在 Fields 里", needed.filter((f) => list.indexOf(f) < 0), []);
  ok("buildItemsQuery 的 Fields 含 Genres", String(buildItemsQuery({ libId: "1", limit: 5 }).Fields).indexOf("Genres") >= 0);
}
eq("chooseImageTier(800,1) → 960", chooseImageTier(800, 1), 960);
eq("chooseImageTier(1000,1) → 1280", chooseImageTier(1000, 1), 1280);
eq("chooseImageTier(1600,1) → 1920", chooseImageTier(1600, 1), 1920);
eq("chooseImageTier(4000,1) → 上限 1920", chooseImageTier(4000, 1), 1920);
eq("chooseImageTier(800,2) → 1920", chooseImageTier(800, 2), 1920);
eq("档位集合", IMAGE_TIERS, [960, 1280, 1920]);
ok("buildImageUrl 带 query", buildImageUrl("http://s/x", { itemId: "1", type: "Backdrop", index: 0, tag: "t", maxWidth: 960, quality: 90 }).indexOf("maxWidth=960") >= 0);
{
  const it = makeItem(9, { rating: 8.1 });
  it.CriticRating = 7.2;
  eq("评分徽章最多 3 个（此处 2 个）", buildRatingBadges(it).length, 2);
  const model = buildInfoModel(it, { base: "http://s" });
  ok("有 Logo → logoUrl", !!model.logoUrl);
  ok("元信息含分级（已归一成日规）", model.cert === "G");
  ok("元信息含年份", model.year === "2025");
  {
    // 分级归一：真机出现过的十几种写法 → 日规四档
    const cases = [
      ["JP:G / JP:0 / JP:0+", "G"],
      ["JP:PG-12 / JP:PG12 / JP:12 / JP:12+", "PG12"],
      ["JP:R15+ / JP:15 / JP:15+", "R15+"],
      ["JP-18+", "R18+"],
      ["TV-14", "PG12"],
      ["TV-MA", "R15+"],
      ["BR-12", "PG12"],
      ["BR-L", "G"],
      ["SG-PG13", "PG12"],
      ["SG-NC16", "R15+"],
      ["TW-6+", "G"],
      ["PL-18", "R18+"],
      ["FR-12", "PG12"],
      ["DE:FSK 18 / DE:FSK-18 / DE:FSK18", "R18+"],
      ["US:TV-MA", "R15+"],
      ["AU-M", "R15+"],
      ["ES-18", "R18+"],
      ["18", "R18+"],
      ["NR", null],
      ["", null],
      [null, null],
    ];
    eq(
      "分级归一为日规四档（20 种真机写法）",
      cases.map(([raw]) => toJapaneseRating(raw)),
      cases.map(([, want]) => want),
    );
  }
  {
    const empty = buildInfoModel({ Name: "x", ImageTags: {} }, { base: "http://s" });
    ok("无标语时 tagline 为空串", empty.tagline === "");
    ok("无简介时 overview 为空串", empty.overview === "");
    // 番剧库真实形态：动画 / Sci-Fi & Fantasy / 喜剧 / 动作冒险
    const gen = makeItem(4);
    gen.Genres = ["动画", "Sci-Fi & Fantasy", "喜剧", "动作冒险", "剧情"];
    const gm = buildInfoModel(gen, { base: "http://s" });
    eq("去掉恒定的「动画」+ 英文本地化 + 裁到 3 个", gm.genres, ["科幻", "喜剧", "动作冒险"]);
    eq("超出部分折算成 +N", gm.genreExtra, 1);
    eq("「动画」不再作为标签出现", usableGenres(["动画", "動畫", "喜剧"]), ["喜剧"]);
    eq(
      "同一概念多种写法归一后去重（科幻 / Sci-Fi & Fantasy / 科幻奇幻 → 科幻）",
      usableGenres(["科幻", "Sci-Fi & Fantasy", "科幻奇幻", "剧情"]),
      ["科幻", "剧情"],
    );
    eq(
      "脏值过滤（片商/发行/系列/字幕/分辨率/纯数字）",
      usableGenres(["无毛", "中文字幕", "1080P", "4K", "片商: kawaii", "发行: HHHグループ", "系列: 某某", "12"]),
      ["无毛"],
    );
    eq("空/非数组容错", [usableGenres(null), usableGenres(undefined), usableGenres("x")], [[], [], []]);
    const both = makeItem(3);
    both.Taglines = ["真正的标语"];
    const m2 = buildInfoModel(both, { base: "http://s" });
    eq("标语与简介是两个字段，不再二选一", [m2.tagline, m2.overview], ["真正的标语", "简介3"]);
    const dated = makeItem(3);
    dated.Taglines = ["发行日期: 2026-09-19"];
    eq("「发行日期」类标语被丢弃（真机 179/200 条是这种元数据）", buildInfoModel(dated, { base: "http://s" }).tagline, "");
  }
}

/* ------------------------------------------------------------------ *
 * 1. 挂载 + DOM 结构
 * ------------------------------------------------------------------ */

console.log("== 1. 挂载与 DOM ==");
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  await app.start();

  eq("建 pool.length 个 slide", app.slideEls.length, 5);
  eq("每个 slide 有 data-pool-index", app.slideEls.map((s) => s.getAttribute("data-pool-index")), ["0", "1", "2", "3", "4"]);
  ok("slide 内只有 1 个节点且是 <img>", app.slideEls.every((s) => s.childNodes.length === 1 && s.childNodes[0].tagName === "IMG"));
  ok("每个 <img> 都有 data-src", app.imgEls.every((im) => !!im.getAttribute("data-src")));
  eq("首屏预置前 2 张（img0/img1 有 src）", [!!app.imgEls[0].getAttribute("src"), !!app.imgEls[1].getAttribute("src")], [true, true]);
  ok("其余 img 初始无 src（只有 data-src）", !app.imgEls[2].getAttribute("src") && !app.imgEls[3].getAttribute("src") && !app.imgEls[4].getAttribute("src"));

  // 层级顺序：hotzone 排在箭头之前
  const root = app.root;
  const kids = root.children.map((c) => c.className);
  const iHotPrev = kids.indexOf("hs-hotzone hs-hotzone--prev");
  const iPrevBtn = kids.indexOf("swiper-button-prev");
  ok("热区排在箭头之前入 DOM", iHotPrev >= 0 && iPrevBtn >= 0 && iHotPrev < iPrevBtn, JSON.stringify(kids));
  ok("根容器有深色底/相对定位契约（class 为 hs-root）", !!root.classList.contains("hs-root"));

  // aria
  eq("根容器 role", root.getAttribute("role"), "region");
  eq("根容器 aria-label", root.getAttribute("aria-label"), "首页轮播");
  eq("箭头 tabindex/role/aria-label", [app.prevBtn.getAttribute("tabindex"), app.prevBtn.getAttribute("role"), app.prevBtn.getAttribute("aria-label")], ["0", "button", "上一个"]);
  ok("信息层无暂停按钮（.hs-pause 已移除）", !app.root.querySelector(".hs-pause"));
})();

/* ------------------------------------------------------------------ *
 * 2. Swiper 配置
 * ------------------------------------------------------------------ */

console.log("== 2. Swiper 配置 ==");
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  await app.start();
  const p = app.swiperParams;
  eq("effect=fade", p.effect, "fade");
  eq("fadeEffect.crossFade=true", p.fadeEffect.crossFade, true);
  eq("loop=false", p.loop, false);
  eq("默认（随机换批）⇒ rewind=false", p.rewind, false);
  eq("simulateTouch=false", p.simulateTouch, false);
  eq("speed 与 SWIPER_SPEED 一致", p.speed, SWIPER_SPEED);
  ok("navigation 显式传 prevEl/nextEl", p.navigation.prevEl === app.prevBtn && p.navigation.nextEl === app.nextBtn);
  eq("不用 Swiper 的 autoplay（计时统一由 startImagePhase 负责，避免双翻页）", p.autoplay, false);
  ok("preventInteractionOnTransition=true", p.preventInteractionOnTransition === true);
})();

/* ------------------------------------------------------------------ *
 * 3. 懒加载窗口 + 图片档位
 * ------------------------------------------------------------------ */

console.log("== 3. 懒加载 + 图片档位 ==");
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({ innerWidth: 800, dpr: 1 }); // → 档位 960
  const app = makeApp(state);
  await app.start();
  const sw = app.swiper;

  ok("图片 URL 含离散档位 maxWidth=960", app.imgEls[0].getAttribute("data-src").indexOf("maxWidth=960") >= 0, app.imgEls[0].getAttribute("data-src"));
  ok("图片 URL 不含写死的 maxWidth=1920", app.imgEls[0].getAttribute("data-src").indexOf("maxWidth=1920") < 0);

  // 翻到 i=1
  sw.activeIndex = 1;
  sw.emit("slideChangeTransitionStart");
  sw.emit("slideChange");
  state.timers.runAll(); // flush 200ms 防抖

  const withSrc = app.imgEls.map((im, i) => (im.getAttribute("src") ? i : -1)).filter((i) => i >= 0);
  eq("翻到 1 后 [0,1,2] 被赋 src", withSrc, [0, 1, 2]);
  ok("同一时刻 src 集合 ≤ 3", withSrc.length <= 3);

  // 再次同一页：不重复
  sw.emit("slideChange");
  state.timers.runAll();
  const withSrc2 = app.imgEls.map((im, i) => (im.getAttribute("src") ? i : -1)).filter((i) => i >= 0);
  eq("重复滑到同一页不新增 src", withSrc2, [0, 1, 2]);

  // 赋过的 src 等于 data-src
  eq("已赋 src 与 data-src 一致", app.imgEls[2].getAttribute("src"), app.imgEls[2].getAttribute("data-src"));
})();

/* ------------------------------------------------------------------ *
 * 4. start() 幂等
 * ------------------------------------------------------------------ */

console.log("== 4. start() 幂等 ==");
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  await app.start();
  await app.start();
  await app.start();
  eq("连调 3 次 start()：只有 1 个 Swiper 实例", FakeSwiper.instances.length, 1);
  eq("连调 3 次 start()：只有 1 个根容器", state.doc.body.querySelectorAll(".hs-root").length, 1);
})();

/* ------------------------------------------------------------------ *
 * 5. 撤离干净 + viewbeforeshow 监听保留 + 可重挂
 * ------------------------------------------------------------------ */

console.log("== 5. 撤离 ==");
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  app.bootstrap();
  await app.mountPromise;
  eq("bootstrap 后 viewbeforeshow 监听数=1", state.doc.listenerCount("viewbeforeshow"), 1);
  ok("挂载后根容器在", !!state.doc.querySelector(".hs-root"));

  app.teardown();
  eq("撤离后无 .hs-root", state.doc.querySelector(".hs-root"), null);
  eq("撤离后无 video 元素", state.doc.querySelectorAll("video").length, 0);
  eq("撤离后 body 无 hs-home", state.doc.body.classList.contains("hs-home"), false);
  eq("撤离后定时器表已清", state.timers.count(), 0);
  eq("撤离后 viewbeforeshow 监听仍在（防回不来的坑）", state.doc.listenerCount("viewbeforeshow"), 1);

  // 再次 start 能重挂
  await app.start();
  ok("再次 start() 重新挂上根容器", !!state.doc.querySelector(".hs-root"));
  ok("再次 start() 新建 Swiper 实例", FakeSwiper.instances.length === 2);

  // 离开首页：移除容器 + 改 hash → 派发视图事件 → 撤离
  state.tab.remove();
  state.win.location.hash = "#!/item?id=1";
  state.doc.dispatch("viewbeforeshow", { detail: { type: "item" } });
  state.timers.runAll(); // ★ 待拆改为延迟复检：推进复检窗口 → 仍非 home → teardown
  eq("离开首页派发视图事件 → 撤离（DOM 判定）", state.doc.querySelector(".hs-root"), null);
})();

/* ------------------------------------------------------------------ *
 * 6. prefers-reduced-motion
 * ------------------------------------------------------------------ */

console.log("== 6. 减弱动效 ==");
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({ reducedMotion: true });
  const app = makeApp(state);
  await app.start();
  eq("reduced-motion：speed=0", app.swiperParams.speed, 0);
  eq("reduced-motion：不启 autoplay（autoplay=false）", app.swiperParams.autoplay, false);
})();

/* ------------------------------------------------------------------ *
 * 7. 占位态（source none / 空池）
 * ------------------------------------------------------------------ */

console.log("== 7. 占位态 ==");
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({
    items: [],
    getItemsImpl: () => Promise.resolve({ Items: [], TotalRecordCount: 0 }),
  });
  const app = makeApp(state);
  await app.start();
  ok("空池 → root.is-placeholder", app.root.classList.contains("is-placeholder"));
  ok("占位文案非空", !!app.placeholderEl.textContent);
  ok("占位态不建 Swiper 实例", FakeSwiper.instances.length === 0);

  // CSS 侧：占位态隐藏 PLAY/DETAIL/进度条/箭头/信息层
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const css = fs.readFileSync(path.join(__dirname, "styles.css"), "utf8");
  const blocks = css.match(/[^{}]*is-placeholder[^{}]*\{[^}]*\}/g) || [];
  const hideBlock = blocks.filter((b) => b.indexOf(".hs-info__actions") >= 0)[0] || "";
  ok("占位态隐藏块含 .hs-info__actions", hideBlock.indexOf(".hs-info__actions") >= 0);
  ok("占位态隐藏块含 .swiper-button-prev", hideBlock.indexOf(".swiper-button-prev") >= 0);
  ok("占位态隐藏块含 .hs-info__inner", hideBlock.indexOf(".hs-info__inner") >= 0);
  ok("占位态隐藏块为 display:none", /display:\s*none/.test(hideBlock));
})();

/* ------------------------------------------------------------------ *
 * 8. 入口门（DOM 判定）+ 启动自愈重试（缺陷 A / B 的证伪用例）
 * ------------------------------------------------------------------ */

console.log("== 8. 入口门 + 启动自愈重试 ==");

// ① detail.type 不是 "home"（"undefined"）但容器在 → 仍挂载
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({ hash: "#!/home", noTabContent: true });
  const app = makeApp(state);
  app.bootstrap(); // 自查时无容器 → 未挂载 + 排重试
  ok("① 首次自查无容器 → 未挂载", !state.doc.querySelector(".hs-root"));
  state.doc.body.appendChild(state.tab); // 容器出现
  state.doc.dispatch("viewbeforeshow", { detail: { type: "undefined" } }); // type 非 home
  await app.mountPromise;
  ok("① detail.type 非 home 仍挂载（DOM 判定）", !!state.doc.querySelector(".hs-root"));
  eq("① 三个视图事件监听都挂了", [state.doc.listenerCount("viewbeforeshow"), state.doc.listenerCount("pagebeforeshow"), state.doc.listenerCount("viewshow")], [1, 1, 1]);
})();

// ② 首次无容器 → 之后容器出现 + 推进 300ms → 自动挂载
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({ hash: "#!/home", noTabContent: true });
  const app = makeApp(state);
  await app.start();
  ok("② 首次无容器 → 未挂载", !state.doc.querySelector(".hs-root"));
  eq("② 已排一次重试定时器", state.timers.count(), 1);
  state.doc.body.appendChild(state.tab);
  state.timers.runAll(); // 推进 300ms
  await app.mountPromise;
  ok("② 容器出现后自动挂载成功", !!state.doc.querySelector(".hs-root"));
})();

// ③ 重试有上限：容器始终不存在 → 停止、warn 一次、定时器表清空
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({ hash: "#!/home", noTabContent: true });
  const app = makeApp(state);
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  await app.start();
  let guard = 0;
  while (state.timers.count() > 0 && guard++ < 500) state.timers.runAll();
  console.warn = orig;
  ok("③ 始终无容器 → 未挂载", !state.doc.querySelector(".hs-root"));
  eq("③ 重试到上限后定时器表清空", state.timers.count(), 0);
  eq("③ 超限不产生 warn（降噪，走 dbg）", warns.length, 0);
  ok("③ 重试次数达上限（>=20）", app.mountRetries >= 20);
})();

// ④ 撤离清重试定时器 + 三个监听都保留 + 再触发能重挂
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  app.bootstrap();
  await app.mountPromise;
  ok("④ 已挂载", !!state.doc.querySelector(".hs-root"));
  app.teardown();
  eq("④ 撤离后无 .hs-root", state.doc.querySelector(".hs-root"), null);
  eq("④ 撤离后定时器表清空", state.timers.count(), 0);
  eq("④ 三个视图事件监听都保留", [state.doc.listenerCount("viewbeforeshow"), state.doc.listenerCount("pagebeforeshow"), state.doc.listenerCount("viewshow")], [1, 1, 1]);
  state.doc.dispatch("viewshow", { detail: { type: "home" } });
  await app.mountPromise;
  ok("④ 再次触发视图事件 → 重新挂载", !!state.doc.querySelector(".hs-root"));
})();

// ⑤ 非首页派发视图事件 → teardown() 而非 start()
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({ hash: "#!/home", noTabContent: true });
  const app = makeApp(state);
  app.bootstrap();
  state.doc.body.appendChild(state.tab);
  state.doc.dispatch("viewbeforeshow", { detail: { type: "home" } });
  await app.mountPromise;
  ok("⑤ 首页事件已挂载", !!state.doc.querySelector(".hs-root"));
  // 切到非首页
  state.tab.remove();
  state.win.location.hash = "#!/item?id=9";
  state.doc.dispatch("viewshow", { detail: { type: "item" } });
  state.timers.runAll(); // ★ 待拆改为延迟复检：推进复检窗口 → teardown
  eq("⑤ 非首页视图事件 → 撤离（而非重挂）", state.doc.querySelector(".hs-root"), null);
})();



/* ------------------------------------------------------------------ *
 * 9. isHome 认「视图被隐藏」（缺陷 C：4.7 add hide / 4.11 add page-hidden，都不 remove）
 * ------------------------------------------------------------------ */

console.log("== 9. isHome 隐藏视图判定 ==");

// ① 祖先带 hide（4.7）→ isHome 假 → 撤离
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  app.bootstrap();
  await app.mountPromise;
  ok("① 初始已挂载", !!state.doc.querySelector(".hs-root"));
  state.view.classList.add("hide"); // 4.7 形态
  state.win.location.hash = "#!/item?id=1";
  state.doc.dispatch("viewbeforeshow", { detail: { type: "item" } });
  state.timers.runAll(); // ★ 待拆改为延迟复检：推进复检窗口 → 仍非 home → teardown
  eq("① hide 视图下 → 撤离（.hs-root 移除）", state.doc.querySelector(".hs-root"), null);
  eq("① body.hs-home 已摘除", state.doc.body.classList.contains("hs-home"), false);
})();

// ② 祖先带 page-hidden（4.11）
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  app.bootstrap();
  await app.mountPromise;
  state.view.classList.add("page-hidden"); // 4.11 形态
  state.win.location.hash = "#!/item?id=2";
  state.doc.dispatch("viewshow", { detail: { type: "item" } });
  state.timers.runAll(); // ★ 待拆改为延迟复检：推进复检窗口 → teardown
  eq("② page-hidden 视图下 → 撤离", state.doc.querySelector(".hs-root"), null);
})();

// ③ 回来路径：去掉 hide + hash 回 home → 再派事件 → 重新挂载
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  app.bootstrap();
  await app.mountPromise;
  state.view.classList.add("hide");
  state.win.location.hash = "#!/item?id=1";
  state.doc.dispatch("viewbeforeshow", { detail: { type: "item" } });
  state.timers.runAll(); // ★ 待拆改为延迟复检：推进复检窗口 → teardown
  eq("③ 已撤离", state.doc.querySelector(".hs-root"), null);
  state.view.classList.remove("hide");
  state.win.location.hash = "#!/home";
  state.doc.dispatch("viewshow", { detail: { type: "home" } });
  await app.mountPromise;
  ok("③ 回首页后重新挂载成功（防「撤不回来」）", !!state.doc.querySelector(".hs-root"));
})();

// ④ hash=#!/home 时即使祖先带 hide 仍为 true（hash 优先）
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({ hash: "#!/home" });
  const app = makeApp(state);
  app.bootstrap();
  await app.mountPromise;
  state.view.classList.add("hide");
  eq("④ hash home 优先 → isHome 真", app.isHome(), true);
})();

// ⑤ hash 空 + pathname 是入口壳（…/index.html，不含路由信息）+ 容器可见 → 真（早注入窗口 DOM 兜底）
await (async () => {
  const state = makeState({ hash: "" }); // pathname 默认 "/web/index.html"（壳）
  const app = makeApp(state);
  eq("⑤ hash 空 + 壳 pathname + 容器可见 → isHome 真", app.isHome(), true);
})();

// ⑤b hash 与 pathname 都空 + 容器可见 → 真（仅剩的早注入真空窗口才允许 DOM 兜底）
await (async () => {
  const state = makeState({ hash: "", pathname: "" });
  const app = makeApp(state);
  eq("⑤b 路由信息全空 + 容器可见 → isHome 真", app.isHome(), true);
})();

// ⑤c hash 非空但非 home（库页）→ **假**：路由权威，绝不落 DOM 兜底
//     （4.11 库页 DOM 里也有可见 .tabContent[data-index="0"]，旧兜底在此误判 ⇒ 轮播挂进库页）
await (async () => {
  const state = makeState({ hash: "#!/list/list.html?parentId=1593" });
  const app = makeApp(state);
  eq("⑤c 库页 hash + 可见容器 → isHome 假（hash 权威）", app.isHome(), false);
})();

/* ------------------------------------------------------------------ *
 * 10. history 路由（缺陷 D）+ 诊断可观测性
 * ------------------------------------------------------------------ */

console.log("== 10. history 路由 + 诊断 ==");

// ① hash="" 且容器不存在 → start() 必须排重试（不许静默返回）
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({ hash: "", noTabContent: true });
  const app = makeApp(state);
  await app.start();
  ok("① 容器缺失 → 未挂载", !state.doc.querySelector(".hs-root"));
  eq("① 排了重试定时器（非静默）", state.timers.count(), 1);
  eq("① mountRetries=1", app.mountRetries, 1);
})();

// ② hash=""、容器在第 2 次重试时才出现 → 自动挂载
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({ hash: "", noTabContent: true });
  const app = makeApp(state);
  await app.start(); // 排 #1
  state.timers.runAll(); // #1 触发：无容器 → 排 #2
  eq("② 第 1 次重试后 mountRetries=2", app.mountRetries, 2);
  state.doc.body.appendChild(state.view); // 容器出现
  state.timers.runAll(); // #2 触发 → 挂载
  await app.mountPromise;
  ok("② 容器出现后（第 2 次重试）自动挂载成功", !!state.doc.querySelector(".hs-root"));
})();

// ③ pathname="/web/home" + hash="" → isHome() 真（history 路由）
await (async () => {
  const state = makeState({ hash: "", pathname: "/web/home" });
  const app = makeApp(state);
  eq("③ pathname=/web/home → isHome 真", app.isHome(), true);
})();

// ④ pathname 非 home + 容器在被隐藏视图里 → false
await (async () => {
  const state = makeState({ hash: "", pathname: "/web/item/1" });
  const app = makeApp(state);
  state.view.classList.add("page-hidden");
  eq("④ pathname 非 home + page-hidden → isHome 假", app.isHome(), false);
})();

// ⑤ 重试到上限 → 停止、warn 恰好一次、定时器表清空
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({ hash: "", noTabContent: true });
  const app = makeApp(state);
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  await app.start();
  let g = 0;
  while (state.timers.count() > 0 && g++ < 500) state.timers.runAll();
  console.warn = orig;
  ok("⑤ 未挂载", !state.doc.querySelector(".hs-root"));
  eq("⑤ 定时器表清空", state.timers.count(), 0);
  eq("⑤ 超限不产生 warn（降噪，走 dbg）", warns.length, 0);
  ok("⑤ 重试达上限（>=20）", app.mountRetries >= 20);
})();

// ⑥ userId 解析不到 → fetchPage 抛明确错误，且不发请求（无 /Users/null/）
await (async () => {
  const calls = [];
  const emptyStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const env = {
    apiClient: null,
    storage: emptyStorage,
    fetchImpl: (u) => {
      calls.push(String(u));
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ Items: [], TotalRecordCount: 0 }) });
    },
    userId: null,
    serverId: null,
    serverBase: "http://srv:8096",
    now: () => 1,
  };
  let threw = false;
  let msg = "";
  try {
    await fetchPage({ libId: "3", collectionType: "movies", limit: 20 }, env);
  } catch (e) {
    threw = true;
    msg = e && e.message ? e.message : String(e);
  }
  ok("⑥ userId 解析不到 → fetchPage 抛错（fail-fast）", threw, "msg=" + msg);
  eq("⑥ 未发出任何请求", calls.length, 0);
  ok("⑥ URL 不含 /Users/null/", !calls.some((u) => u.indexOf("/Users/null/") >= 0));
})();

// ⑦ 空池 → 占位态；诊断开关打开时有日志
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({ items: [] });
  globalThis.HS_DEBUG = true;
  const logs = [];
  const orig = console.warn;
  console.warn = (...a) => logs.push(a.join(" "));
  const app = makeApp(state);
  await app.start();
  console.warn = orig;
  delete globalThis.HS_DEBUG;
  ok("⑦ 空池 → 占位态", app.root.classList.contains("is-placeholder"));
  ok("⑦ 诊断开时输出「池子为空」", logs.some((l) => l.indexOf("[HomeSwiper]") >= 0 && l.indexOf("池子为空") >= 0), "logs=" + JSON.stringify(logs.slice(0, 3)));
})();

/* ------------------------------------------------------------------ *
 * 11. 宿主观 .view + hs-host + 观察器时序 + await 后复检 + 降噪 + CSS 文本
 * ------------------------------------------------------------------ */

console.log("== 11. 宿主 / 自愈 / 降噪 / CSS ==");

// ① 宿主选择：有 .view → root.parentNode 是 .view；无 .view → 退回 .tabContent
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  await app.start();
  ok("① 宿主 = .view（root.parentNode === state.view）", app.root.parentNode === state.view);
  eq("① 宿主带 hs-host（挂载时）", state.view.classList.contains("hs-host"), true);
})();
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({ noViewWrapper: true });
  const app = makeApp(state);
  await app.start();
  ok("①b 无 .view → 退回 .tabContent", app.root.parentNode === state.tab);
})();

// ② 异步窗口内被抹除 → 复检兜住
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  const origGet = state.apiClient.getItems.bind(state.apiClient);
  state.apiClient.getItems = (u, q, s) => {
    if (app.root) app.root.remove(); // 在取数解析前抹掉根容器
    return origGet(u, q, s);
  };
  await app.start();
  ok("② 异步窗口内被抹除 → mount 结束仍在宿主内", state.view.contains(app.root));
})();

// ③ 挂载后被抹掉 → 触发 mutation → 自愈重插 + retries 归零
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  await app.start();
  ok("③ 初始在宿主内", state.view.contains(app.root));
  app.root.remove();
  ok("③ 被抹掉后不在宿主内", !state.view.contains(app.root));
  app.observer.cb();
  ok("③ 自愈：重新插入", state.view.contains(app.root));
  eq("③ 重插后 retries 归零", app.retries, 0);
})();

// ④ 观察器在 loadPool 之前已挂（loadPool 期间触发 mutation，回调计数>0）
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  let observerAtLoad = null;
  let fired = 0;
  const origGet = state.apiClient.getItems.bind(state.apiClient);
  state.apiClient.getItems = (u, q, s) => {
    observerAtLoad = !!app.observer;
    if (app.observer) {
      app.observer.cb();
      fired++;
    }
    return origGet(u, q, s);
  };
  await app.start();
  eq("④ loadPool 期间观察器已挂", observerAtLoad, true);
  ok("④ loadPool 期间触发回调计数>0", fired > 0);
})();

// ⑤ hs-host：挂载时有、撤离后无
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  app.bootstrap();
  await app.mountPromise;
  eq("⑤ 挂载后宿主有 hs-host", state.view.classList.contains("hs-host"), true);
  app.teardown();
  eq("⑤ 撤离后宿主无 hs-host", state.view.classList.contains("hs-host"), false);
})();

// ⑥ hs.debug：关闭零日志；开启有 bootstrap/start/mount/teardown 日志
await (async () => {
  FakeSwiper.instances = [];
  const stateOff = makeState({});
  let logsOff = [];
  let orig = console.warn;
  console.warn = (...a) => logsOff.push(a.join(" "));
  const appOff = makeApp(stateOff);
  await appOff.start();
  console.warn = orig;
  eq("⑥ 关闭开关 → 零 [HomeSwiper] 日志", logsOff.filter((l) => l.indexOf("[HomeSwiper]") >= 0).length, 0);

  FakeSwiper.instances = [];
  const stateOn = makeState({});
  globalThis.HS_DEBUG = true;
  let logsOn = [];
  console.warn = (...a) => logsOn.push(a.join(" "));
  const appOn = makeApp(stateOn);
  appOn.bootstrap();
  await appOn.mountPromise;
  appOn.teardown();
  console.warn = orig;
  delete globalThis.HS_DEBUG;
  const has = (kw) => logsOn.some((l) => l.indexOf("[HomeSwiper]") >= 0 && l.indexOf(kw) >= 0);
  ok("⑥ 开启后 bootstrap 有日志", has("bootstrap():"));
  ok("⑥ 开启后 start 判定有日志", has("start():"));
  ok("⑥ 开启后 mount 结果有日志", has("mount(): 完成"));
  ok("⑥ 开启后 teardown 有日志", has("teardown():"));
})();

// ⑦ 重试超限（debug 开）走 dbg 有日志
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({ hash: "", noTabContent: true });
  globalThis.HS_DEBUG = true;
  let logs = [];
  const orig = console.warn;
  console.warn = (...a) => logs.push(a.join(" "));
  const app = makeApp(state);
  await app.start();
  let g = 0;
  while (state.timers.count() > 0 && g++ < 500) state.timers.runAll();
  console.warn = orig;
  delete globalThis.HS_DEBUG;
  ok("⑦ 超限（debug 开）有 dbg 日志（超限）", logs.some((l) => l.indexOf("[HomeSwiper]") >= 0 && l.indexOf("超限") >= 0));
})();

// ⑧ CSS 文本断言
{
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const css = fs.readFileSync(path.join(__dirname, "styles.css"), "utf8");
  const cssNoCmt = css.replace(/\/\*[\s\S]*?\*\//g, ""); // 剥注释：说明文字里会引用旧规则名，不能算数
  const pluginSrc = fs.readFileSync(path.join(__dirname, "plugin.js"), "utf8");
  ok("⑧ 媒体库条已改为 fixed 覆盖首行（不再参与顶栏 flex）", cssNoCmt.indexOf("body.hs-home .hs-libbar {") >= 0 && /body\.hs-home \.hs-libbar \{[^}]*position:\s*fixed/.test(cssNoCmt));
  ok("⑧ 顶栏两条 flex 干预已删除（headerLeft/headerMiddle 不再被我们改写）", cssNoCmt.indexOf("body.hs-home.hs-libbar .headerLeft") < 0 && cssNoCmt.indexOf("body.hs-home.hs-libbar .headerMiddle") < 0);
  ok("⑧ 不再有无 hs-libbar 前缀的 body.hs-home .headerLeft", cssNoCmt.indexOf("body.hs-home .headerLeft") < 0);
  ok("⑧ 含 body.hs-home .dockedtabs-tabs", css.indexOf("body.hs-home .dockedtabs-tabs") >= 0);
  ok("⑧ 含 body.hs-home .tabs-viewmenubar", css.indexOf("body.hs-home .tabs-viewmenubar") >= 0);
  ok("⑧ 顶栏右缘向外多铺一个滚动条宽（补右上缺口）", /\.skinHeader\s*\{[^}]*right:\s*calc\(-1 \* \(100vw - 100%\)\)/.test(cssNoCmt));
  ok("⑧ 内容区统一深色底（两端一致，否则客户端蓝底会露出来）", /body\.hs-immersive \.view\s*\{[^}]*background-color:\s*var\(--hs-bg/.test(cssNoCmt));
  ok("⑧ 背景压暗用 hs-immersive（不是 hs-home，避免连带压暗设置页）", /body\.hs-immersive \.backdropContainer,[\s\S]{0,120}?opacity:\s*0?\.22/.test(cssNoCmt) && !/body\.hs-home \.backdropContainer/.test(cssNoCmt));
  ok("⑧ 底边过渡：图淡出 + 轻微压暗（不再渐隐到固定色）", /hs-root::after\s*\{[^}]*linear-gradient\(0deg,[^}]*260px/.test(cssNoCmt) && !/hs-root::after\s*\{[^}]*var\(--theme-background/.test(cssNoCmt));
  ok("⑧ 图/视频层有底边渐隐（让剧照溶进页面底色）", /\.swiper\s*\{[^}]*mask-image:\s*linear-gradient\(to bottom/.test(cssNoCmt));
  ok(
    "⑧ 信息块不因播放状态改布局（唯一差异只有视频与压暗）",
    !/\.is-trailer \.hs-info(__inner)?\s*\{/.test(cssNoCmt),
  );
  ok(
    "⑧ logo 下沿锚定 / 标语元信息其下 / 按钮钉底（播放态不得覆盖）",
    /\.hs-title-slot \{[^}]*bottom:\s*calc\(100% - var\(--hs-logo-top\)\)/.test(cssNoCmt) &&
      /\.hs-middle \{[^}]*top:\s*calc\(var\(--hs-logo-top\) \+ 12px\)/.test(cssNoCmt) &&
      /\.hs-info__actions \{[^}]*position:\s*absolute/.test(cssNoCmt) &&
      /\.hs-info__actions \{[^}]*bottom:\s*var\(--hs-info-pad\)/.test(cssNoCmt) &&
      !/\.is-trailer \.hs-info__inner \.hs-(tagline|info__meta|overview)/.test(cssNoCmt),
  );
  ok(
    "⑧ Logo 按宽度缩放（Emby logo 是宽幅，按高度卡会太小）",
    /\.hs-logo \{[^}]*width:\s*100%/.test(cssNoCmt) &&
      /\.hs-logo \{[^}]*max-width:/.test(cssNoCmt) &&
      !/\.hs-logo \{[^}]*max-height:\s*var\(--hs-slot-h\)/.test(cssNoCmt),
  );
  ok(
    "⑧ 进入任一侧热区 ⇒ 两个箭头同时出现（单侧会削掉回翻暗示）",
    /\.hs-hotzone--prev:hover ~ \.swiper-button-next/.test(cssNoCmt) &&
      /\.hs-hotzone--next:hover ~ \.swiper-button-prev/.test(cssNoCmt) &&
      /\.hs-hotzone--prev:hover ~ \.swiper-button-prev/.test(cssNoCmt) &&
      /\.hs-hotzone--next:hover ~ \.swiper-button-next/.test(cssNoCmt),
  );
  ok(
    "⑧ 自动翻页只有一个时间源：Swiper autoplay 关闭，翻页由图片阶段计时负责",
    /autoplay: false/.test(pluginSrc) &&
      !/syncAutoplay/.test(pluginSrc) &&
      /const p = Math\.min\(1, \(this\.nowMs\(\) - startMs\) \/ total\)/.test(pluginSrc),
  );  ok(
    "⑧ 改「每轮条数」立即生效：内存池键含 limit + 重建走 force",
    /poolKey\(userId, serverId, libId\) \+ "@" \+ limit/.test(pluginSrc) &&
      /loadPool\(\{ force: true \}\)/.test(pluginSrc),
  );
  ok(
    "⑧ 切条位移在 slideChange 里统一触发，用 WAAPI（不依赖 class 切换时机）",
    /this\.playSwapShift\(this\.swapDirection\(this\.prevPoolIndex, idx\)\)/.test(pluginSrc) &&
      /swapDirection\(prev, next\)/.test(pluginSrc) &&
      /const d = \(next - prev \+ n\) % n/.test(pluginSrc) &&
      /el\.animate\(/.test(pluginSrc),
  );
  ok(
    "⑧ 提示胶囊在静音按钮左侧、文案是「任意区域」；按钮保持纯 toggle",
    /点击任意区域开启声音/.test(cssNoCmt) &&
      /right: calc\(100% \+ 10px\)/.test(cssNoCmt) &&
      /border-radius: 999px/.test(cssNoCmt) &&
      !/提示态）：开启声音/.test(pluginSrc) &&
      /this\.muteBtn\.contains\(t\)/.test(pluginSrc),
  );
  ok(
    "⑧ 「轮播数量」的提示只在选「随机换批」时出现（下拉 change 即时切换）",
    /buildHint\(text\)/.test(pluginSrc) &&
      /每次向服务器请求的条数/.test(pluginSrc) &&
      /const syncHint = \(\) =>/.test(pluginSrc) &&
      /addEventListener\("change", syncHint\)/.test(pluginSrc) &&
      /\.hs-panel__hint\s*\{/.test(cssNoCmt),
  );
  ok(
    "⑧ 静音提示：策略降级才挂、补声/点按/退场清除；有交互先重试一次有声",
    /setHintOnMute\(true\)/.test(pluginSrc) &&
      (pluginSrc.match(/setHintOnMute\(false\)/g) || []).length >= 3 &&
      /hasBeenActive/.test(pluginSrc),
  );
  ok(
    "⑧ 诊断日志不依赖 env.warn（createEnv 没有该字段，会永远静默）",
    /export function logInfo\(/.test(pluginSrc) &&
      !/\n\s*if \(typeof (e|env)\.warn/.test(pluginSrc) &&
      /export function logInfo\(/.test(pluginSrc),
  );
  ok(
    "⑧ 简介滚动：幂等只看「真在跑」，延迟定时器自持（不被 bumpEpoch 清掉后卡死）",
    /node\.__hsOvSig === sig && node\.__hsScrollRaf/.test(pluginSrc) &&
      /node\.__hsOvTimer = w\.setTimeout/.test(pluginSrc) &&
      /clearTimeout\(node\.__hsOvTimer\)/.test(pluginSrc) &&
      !/__hsOvSig === sig && \(node\.__hsScrollRaf \|\| node\.__hsOvPending\)/.test(pluginSrc),
  );
  ok(
    "⑧ 简介滚动不留 rAF：撤离/拆 DOM 停全部，切条停旧节点",
    /stopAllOverviewScrolls\(\)/.test(pluginSrc) &&
      /this\.stopAllOverviewScrolls\(\); \/\/ 否则 rAF/.test(pluginSrc) &&
      /this\.stopAllOverviewScrolls\(\); \/\/ 节点即将被移除/.test(pluginSrc) &&
      /旧节点转为隐藏后必须停掉它的简介滚动/.test(pluginSrc),
  );
  ok(
    "⑧ 切后台暂停计时（回前台不会立刻翻页）",
    /visibilitychange/.test(pluginSrc) && /把暂停时长补回去/.test(pluginSrc),
  );
  ok(
    "⑧ 建轮播只有一个入口：mount 与设置变更都走 rebuildCarousel（含 量高/图片阶段/预告片）",
    /async rebuildCarousel\(startIdx\)/.test(pluginSrc) &&
      /await this\.rebuildCarousel\(start\)/.test(pluginSrc) &&
      /return this\.rebuildCarousel\(0\)/.test(pluginSrc) &&
      /this\.applyHeroHeight\(\);/.test(pluginSrc) &&
      /this\.startImagePhase\(start\)/.test(pluginSrc) &&
      /this\.scheduleTrailer\(start\)/.test(pluginSrc),
  );

  ok(
    "⑧ 静音按钮：悬停轮播才显示 + 两态图标 + 在信息层之上",
    /\.hs-mute \{[^}]*z-index:\s*5/.test(cssNoCmt) &&
      /\.is-trailer:hover \.hs-mute/.test(cssNoCmt) &&
      /\.hs-mute\.is-muted \.hs-mute__slash\s*\{[^}]*display:\s*inline/.test(cssNoCmt),
  );
  ok(
    "⑧ 信息层次：事实/引子/正文三段固定占位，字号逐级变大",
    /\.hs-info__meta \{[^}]*height:\s*26px/.test(cssNoCmt) &&
      /\.hs-tagline \{[^}]*height:\s*42px/.test(cssNoCmt) &&
      /\.hs-overview \{[^}]*top:\s*96px/.test(cssNoCmt) &&
      /\.hs-info__meta \{[^}]*font-size:\s*13\.5px/.test(cssNoCmt) &&
      /\.hs-overview \{[^}]*font-size:\s*15\.5px/.test(cssNoCmt) &&
      /\.hs-overview \{[^}]*line-height:\s*1\.78/.test(cssNoCmt),
  );
  ok(
    "⑧ 简介从头开始排、溢出交给自动滚动（不居中、不羽化）",
    /\.hs-overview \{[^}]*overflow:\s*hidden/.test(cssNoCmt) &&
      !/\.hs-overview \{[^}]*margin-top:\s*auto/.test(cssNoCmt) &&
      !/\.hs-overview \{[^}]*mask-image/.test(cssNoCmt) &&
      !/\.is-trailer \.hs-overview\s*\{/.test(cssNoCmt),
  );
  ok(
    "⑧ 标语最多 2 行",
    /\.hs-tagline \{[^}]*-webkit-line-clamp:\s*2/.test(cssNoCmt),
  );
  ok(
    "⑧ 播放态信息列禁止 flex 收缩（否则简介被压成一块）",
    /\.is-trailer \.hs-info__inner > \*\s*\{[^}]*flex:\s*0 0 auto/.test(cssNoCmt),
  );
  ok(
    "⑧ 播放态不再放大字号（不覆盖 title 的 font-size）",
    !/\.is-trailer \.hs-title-text\s*\{[^}]*font-size/.test(cssNoCmt),
  );
  ok(
    "⑧ 信息块遮罩两态常驻（不随播放态切换，过渡无跳变）",
    /\.hs-info__inner\.is-active::before\s*\{[^}]*opacity:\s*1/.test(cssNoCmt) &&
      !/\.is-trailer \.hs-info__inner\.is-active::before/.test(cssNoCmt),
  );
  ok(
    "⑧ 视频高度由 --hs-video-h 给出（留出底部渐隐的空白）",
    /\.hs-video \{[^}]*height:\s*var\(--hs-video-h/.test(cssNoCmt) && !/\.hs-video \{[^}]*bottom:\s*0/.test(cssNoCmt),
  );
  ok("⑧ 首页原生分区标题排版已对齐（作用域内）", /body\.hs-home \.sectionTitle\s*\{[^}]*letter-spacing/.test(cssNoCmt));
  ok("⑧ .hs-root 是文档流块（relative + width:100% + height:100vh）", /position:\s*relative/.test(cssNoCmt) && /width:\s*100%/.test(cssNoCmt) && /height:\s*100vh/.test(cssNoCmt));
  ok("⑧ 不再有 hero 推挤变量 --hs-hero-h", cssNoCmt.indexOf("--hs-hero-h") < 0);
  ok("⑧ 缝补块存在且宽度 CSS 自测（100vw − 100%）", /\.hs-gutter\s*\{[^}]*width:\s*calc\(100vw - 100%\)/.test(cssNoCmt));
  // 宿主绝不能有 position 声明（真机实测会把 .view 压成 0 高）；仅排除 .hs-host > .hs-root 那条。
  // 先剥掉注释（注释里提到过被删的规则，会误匹配）。
  const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const hostBlocks = (cssNoComments.match(/[^{}]*\.hs-host[^{}]*\{[^}]*\}/g) || []).filter(
    (b) => b.indexOf(".hs-host > .hs-root") < 0,
  );
  ok("⑧a0 自检：确实抓到 .hs-host 规则块", hostBlocks.length > 0, JSON.stringify(hostBlocks));
  ok(
    "⑧ 无任何针对 .hs-host 自身的 position 与 overflow 声明",
    hostBlocks.every((b) => !/position\s*:/.test(b) && !/overflow\s*:/.test(b)),
    JSON.stringify(hostBlocks),
  );
  ok(
    "⑧a 存在 body.hs-home .hs-host 规则且含 isolation: isolate",
    hostBlocks.some((b) => /isolation\s*:\s*isolate/.test(b)),
    JSON.stringify(hostBlocks),
  );
  // ⑧d 媒体库条：几何交给 JS 变量（A 方案）+ 整栏渐变磨砂 + 按钮框/亮文字（不高亮）
  const libbarBlock = (cssNoCmt.match(/body\.hs-home \.hs-libbar \{[^}]*\}/) || [""])[0];
  ok("⑧d0 自检：抓到 .hs-libbar 规则块", libbarBlock.length > 0, libbarBlock);
  ok("⑧d .hs-libbar 的 top 用 --hs-libbar-top（量出来的）", /top:\s*var\(--hs-libbar-top/.test(libbarBlock), libbarBlock);
  ok("⑧d .hs-libbar 的 height 用 --hs-libbar-h（量出来的）", /height:\s*var\(--hs-libbar-h/.test(libbarBlock), libbarBlock);
  ok(
    "⑧d 左对齐 logo 右侧（left/tx 用变量，量不到才居中兜底）",
    /left:\s*var\(--hs-libbar-left/.test(libbarBlock) &&
      /transform:\s*translateX\(var\(--hs-libbar-tx,\s*-50%\)\)/.test(libbarBlock) &&
      /width:\s*auto/.test(libbarBlock) &&
      /max-width:\s*min\(70vw,\s*1080px\)/.test(libbarBlock),
    libbarBlock,
  );
  ok("⑧d .hs-libbar 不再写死 0.18em / 3.1em", !/top:\s*0\.18em/.test(libbarBlock) && !/height:\s*3\.1em/.test(libbarBlock), libbarBlock);
  ok("⑧d 条自身不做模糊（无 backdrop-filter）", !/backdrop-filter/.test(libbarBlock), libbarBlock);
  ok(
    "⑧d 条自身不画框（background:none + border:0，避免露出矩形）",
    /background:\s*none/.test(libbarBlock) && /border:\s*0/.test(libbarBlock),
    libbarBlock,
  );
  // 整栏渐变磨砂：回归「.skinHeader 纵向渐变 + 按行高收口 + 底色透明」
  const headerRule = (cssNoCmt.match(/body\.hs-home \.skinHeader \{[^}]*\}/) || [""])[0];
  ok("⑧d0 自检：抓到 .skinHeader 规则块", headerRule.length > 0, headerRule);
  ok("⑧d .skinHeader 有整栏渐变磨砂", /background-image:\s*linear-gradient\(/.test(headerRule) && /180deg/.test(headerRule), headerRule);
  ok(
    "⑧d 渐变从深到全透明（顶部仍明显、底部 0）",
    /rgba\(14,\s*14,\s*18,\s*0?\.9\)\s*0%/.test(headerRule) && /rgba\(14,\s*14,\s*18,\s*0\)\s*100%/.test(headerRule),
    headerRule,
  );
  ok(
    "⑧d 前段深度已压低（55% 处 .84，避免 60% 拐点成为可见分界）",
    /rgba\(14,\s*14,\s*18,\s*0?\.84\)\s*55%/.test(headerRule),
    headerRule,
  );
  ok("⑧d 渐变按行高收口（background-size 用 --hs-libbar-h）", /background-size:\s*100%\s*calc\([^;]*--hs-libbar-h/.test(headerRule), headerRule);
  ok("⑧d 顶栏底色被清成透明（只留渐变）", /background-color:\s*transparent/.test(headerRule), headerRule);
  ok(
    "⑧d 关掉 Emby 滚动态整栏模糊（否则滚上来一条粗磨砂）",
    /[\s;]backdrop-filter:\s*none/.test(headerRule),
    headerRule,
  );
  const itemBlock = (cssNoCmt.match(/body\.hs-home \.hs-libbar__item \{[^}]*\}/) || [""])[0];
  ok("⑧d0 自检：抓到 .hs-libbar__item 规则块", itemBlock.length > 0, itemBlock);
  ok("⑧d 按钮无描边、无自身底色（纯文字标签）", /border:\s*0/.test(itemBlock) && /background:\s*transparent/.test(itemBlock), itemBlock);
  ok("⑧d 文字亮度 .92（略收回一档）", /color:\s*rgba\(255,\s*255,\s*255,\s*0?\.92\)/.test(itemBlock), itemBlock);
  ok("⑧d 文字更清楚（1.15em / 600 / 字距 .01em）", /font-size:\s*1\.15em/.test(itemBlock) && /font-weight:\s*600/.test(itemBlock) && /letter-spacing:\s*0\.01em/.test(itemBlock), itemBlock);
  ok("⑧d 阴影加深（1px3px alpha .7 + 10px 光晕）", /text-shadow:\s*0 1px 3px rgba\(0,\s*0,\s*0,\s*0?\.7\)/.test(itemBlock), itemBlock);
  ok("⑧d 按钮不带磨砂（无 backdrop-filter）", !/backdrop-filter/.test(itemBlock), itemBlock);
  // 悬停反馈改为「条级高亮层」：从顶栏最顶边铺到条底 + 顶部 3px 粗条
  const hoverBlock = (cssNoCmt.match(/body\.hs-home \.hs-libbar__hover \{[^}]*\}/) || [""])[0];
  ok("⑧d0 自检：抓到 .hs-libbar__hover 规则块", hoverBlock.length > 0, hoverBlock);
  ok(
    "⑧d 高亮层贴到顶栏最顶边（top: -1 × --hs-libbar-top）",
    /top:\s*calc\(-1\s*\*\s*var\(--hs-libbar-top/.test(hoverBlock),
    hoverBlock,
  );
  ok(
    "⑧d 高亮层：4px 粗条 + 向下淡出的渐变块（条与块连成一体）",
    /border-top:\s*4px solid rgba\(255,\s*255,\s*255,\s*0?\.92\)/.test(hoverBlock) &&
      /background:\s*linear-gradient\(\s*180deg,\s*rgba\(255,\s*255,\s*255,\s*0?\.15\)\s*0%/.test(hoverBlock),
    hoverBlock,
  );
  ok("⑧d 高亮层由 .is-on 点亮（默认透明）", /\.hs-libbar__hover\.is-on \{[^}]*opacity:\s*1/.test(cssNoCmt), hoverBlock);
  ok("⑧d 按钮自身不再画悬停底色（交给高亮层）", !/\.hs-libbar__item:hover \{[^}]*background:/.test(cssNoCmt));
  ok(
    "⑧d 抽屉回收只裁 __clip（不能裁到条，否则高亮层被裁掉）",
    /\.hs-libbar__clip \{[^}]*clip-path:\s*inset\(0\)/.test(cssNoCmt) &&
      /\.is-too-narrow \.hs-libbar__clip \{[^}]*clip-path:\s*inset\(0 100% 0 0\)/.test(cssNoCmt) &&
      !/\.hs-libbar \{[^}]*clip-path/.test(cssNoCmt),
  );
  ok(
    "⑧d 无框之后不再画分隔线（悬空小竖条会更乱）",
    !/\.hs-libbar__item \+ \.hs-libbar__item/.test(cssNoCmt),
  );
  ok(
    "⑧d 回收动画时序：先推回（__clip 0.28s）再淡出（opacity 延迟 0.18s）",
    /\.hs-libbar__clip \{[^}]*transition:\s*clip-path 0?\.28s/.test(cssNoCmt) &&
      /\.is-too-narrow \{[^}]*transition:\s*opacity 0?\.1s ease 0?\.18s/.test(cssNoCmt) &&
      /\.is-too-narrow \{[^}]*visibility 0s linear 0?\.28s/.test(cssNoCmt),
  );
  ok(
    "⑧d 可见态不夹宽度（否则回收前会被 max-width 瞬间截断）",
    !/\.hs-libbar \{[^}]*max-width:[^}]*--hs-libbar-max/.test(cssNoCmt),
  );
  ok("⑧d 不再有 ::before 框体（去掉了斜边梯形）", !/hs-libbar::before/.test(cssNoCmt));
}

/* ------------------------------------------------------------------ *
 * 12. B 方案：轮播进文档流（不再有覆盖层 / 推挤 / 滚动跟随 / 滚轮转交）
 * ------------------------------------------------------------------ */
console.log("== 12. B：轮播进文档流 ==");

// ① 挂载点是滚动内容层，且是它的第一个子节点
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const scroller = addEl(state.view, "emby-scroller");
  const slider = addEl(scroller, "scrollSlider");
  const app = makeApp(state);
  await app.start();
  ok("① 根容器挂在 .scrollSlider 里（不是 .view）", app.root.parentNode === slider);
  ok("① 它是内容层第一个子节点", slider.children[0] === app.root);
  ok("① 宿主不再是 .view", app.mountContainer === slider);
  app.teardown();
})();

// ② CSS：根容器是文档流块
{
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const c = fs.readFileSync(path.join(__dirname, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const root = (c.match(/body\.hs-home \.hs-root \{[^}]*\}/) || [""])[0];
  ok("②0 自检：抓到 .hs-root 规则块", root.length > 0, root);
  ok("② position: relative（不再 absolute 覆盖）", /position:\s*relative/.test(root), root);
  ok("② width: 100%", /width:\s*100%/.test(root), root);
  ok("② height: 100vh（只占顶部一屏）", /height:\s*100vh/.test(root), root);
  ok("② 不再有 right/top 定位与 --hs-hero-h", !/--hs-hero-h/.test(root) && !/\bright:/.test(root) && !/\btop:\s*0/.test(root), root);
  ok("② 全篇不再有 hs-hero-push", !/hs-hero-push/.test(c));
  ok("② 缝补块在视图内、z-index:-1，且向外伸一个滚动条宽", /\.hs-gutter\s*\{[^}]*z-index:\s*-1/.test(c) && /\.hs-gutter\s*\{[^}]*right:\s*calc\(-1 \* \(100vw - 100%\)\)/.test(c));
}

// ③ 运行期：不再有 wheel 监听 / hero 的 rAF 锁
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  await app.start();
  ok("③ 根容器没有 wheel 转发监听", !app._wheelHandler);
  ok("③ 没有 hero 的 rAF 锁", app._heroPending === undefined);
  app.teardown();
})();

// ③b 高度按「容器底边 − 块顶偏移」量（不能写死 100vh）
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const scroller = addEl(state.view, "emby-scroller");
  const slider = addEl(scroller, "scrollSlider");
  void slider;
  scroller.clientHeight = 860;
  scroller.scrollHeight = 3000;
  scroller.scrollTop = 0;
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 860, height: 860, left: 0, right: 0, width: 0 });
  state.win.innerHeight = 860;
  const app = makeApp(state);
  await app.start();
  app.root.getBoundingClientRect = () => ({ top: 60, bottom: 860, height: 800, left: 0, right: 0, width: 0 });
  app.applyHeroHeight();
  eq("③b 没有下一行 ⇒ 基准 23%（860−198）", app.root.style.height, "662px");
  eq("③b 用负 margin-top 抵消内容起点（顶栏背后也有图）", app.root.style.marginTop, "-60px");
  scroller.scrollTop = 100;
  app.root.style.height = "";
  app.root.style.marginTop = "";
  // 滚动后 rect.top 会变成 60-100=-40；补偿 scrollTop 后仍应算出同样的高度与 margin
  app.root.getBoundingClientRect = () => ({ top: -40, bottom: 760, height: 800, left: 0, right: 0, width: 0 });
  app.applyHeroHeight();
  eq("③b2 滚动中照样能量（用 scrollTop 补偿）", app.root.style.height, "662px");
  eq("③b3 补偿后 offset 仍是 60", app.root.style.marginTop, "-60px");

  // ③d 幂等：真实布局里 rect.top 会被我们自己写下的 marginTop 改变 ⇒ 连调必须稳定
  //    （旧实现每次重新量 top，第二次量到 0 就把 marginTop 清掉，与第一次互相抵消）
  app.root.style.height = "";
  app.root.style.marginTop = "";
  scroller.scrollTop = 0;
  app.root.getBoundingClientRect = () => {
    const mt = parseFloat(app.root.style.marginTop) || 0; // 负值：块被我们自己上移了多少
    const top = 60 + mt;                                   // 自然起点 60，被 margin 上移
    const h = parseFloat(app.root.style.height) || 800;
    return { top, bottom: top + h, height: h, left: 0, right: 0, width: 0 };
  };
  app.applyHeroHeight();
  const m1 = app.root.style.marginTop;
  app.applyHeroHeight();
  const m2 = app.root.style.marginTop;
  app.applyHeroHeight();
  const m3 = app.root.style.marginTop;
  eq("③d 首次把块提到顶栏背后", m1, "-60px");
  eq("③d 第二次仍保持（幂等，不自清）", m2, "-60px");
  eq("③d 第三次仍保持", m3, "-60px");
  app.teardown();
})();

// ③c 几何兜底：avail 量不出来时，条压到图标就回收
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  addEl(state.doc.body, "headerMiddle");
  const app = makeApp(state);
  await app.start();
  const bar = app.libBarEl;
  ok("③c0 库条存在", !!bar);
  bar.getBoundingClientRect = () => ({ left: 300, right: 1200, width: 900, top: 0, bottom: 40, height: 40 });
  const right = addEl(state.doc.body, "headerRight");
  right.getBoundingClientRect = () => ({ left: 1000, right: 1800, width: 800, top: 0, bottom: 40, height: 40 });
  app.syncLibBarFit(NaN);
  ok("③c 条右缘越过图标左缘 ⇒ is-too-narrow", bar.classList.contains("is-too-narrow"));
  bar.getBoundingClientRect = () => ({ left: 300, right: 900, width: 600, top: 0, bottom: 40, height: 40 });
  app.syncLibBarFit(NaN);
  ok("③c2 不重叠 ⇒ 摘掉 is-too-narrow", !bar.classList.contains("is-too-narrow"));
  app.teardown();
})();

// ③e 判定：avail 量测"偏乐观"时，实际几何压到图标也必须回收
//     （真机症状：缩窗后条右端压在头像上，而 avail 还报"放得下"）
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  addEl(state.doc.body, "headerMiddle");
  const app = makeApp(state);
  await app.start();
  const bar = app.libBarEl;
  ok("③e0 库条存在", !!bar);
  bar.getBoundingClientRect = () => ({ left: 300, right: 1200, width: 900, top: 0, bottom: 40, height: 40 });
  const right = addEl(state.doc.body, "headerRight");
  right.getBoundingClientRect = () => ({ left: 1000, right: 1800, width: 800, top: 0, bottom: 40, height: 40 });
  app.syncLibBarFit(2000); // 偏乐观的空隙：按 need 判"放得下"
  ok("③e 几何已压到图标 ⇒ 仍然回收（不被 finite avail 短路）", bar.classList.contains("is-too-narrow"));
  bar.getBoundingClientRect = () => ({ left: 300, right: 900, width: 600, top: 0, bottom: 40, height: 40 });
  app.syncLibBarFit(2000);
  ok("③e2 几何不重叠 ⇒ 恢复显示", !bar.classList.contains("is-too-narrow"));
  app.teardown();
})();

// ③f 缩窗必须真的重测：挂载流程末尾不许把尺寸监听拆掉
//     （真机症状：只有加载那一帧判定生效，之后手动拖窄不回收、动画也不播）
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  addEl(state.doc.body, "headerMiddle");
  state.win.ResizeObserver = TrackingRO; // 真实浏览器里一定有，测试环境补上
  const app = makeApp(state);
  await app.start();
  ok("③f 挂载后仍保留 window.resize 兜底", typeof app._resizeHandler === "function");
  ok("③f2 挂载后仍保留 ResizeObserver", !!app._resizeWatch);
  let n = 0;
  const orig = app.measureLibBarGeometry.bind(app);
  app.measureLibBarGeometry = () => {
    n++;
    return orig();
  };
  if (typeof app._resizeHandler === "function") app._resizeHandler();
  ok("③f3 resize 立即重调 measureLibBarGeometry（rAF 合帧，不等 120ms 防抖）", n === 1);
  app.teardown();
})();

// ③g 回收态不能自我抵消：`is-too-narrow` 自带 translateX(-6px)，
//     量到的右缘比真实占位少 6px ⇒ 判据必须把那 6px 加回去，否则会在阈值附近反复显隐
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  addEl(state.doc.body, "headerMiddle");
  const app = makeApp(state);
  await app.start();
  const bar = app.libBarEl;
  const right = addEl(state.doc.body, "headerRight");
  right.getBoundingClientRect = () => ({ left: 1000, right: 1800, width: 800, top: 0, bottom: 40, height: 40 });
  bar.classList.add("is-too-narrow");
  bar.getBoundingClientRect = () => ({ left: 300, right: 990, width: 690, top: 0, bottom: 40, height: 40 });
  app.syncLibBarFit(2000);
  ok("③g 已回收时右缘少算 6px 也不许自己翻回显示", bar.classList.contains("is-too-narrow"));
  // 迟滞：bound=1000 ⇒ 未回收阈值 992、已回收阈值 968（多让 24px）。
  // right=978 → 真实占位 984：不迟滞就会恢复显示，迟滞后必须保持隐藏。
  bar.getBoundingClientRect = () => ({ left: 300, right: 978, width: 678, top: 0, bottom: 40, height: 40 });
  app.syncLibBarFit(2000);
  ok("③g3 迟滞：只腾出 14px 仍保持回收（要 ≥24px 才恢复）", bar.classList.contains("is-too-narrow"));
  bar.getBoundingClientRect = () => ({ left: 300, right: 960, width: 660, top: 0, bottom: 40, height: 40 });
  app.syncLibBarFit(2000);
  ok("③g2 明显腾出空间才恢复显示", !bar.classList.contains("is-too-narrow"));
  app.teardown();
})();

// ③d 缝垫层：插在宿主首位、量滚动条宽、撤离清理
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const scroller = addEl(state.view, "emby-scroller");
  const slider = addEl(scroller, "scrollSlider");
  void slider;
  Object.defineProperty(scroller, "offsetWidth", { value: 1600, configurable: true });
  Object.defineProperty(scroller, "clientWidth", { value: 1584, configurable: true });
  scroller.clientHeight = 800;
  scroller.scrollHeight = 3000;
  const app = makeApp(state);
  await app.start();
  ok("③d1 补块插在视图首位", !!app.gutterEl && app.gutterEl.parentNode === state.view);
  eq("③d3 仍写 --hs-sb-w（供调试/兜底）", state.doc.documentElement.style.getPropertyValue("--hs-sb-w"), "16px");
  app.teardown();
  ok("③d4 撤离后垫层移除", !state.doc.querySelector(".hs-gutter"));
  eq("③d5 撤离后 --hs-sb-w 已清", state.doc.documentElement.style.getPropertyValue("--hs-sb-w"), "");
})();

// ③e 视图也要有 hs-host（负 z-index 垫层才留在视图的层叠上下文里）
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const scroller = addEl(state.view, "emby-scroller");
  addEl(scroller, "scrollSlider");
  scroller.clientHeight = 800;
  scroller.scrollHeight = 3000;
  const app = makeApp(state);
  await app.start();
  ok("③e 视图带 hs-host（isolation）", state.view.classList.contains("hs-host"));
  app.teardown();
  ok("③e2 撤离后视图的 hs-host 已摘", !state.view.classList.contains("hs-host"));
})();

// ③f 露一条：下一个分区有高度时露 72px，没有则不留白边
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const scroller = addEl(state.view, "emby-scroller");
  const slider = addEl(scroller, "scrollSlider");
  scroller.clientHeight = 860;
  scroller.scrollHeight = 3000;
  scroller.scrollTop = 0;
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 860, height: 860, left: 0, right: 0, width: 0 });
  state.win.innerHeight = 860;
  const app = makeApp(state);
  await app.start();
  app.root.getBoundingClientRect = () => ({ top: 60, bottom: 860, height: 800, left: 0, right: 0, width: 0 });
  const next = addEl(slider, "section");
  next.getBoundingClientRect = () => ({ top: 860, bottom: 1200, height: 340, left: 0, right: 0, width: 0 });
  app.applyHeroHeight();
  eq("③f1 行高 340 ⇒ 保证放下（340+8，40% 封顶=344）", app.root.style.height, "516px");
  next.getBoundingClientRect = () => ({ top: 860, bottom: 900, height: 40, left: 0, right: 0, width: 0 });
  app.applyHeroHeight();
  eq("③f1b 行高只有 40 ⇒ 夹到下限 20%（860−172）", app.root.style.height, "688px");
  next.getBoundingClientRect = () => ({ top: 860, bottom: 860, height: 0, left: 0, right: 0, width: 0 });
  app.applyHeroHeight();
  eq("③f2 下一段高度 0 ⇒ 回到基准 23%（860−198）", app.root.style.height, "662px");
  app.teardown();
})();

// ③g 分区后渲染 ⇒ mutation 后要重量高度（客户端慢渲染的真机问题）
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const scroller = addEl(state.view, "emby-scroller");
  const slider = addEl(scroller, "scrollSlider");
  scroller.clientHeight = 860;
  scroller.scrollHeight = 3000;
  scroller.scrollTop = 0;
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 860, height: 860, left: 0, right: 0, width: 0 });
  state.win.innerHeight = 860;
  const app = makeApp(state);
  await app.start();
  app.root.getBoundingClientRect = () => ({ top: 60, bottom: 860, height: 800, left: 0, right: 0, width: 0 });
  app.applyHeroHeight();
  eq("③g1 分区还没渲染 ⇒ 基准 23%（662px）", app.root.style.height, "662px");
  // 分区出现
  const next = addEl(slider, "section");
  next.getBoundingClientRect = () => ({ top: 860, bottom: 1200, height: 340, left: 0, right: 0, width: 0 });
  app.observer && app.observer.cb();
  await sleep(60);
  eq("③g2 mutation 后重量 ⇒ 保证放下（516px）", app.root.style.height, "516px");
  app.teardown();
})();

// ③h 下一个兄弟是"包住所有分区的容器" ⇒ 只按第一行的高度算
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const scroller = addEl(state.view, "emby-scroller");
  const slider = addEl(scroller, "scrollSlider");
  scroller.clientHeight = 860;
  scroller.scrollHeight = 3000;
  scroller.scrollTop = 0;
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 860, height: 860, left: 0, right: 0, width: 0 });
  state.win.innerHeight = 860;
  const app = makeApp(state);
  await app.start();
  app.root.getBoundingClientRect = () => ({ top: 60, bottom: 860, height: 800, left: 0, right: 0, width: 0 });
  const wrap = addEl(slider, "sections");
  const row1 = addEl(wrap, "section");
  const row2 = addEl(wrap, "section");
  wrap.getBoundingClientRect = () => ({ top: 860, bottom: 1500, height: 640, left: 0, right: 0, width: 0 });
  row1.getBoundingClientRect = () => ({ top: 860, bottom: 1190, height: 330, left: 0, right: 0, width: 0 });
  row2.getBoundingClientRect = () => ({ top: 1200, bottom: 1500, height: 300, left: 0, right: 0, width: 0 });
  app.applyHeroHeight();
  eq("③h 容器包两行 ⇒ 内部间距 340 ⇒ 516px", app.root.style.height, "516px");
  app.teardown();
})();

// ③i 取景重心：窗口越扁越往上，接近 16:9 回中
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const scroller = addEl(state.view, "emby-scroller");
  const slider = addEl(scroller, "scrollSlider");
  void slider;
  scroller.clientWidth = 1600;
  scroller.clientHeight = 600;
  scroller.scrollHeight = 3000;
  scroller.scrollTop = 0;
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600, left: 0, right: 0, width: 1600 });
  state.win.innerHeight = 600;
  const app = makeApp(state);
  await app.start();
  app.root.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600, left: 0, right: 0, width: 1600 });
  app.applyHeroHeight();
  eq("③i1 超宽（1600/462≈3.5）⇒ 取景 18%", app.root.style.getPropertyValue("--hs-obj-y"), "18%");
  scroller.clientWidth = 1600;
  scroller.clientHeight = 900;
  scroller.scrollHeight = 3000;
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 900, height: 900, left: 0, right: 0, width: 1600 });
  state.win.innerHeight = 900;
  app.root.getBoundingClientRect = () => ({ top: 0, bottom: 900, height: 900, left: 0, right: 0, width: 1600 });
  app.applyHeroHeight();
  eq("③i2 露出后盒子 1600×693≈2.3 ⇒ 34%", app.root.style.getPropertyValue("--hs-obj-y"), "34%");
  app.teardown();
})();

// ③j 返回首页：分区后渲染 ⇒ 延迟重量把"占满"修正为"露一条"
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const scroller = addEl(state.view, "emby-scroller");
  const slider = addEl(scroller, "scrollSlider");
  scroller.clientHeight = 860;
  scroller.scrollHeight = 3000;
  scroller.scrollTop = 0;
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 860, height: 860, left: 0, right: 0, width: 0 });
  state.win.innerHeight = 860;
  const app = makeApp(state);
  await app.start();
  app.root.getBoundingClientRect = () => ({ top: 60, bottom: 860, height: 800, left: 0, right: 0, width: 0 });
  app.applyHeroHeight();
  eq("③j1 分区还没渲染 ⇒ 基准 23%（662px），不占满", app.root.style.height, "662px");
  const next = addEl(slider, "section");
  next.getBoundingClientRect = () => ({ top: 860, bottom: 1200, height: 340, left: 0, right: 0, width: 0 });
  state.timers.runAll(); // 推到 300ms 的 hero-fit
  eq("③j2 延迟重量后 ⇒ 保证放下（516px）", app.root.style.height, "516px");
  app.teardown();
})();

// ③k 真机结构：每行是 .verticalSection，行内有 h=0 的 .emby-scrollbuttons
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const scroller = addEl(state.view, "emby-scroller");
  const slider = addEl(scroller, "scrollSlider");
  scroller.clientHeight = 1274;
  scroller.scrollHeight = 3000;
  scroller.scrollTop = 0;
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 1274, height: 1274, left: 0, right: 0, width: 0 });
  state.win.innerHeight = 1274;
  const app = makeApp(state);
  await app.start();
  app.root.getBoundingClientRect = () => ({ top: 60, bottom: 761, height: 701, left: 0, right: 0, width: 0 });
  const row1 = addEl(slider, "verticalSection");
  addEl(row1, "emby-scrollbuttons");   // h=0 的滚动按钮（旧写法就栽在这）
  addEl(row1, "sectionTitleContainer");
  addEl(row1, "padded-top-focusscale");
  const row2 = addEl(slider, "verticalSection");
  row1.getBoundingClientRect = () => ({ top: 761, bottom: 1047, height: 286, left: 0, right: 0, width: 0 });
  row2.getBoundingClientRect = () => ({ top: 1047, bottom: 1413, height: 366, left: 0, right: 0, width: 0 });
  app.applyHeroHeight();
  eq("③k 行高 286 ⇒ 露 294（含 8px 呼吸）⇒ 980", app.root.style.height, "980px");
  app.teardown();
})();

// ③l 4.7 客户端：第二行是隐藏空分区（h=0、top=0）⇒ 退回第一行自身高度
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const scroller = addEl(state.view, "emby-scroller");
  const slider = addEl(scroller, "scrollSlider");
  scroller.clientHeight = 1274;
  scroller.scrollHeight = 3000;
  scroller.scrollTop = 0;
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 1274, height: 1274, left: 0, right: 0, width: 0 });
  state.win.innerHeight = 1274;
  const app = makeApp(state);
  await app.start();
  app.root.getBoundingClientRect = () => ({ top: 60, bottom: 761, height: 701, left: 0, right: 0, width: 0 });
  const row1 = addEl(slider, "verticalSection section0");
  const hidden = addEl(slider, "verticalSection section-downloads hide");
  row1.getBoundingClientRect = () => ({ top: 761, bottom: 1047, height: 286, left: 0, right: 0, width: 0 });
  hidden.getBoundingClientRect = () => ({ top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0 });
  app.applyHeroHeight();
  eq("③l 隐藏空分区 ⇒ 用第一行 286 ⇒ 980", app.root.style.height, "980px");
  app.teardown();
})();

// ③m 客户端真实结构：所有分区包在 .sections 里（root 的唯一兄弟 h=2828）
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const scroller = addEl(state.view, "emby-scroller");
  const slider = addEl(scroller, "scrollSlider");
  scroller.clientHeight = 1218;
  scroller.scrollHeight = 4000;
  scroller.scrollTop = 0;
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 1218, height: 1218, left: 0, right: 0, width: 0 });
  state.win.innerHeight = 1218;
  const app = makeApp(state);
  await app.start();
  app.root.getBoundingClientRect = () => ({ top: 0, bottom: 1218, height: 1218, left: 0, right: 0, width: 0 });
  const wrap = addEl(slider, "sections homeSectionsContainer");
  const row1 = addEl(wrap, "verticalSection section0");
  const hidden = addEl(wrap, "verticalSection section-downloads hide");
  const row2 = addEl(wrap, "verticalSection section1");
  wrap.getBoundingClientRect = () => ({ top: 548, bottom: 3376, height: 2828, left: 0, right: 0, width: 0 });
  row1.getBoundingClientRect = () => ({ top: 548, bottom: 834, height: 286, left: 0, right: 0, width: 0 });
  hidden.getBoundingClientRect = () => ({ top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0 });
  row2.getBoundingClientRect = () => ({ top: 834, bottom: 1200, height: 366, left: 0, right: 0, width: 0 });
  app.applyHeroHeight();
  eq("③m .sections 内部间距 286 ⇒ 924", app.root.style.height, "924px");
  app.teardown();
})();

// ③n 客户端：root 的兄弟是 [.sections, .padded-bottom-page] ⇒ 必须按 .sections 内部算，不能算兄弟间距
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const scroller = addEl(state.view, "emby-scroller");
  const slider = addEl(scroller, "scrollSlider");
  scroller.clientHeight = 1218;
  scroller.scrollHeight = 4000;
  scroller.scrollTop = 0;
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 1218, height: 1218, left: 0, right: 0, width: 0 });
  state.win.innerHeight = 1218;
  const app = makeApp(state);
  await app.start();
  app.root.getBoundingClientRect = () => ({ top: 0, bottom: 1218, height: 1218, left: 0, right: 0, width: 0 });
  const wrap = addEl(slider, "sections homeSectionsContainer");
  const row1 = addEl(wrap, "verticalSection section0");
  const row2 = addEl(wrap, "verticalSection section1");
  const tail = addEl(slider, "padded-bottom-page");
  wrap.getBoundingClientRect = () => ({ top: 548, bottom: 3376, height: 2828, left: 0, right: 0, width: 0 });
  row1.getBoundingClientRect = () => ({ top: 548, bottom: 826, height: 278, left: 0, right: 0, width: 0 });
  row2.getBoundingClientRect = () => ({ top: 826, bottom: 3196, height: 2370, left: 0, right: 0, width: 0 });
  tail.getBoundingClientRect = () => ({ top: 3414, bottom: 3544, height: 130, left: 0, right: 0, width: 0 });
  app.applyHeroHeight();
  eq("③n 内部间距 278 ⇒ 露 286 ⇒ 932（不能算成兄弟间距 2866）", app.root.style.height, "932px");
  app.teardown();
})();

// ③o 背景压暗类：挂载时加、离开首页时摘（否则设置页也会被压暗）
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  await app.start();
  ok("③o1 挂载后 body 带 hs-immersive", state.doc.body.classList.contains("hs-immersive"));
  app.hideForNavigation();
  ok("③o2 离开首页后已摘掉（设置页不再被压暗）", !state.doc.body.classList.contains("hs-immersive"));
  app.teardown();
})();

// ③p 根容器必须透明：图淡出后要露出页面背景（否则出现第二条接缝）
{
  const lines = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const root = (lines.match(/body\.hs-home \.hs-root \{[^}]*\}/) || [""])[0];
  ok("③p .hs-root 底色透明（不再垫近黑色）", /background:\s*transparent/.test(root), root);
ok(
  "③p2 .hs-root 禁止选中/拖拽（拖拽或双击不会把标题简介框选成蓝底）",
  /-webkit-user-select:\s*none/.test(root) && /user-select:\s*none/.test(root) && /user-drag:\s*none/.test(root),
  root,
);
}

// ③q 从详情返回：记住当前条目 id，重新挂载时恢复到该下标
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({ items: [makeItem(1), makeItem(2), makeItem(3), makeItem(4)] });
  const app = makeApp(state);
  await app.start();
  const sw1 = FakeSwiper.instances[0];
  ok("③q0 首次从第 0 条开始", sw1.activeIndex === 0);
  sw1.activeIndex = 2; // 模拟用户翻到第 3 条
  app.rememberResume();
  eq("③q1 记住了第 3 条的 Id", app._resumeId, String(app.pool[2].Id));
  app.teardown();
  // 再次进入（同一份池子）
  FakeSwiper.instances = [];
  await app.start();
  const sw2 = FakeSwiper.instances[0];
  eq("③q2 重新挂载时用 initialSlide 恢复", sw2.params.initialSlide, 2);
  eq("③q3 活动页也是第 3 条", sw2.activeIndex, 2);
  app.teardown();
})();

// ③r 首条预告片：必须在 applyHeroHeight（写好 --hs-video-w）之后才排，否则永远不播
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const item = makeItem(1);
  item.LocalTrailerCount = 1;
  const app = makeApp(state);
  app.pool = [item];
  let called = null;
  app.scheduleTrailer = (i) => { called = i; };
  await app.start();
  eq("③r 首条预告片在量高之后才排队", called, 0);
  app.teardown();
})();

// ③s 预告片声音：先尝试有声，被拦才降级静音 + 手势补声
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  await app.start();
  app.settings = Object.assign({}, app.settings, { TrailerVolume: 0.35 });
  eq("③s1 音量取设置项 TrailerVolume", app.trailerVolume(), 0.35);
  app.settings.TrailerVolume = 9;
  eq("③s2 音量夹到 1", app.trailerVolume(), 1);
  app.settings.TrailerVolume = -3;
  eq("③s3 音量夹到 0", app.trailerVolume(), 0);
  ok("③s4 有手势补声的实现", typeof app.playMutedAndArmUnmute === "function");
  app.teardown();
})();

// ③t 缩放/停播后必须恢复自动翻页；尺寸变化不能停播
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  await app.start();
  const sw = FakeSwiper.instances[0];
  // 模拟"正在播预告片"：图片阶段已停
  app._videoIndex = 0;
  app.stopImagePhase();
  eq("③t0 播片时图片阶段停止", app._phaseIdx, -1);
  const startsBefore = app._phaseStarts || 0;
  app.stopTrailer("test");
  ok("③t1 stopTrailer 后重新启动图片阶段（进度条不再卡住）", (app._phaseStarts || 0) > startsBefore);
  // keepPaused 分支：播完要先看封面
  app._videoIndex = 1;
  app.stopImagePhase();
  app.stopTrailer("ended", true);
  eq("③t2 keepPaused 时保持暂停（图片阶段不重启）", app._phaseIdx, -1);
  app.teardown();
})();

// ③u 视频面板比例跟随视频（默认 16:9，元数据到达后按真实比例）
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  await app.start();
  app.settings = Object.assign({}, app.settings, { PlayTrailer: true });
  app.root.clientHeight = 900;
  app.root.clientWidth = 1600;
  app._videoAspect = 16 / 9;
  app.layoutVideo(900, 1600);
  const w169 = app._videoW;
  const h169 = app._videoH;
  eq("③u1 1600 宽 ⇒ 满高播放，面板宽 1248（左右裁 22%）", w169, Math.round(1600 * 0.78));
  eq("③u2 高度满高 900", h169, 900);
  app.layoutVideo(900, 2400); // 宽窗口 ⇒ 撑满高度，正常播
  eq("③u3 2400 宽 ⇒ 1872（78%）", app._videoW, Math.round(2400 * 0.78));
  eq("③u4 高度撑满 900", app._videoH, 900);
  app.layoutVideo(900, 1366); // 1366×900：盒比 1.18 ⇒ 左右裁 34% > 30% ⇒ 不播
  eq("③u4b 1366 宽（裁 34%）⇒ 仍播（能放就播）", app._videoW, Math.round(1366 * 0.78));
  app.layoutVideo(844, 1395); // 截图那个尺寸：盒比 1.29 ⇒ 裁 27% ≤ 30% ⇒ 播
  eq("③u4c 1395×844（裁 27%）⇒ 播", app._videoW, Math.round(1395 * 0.78));
  app.layoutVideo(900, 1040); // 窄 ⇒ 不播
  eq("③u5 1040 宽 ⇒ 811 ≥ 680，仍播", app._videoW, Math.round(1040 * 0.78));
  app.layoutVideo(900, 900); // 更窄 ⇒ 不播
  eq("③u6 900 宽 ⇒ 702 ≥ 680，仍播", app._videoW, Math.round(900 * 0.78));
  app.teardown();
})();

// ③v 窗口从"放不下"恢复到"放得下"⇒ 给当前这张重新排队
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  await app.start();
  app.settings = Object.assign({}, app.settings, { PlayTrailer: true });
  let scheduled = -1;
  app.scheduleTrailer = (i) => {
    scheduled = i;
  };
  app.activePoolIndex = () => 3;
  app.layoutVideo(900, 2400); // 放得下（首次：从"没有面板"到"有面板"）
  eq("③v0 首次放得下 ⇒ 给当前这张排队", scheduled, 3);
  scheduled = -1;
  app.layoutVideo(900, 640); // 太窄 ⇒ 640×80% = 512，保底也只有 640 < 680
  eq("③v1 变窄后 _videoW=0（保底也 < 680）", app._videoW, 0);
  eq("③v1b 没位置时不排队", scheduled, -1);
  scheduled = -1;
  app.layoutVideo(900, 2400); // 又放得下
  eq("③v2 恢复后给当前这张重排", scheduled, 3);
  app.teardown();
})();

// ③w 视频填充方式：常规比例裁剪、极端比例缩放
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  await app.start();
  app.settings = Object.assign({}, app.settings, { PlayTrailer: true });
  app._videoAspect = 16 / 9;
  app.layoutVideo(860, 2143);
  eq("③w1 横向素材 ⇒ cover", app.root.style.getPropertyValue("--hs-video-fit"), "cover");
  eq("③w1b 面板宽 = 2143 × 78%（固定占比）", app._videoW, Math.round(2143 * 0.78));
  app._videoAspect = 2.35;
  app.layoutVideo(860, 2143);
  eq("③w2 2.35:1 横向 ⇒ cover", app.root.style.getPropertyValue("--hs-video-fit"), "cover");
  app._videoAspect = 3.0;
  app.layoutVideo(860, 2143);
  eq("③w3 超宽银幕 3:1 ⇒ 高度收缩到 557，cover 且零裁切", app.root.style.getPropertyValue("--hs-video-fit"), "cover");
  app._videoAspect = 2.39;
  app.layoutVideo(1080, 1920);
  eq("③w3b 2.39 片 ⇒ 高度收缩，cover 且零裁切", app.root.style.getPropertyValue("--hs-video-fit"), "cover");
  app._videoAspect = 16 / 9;
  app.layoutVideo(1080, 1920);
  eq("③w3c 16:9 片在 16:9 盒子 ⇒ 仍 cover（裁 22% 可接受）", app.root.style.getPropertyValue("--hs-video-fit"), "cover");
  app._videoAspect = 0.8;
  app.layoutVideo(860, 2143);
  eq("③w4 竖屏 ⇒ contain（不切人）", app.root.style.getPropertyValue("--hs-video-fit"), "contain");
  app.teardown();
})();

// ③x 宽窗口：高度按视频比例收缩后仍播放（带子判定只在"太矮"时生效）
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  await app.start();
  app.settings = Object.assign({}, app.settings, { PlayTrailer: true });
  app._videoAspect = 16 / 9;
  app.layoutVideo(900, 2400); // 1872 宽：撑满高度，正常播
  eq("③x1 2400 宽 ⇒ 1872（78%）", app._videoW, Math.round(2400 * 0.78));
  eq("③x2 高度撑满 900", app._videoH, 900);
  app._videoAspect = 2.39; // 宽银幕：按比例收缩到 783（> 765 阈值）仍播
  app.layoutVideo(900, 2400);
  eq("③x3 2.39 ⇒ 满高 900（上下不裁，左右裁 3%）", app._videoH, 900);
  eq("③x4 2.39 ⇒ cover（盒子已按比例，零裁切）", app.root.style.getPropertyValue("--hs-video-fit"), "cover");
  app._videoAspect = 0.8; // 竖屏 ⇒ contain
  app.layoutVideo(900, 2400);
  eq("③x5 竖屏 ⇒ contain", app.root.style.getPropertyValue("--hs-video-fit"), "contain");
  app._videoAspect = 16 / 9;
  app.layoutVideo(900, 2400);
  eq("③x6 cover 时取景重心 = center 55%（取景框下移）", app.root.style.getPropertyValue("--hs-video-pos"), "center 55%");
  app.teardown();
})();

// ③y 窗口缩到放不下面板 ⇒ 声音渐隐后再停（不是瞬间静音）
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  await app.start();
  ok("③y1 有 fadeOutAudio 实现", typeof app.fadeOutAudio === "function");
  // 没有 video 元素时返回 false（stopTrailer 会退回直接 pause）
  app.videoEl = null;
  ok("③y2 无 video 时返回 false", app.fadeOutAudio() === false);
  // 有 video 且未暂停 ⇒ 接管
  let paused = false;
  app.videoEl = { paused: false, volume: 0.6, pause() { paused = true; } };
  ok("③y3 有 video 时接管暂停", app.fadeOutAudio() === true);
  ok("③y4 首帧音量不增（从当前音量往下走）", app.videoEl.volume <= 0.6);
  app.videoEl = null;
  app.teardown();
})();

// ③z 切条：有预告片的条目要识别出来，并收起旧面板
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  await app.start();
  const item = app.pool[1];
  item.LocalTrailerCount = 1;
  app._trailerIds[String(item.Id)] = "t-1";
  ok("③z1 有预告片的条目 itemHasTrailer=true", app.itemHasTrailer(1) === true);
  app.root.classList.add("is-trailer");
  app.notifyVideoLayer(0, 1);
  ok("③z2 切条后旧面板已收起（is-trailer 移除）", !app.root.classList.contains("is-trailer"));
  app.teardown();
})();

// ③aa 预告片播完 ⇒ 直接翻到下一个（不是重新起 30 秒计时）
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  await app.start();
  app.settings = Object.assign({}, app.settings, { ImageInterval: 30 });
  const sw = FakeSwiper.instances[0];
  let next = 0;
  sw.slideNext = () => {
    next++;
  };
  app.stopImagePhase();
  app.onTrailerEnded();
  // 定时器是 700ms，用假时钟推进
  app.tick ? app.tick(800) : null;
  ok("③aa1 onTrailerEnded 不立即翻页（等 700ms，避免与退场撞车）", next === 0);
  app.teardown();
})();

// ③ab 起播必须取消上一次遗留的"清 src"定时器（否则新视频被清掉 ⇒ 时好时坏）
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  await app.start();
  let cleared = 0;
  const origClear = app.clearTimer.bind(app);
  app.clearTimer = (key) => {
    if (key === "trailer-src-clear") cleared++;
    return origClear(key);
  };
  const item = app.pool[0];
  app.settings = Object.assign({}, app.settings, { PlayTrailer: true });
  app._videoW = 1000;
  app._trailerIds[String(item.Id)] = "t-1";
  app._tQueue = app.nowMs() - 1000; // 视为"早就切过条了"，不再走最小起播延迟
  app.playTrailer(0, "t-1");
  ok("③ab 起播时取消了 trailer-src-clear", cleared >= 1, "cleared=" + cleared);
  app.teardown();
})();

// ③ac 手动翻页：直接调用 swiper（动画全归零的基线状态）
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({ settings: { SelectionLogic: "recent" } });
  const app = makeApp(state);
  await app.start();
  const sw = FakeSwiper.instances[0];
  let next = 0;
  let prev = 0;
  sw.slideNext = () => {
    next++;
  };
  sw.slidePrev = () => {
    prev++;
  };
  app._hotNextClick();
  app._hotNextClick();
  eq("③ac1 热区下一次 = 翻一页", next, 2);
  app._hotPrevClick();
  eq("③ac2 热区上一次 = 回退一页", prev, 1);
  ok("③ac3 热区点击处理器已绑定", typeof app._hotNextClick === "function" && typeof app._hotPrevClick === "function");
  app.teardown();
})();

// ④ 唯一的滚动职责：滚过一屏收起库条
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  addEl(state.doc.body, "headerMiddle");
  const scroller = addEl(state.view, "emby-scroller");
  const slider = addEl(scroller, "scrollSlider");
  void slider;
  scroller.clientHeight = 800;
  scroller.scrollHeight = 3000;
  scroller.scrollTop = 0;
  const app = makeApp(state);
  await app.start();
  ok("④ 挂上了库条滚动监听", app._libBarScrollEl === scroller);
  scroller.scrollTop = 900;
  app.syncLibBarVisibility();
  ok("④ 滚过一屏 → 库条加 is-hero-out", !!app.libBarEl && app.libBarEl.classList.contains("is-hero-out"));
  scroller.scrollTop = 120;
  app.syncLibBarVisibility();
  ok("④ 回到顶部 → 摘掉 is-hero-out", !app.libBarEl.classList.contains("is-hero-out"));
  app.teardown();
  ok("④ 撤离后滚动句柄已清", app._libBarScrollHandler === null);
})();

/* ------------------------------------------------------------------ *
 * 17. S6：媒体库条（.headerMiddle）+ 设置入口/面板（.mainDrawer）
 * ------------------------------------------------------------------ */

console.log("== 17. S6 媒体库条 + 设置面板 ==");

// 1) 库条渲染 + body.hs-libbar + teardown 清理
await (async () => {
  FakeSwiper.instances = [];
  const libs = [{ Id: "1", Name: "甲" }, { Id: "2", Name: "乙" }, { Id: "3", Name: "丙" }];
  const state = makeState({ libraries: libs });
  const header = addEl(state.doc.body, "headerMiddle");
  addEl(state.doc.body, "mainDrawer");
  const app = makeApp(state);
  await app.start();

  const bar = state.doc.querySelector(".hs-libbar");
  ok("1a) 挂载后存在 .hs-libbar", !!bar);
  const items = bar ? bar.querySelectorAll(".hs-libbar__item") : [];
  eq("1b) 3 个库 ⇒ 3 个 .hs-libbar__item", items.length, 3);
  eq("1c) 三项文本 = 库名", items.map((i) => i.textContent), ["甲", "乙", "丙"]);
  eq(
    "1d) 仅当前库（LibId=1）带 .is-active",
    items.filter((i) => i.classList.contains("is-active")).map((i) => i.getAttribute("data-lib-id")),
    ["1"],
  );
  ok("1e) 挂载后 body 有 hs-libbar", state.doc.body.classList.contains("hs-libbar"));
  ok("1f) 库条挂在 .headerMiddle 内", header.contains(bar));

  app.teardown();
  ok("1g) teardown 后 body 无 hs-libbar", !state.doc.body.classList.contains("hs-libbar"));
  ok("1h) teardown 后 .hs-libbar 不在 DOM", !state.doc.querySelector(".hs-libbar"));
})();

// 2) 点击某项 ⇒ **进入该媒体库（导航）**，不再切轮播库（旧行为已删）
await (async () => {
  FakeSwiper.instances = [];
  const libs = [{ Id: "1", Name: "甲" }, { Id: "2", Name: "乙" }, { Id: "3", Name: "丙" }];
  const state = makeState({ libraries: libs });
  addEl(state.doc.body, "headerMiddle");
  addEl(state.doc.body, "mainDrawer");
  const app = makeApp(state);
  await app.start();

  let writes = 0;
  let applied = 0;
  app.writeSettings = function (s) {
    writes += 1;
    return s;
  };
  app.applySettingsLive = function () {
    applied += 1;
    return Promise.resolve(true);
  };

  // 装 Emby 路由器桩
  let shown = null;
  globalThis.Emby = { Page: { showItem: (id) => { shown = id; } } };
  const bar = state.doc.querySelector(".hs-libbar");
  bar.querySelectorAll(".hs-libbar__item")[1].dispatch("click", { type: "click" });
  eq("2a) 点击库条项 ⇒ 进入该库（Emby.Page.showItem(lib.Id)）", shown, "2");
  eq("2b) 旧行为已删：不再 writeSettings（0 次）", writes, 0);
  eq("2c) 旧行为已删：不再 applySettingsLive（0 次）", applied, 0);
  eq("2d) 轮播用库未变（settings.LibId 不动）", app.settings.LibId, "1");
  const active = bar.querySelectorAll(".hs-libbar__item").filter((i) => i.classList.contains("is-active"));
  eq("2e) .is-active 仍按 settings.LibId（纯信息性）标在「1」", active.map((i) => i.getAttribute("data-lib-id")), ["1"]);
  delete globalThis.Emby;
})();

// 3) 面板初值 = readSettings 的返回；面板路径 storage.getItem 次数为 0
await (async () => {
  FakeSwiper.instances = [];
  const libs = [{ Id: "1", Name: "甲" }, { Id: "2", Name: "乙" }];
  const state = makeState({ libraries: libs });
  addEl(state.doc.body, "mainDrawer");
  const app = makeApp(state);
  await app.start();

  const expected = readSettings("U1", state.env, libs);

  let getItems = 0;
  const origGet = state.rawStorage.getItem;
  state.rawStorage.getItem = function (k) {
    getItems += 1;
    return origGet.call(this, k);
  };
  app.openPanel();
  state.rawStorage.getItem = origGet; // 还原，避免影响后续用例

  ok("3a0) 自检：面板确实打开（DOM 有 .hs-panel）", !!state.doc.querySelector(".hs-panel"));
  eq("3a) 面板路径上 storage.getItem 调用次数为 0", getItems, 0);
  const f = app.panelFields;
  eq("3b) LibId 初值 = readSettings 返回", String(f.LibId.control.value), String(expected.LibId));
  eq("3c) SelectionLogic 初值", String(f.SelectionLogic.control.value), String(expected.SelectionLogic));
  eq("3d) PoolSize 初值", String(f.PoolSize.control.value), String(expected.PoolSize));
  eq("3e) ImageInterval 初值（秒）", String(f.ImageInterval.control.value), String(Math.round(expected.ImageInterval / 1000)));
  eq("3f) PlayTrailer 初值", !!f.PlayTrailer.control.checked, expected.PlayTrailer);
  eq("3g) TrailerVolume 初值", String(f.TrailerVolume.control.value), String(expected.TrailerVolume));
  app.closePanel();
})();

// 4) PlayTrailer=false ⇒ TrailerVolume 行自动隐藏
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({ libraries: [{ Id: "1", Name: "甲" }] });
  addEl(state.doc.body, "mainDrawer");
  const app = makeApp(state);
  await app.start();
  app.openPanel();
  const pt = app.panelFields.PlayTrailer;
  const tv = app.panelFields.TrailerVolume;
  ok("4a) 初始可见（PlayTrailer 默认 true）", tv.field.style.display !== "none");
  pt.control.checked = false;
  pt.control.dispatch("change", { type: "change" });
  eq("4b) PlayTrailer=false ⇒ TrailerVolume 行 display:none", tv.field.style.display, "none");
  ok("4c) 且带 hidden 属性", tv.field.getAttribute("hidden") === "");
  pt.control.checked = true;
  pt.control.dispatch("change", { type: "change" });
  ok("4d) 切回 true ⇒ 行恢复可见", tv.field.style.display !== "none" && tv.field.getAttribute("hidden") === null);
  app.closePanel();
})();

// 5) 保存 ⇒ ImageInterval 秒→毫秒；六个键名逐字正确
await (async () => {
  FakeSwiper.instances = [];
  const libs = [{ Id: "1", Name: "甲" }, { Id: "2", Name: "乙" }];
  const state = makeState({ libraries: libs });
  addEl(state.doc.body, "mainDrawer");
  const app = makeApp(state);
  await app.start();

  let captured = null;
  app.writeSettings = function (s) {
    captured = s;
    return s;
  };
  app.applySettingsLive = function () {
    return Promise.resolve(true);
  };

  app.openPanel();
  const f = app.panelFields;
  f.ImageInterval.control.value = "15"; // 秒
  f.PoolSize.control.value = "12";
  f.TrailerVolume.control.value = "0.8";
  f.LibId.control.value = "2";
  f.SelectionLogic.control.value = "recent";
  f.PlayTrailer.control.checked = true;
  app.panelSaveBtn.dispatch("click", { type: "click" });

  ok("5a) 保存触发 writeSettings", !!captured);
  eq("5b) ImageInterval 秒→毫秒（15s→15000）", captured && captured.ImageInterval, 15000);
  eq(
    "5c) 六个键名逐字正确",
    Object.keys(captured).sort(),
    ["ImageInterval", "LibId", "PlayTrailer", "PoolSize", "SelectionLogic", "TrailerVolume"].sort(),
  );
  eq("5d) PoolSize 透传", captured.PoolSize, 12);
  eq("5e) TrailerVolume 透传", captured.TrailerVolume, 0.8);
  eq("5f) LibId 透传", captured.LibId, "2");
  app.closePanel();
})();

// 6) 面板 close：Esc 关闭 + 焦点陷阱可调用（不抛）
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({ libraries: [{ Id: "1", Name: "甲" }] });
  addEl(state.doc.body, "mainDrawer");
  const app = makeApp(state);
  await app.start();
  app.openPanel();
  ok("6a) 打开后 .hs-panel 在 DOM", !!state.doc.querySelector(".hs-panel"));
  // 挂面板期间 doc 上有 keydown 捕获监听
  const before = state.doc.listenerCount("keydown");
  ok("6b) 打开时挂了 keydown 监听", before >= 1);
  let threw = false;
  try {
    app.onPanelKeydown({ key: "Escape", preventDefault() {} });
  } catch (e) {
    threw = true;
  }
  ok("6c) Esc 关闭不抛错", !threw);
  ok("6d) Esc 后 .hs-panel 已移除", !state.doc.querySelector(".hs-panel"));
  ok("6e) keydown 监听已摘", state.doc.listenerCount("keydown") === before - 1);
})();

// 7) teardown 清理：库条 / 入口 / 面板均移除；两个观察器已 disconnect
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({ libraries: [{ Id: "1", Name: "甲" }] });
  addEl(state.doc.body, "headerMiddle");
  addEl(state.doc.body, "mainDrawer");
  const app = makeApp(state);
  await app.start();
  app.openPanel();
  const lbObs = app.libBarObserver;
  ok("7a) 库条观察器已建立", !!lbObs);
  app.teardown();
  ok("7b) .hs-libbar 不在 DOM", !state.doc.querySelector(".hs-libbar"));
  ok("7c) 侧栏入口已彻底移除（设置只走顶栏按钮）", !state.doc.querySelector(".hs-settings-entry"));
  ok("7d) .hs-panel 不在 DOM", !state.doc.querySelector(".hs-panel"));
  ok("7e) body 无 hs-libbar", !state.doc.body.classList.contains("hs-libbar"));
  ok("7f) 库条观察器已 disconnect", lbObs.disconnected === true);
})();

// 8) 媒体库条鼠标拖动横向滚动 + 拖动后抑制点击
await (async () => {
  FakeSwiper.instances = [];
  const libs = [{ Id: "1", Name: "甲" }, { Id: "2", Name: "乙" }, { Id: "3", Name: "丙" }];
  const state = makeState({ libraries: libs });
  addEl(state.doc.body, "headerMiddle");
  addEl(state.doc.body, "mainDrawer");
  const app = makeApp(state);
  await app.start();
  const track = app.libBarTrack;
  ok("8a0) track 存在", !!track);

  let writes = 0;
  let applied = 0;
  let shownIds = [];
  app.writeSettings = function (s) {
    writes += 1;
    return s;
  };
  app.applySettingsLive = function () {
    applied += 1;
    return Promise.resolve(true);
  };
  // 点击＝进入该库（导航），不再切轮播库。桩掉 Emby 路由器以断言 showItem 被调用。
  globalThis.Emby = { Page: { showItem: (id) => { shownIds.push(String(id)); } } };

  // e) 未 pointerdown 时 pointermove 不改 scrollLeft
  track.scrollLeft = 100;
  track.dispatch("pointermove", { clientX: 10, pointerId: 7 });
  eq("8e) 未 pointerdown 时 pointermove 不改 scrollLeft", track.scrollLeft, 100);

  // a) 拖动：dx < 0 ⇒ scrollLeft = startScrollLeft - dx
  track.scrollLeft = 100;
  track.dispatch("pointerdown", { button: 0, clientX: 500, pointerId: 7 });
  ok("8a1) pointerdown 后带 is-dragging", track.classList.contains("is-dragging"));
  track.dispatch("pointermove", { clientX: 450, pointerId: 7 }); // dx = -50（> 阈值）
  eq("8a) 拖动位移 > 阈值 ⇒ scrollLeft = start - dx（100-(-50)=150）", track.scrollLeft, 150);
  track.dispatch("pointerup", { clientX: 450, pointerId: 7 });
  ok("8a2) pointerup 后 is-dragging 已移除", !track.classList.contains("is-dragging"));

  // b) 拖动之后紧随的 click 被吞掉（不应触发导航）
  const shownBefore = shownIds.length;
  track.querySelectorAll(".hs-libbar__item")[1].dispatch("click", { type: "click" });
  eq("8b1) 拖动后的 click 被吞：showItem 0 次", shownIds.length, shownBefore);
  eq("8b2) 拖动后的 click 被吞：writeSettings 0 次", writes, 0);
  eq("8b3) 拖动后的 click 被吞：applySettingsLive 0 次", applied, 0);

  // c) 纯点击（无位移）⇒ 进入该库（showItem 被调，且不切轮播库）
  track.dispatch("pointerdown", { button: 0, clientX: 700, pointerId: 8 });
  track.dispatch("pointerup", { clientX: 700, pointerId: 8 });
  track.querySelectorAll(".hs-libbar__item")[1].dispatch("click", { type: "click" });
  eq("8c1) 纯点击 ⇒ showItem(lib.Id) 被调用", shownIds[shownIds.length - 1], "2");
  eq("8c2) 纯点击 ⇒ writeSettings 仍 0（不再切轮播库）", writes, 0);
  eq("8c3) 纯点击 ⇒ applySettingsLive 仍 0", applied, 0);

  // d) 位移正好 = 阈值(4px) 不算拖动 ⇒ 随后的 click 不应被吞
  track.dispatch("pointerdown", { button: 0, clientX: 300, pointerId: 9 });
  track.dispatch("pointermove", { clientX: 304, pointerId: 9 }); // dx = 4（不 > 4）
  track.dispatch("pointerup", { clientX: 304, pointerId: 9 });
  const s2 = shownIds.length;
  track.querySelectorAll(".hs-libbar__item")[0].dispatch("click", { type: "click" });
  eq("8d) dx=阈值(4) 不算拖动 ⇒ click 生效（showItem +1）", shownIds.length, s2 + 1);

  app.teardown();
})();

// 9) f) teardown 后 track 上 pointer 监听成对移除（计数桩）
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({ libraries: [{ Id: "1", Name: "甲" }] });
  addEl(state.doc.body, "headerMiddle");
  addEl(state.doc.body, "mainDrawer");
  const app = makeApp(state);

  const adds = [];
  const removes = [];
  const origAdd = El.prototype.addEventListener;
  const origRemove = El.prototype.removeEventListener;
  const isPtr = (t) => String(t).indexOf("pointer") === 0;
  El.prototype.addEventListener = function (t, fn) {
    if (this === app.libBarTrack && isPtr(t)) adds.push(t);
    return origAdd.call(this, t, fn);
  };
  El.prototype.removeEventListener = function (t, fn) {
    if (this === app.libBarTrack && isPtr(t)) removes.push(t);
    return origRemove.call(this, t, fn);
  };
  try {
    await app.start();
    ok("9f0) 拖动监听只挂一次（4 个 pointer 监听）", adds.length === 4, JSON.stringify(adds));
    app.teardown();
    ok("9f) teardown 后 pointer 监听 add/remove 成对", removes.length === adds.length && removes.length === 4, JSON.stringify(removes));
  } finally {
    El.prototype.addEventListener = origAdd;
    El.prototype.removeEventListener = origRemove;
  }
})();

/* ------------------------------------------------------------------ *
 * 18. 箭头悬停反馈环修复（热区=唯一交互层）+ 回首页不加载（延迟复检 + hashchange + mounted 复检）
 * ------------------------------------------------------------------ */

console.log("== 18. 箭头/热区 + 回首页 ==");

// a) 箭头基础规则含 pointer-events:none（不是只在隐藏态）
{
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const css = fs.readFileSync(path.join(__dirname, "styles.css"), "utf8");
  const arrowBase = (css.match(/body\.hs-home \.hs-root \.swiper-button-prev,[^{]*\{[^}]*\}/) || [""])[0];
  ok("18a0) 自检：抓到箭头基础规则块", arrowBase.length > 0, arrowBase);
  ok("18a) 箭头基础规则含 pointer-events: none", /pointer-events\s*:\s*none/.test(arrowBase), arrowBase);
  // b) 存在「热区 hover → 箭头 background」规则（精确匹配到含 background 的那条，勿误配 opacity 的可见态规则）
  const hoverBg = (
    css.match(
      /body\.hs-home \.hs-root \.hs-hotzone--prev:hover ~ \.swiper-button-prev,\s*body\.hs-home \.hs-root \.hs-hotzone--next:hover ~ \.swiper-button-next\s*\{[^}]*\}/,
    ) || [""]
  )[0];
  ok("18b0) 自检：抓到热区 hover ⇒ 箭头 background 规则块", hoverBg.length > 0, hoverBg);
  ok("18b) 热区 hover ⇒ 箭头 background 加深规则存在", /background\s*:/.test(hoverBg), hoverBg);
}

// c) DOM 顺序：hotNext 在 nextBtn 之前（~ 复合选择器依赖此顺序）
// d) 点击热区导航；箭头自身点击不导航（未给箭头绑 click）
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({ settings: { SelectionLogic: "recent" } });
  const app = makeApp(state);
  await app.start();

  const kids = app.root.children.map((c) => c.className);
  const iHotNext = kids.indexOf("hs-hotzone hs-hotzone--next");
  const iNextBtn = kids.indexOf("swiper-button-next");
  ok("18c) hotNext 在 nextBtn 之前（~ 依赖此顺序，防回归）", iHotNext >= 0 && iNextBtn >= 0 && iHotNext < iNextBtn, JSON.stringify(kids));

  let nexts = 0;
  let prevs = 0;
  app.swiper.slideNext = () => {
    nexts += 1;
  };
  app.swiper.slidePrev = () => {
    prevs += 1;
  };
  app.hotNext.dispatch("click", { type: "click" });
  app.hotPrev.dispatch("click", { type: "click" });
  eq("18d1) 点击后热区 ⇒ slideNext ×1", nexts, 1);
  eq("18d2) 点击前热区 ⇒ slidePrev ×1", prevs, 1);
  // 箭头自身点击不应触发导航（pointer-events:none + 未绑 click）
  app.nextBtn.dispatch("click", { type: "click" });
  app.prevBtn.dispatch("click", { type: "click" });
  eq("18d3) 箭头点击不导航（未给箭头绑 click）", [nexts, prevs], [1, 1]);
})();

// e) bootstrap 挂 hashchange 且撤离后仍在（全局资源）
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  let hashAdds = 0;
  let hashRemoves = 0;
  state.win.addEventListener = function (t) {
    if (t === "hashchange") hashAdds += 1;
  };
  state.win.removeEventListener = function (t) {
    if (t === "hashchange") hashRemoves += 1;
  };
  const app = makeApp(state);
  app.bootstrap();
  eq("18e) bootstrap() 挂了 hashchange", hashAdds, 1);
  await app.mountPromise;
  app.teardown();
  eq("18e2) 撤离后 hashchange 仍在（全局资源，不移除）", hashRemoves, 0);
})();

// f) 判非 home 时不立即 teardown；窗口内变真 ⇒ 始终不拆
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  app.bootstrap();
  await app.mountPromise;
  ok("18f0) 已挂载", app.mounted === true);
  let teardowns = 0;
  const origTd = app.teardown.bind(app);
  app.teardown = function () {
    teardowns += 1;
    return origTd();
  };
  // 模拟离开：视图被隐藏 + hash 非 home
  state.view.classList.add("hide");
  state.win.location.hash = "#/item";
  app._viewHandler();
  ok("18f1) 判非 home 时不立即 teardown（mounted 仍真、根容器仍在）", app.mounted === true && !!app.root && !!app.root.parentNode);
  eq("18f2) 此刻 teardown 未被调用", teardowns, 0);
  // 窗口内又回 home → 取消待拆
  state.view.classList.remove("hide");
  state.win.location.hash = "#!/home";
  app._viewHandler();
  state.timers.runAll(); // 冲刷（被取消的待拆不应触发）
  eq("18f3) 窗口内回 home ⇒ 始终未拆", teardowns, 0);
  ok("18f4) 轮播仍挂载", app.mounted === true);
})();

// g) 复检到点仍非 home ⇒ 正常 teardown
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  app.bootstrap();
  await app.mountPromise;
  let teardowns = 0;
  const origTd = app.teardown.bind(app);
  app.teardown = function () {
    teardowns += 1;
    return origTd();
  };
  state.view.classList.add("hide");
  state.win.location.hash = "#/item";
  app._viewHandler();
  ok("18g0) 延迟窗口内仍挂载", app.mounted === true);
  state.timers.runAll(); // 复检到点，仍非 home → teardown
  eq("18g) 复检仍非 home ⇒ teardown 1 次", teardowns, 1);
  ok("18g2) 已撤离", app.mounted === false && !state.doc.querySelector(".hs-root"));
})();

// h) mounted===true 但根容器已脱离 DOM ⇒ start() 不得空转返回
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  await app.start();
  ok("18h0) 初始已挂载", app.mounted === true && !!app.root && !!app.root.parentNode);
  app.root.parentNode.removeChild(app.root); // 模拟 Emby 清掉根容器（mounted 仍真）
  ok("18h1) 根容器已脱离 DOM", !app.root.parentNode);
  app.start(); // 不得空转返回
  ok("18h2) start() 检测到根容器脱离 ⇒ 重新挂回 DOM", !!(app.root && app.root.parentNode));
  ok("18h3) 根容器回到宿主内", app.mountContainer.contains(app.root));
})();

/* ------------------------------------------------------------------ *
 * 19. 容器解析「可见优先」+ 根容器归位（真机：锁死在隐藏旧视图）
 * ------------------------------------------------------------------ */

console.log("== 19. 可见优先的容器解析 + 根容器归位 ==");

// a) 两个 .tabContent[data-index="0"]：第一个在 page-hidden 里、第二个可见 ⇒ 必须选第二个
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({ noTabContent: true });
  const v1 = addEl(state.doc.body, "view");
  const t1 = addEl(v1, "tabContent");
  t1.setAttribute("data-index", "0");
  v1.classList.add("page-hidden"); // 旧视图：隐藏但仍在 DOM
  const v2 = addEl(state.doc.body, "view");
  const t2 = addEl(v2, "tabContent");
  t2.setAttribute("data-index", "0"); // 新视图：可见

  const app = makeApp(state);
  ok("19a1) resolveMountContainer 返回可见的那个 .view（第二个）", app.resolveMountContainer() === v2);
  await app.start();
  ok("19a2) mount() 后根容器在可见宿主里", app.root.parentNode === v2);
  ok("19a3) 可见宿主带 hs-host", v2.classList.contains("hs-host"));
  ok("19a4) 隐藏旧宿主无 hs-host", !v1.classList.contains("hs-host"));
})();

// b) 根容器留在隐藏旧视图里、mounted===true ⇒ start() 把它搬回可见宿主（迁移 hs-host）
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  await app.start();
  const oldView = state.view;
  ok("19b0) 初始挂在 state.view", app.root.parentNode === oldView && app.mounted === true);
  // 新的可见视图出现；旧视图隐藏
  const v2 = addEl(state.doc.body, "view");
  const t2 = addEl(v2, "tabContent");
  t2.setAttribute("data-index", "0");
  oldView.classList.add("page-hidden");
  app.start(); // mounted===true，但当前宿主已变 ⇒ 必须搬迁而非静默返回
  ok("19b) start() 把根容器搬到可见宿主", app.root.parentNode === v2, app.root.parentNode && app.root.parentNode.className);
  ok("19b2) 新宿主带 hs-host", v2.classList.contains("hs-host"));
  ok("19b3) 旧宿主已无 hs-host", !oldView.classList.contains("hs-host"));
})();

// c) findScrollerHost：跳过 0 尺寸候选 + scrollingElement 兜底
await (async () => {
  const state = makeState({ noTabContent: true });
  state.tab.remove();
  const app = makeApp(state);
  app.mountContainer = state.view;
  addEl(state.view, "emby-scroller", 0, 0); // 0×0 在前
  const sc = addEl(state.view, "scrollFrameY", 1000, 400); // 可滚在后
  ok("19c1) 前面 0×0、后面可滚 ⇒ 返回可滚的那个", app.findScrollerHost() === sc);

  const state2 = makeState({ noTabContent: true });
  state2.tab.remove();
  const app2 = makeApp(state2);
  app2.mountContainer = state2.view;
  addEl(state2.view, "emby-scroller", 0, 0); // 唯一候选、0 尺寸
  state2.doc.documentElement.scrollHeight = 5000; // 让 scrollingElement 可滚
  state2.doc.documentElement.clientHeight = 800;
  ok(
    "19c2) 全 0 尺寸候选 + 可滚的 scrollingElement ⇒ 走兜底 scrollingElement",
    app2.findScrollerHost() === state2.doc.scrollingElement,
  );
})();

// e) 只有隐藏的 .tabContent[data-index="0"] + hash 非 home ⇒ isHome false
await (async () => {
  const state = makeState({ hash: "#!/item?id=1" });
  const app = makeApp(state);
  state.view.classList.add("page-hidden");
  eq("19e) 只有隐藏的 tabContent + hash 非 home ⇒ isHome false", app.isHome(), false);
})();

// f) start() 的"静默返回"分支确实打了 dbg（带 className 与宿主是否一致）
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  await app.start();
  const logs = [];
  const origDbg = app.dbg.bind(app);
  app.dbg = (factory) => {
    try {
      logs.push(typeof factory === "function" ? factory() : factory);
    } catch (e) {
      /* ignore */
    }
  };
  app.start(); // mounted 且宿主正确 ⇒ 走"仍在 DOM 且宿主正确"分支
  app.dbg = origDbg;
  ok(
    "19f) start() 静默返回分支确实打了 dbg（含『仍在 DOM』）",
    logs.some((l) => String(l).indexOf("仍在 DOM") >= 0),
    JSON.stringify(logs),
  );
})();

/* ------------------------------------------------------------------ *
 * 20. 宿主搬迁后观察器重挂（同类风险：观察器仍挂在旧宿主 → 间歇性失灵）
 * ------------------------------------------------------------------ */

console.log("== 20. 宿主搬迁后观察器重挂 ==");

await (async () => {
  FakeSwiper.instances = [];
  TrackingMO.reset();
  TrackingRO.reset();
  const state = makeState({});
  state.win.MutationObserver = TrackingMO;
  state.win.ResizeObserver = TrackingRO;
  const app = makeApp(state);
  await app.start();

  // a) 初始主观察器观察的是当时的宿主
  const initialHost = app.mountContainer;
  const mo0 = TrackingMO.active();
  ok(
    "20a) 初始主观察器观察当时宿主（活跃数=1）",
    mo0.length === 1 && mo0[0].target === initialHost,
    JSON.stringify(mo0.map((o) => o.target && o.target.className)),
  );

  // 造一个新的可见宿主
  const v2 = addEl(state.doc.body, "view");
  const t2 = addEl(v2, "tabContent");
  t2.setAttribute("data-index", "0");
  v2.clientHeight = 700;
  state.view.classList.add("page-hidden");

  const oldObserver = mo0[0];
  app.moveRootTo(v2); // 宿主确实变了（changed=true）

  // b) 主观察器现在观察新宿主；旧的已 disconnect；活跃数=1
  const moActive = TrackingMO.active();
  ok("20b1) 主观察器现在观察新宿主", moActive.length === 1 && moActive[0].target === v2, JSON.stringify(moActive.map((o) => o.target && o.target.className)));
  ok("20b2) 旧主观察器已 disconnect", oldObserver.disconnected === true);
  eq("20b3) 全流程只存在一个活跃主观察器", moActive.length, 1);


  // d) 功能性：搬迁后从 newHost 移除根容器 → 触发 MO ⇒ 重插回 newHost
  app.root.parentNode.removeChild(app.root);
  ok("20d0) 根容器已脱离新宿主", !app.root.parentNode);
  moActive[0].fire();
  ok(
    "20d) MO 自愈对新宿主生效：根容器重插回 newHost",
    app.root.parentNode === v2,
    app.root.parentNode && app.root.parentNode.className,
  );

})();

// 21) PLAY / DETAIL / 库条导航开始时：先「视觉收起」（body.hs-leaving），**不**拆 DOM，
//     避免原生首页闪现；真正的 teardown 仍由视图事件负责。
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({ items: [makeItem(1), makeItem(2)] });
  addEl(state.doc.body, "headerMiddle");
  addEl(state.doc.body, "mainDrawer");
  const app = makeApp(state);
  await app.start();
  const root = app.root;

  // 桩掉 Emby 路由器与 AMD require：记录调用，验证"视觉收起"先于导航/起播。
  let shown = null;
  let played = null;
  globalThis.Emby = { Page: { showItem: (id) => { shown = String(id); } } };
  globalThis.require = (names, cb) => { cb({ play: (opts) => { played = opts; } }); };
  globalThis.requirejs = undefined;

  const leaving = () => state.doc.body.classList.contains("hs-leaving");

  // —— 21a) PLAY：**不**做视觉收起（播放器端起播时 WebView 会变透明，藏起我们这层只会扩大透出面积）
  const playBtn = root.querySelector(".hs-btn--play");
  ok("21a0) PLAY 按钮存在", !!playBtn);
  playBtn.click();
  ok("21a1) PLAY ⇒ pm.play({items:[item]}) 被调用", !!played && Array.isArray(played.items) && played.items[0].Id === "1");
  ok("21a2) PLAY ⇒ **不**加 hs-leaving（保持轮播不透明地盖着，压小透明洞）", !leaving());
  ok("21a3) PLAY ⇒ **不**拆 DOM（根容器仍在）", !!root.parentNode);

  // —— 21b) DETAIL：先视觉收起，再 showItem
  const state2 = makeState({ items: [makeItem(3)] });
  addEl(state2.doc.body, "headerMiddle");
  addEl(state2.doc.body, "mainDrawer");
  const app2 = makeApp(state2);
  await app2.start();
  const root2 = app2.root;
  const detailBtn = root2.querySelector(".hs-btn--detail");
  ok("21b0) DETAIL 按钮存在", !!detailBtn);
  detailBtn.click();
  ok("21b1) DETAIL ⇒ Emby.Page.showItem(item.Id) 被调用", shown === "3");
  ok("21b2) DETAIL ⇒ body.hs-leaving 已加", state2.doc.body.classList.contains("hs-leaving"));
  ok("21b3) DETAIL ⇒ **不**拆 DOM（根容器仍在）", !!root2.parentNode);

  // —— 21c) 库条点击：先视觉收起，再 showItem 进库
  const state3 = makeState({ libraries: [{ Id: "9", Name: "某库" }] });
  addEl(state3.doc.body, "headerMiddle");
  addEl(state3.doc.body, "mainDrawer");
  const app3 = makeApp(state3);
  await app3.start();
  const root3 = app3.root;
  const libItem = app3.libBarTrack.querySelector(".hs-libbar__item");
  ok("21c0) 库条项存在", !!libItem);
  libItem.click();
  ok("21c1) 库条点击 ⇒ Emby.Page.showItem(lib.Id) 被调用", shown === "9");
  ok("21c2) 库条点击 ⇒ body.hs-leaving 已加", state3.doc.body.classList.contains("hs-leaving"));
  ok("21c3) 库条点击 ⇒ **不**拆 DOM（根容器仍在）", !!root3.parentNode);

  // —— 21d) 收尾：teardown 会清掉 hs-leaving；回首页（mount 的 hs-home 分支）也会清
  app3.teardown();
  ok("21d) teardown ⇒ hs-leaving 一并清除", !state3.doc.body.classList.contains("hs-leaving"));

  // 还原全局桩
  delete globalThis.require;
  globalThis.Emby = undefined;
})();

// 21-3) 顶栏快捷入口：只在首页、落在 .headerRight 最左、点击可开面板
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const header = addEl(state.doc.body, "skinHeader");
  const right = addEl(header, "headerRight");
  addEl(right, "headerButton"); // 既有的右侧图标
  const app = makeApp(state);
  await app.start();
  const btn = state.doc.querySelector(".hs-header-settings");
  ok("21i) 首页顶栏出现快捷入口", !!btn);
  ok("21j) 它排在右侧图标组最左边", !!btn && right.children[0] === btn);
  ok("21k) 图标不是齿轮（避免与 Emby 设置混淆）", !!btn && btn.firstChild.textContent !== "settings");
  app.teardown();
  ok("21l) 撤离后顶栏按钮被移除", !state.doc.querySelector(".hs-header-settings"));
})();

// 22) 设置面板：设置页没有 hs-home 也要能打开（入口只保留顶栏按钮）
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  await app.start();
  state.win.location.hash = "#!/dashboard/settings";
  await app.openPanel();
  ok("22e) 设置页能打开面板（.hs-panel 已建）", !!state.doc.querySelector(".hs-panel"));
  ok("22f) 未挂载时打开面板会先补读真实设置", app.settingsLoaded === true);
  eq("22g) 副标题写明「只对本客户端生效」", state.doc.querySelector(".hs-panel__subtitle").textContent, "只对本客户端生效");
  ok("22h2) 保存按钮是通栏主按钮", !!state.doc.querySelector(".hs-panel__save"));
  ok("22h3) 侧栏/抽屉里没有任何轮播入口", !state.doc.querySelector(".hs-settings-entry"));
  app.teardown();
})();

/* ------------------------------------------------------------------ *
 * 23. 轮播只在首页：媒体库页绝不展现（真机 bug 回归）
 *     4.11 网页端的库页 DOM 里也存在**可见**的 .tabContent[data-index="0"]；
 *     旧 isHome() 的 DOM 兜底（hash 非空也落兜底）+ start() 陈旧搬迁 +
 *     applyHeroHeight() 的搬迁自愈，三条路都会把轮播弄进库页。
 * ------------------------------------------------------------------ */

console.log("== 23. 库页不展现轮播 ==");

function makeLibraryView(state) {
  // 4.11 库页形态：另一个 .view，内含自己的**可见** .tabContent[data-index="0"]
  const libView = new El("div");
  libView.className = "view";
  const libTab = new El("div");
  libTab.className = "tabContent";
  libTab.setAttribute("data-index", "0");
  libView.appendChild(libTab);
  state.doc.body.appendChild(libView);
  state.libView = libView;
  return libView;
}

// ① 库页视图事件：isHome 假 → 复检后撤离；库页视图里绝无 .hs-root
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  app.bootstrap();
  await app.mountPromise;
  ok("①0 初始已挂载", !!state.doc.querySelector(".hs-root"));
  const libView = makeLibraryView(state);
  state.view.classList.add("page-hidden"); // 4.11：旧首页视图被标记隐藏
  state.win.location.hash = "#!/list/list.html?parentId=1593";
  state.doc.dispatch("viewshow", { detail: {} });
  eq("①a 库页 hash → isHome 假（路由权威，不落 DOM 兜底）", app.isHome(), false);
  state.timers.runAll(); // 推进待拆复检
  eq("①b 库页 → 已撤离（.hs-root 移除）", state.doc.querySelector(".hs-root"), null);
  ok("①c 库页视图里没有 .hs-root", !libView.querySelector(".hs-root"));
  eq("①d body.hs-home 已摘除", state.doc.body.classList.contains("hs-home"), false);
})();

// ② 陈旧搬迁护栏：撤离复检的窗口里来了 start()，根容器绝不被搬进库页视图
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  app.bootstrap();
  await app.mountPromise;
  const libView = makeLibraryView(state);
  state.view.classList.add("page-hidden");
  state.win.location.hash = "#!/list/list.html?parentId=1593";
  state.doc.dispatch("viewshow", { detail: {} }); // → 排复检
  app.start(); // 竞态：复检到点前 start() 被调（旧代码在此把根容器搬进库页）
  ok("②a start() 后根容器没进库页视图", !libView.querySelector(".hs-root"));
  ok("②b 根容器仍在原宿主（未搬迁）", app.root.parentNode === state.view);
  state.timers.runAll(); // 复检 → teardown
  eq("②c 复检后照常撤离", state.doc.querySelector(".hs-root"), null);
})();

// ③ ensureRootAttached / applyHeroHeight 在非首页一律不动根容器
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  app.bootstrap();
  await app.mountPromise;
  const libView = makeLibraryView(state);
  state.view.classList.add("page-hidden");
  state.win.location.hash = "#!/list/list.html?parentId=1593";
  eq("③a ensureRootAttached 非首页 → false", app.ensureRootAttached(), false);
  ok("③b 非首页不会把根容器搬进库页", !libView.querySelector(".hs-root"));
  ok("③c 根容器仍在原宿主", app.root.parentNode === state.view);
  app.teardown();
})();

/* ------------------------------------------------------------------ *
 * ㊾ 信息层「交接触点隔离」—— DETAIL / PLAY 点到上一条的真因
 *
 * 旧写法：.hs-info__inner{pointer-events:none}，但它的子节点
 * .hs-info__actions{pointer-events:auto} 会**重新开启命中**（pointer-events
 * 可被子节点覆盖）；而 .is-active 是 position:static、非激活节点是
 * position:absolute —— 同一层叠上下文里定位元素画在非定位块之上
 * ⇒ 上一层虽然 opacity:0，它的按钮仍在最上面接点击 ⇒ 永远点到「上一页」。
 * ------------------------------------------------------------------ */
await (async () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const css = fs.readFileSync(path.join(__dirname, "styles.css"), "utf8");
  const c = css.replace(/\/\*[\s\S]*?\*\//g, ""); // 剥注释：说明文字会引用旧规则，不能算数

  const actionsBlock = (c.match(/body\.hs-home \.hs-root \.hs-info__actions \{[^}]*\}/) || [""])[0];
  ok("㊾0 自检：抓到 .hs-info__actions 规则块", actionsBlock.length > 0, actionsBlock);
  ok(
    "㊾ .hs-info__actions 不再无条件开 pointer-events:auto（否则隐形层按钮仍可点）",
    !/pointer-events/.test(actionsBlock),
    actionsBlock,
  );

  // 交叉淡入块（含 position:absolute）才是承载 visibility/pointer-events 的那一条
  const innerBlock = (c.match(/body\.hs-home \.hs-root \.hs-info__inner \{[^}]*position:\s*absolute[^}]*\}/) || [""])[0];
  ok("㊾0 自检：抓到 .hs-info__inner 基础块", innerBlock.length > 0, innerBlock);
  ok(
    "㊾ 非激活节点整棵子树不参与命中（visibility:hidden）",
    /visibility:\s*hidden/.test(innerBlock),
    innerBlock,
  );
  ok(
    "㊾ 隐藏节点立即不可见（当前为硬切基线，无过渡）",
    /transition:\s*none/.test(innerBlock) || /visibility 0s linear/.test(innerBlock),
    innerBlock,
  );

  const activeBlock = (c.match(/body\.hs-home \.hs-root \.hs-info__inner\.is-active \{[^}]*\}/) || [""])[0];
  ok("㊾0 自检：抓到 .is-active 块", activeBlock.length > 0, activeBlock);
  ok(
    "㊾ 激活节点：可见 + 立即切换（transition 不带 visibility 延迟）",
    /visibility:\s*visible/.test(activeBlock) && !/visibility/.test(activeBlock.split("transition:")[1] || ""),
    activeBlock,
  );
  ok(
    "㊾b 激活节点**不整块吃点击**（否则盖住左箭头热区），只有按钮可点",
    /pointer-events:\s*none/.test(activeBlock) &&
      /\.hs-info__inner\.is-active \.hs-btn\s*\{[^}]*pointer-events:\s*auto/.test(c),
    activeBlock,
  );
})();

/* ------------------------------------------------------------------ *
 * ⑤ 信息层：标语与简介是两行，各自为空就各自隐藏
 * ------------------------------------------------------------------ */
await (async () => {
  FakeSwiper.instances = [];
  const state = makeState({});
  const app = makeApp(state);
  await app.start();
  const node = app.infoNodes[app.visibleNodeIndex];
  const item = makeItem(7);
  item.Taglines = ["一句真正的标语"];
  item.Genres = ["剧情", "Sci-Fi & Fantasy"];
  app.fillInfoNode(node, buildInfoModel(item, { base: "http://s" }), item);
  ok(
    "⑤ 标语行与简介行同时渲染（旧实现二选一，简介会被标语顶掉）",
    !!node.querySelector(".hs-tagline") && !!node.querySelector(".hs-overview"),
  );
  eq("⑤ 标语行 = Taglines[0]", node.querySelector(".hs-tagline").textContent, "一句真正的标语");
  ok("⑤ 简介行 = Overview", node.querySelector(".hs-overview").textContent.indexOf("简介7") === 0);
  ok(
    "⑤ 简介有 track/body 两层（自动滚动靠 track 整体位移）",
    !!node.querySelector(".hs-overview__track") && !!node.querySelector(".hs-overview__body"),
  );
  {
    const multi = makeItem(11);
    multi.Overview = "第一段内容\n\n第二段内容";
    app.fillInfoNode(node, buildInfoModel(multi, { base: "http://s" }), multi);
    const segs = node.querySelectorAll(".hs-overview__p");
    ok("⑤ 简介按换行拆段（保留源数据的分段）", segs.length === 2, "segs=" + segs.length);
    ok("⑤ 拆段后文本完整", node.querySelector(".hs-overview").textContent.indexOf("第二段内容") > 0);
    const soft = makeItem(12);
    soft.Overview = "第一行\n第二行\n第三行";
    app.fillInfoNode(node, buildInfoModel(soft, { base: "http://s" }), soft);
    ok(
      "⑤ 单换行不拆段（否则一句话会被拆成一行一段）",
      node.querySelectorAll(".hs-overview__p").length === 0 &&
        node.querySelector(".hs-overview").textContent.indexOf("第二行") > 0,
    );
  }

  const item2 = makeItem(8);
  item2.Taglines = [];
  app.fillInfoNode(node, buildInfoModel(item2, { base: "http://s" }), item2);
  ok("⑤ 无标语时只渲染简介行", !node.querySelector(".hs-tagline") && !!node.querySelector(".hs-overview"));

  const itemDate = makeItem(9);
  itemDate.Taglines = ["发行日期: 2026-09-19"];
  app.fillInfoNode(node, buildInfoModel(itemDate, { base: "http://s" }), itemDate);
  ok("⑤ 日期型标语不渲染（否则简介永远看不到）", !node.querySelector(".hs-tagline"));

  app.fillInfoNode(node, buildInfoModel(item, { base: "http://s" }), item);
  eq("⑤ 类型渲染成裸文字（不是胶囊）", node.querySelectorAll(".hs-meta-plain").length, 3); // 年份 + 2 个类型
  {
    const metaEl = node.querySelector(".hs-info__meta");
    const kinds = metaEl.children.map((c) => String(c.className));
    ok(
      "⑤ 同一行的顺序：评分 → 分级 → 年份 → 类型",
      kinds.length >= 5 &&
        kinds[0].indexOf("hs-pill--rating") >= 0 &&
        kinds[1].indexOf("hs-pill--cert") >= 0 &&
        kinds[2].indexOf("hs-meta-plain") >= 0 &&
        kinds[3].indexOf("hs-meta-plain") >= 0 &&
        kinds[4].indexOf("hs-meta-plain") >= 0,
    );
  }
  ok("⑤ 不再有独立的标签行容器", !node.querySelector(".hs-info__tags"));
  eq("⑤ 分级带 data-rating（CSS 据此配色）", node.querySelector(".hs-pill--cert").getAttribute("data-rating"), "G");
  {
    // 选择器只用单一类名：测试用的假 DOM 对后代选择器支持不完整
    const stars = node.querySelectorAll(".hs-pill__star");
    const vals = node.querySelectorAll(".hs-pill__value");
    ok(
      "⑤ 评分胶囊：星型图标 + 纯数值",
      stars.length === 1 && stars[0].textContent === "★" && vals.length === 1 && /^\d+(\.\d)?$/.test(vals[0].textContent),
      "star=" + (stars[0] && stars[0].textContent) + " val=" + (vals[0] && vals[0].textContent),
    );
  }
  {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const c = fs.readFileSync(path.join(__dirname, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    {
      const vig = (c.match(/\.hs-root::after\s*\{[^}]*\}/) || [""])[0];
      ok("暗角：存在 .hs-root::after", vig.length > 0, vig);
      ok("暗角：z-index 2（视频之上、箭头/信息层之下）", /z-index:\s*2\b/.test(vig), vig);
      ok("暗角：pointer-events:none（不吃点击/滚轮）", /pointer-events:\s*none/.test(vig), vig);
      eq("暗角：四条渐变（上下左右）", (vig.match(/linear-gradient\(/g) || []).length, 4);
    }
    ok(
      "滚动条：首页轨道常驻暗色（否则缝随背景图发亮）",
      /body\.hs-home ::-webkit-scrollbar-track[^{]*\{[^}]*rgba\(10,\s*10,\s*12,\s*0?\.6\)/.test(c),
    );
    ok(
      "滚动条：桌面收窄到 0.3em（照参考插件）",
      /@media \(pointer: fine\)[\s\S]*?::-webkit-scrollbar\s*\{[^}]*width:\s*0\.3em/.test(c),
    );
    ok(
      "滚动条：触摸端直接隐藏（不占位）",
      /@media \(hover: none\) and \(pointer: coarse\)[\s\S]*?::-webkit-scrollbar\s*\{[^}]*display:\s*none/.test(c),
    );
    ok(
      "滚动条：滑块半透明、无内缩（0.3em 下不能再留 border）",
      /::-webkit-scrollbar-thumb\s*\{[^}]*rgba\(255,\s*255,\s*255,\s*0?\.3\)/.test(c) && !/::-webkit-scrollbar-thumb\s*\{[^}]*border:\s*2px/.test(c),
    );
    ok(
      "⑤ 面板声明深色 color-scheme（原生下拉弹层才会画成深色，否则白底白字）",
      /\.hs-panel\s*\{[^}]*color-scheme:\s*dark/.test(c),
    );
    ok(
      "⑤ 下拉项显式上色（兜底旧版 Chromium）",
      /\.hs-panel__body option\s*\{[^}]*background-color:\s*#1b1e24/.test(c),
    );
    ok(
      "⑤ 评分星型用文字节点（不再用 CSS mask 造图标）",
      /\.hs-pill__star\s*\{[^}]*color:\s*#f6c453/.test(c),
    );
    ok(
      "⑤ 分级不再按档配色（统一中性色；data-rating 只作语义钩子）",
      c.indexOf('data-rating="G"') < 0 && /\.hs-pill\s*\{[^}]*border-radius/.test(c),
    );
    ok(
      "⑤ 星级图标有独立金色（#f6c453，与文字色区分）",
      /\.hs-pill__star\s*\{[^}]*color:\s*#f6c453/.test(c),
    );
  }
})();

await sleep();
console.log("\n== 汇总 ==");
console.log("PASS=" + pass + "  FAIL=" + fail);
if (fail > 0) {
  console.log("结果：FAILED");
  process.exitCode = 1;
} else {
  console.log("结果：ALL PASS");
}
