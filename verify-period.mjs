#!/usr/bin/env node
/**
 * 峰谷时段判定的离线验证 —— 含中国法定节假日。
 *   node verify-period.mjs
 *
 * 为什么需要它：DeepSeek 的计费规则里有一条「**调休上班的周末 + 中国法定节假日
 * 全天按空闲时段计费**」，而这条规则**每年都要跟着国务院办公厅的新通知更新**
 * （`lib/client.js` 里的 `CN_HOLIDAY_RANGES`）。更新完之后必须能证明它是对的 ——
 * 靠肉眼看日期表最容易在「节假日落在工作日」这种情况下出错。
 *
 * 做法：从 `lib/client.js` **原文抽出**那两段代码（常量 + 时段函数）在 Node 里跑，
 * 所以测的是真正上线的那份逻辑，不是测试里重写的一份。
 *
 * 为什么用抽取而不是 import：client.js 是浏览器 bundle
 * （`window.__ModuleLoader__.load({ id, factory })`），在 Node 里直接 import 不了。
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "lib", "client.js");

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed += 1;
};

// ── 从 bundle 里抽出时段判定那两段 ────────────────────────────────
const lines = readFileSync(SRC, "utf8").split("\n");
const idx = (pred) => lines.findIndex(pred);
const a0 = idx((l) => l.includes("const HOUR = 3600000;"));
const a1 = idx((l) => l.includes("── 货币口径"));
const b0 = idx((l) => l.includes("const bjFormatter ="));
const b1 = idx((l) => l.includes("function fmtClock(msOfDay)"));
if (a0 < 0 || a1 < 0 || b0 < 0 || b1 < 0) {
  console.error("抽区段失败：bundle 结构变了（找 const HOUR / 货币口径 / bjFormatter / fmtClock）");
  process.exit(2);
}
const code = lines.slice(a0, a1).join("\n") + "\n" + lines.slice(b0, b1).join("\n");

let M;
try {
  M = new Function(
    code + "\n; return { periodAt, nextBoundary, isBjWeekend, isCnHoliday, isBjOffPeakDay, bjDayLabel };"
  )();
} catch (e) {
  console.error("抽出的区段执行失败：" + e.message);
  process.exit(2);
}

/** 北京某日某刻的 epoch ms。 */
const bj = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi);

// ── 用例 ─────────────────────────────────────────────────────────
// ★ 期望值是照着 DeepSeek 规则 + 国务院办公厅《关于2026年部分节假日安排的通知》写的。
const CASES = [
  // 平常工作日：峰时
  ["2026-09-24 10:00", bj(2026, 9, 24, 10), true, "周四·平常工作日"],
  ["2026-09-24 15:00", bj(2026, 9, 24, 15), true, "周四·下午峰时窗"],
  // ★ 关键：节假日落在**工作日**（周末规则覆盖不到，只有节假日表能救）
  ["2026-09-25 10:00", bj(2026, 9, 25, 10), false, "周五·中秋"],
  ["2026-09-25 15:00", bj(2026, 9, 25, 15), false, "周五·中秋（下午峰时窗内）"],
  ["2026-10-01 10:00", bj(2026, 10, 1, 10), false, "周四·国庆"],
  ["2026-10-05 15:00", bj(2026, 10, 5, 15), false, "周一·国庆"],
  ["2026-10-07 10:00", bj(2026, 10, 7, 10), false, "周三·国庆最后一天"],
  // 节后恢复
  ["2026-09-28 10:00", bj(2026, 9, 28, 10), true, "周一·中秋后上班"],
  ["2026-10-08 10:00", bj(2026, 10, 8, 10), true, "周四·国庆后上班"],
  // 周末
  ["2026-09-26 10:00", bj(2026, 9, 26, 10), false, "周六"],
  ["2026-09-27 10:00", bj(2026, 9, 27, 10), false, "周日"],
  // ★ 规定里的另一半「调休上班的周末」—— 2026 年 **8/23 之后**的调休上班日
  //   全是周六/周日，被「所有周末都算谷时」那条覆盖。这里固定住，
  //   防止以后有人误加一张「调休上班日 = 峰时」的表（那是反的）。
  ["2026-09-20 10:00", bj(2026, 9, 20, 10), false, "周日·调休上班日"],
  ["2026-10-10 10:00", bj(2026, 10, 10, 10), false, "周六·调休上班日"],
];

// ★ 生效日之前（2026-08-23 之前）：DeepSeek 的新规则还没上线，
//   所以**节假日表和周末表都不生效** —— 一律按平常工作日算。
//   ★ 这里不是「漏了」，是刻意的：与既有的 WEEKEND_EFFECTIVE 同口径。
//   把这件事写成显式断言，而不是让它以「意外失败」的形式出现。
const BEFORE_EFFECTIVE = [
  ["2026-01-01 10:00", bj(2026, 1, 1, 10), true, "周四·元旦（生效日前）"],
  ["2026-01-04 10:00", bj(2026, 1, 4, 10), true, "周日·调休上班日（生效日前）"],
  ["2026-02-17 10:00", bj(2026, 2, 17, 10), true, "周二·春节（生效日前）"],
  ["2026-02-28 10:00", bj(2026, 2, 28, 10), true, "周六·调休上班日（生效日前）"],
  ["2026-04-06 10:00", bj(2026, 4, 6, 10), true, "周一·清明（生效日前）"],
  ["2026-05-01 10:00", bj(2026, 5, 1, 10), true, "周五·劳动节（生效日前）"],
  ["2026-06-19 10:00", bj(2026, 6, 19, 10), true, "周五·端午（生效日前）"],
];
CASES.push(...BEFORE_EFFECTIVE);

console.log("── 时段判定 ──");
for (const [label, ms, wantPeak, desc] of CASES) {
  const p = M.periodAt(ms);
  const tags = [M.isCnHoliday(ms) && "节假日", M.isBjWeekend(ms) && "周末"].filter(Boolean);
  check(
    `${label}  ${desc}`,
    p.peak === wantPeak,
    `${p.peak ? "峰时" : "谷时"}（期望${wantPeak ? "峰时" : "谷时"}）${tags.length ? "  {" + tags.join("+") + "}" : ""}`
  );
}

console.log("── 边界推算 ──");
{
  // 国庆长假中：下一个峰时是 10/8 09:00 → 10/1 10:00 起算 = 167 小时
  const nb = M.nextBoundary(bj(2026, 10, 1, 10));
  check("国庆中 10/1 10:00 → 距峰时 167h", nb.next === "peak" && nb.delta === 167 * 3600000, `${nb.delta / 3600000}h`);
}
{
  // 平常工作日 10:00 → 12:00 转谷时 = 2 小时
  const nb = M.nextBoundary(bj(2026, 9, 24, 10));
  check("平常工作日 9/24 10:00 → 距谷时 2h", nb.next === "valley" && nb.delta === 2 * 3600000, `${nb.delta / 3600000}h`);
}
{
  // 长假里找不到峰时的兜底：春节连休 9 天 > 原来的搜索上限 3 天
  const nb = M.nextBoundary(bj(2026, 10, 5, 10));
  check("长假中不会因搜索上限返回错误边界", nb.delta > 0 && nb.delta <= 10 * 24 * 3600000, `${nb.delta / 3600000}h`);
}

console.log("");
if (failed) {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
console.log("全部通过");
