/**
 * HomeSwiper 构建组装脚本（作者态，仅本地运行）
 * ---------------------------------------------------------------------------
 * 用法：  node .build/assemble.js
 *
 * 严格按计划书四章「构建流程」六步执行；任一步断言不满足即抛错中断，绝不产出半成品。
 *
 *   ① 拼接官方 CSS：swiper.css + effect-fade.css + navigation.css
 *   ② lightningcss 摊平(嵌套) + downlevel(chrome100) + 压缩        → SWIPER_CSS
 *   ③ 断言：不得残留 & / :has( / dvh / scrollbar-width / scrollbar-color /
 *      color-mix( / oklch( / @container / text-wrap: balance，
 *      且必须保住 .swiper-navigation-icon { transform: rotate(180deg) }
 *   ④ 生成临时入口：两份 CSS 以 JSON.stringify 生成字符串模块（不手贴模板字符串）
 *   ⑤ esbuild bundle（--format=iife --target=chrome100 --minify）
 *   ⑥ 写 swiper.js → acorn 校验（ecmaVersion 2021）→ 打印 raw / gzip 体积
 *
 * 产物：swiper.js  （自包含：Swiper 库 + SWIPER_CSS + CUSTOM_CSS + 插件逻辑）
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";
import * as lightningcss from "lightningcss";
import * as acorn from "acorn";

const { transform } = lightningcss;

/* ------------------------------------------------------------------ *
 * 路径
 * ------------------------------------------------------------------ */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SWIPER_DIR = path.join(ROOT, "node_modules", "swiper");

const CSS_SOURCES = [
  path.join(SWIPER_DIR, "swiper.css"),
  path.join(SWIPER_DIR, "modules", "effect-fade.css"),
  path.join(SWIPER_DIR, "modules", "navigation.css"),
];
const CUSTOM_CSS_SRC = path.join(__dirname, "styles.css");
const GEN_CSS_MODULE = path.join(__dirname, ".gen-css.mjs");
const ENTRY_MODULE = path.join(__dirname, ".entry.mjs");
const OUT_FILE = path.join(ROOT, "HomeSwiper.js");

/** lightningcss targets：Chromium 100（编码为 major<<16）。 */
const TARGETS = { chrome: 100 << 16 };

/* ------------------------------------------------------------------ *
 * 断言工具
 * ------------------------------------------------------------------ */

class BuildError extends Error {}

function assert(cond, message) {
  if (!cond) {
    throw new BuildError(message);
  }
}

