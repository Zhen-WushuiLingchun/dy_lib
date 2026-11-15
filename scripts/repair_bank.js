#!/usr/bin/env node
// 修复题库里"一道题干里拼进了选项和下一题题干"的脏条目，并重建 CSV
// 用法: node scripts/repair_bank.js [--dry]
// 设计原则：只做定点修复（每条都能在 diff 里一眼看清），不做大规模重排；
// 重复运行安全（已经修好的条目不会再次命中）。
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const BANK = path.join(ROOT, "data", "bank.json");
const DRY = process.argv.includes("--dry");

const bank = JSON.parse(fs.readFileSync(BANK, "utf8"));
const log = [];
const bad = [];

// 从脏题干里截出真正的第一道题
function cut(stem, marker, tail) {
  const i = stem.indexOf(tail);
  return i >= 0 ? stem.slice(0, i + tail.length) : stem;
}

// —— 定点修复表 ——
// 每条：找 stem 含 from 的条目，应用 patch；找不到就记入 bad
const REPAIRS = [
  {
    // "庶几"句被并进了王蒙诗句，答案也跟着错了
    from: "“庶几”的意思是？A.",
    patch: {
      qtype: "mcq",
      stem: "“庶几”的意思是( )",
      options: { A: "没有几个", B: "平民", C: "庶民", D: "差不多" },
      answer: "D",
      answer_text: "差不多",
      verified: true,
      source: "repair",
    },
  },
  {
    // 萧红作品题：inline 但题干里带选项，转成 mcq
    from: "以下属于萧红作品的是",
    patch: {
      qtype: "mcq",
      stem: "以下属于萧红作品的是( )",
      options: { A: "《呼兰河传》", B: "《风云初记》", C: "《科尔沁旗草原》", D: "《八月的乡村》" },
      answer: "A",
      answer_text: "《呼兰河传》",
      verified: true,
      source: "repair",
    },
  },
  {
    from: "《楚辞·渔夫》中所采用的文学手法是： A.",
    patch: { stem: "《楚辞·渔夫》中所采用的文学手法是( )", verified: true },
  },
  {
    from: "“共同研究学术之机关”的基本含义是 A.",
    patch: {
      stem: "在《北京大学月刊发刊词》一文中，“共同研究学术之机关”的基本含义是( )",
      options: { A: "强调大学的教育职能", B: "强调大学的批判功能", C: "强调大学的科学职能" },
      answer: "C",
      answer_text: "强调大学的科学职能",
      verified: true,
      source: "repair",
    },
  },
  {
    from: "孟子采用的手法是 A.",
    patch: {
      stem: "在描述百姓对齐王好乐和田猎的两种不同反应时，为了增强说服力和感染力，孟子采用的手法是( )",
      options: { A: "巧设悬念", B: "重章叠句", C: "场景烘托", D: "渲染夸张" },
      answer: "B",
      answer_text: "重章叠句",
      verified: true,
      source: "repair",
    },
  },
  {
    from: "说明一个抽象的道理”这一特点的文章是 A.",
    patch: { stem: "具有“用诸多极具体的人生现象和故事，说明一个抽象的道理”这一特点的文章是( )", verified: true },
  },
  {
    // 原题库错字
    from: "《野生陶先生二三事》",
    patch: { stem: null, rename: { "《野生陶先生二三事》": "《叶圣陶先生二三事》" } },
  },
];

for (const r of REPAIRS) {
  const hit = bank.filter(e => (e.stem || "").includes(r.from));
  if (hit.length !== 1) { bad.push({ from: r.from, hits: hit.length }); continue; }
  const e = hit[0];
  const { rename, ...patch } = r.patch;
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) continue;
    if (k === "stem" && rename) e.stem = e.stem.replace(rename[0], rename[1]);
    else e[k] = v;
  }
  if (rename) for (const [a, b] of Object.entries(rename)) e.stem = (e.stem || "").replace(a, b);
  log.push(`${r.from.slice(0, 24)} -> ${e.stem.slice(0, 40)} | ${e.answer_text}`);
}

// —— 校验：不应再有题干内嵌选项的条目 ——
const stillBad = bank.filter(e => e.qtype !== "inline" && /[A-D][.．、]\s/.test(e.stem || ""));
if (stillBad.length) bad.push({ residual: stillBad.map(e => e.stem.slice(0, 50)) });

if (!DRY && !bad.length) {
  fs.writeFileSync(BANK, JSON.stringify(bank, null, 1), "utf8");
  const csv = s => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
  let out = "\uFEFF题型,题号,题干,A,B,C,D,答案字母,答案文本,重复次数,已核对\n";
  for (const e of bank) {
    out += [csv(e.qtype), csv(e.no), csv(e.stem), csv(e.options?.A), csv(e.options?.B), csv(e.options?.C), csv(e.options?.D), csv(e.answer), csv(e.answer_text), csv(e.dupCount), csv(e.verified ? "是" : "")].join(",") + "\n";
  }
  fs.writeFileSync(path.join(ROOT, "data", "bank.csv"), out, "utf8");
}

console.log(JSON.stringify({ repaired: log.length, bad, total: bank.length, written: !DRY && !bad.length }, null, 1));
for (const l of log) console.log("  " + l);
