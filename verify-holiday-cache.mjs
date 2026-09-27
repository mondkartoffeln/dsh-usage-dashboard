#!/usr/bin/env node
/**
 * 节假日日历「什么时候才联网」的离线验证。
 *   node verify-holiday-cache.mjs
 *
 * 为什么需要它：`initHolidayCalendar` 的核心不是「怎么抓」，而是「**要不要抓**」。
 * 这条判断错了，后果是**静默的**：
 *   · 判得太宽 → 每次启动都联网（慢，且断网时启动被拖住）
 *   · 判得太窄 → **明年的安排永远抓不到**，日历停在旧年份，
 *     而界面上完全看不出来（照旧显示「法定节假日」，只是漏掉新假期）
 *
 * 背景（实测 2022–2026 连续五年的国务院通知）：
 *   2021-10-25 / 2022-12-08 / 2023-10 / 2024-11 / 2025-11
 *   ⇒ **每年必发，但落在 10～12 月里飘**。
 *   所以「一年抓一次」是对的，但**得抓在对的时间** ——
 *   若每年 1 月抓一次就锁死，会错过 10～12 月才发的下一年安排。
 *
 * 做法：**从 `lib/index.js` 原文抽出那几段代码**在 Node 里跑，
 * 配一个临时 HOME 和假的 `fetch`，数它到底联网了几次。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "lib", "index.js");

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed += 1;
};

// ── 从 index.js 抽出需要的几段 ──────────────────────────────────
const lines = readFileSync(SRC, "utf8").split("\n");
const find = (needle, from = 0) => {
  for (let i = from; i < lines.length; i += 1) if (lines[i].includes(needle)) return i;
  return -1;
};
const block = (startNeedle, endNeedle) => {
  const a = find(startNeedle);
  const b = find(endNeedle, a + 1);
  if (a < 0 || b < 0) throw new Error(`找不到区段：${startNeedle} / ${endNeedle}`);
  return lines.slice(a, b).join("\n");
};

let code;
try {
  // 常量块（基线 + 三个阈值常量 + 生效日）
  code = block("const CN_HOLIDAY_BASELINE = [", "function holidayCachePath(home)");
  // 缓存路径 + fetchHolidayYear + initHolidayCalendar（到 isPeak 为止）
  code += "\n" + block("function holidayCachePath(home)", "function isPeak(ms)");
} catch (e) {
  console.error("抽区段失败：" + e.message);
  process.exit(2);
}

const HOME = join(tmpdir(), "dsh-holiday-cache-verify");
const CACHE = join(HOME, "ui-usage-holidays.json");
let fetchCalls = 0;
const fakeFetch = async () => {
  fetchCalls += 1;
  // 返回空：测的是「要不要联网」，不是解析
  return { ok: true, json: async () => ({ code: 0, holiday: {} }) };
};

function build() {
  return new Function(
    "readFileSync", "writeFileSync", "mkdirSync", "join", "dirname", "HOUR", "beijingDay", "fetch", "WEEKEND_EFFECTIVE",
    code + "\n; return { initHolidayCalendar };"
  )(
    readFileSync, writeFileSync, mkdirSync, join, dirname, 3600000,
    (ms) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10),
    fakeFetch,
    Date.UTC(2026, 7, 22, 16, 0, 0)
  );
}

/**
 * 跑一个场景。
 * @param cacheSpec - `null`（无缓存）或 `{ ageHours, years?, dates? }`。
 *   ★ 缓存年龄**相对生效的「现在」**算 —— 否则用假时钟时
 *     「2 小时前」会变成「49 天前」，测的就不是想测的那件事了。
 * @param expectFetch - 期望是否联网。
 * @param fakeNow - 可选，把「现在」固定到某个 epoch ms（用来测 10 月起的公布窗口）。
 */
async function scenario(name, cacheSpec, expectFetch, fakeNow) {
  fetchCalls = 0;
  const realNow = Date.now;
  const now = fakeNow ?? realNow();
  if (fakeNow !== undefined) Date.now = () => fakeNow;
  try {
    rmSync(HOME, { recursive: true, force: true });
    mkdirSync(HOME, { recursive: true });
    if (cacheSpec !== null) {
      const cache = { years: cacheSpec.years, dates: cacheSpec.dates ?? [] };
      if (cacheSpec.ageHours !== undefined) {
        cache.fetchedAt = new Date(now - cacheSpec.ageHours * 3600000).toISOString();
      }
      writeFileSync(CACHE, JSON.stringify(cache), "utf8");
    }
    await build().initHolidayCalendar(HOME, () => {});
    const ok = expectFetch ? fetchCalls > 0 : fetchCalls === 0;
    check(name, ok, `联网 ${fetchCalls} 次（期望${expectFetch ? ">0" : "0"}）`);
  } finally {
    Date.now = realNow;
  }
}

// ── 场景 ────────────────────────────────────────────────────────
const realNow = Date.now();
const bj = new Date(realNow + 8 * 3600000);
const realYear = bj.getUTCFullYear();
const realMonth = bj.getUTCMonth() + 1;
console.log(`（真实时钟：北京 ${bj.toISOString().slice(0, 10)}，${realMonth} 月；今年=${realYear}）`);
console.log("");

const OLD_H = 40 * 24; // 40 天，超过 30 天保质期
const FRESH_H = 2;     // 2 小时前

console.log("── 基本规则 ──");
await scenario("无缓存 → 联网", null, true);
await scenario("缓存 40 天（> 30 天保质期）→ 联网", { ageHours: OLD_H, years: [realYear, realYear + 1] }, true);
await scenario("缓存 2 小时前、今年明年都已覆盖 → 不联网", { ageHours: FRESH_H, years: [realYear, realYear + 1] }, false);

console.log("");
console.log("── 公布窗口（决定明年那份会不会被抓到）──");
// 实测 9 年通知的月份分布：10 月 ×2、11 月 ×5、12 月 ×2，最晚 2018-12-06。
// 所以窗口从 11 月起 —— 到最晚那次还留 35 天余量，而新年的假从 1/1 才开始。
const OCT = Date.UTC(realYear, 9, 15, 4, 0, 0);
const NOV = Date.UTC(realYear, 10, 15, 4, 0, 0);
const SEP = Date.UTC(realYear, 8, 15, 4, 0, 0);
const inWindowNow = realMonth >= 11;
await scenario(
  `缺明年 + 现在 ${realMonth} 月 → ${inWindowNow ? "联网（窗口内）" : "不联网（未到窗口）"}`,
  { ageHours: FRESH_H, years: [realYear] },
  inWindowNow
);
await scenario("11 月、缓存只有今年 → 联网（去抓明年）", { ageHours: OLD_H, years: [realYear] }, true, NOV);
await scenario("11 月、老格式缓存（无 years 字段）→ 联网", { ageHours: OLD_H }, true, NOV);
await scenario("11 月、刚抓过且已覆盖明年 → 不联网", { ageHours: FRESH_H, years: [realYear, realYear + 1] }, false, NOV);
// ★ 关键对照：窗口起点从 10 月挪到 11 月之后，10 月**不该**再联网了
await scenario("10 月、缺明年 → 不联网（窗口已挪到 11 月，10 月不白试）", { ageHours: FRESH_H, years: [realYear] }, false, OCT);
await scenario("9 月、同样缺明年 → 不联网（还没到窗口，抓也白抓）", { ageHours: FRESH_H, years: [realYear] }, false, SEP);

console.log("");
if (failed) {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
console.log("全部通过");
