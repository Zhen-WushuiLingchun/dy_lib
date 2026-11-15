#!/usr/bin/env node
// 把「题库命中」与「人工/模型补答」合并成 runner 等待的 answers.ready.json
//
// 用法:
//   node scripts/merge_ready.js <tag> [overrides.json] [--strict] [--dry]
//
// overrides.json 支持两种写法（值是选项 id，不是字母！）：
//   { "12": "34567", "13": "42" }
//   [ { "idx": 12, "id": "34567" }, ... ]
//
// 说明：answers.json 由 prepare_answers.js 生成（命中项），overrides 覆盖/补全未命中项。
//       --strict 时若仍有题没答，不写 ready 文件（退出码 1）。
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const argv = process.argv.slice(2).filter(a => !a.startsWith("--"));
const TAG = argv[0] || "run1";
const OV_FILE = argv[1] || path.join(ROOT, "runs", TAG, "overrides.json");
const STRICT = process.argv.includes("--strict");
const DRY = process.argv.includes("--dry");
const DIR = path.join(ROOT, "runs", TAG);
const readJson = (f) => JSON.parse(String(fs.readFileSync(f, "utf8")).replace(/^\uFEFF/, ""));

const qs = readJson(path.join(DIR, "questions.json"));
const answersFile = path.join(DIR, "answers.json");
const answers = fs.existsSync(answersFile) ? readJson(answersFile) : {};

let overrides = {};
if (fs.existsSync(OV_FILE)) {
  const raw = readJson(OV_FILE);
  if (Array.isArray(raw)) {
    for (const o of raw) {
      if (o && o.idx != null && o.id != null) overrides[String(o.idx)] = String(o.id);
    }
  } else {
    for (const [k, v] of Object.entries(raw)) overrides[String(k)] = String(v);
  }
} else {
  console.log(`(提示) 没有 overrides 文件：${OV_FILE}`);
}

// 校验 overrides
const bad = [];
for (const [k, id] of Object.entries(overrides)) {
  const q = qs[Number(k)];
  if (!q) { bad.push(`idx ${k} 不存在`); continue; }
  if (!q.options.some(o => String(o.id) === String(id))) bad.push(`idx ${k} 的选项 id ${id} 不在题目选项里`);
}

const merged = {};
for (const q of qs) {
  const k = String(q.idx);
  const id = overrides[k] != null ? overrides[k] : answers[k];
  if (id != null && q.options.some(o => String(o.id) === String(id))) merged[k] = String(id);
}

const missing = qs.filter(q => merged[String(q.idx)] == null).map(q => q.idx);

console.log(JSON.stringify({
  total: qs.length,
  fromBank: Object.keys(answers).length,
  fromOverrides: Object.keys(overrides).length,
  filled: Object.keys(merged).length,
  missing: missing.length,
}, null, 1));

if (bad.length) {
  console.log("\n!!! overrides 有非法项：");
  bad.forEach(b => console.log("  - " + b));
}

if (missing.length) {
  console.log("\n=== 还缺答案的题 ===");
  for (const idx of missing) {
    const q = qs[idx];
    console.log(`\n[${idx}] ${q.title}`);
    for (const o of q.options) console.log(`    id=${o.id}  ${o.text}`);
  }
}

if (STRICT && missing.length) {
  console.log("\n--strict: 有漏题，未写 answers.ready.json");
  process.exit(1);
}

if (DRY) {
  console.log("\n--dry: 未写文件");
} else {
  const out = path.join(DIR, "answers.ready.json");
  fs.writeFileSync(out, JSON.stringify(merged, null, 1), "utf8");
  console.log(`\n已写入 ${out}（${Object.keys(merged).length}/${qs.length} 题）`);
}