/** Chromium 100 禁用写法（CSS 侧）。 */
const CSS_FORBIDDEN = [
  { name: "原生嵌套残留 &", re: /&/, raw: "&" },
  { name: ":has(", re: /:has\(/, raw: ":has(" },
  { name: "dvh", re: /dvh/, raw: "dvh" },
  { name: "scrollbar-width", re: /scrollbar-width/, raw: "scrollbar-width" },
  { name: "scrollbar-color", re: /scrollbar-color/, raw: "scrollbar-color" },
  { name: "color-mix(", re: /color-mix\(/, raw: "color-mix(" },
  { name: "oklch(", re: /oklch\(/, raw: "oklch(" },
  { name: "@container", re: /@container/, raw: "@container" },
  { name: "text-wrap: balance", re: /text-wrap\s*:\s*balance/, raw: "text-wrap: balance" },
];

/** 断言一份 CSS 文本不含 Chromium 100 禁用写法。 */
function assertCssClean(label, css) {
  for (const item of CSS_FORBIDDEN) {
    if (item.re.test(css)) {
      throw new BuildError(
        `[③ 断言失败] ${label} 残留 Chromium 100 禁用写法：${item.name}`,
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * ② lightningcss：摊平 + downlevel(chrome100) + 压缩
 * ------------------------------------------------------------------ */

/**
 * 用 lightningcss 处理一份 CSS：摊平嵌套、downlevel 到 chrome100、压缩。
 * @param {string} label 用于日志。
 * @param {string} code  原始 CSS 文本。
 * @returns {string} 处理后的压缩 CSS。
 */
function flattenAndMinify(label, code) {
  const result = transform({
    filename: label,
    code: Buffer.from(code, "utf8"),
    minify: true,
    targets: TARGETS,
  });
  const warnings = (result.warnings || []).filter(Boolean);
  for (const w of warnings) {
    console.warn(`  ⚠ [${label}] lightningcss 警告：${w.message || JSON.stringify(w)}`);
  }
  return Buffer.from(result.code).toString("utf8");
}

/**
 * 定向剔除 Chromium 100 不支持、且 lightningcss 会原样透传的声明。
 *
 * 仅处理 `scrollbar-width`：它只出现在官方 CSS 的 `.swiper-css-mode`
 * （本插件从不开启 `cssMode`，该规则是死代码）里；lightningcss 对目标 chrome100
 * 不做裁剪、直接透传，故在此按声明粒度移除（不是"手写正则剥嵌套"，仅删一条属性）。
 * 隐藏滚动条一律改用 `::-webkit-scrollbar` 兜底。
 *
 * @param {string} label 用于日志。
 * @param {string} css   已压缩的 CSS。
 * @returns {string} 清理后的 CSS。
 */
function sanitizeUnsupported(label, css) {
  let removed = 0;
  const cleaned = css.replace(/scrollbar-width\s*:\s*[^;{}]+;?/gi, () => {
    removed += 1;
    return "";
  });
  if (removed > 0) {
    console.log(`  · [${label}] 剔除 lightningcss 未 downlevel 的 scrollbar-width 声明 ×${removed}`);
  }
  return cleaned;
}

/* ------------------------------------------------------------------ *
 * ④ 生成临时入口与字符串模块
 * ------------------------------------------------------------------ */

/** 生成 `.gen-css.mjs`：两份 CSS 以 JSON.stringify 生成字符串模块（不手贴模板字符串）。 */
function writeCssStringModule(swiperCss, customCss) {
  const content =
    "// 自动生成，请勿手改 —— 由 .build/assemble.js 生成\n" +
    "// 两份 CSS 以 JSON.stringify 序列化，避免手贴模板字符串带来的转义错误。\n" +
    `export const SWIPER_CSS = ${JSON.stringify(swiperCss)};\n` +
    `export const CUSTOM_CSS = ${JSON.stringify(customCss)};\n`;
  fs.writeFileSync(GEN_CSS_MODULE, content, "utf8");
}

/** 生成 `.entry.mjs`：esbuild 的打包入口（本身无 export，保证 iife 输出无 UMD 包装）。 */
function writeEntryModule() {
  const content =
    "// 自动生成，请勿手改 —— 由 .build/assemble.js 生成（临时入口）\n" +
    'import { startBootstrap } from "./plugin.js";\n' +
    'import { SWIPER_CSS, CUSTOM_CSS } from "./.gen-css.mjs";\n' +
    "startBootstrap({ SWIPER_CSS, CUSTOM_CSS });\n";
  fs.writeFileSync(ENTRY_MODULE, content, "utf8");
}

/* ------------------------------------------------------------------ *
 * JS 产物断言（Chromium 100 禁用 API + 结构校验）
 * ------------------------------------------------------------------ */

const JS_FORBIDDEN = [
  { name: "AbortSignal.timeout()", re: /AbortSignal\s*\.\s*timeout/ },
  { name: "Array.prototype.at()", re: /\.at\(/ },
  { name: "structuredClone()", re: /structuredClone\s*\(/ },
  { name: "Object.hasOwn()", re: /Object\s*\.\s*hasOwn\s*\(/ },
];

/** 断言 JS 产物：禁用 API / 无 ESM 残留 / 无 UMD 全局 / tree-shaking 生效 / IIFE 包裹。 */
function assertJsBundle(code) {
  for (const item of JS_FORBIDDEN) {
    if (item.re.test(code)) {
      throw new BuildError(`[③/⑥ 断言失败] swiper.js 残留 Chromium 100 禁用 API：${item.name}`);
    }
  }
  assert(!/globalThis\s*\.\s*Swiper/.test(code), "[③/⑥ 断言失败] 产物写入了 globalThis.Swiper（不应有 UMD 包装）");
  assert(!/^\s*(import|export)\s/m.test(code), "[③/⑥ 断言失败] 产物残留 ESM import/export 语句");
  assert(!/parallax/i.test(code), "[③/⑥ 断言失败] tree-shaking 未生效：产物出现 Parallax 特征代码");
  assert(!/manipulation/i.test(code), "[③/⑥ 断言失败] tree-shaking 未生效：产物出现 Manipulation 特征代码");
  assert(/^\s*\(/.test(code), "[③/⑥ 断言失败] 产物未被 IIFE 包裹（首个非空白字符应为 '('）");
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  console.log("== HomeSwiper 构建开始 ==");

  // ---- ① 拼接官方 CSS ------------------------------------------------
  for (const f of CSS_SOURCES) {
    assert(fs.existsSync(f), `[① 失败] 找不到官方 CSS 源文件：${f}`);
  }
  const officialCssRaw = CSS_SOURCES.map((f) => {
    const text = fs.readFileSync(f, "utf8");
    console.log(`  ① 读取 ${path.relative(ROOT, f)} (${text.length} 字符)`);
    return `/* ${path.relative(SWIPER_DIR, f)} */\n${text}`;
  }).join("\n");
  assert(/&/.test(officialCssRaw), "[① 断言失败] 官方 CSS 中未检出原生嵌套 '&'（预期应有，否则摊平步骤无意义）");
  console.log(`  ① 拼接完成：${officialCssRaw.length} 字符`);

  // ---- ② 摊平 + downlevel + 压缩 ------------------------------------
  const swiperCss = sanitizeUnsupported("swiper.css", flattenAndMinify("swiper.css", officialCssRaw));
  console.log(`  ② SWIPER_CSS 摊平+压缩：${officialCssRaw.length} → ${swiperCss.length} 字符`);

  assert(fs.existsSync(CUSTOM_CSS_SRC), `[② 失败] 找不到插件样式源：${CUSTOM_CSS_SRC}`);
  const customCssRaw = fs.readFileSync(CUSTOM_CSS_SRC, "utf8");
  const customCss = sanitizeUnsupported("styles.css", flattenAndMinify("styles.css", customCssRaw));
  console.log(`  ② CUSTOM_CSS 摊平+压缩：${customCssRaw.length} → ${customCss.length} 字符`);

  // ---- ③ 断言 ---------------------------------------------------------
  assertCssClean("SWIPER_CSS", swiperCss);
  assertCssClean("CUSTOM_CSS", customCss);
  console.log("  ③ CSS 禁用写法断言通过（两份均无 & / :has( / dvh / scrollbar-* / color-mix( / oklch( / @container / text-wrap:balance）");

  assert(
    /\.swiper-navigation-icon[^{}]*\{[^{}]*rotate\(180deg\)/.test(swiperCss),
    "[③ 断言失败] 摊平后丢失了 .swiper-navigation-icon { transform: rotate(180deg) }（prev 箭头方向依赖它）",
  );
  console.log("  ③ 断言通过：保住 .swiper-navigation-icon { transform: rotate(180deg) }");

  // ---- ④ 生成临时入口 + 字符串模块 -----------------------------------
  writeCssStringModule(swiperCss, customCss);
  writeEntryModule();
  console.log(`  ④ 已生成 ${path.basename(GEN_CSS_MODULE)}（SWIPER_CSS / CUSTOM_CSS，JSON.stringify 序列化）`);
  console.log(`  ④ 已生成 ${path.basename(ENTRY_MODULE)}（临时入口，import plugin.js + 字符串模块）`);

  // ---- ⑤ esbuild 打包 ------------------------------------------------
  const buildResult = await esbuild.build({
    entryPoints: [ENTRY_MODULE],
    bundle: true,
    format: "iife",
    target: "chrome100",
    minify: true,
    write: false,
    charset: "utf8",
    legalComments: "none",
    logLevel: "warning",
    metafile: true,
  });
  const bundleCode = buildResult.outputFiles[0].text;
  console.log(`  ⑤ esbuild 打包完成：${bundleCode.length} 字符`);

  // 展示参与打包的模块（tree-shaking 证据）
  // 注意：esbuild 的 bytesInOutput 挂在 metafile.outputs[out].inputs 下，而非 metafile.inputs。
  const outputKey = Object.keys(buildResult.metafile.outputs)[0];
  const outInputs = buildResult.metafile.outputs[outputKey].inputs || {};
  const swiperInputs = Object.entries(outInputs).filter(([p]) => p.includes("node_modules/swiper/"));
  const contributed = swiperInputs.filter(([, v]) => (v.bytesInOutput || 0) > 0);
  const dropped = swiperInputs.filter(([, v]) => (v.bytesInOutput || 0) === 0);
  console.log(`  ⑤ swiper 源文件参与打包：${swiperInputs.length} 个；实际产出字节 >0 的：${contributed.length} 个；被摇掉（0 字节）：${dropped.length} 个`);
  for (const [p, v] of contributed.sort((a, b) => (b[1].bytesInOutput || 0) - (a[1].bytesInOutput || 0))) {
    const name = p.replace(/^.*node_modules\//, "");
    console.log(`        · ${name} → ${v.bytesInOutput} 字节`);
  }
  const parallaxInputs = swiperInputs.filter(([p]) => /parallax/i.test(p));
  const parallaxBytes = parallaxInputs.reduce((s, [, v]) => s + (v.bytesInOutput || 0), 0);
  console.log(`  ⑤ parallax 源文件：${parallaxInputs.length} 个，产出字节合计 = ${parallaxBytes}（预期 0）`);
  assert(
    parallaxBytes === 0,
    `[⑤ 断言失败] Parallax 未被 tree-shaking 摇掉（产出 ${parallaxBytes} 字节）`,
  );

  // 正向断言：必须真正打进 core + Navigation + EffectFade + Autoplay
  // autoplay 已不再使用（计时统一由 startImagePhase 负责）⇒ 它必须被摇掉，而不是必需
  const REQUIRED_MODULES = ["modules/navigation.mjs", "modules/effect-fade.mjs"];
  const autoplayBytes = swiperInputs
    .filter(([p]) => p.endsWith("modules/autoplay.mjs"))
    .reduce((s, [, v]) => s + (v.bytesInOutput || 0), 0);
  assert(autoplayBytes === 0, `[⑤ 断言失败] Autoplay 未被摇掉（产出 ${autoplayBytes} 字节）`);
  for (const suffix of REQUIRED_MODULES) {
    const hit = swiperInputs.find(([p, v]) => p.endsWith(suffix) && (v.bytesInOutput || 0) > 0);
    assert(hit, `[⑤ 断言失败] 必需模块未打进产物：${suffix}`);
  }
  console.log(`  ⑤ 正向断言通过：Navigation / EffectFade 已打进产物；Autoplay 已被摇掉`);

  // ---- ⑥ 写文件 + 校验 + 体积 ---------------------------------------
  assertJsBundle(bundleCode);

  const banner =
    "/* HomeSwiper — Emby 首页轮播插件（自动生成，请勿手改；由 .build/assemble.js 构建）\n" +
    " * 自包含：Swiper 库 + SWIPER_CSS + CUSTOM_CSS + 插件逻辑。\n" +
    ` * 构建时间：${new Date().toISOString()} */\n`;
  // ★ 版本戳自动生成：每次构建都换，用来分辨客户端/网页端跑的是不是最新那份。
  //   之前手工写死，两版共用一个戳，导致「贴了没有」无法判断（真机踩过）。
  const buildTag = "b" + new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  // esbuild 会把 `const BUILD_TAG` 常量**内联成字符串字面量**，所以不能替换声明，只能替换占位符本身。
  const stamped = bundleCode.split("__BUILD_TAG__").join(buildTag);
  if (!stamped.includes(buildTag)) throw new BuildError("[⑥ 断言失败] BUILD_TAG 未能写入产物");
  const finalCode = banner + stamped;

  fs.writeFileSync(OUT_FILE, finalCode, "utf8");

  try {
    acorn.parse(finalCode, { ecmaVersion: 2021, sourceType: "script" });
  } catch (err) {
    throw new BuildError(`[⑥ 断言失败] acorn(ecmaVersion:2021) 解析 swiper.js 失败：${err.message}`);
  }
  console.log("  ⑥ acorn 校验通过（ecmaVersion: 2021）");

  const raw = Buffer.byteLength(finalCode, "utf8");
  const gzip = zlib.gzipSync(Buffer.from(finalCode, "utf8")).length;
  const kb = (n) => (n / 1024).toFixed(1) + " KB";
  console.log("  ⑥ 产物体积：");
  console.log(`       HomeSwiper.js raw  = ${raw} 字节 (${kb(raw)})`);
  console.log(`       HomeSwiper.js gzip = ${gzip} 字节 (${kb(gzip)})`);
  console.log(`  ⑥ 已写出 ${path.relative(ROOT, OUT_FILE)}`);

  console.log("== 构建成功 ==");
}

main().catch((err) => {
  if (err instanceof BuildError) {
    console.error("\n✗ 构建中断：" + err.message);
  } else {
    console.error("\n✗ 构建异常：", err && err.stack ? err.stack : err);
  }
  process.exit(1);
});
