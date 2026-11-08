#!/usr/bin/env node
// 把一次考试结果合并进题库（按题干匹配：更新已有条目 / 新增条目 / 记录冲突）
// 用法: node scripts/merge_exam.js <tag>
const fs = require("fs");
const path = require("path");
const { norm, dice } = require("./lib_match");

const ROOT = path.join(__dirname, "..");
const TAG = process.argv[2] || "run1";
const DIR = path.join(ROOT, "runs", TAG);
const BANK = path.join(ROOT, "data", "bank.json");
const bank = JSON.parse(fs.readFileSync(BANK, "utf8"));
const parsed = JSON.parse(fs.readFileSync(path.join(DIR, "parsed.json"), "utf8"));

const conflicts = [];
let updated = 0, added = 0;
for (const q of parsed) {
  if (!q.answer) continue;
  const opts = {};
  for (const o of q.options) opts[o.letter] = o.text;
  const answer_text = opts[q.answer] || null;
  const nq = norm(q.title);
  let best = null;
  for (const e of bank) {
    const ne = norm(e.stem);
    if (!ne) continue;
    let s = dice(nq, ne);
    if (ne === nq) s = 1;
    else if (nq.length > 8 && (ne.startsWith(nq) || nq.startsWith(ne))) s = Math.max(s, 0.99);
    if (!best || s > best.s) best = { s, e };
  }
  if (best && best.s >= 0.9) {
    const e = best.e;
    const old = e.answer_text;
    if (old && answer_text && norm(old) !== norm(answer_text)) {
      conflicts.push({ stem: q.title, bank: old, exam: answer_text });
      e.altAnswers = [...new Set([...(e.altAnswers || []), old, answer_text])];
    }
    e.options = opts; e.answer = q.answer; e.answer_text = answer_text;
    e.qtype = "mcq"; e.verified = true;
    updated++;
  } else {
    bank.push({ qtype: "mcq", no: q.idx + 1, stem: q.title, options: opts, answer: q.answer, answer_text, source: `exam-${TAG}`, dupCount: 1, verified: true });
    added++;
  }
}
fs.writeFileSync(BANK, JSON.stringify(bank, null, 1), "utf8");

function csv(s) { return '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"'; }
let out = "\uFEFF题型,题号,题干,A,B,C,D,答案字母,答案文本,重复次数,已核对\n";
for (const e of bank) {
  out += [csv(e.qtype), csv(e.no), csv(e.stem), csv(e.options?.A), csv(e.options?.B), csv(e.options?.C), csv(e.options?.D), csv(e.answer), csv(e.answer_text), csv(e.dupCount), csv(e.verified ? "是" : "")].join(",") + "\n";
}
fs.writeFileSync(path.join(ROOT, "data", "bank.csv"), out, "utf8");

console.log(JSON.stringify({ updated, added, conflicts: conflicts.length, total: bank.length }, null, 1));
if (conflicts.length) {
  const f = path.join(ROOT, "data", "conflicts_exam.md");
  // 追加模式：保留历史冲突记录，按条目文本去重（原来整份覆盖会丢掉以往记录）
  const entries = [];
  if (fs.existsSync(f)) {
    for (const block of fs.readFileSync(f, "utf8").split(/\r?\n(?=- )/)) {
      const t = block.trim();
      if (t.startsWith("- ")) entries.push(t);
    }
  }
  const key = (s) => s.replace(/\s+/g, "");
  const seen = new Set(entries.map(key));
  for (const c of conflicts) {
    const block = `- ${c.stem}\n  - 题库: ${c.bank}\n  - 考试: ${c.exam}`;
    if (!seen.has(key(block))) { entries.push(block); seen.add(key(block)); }
  }
  let rep = `# 题库与考试答案不一致\n\n共 ${entries.length} 条。\n\n`;
  for (const b of entries) rep += b + "\n\n";
  fs.writeFileSync(f, rep, "utf8");
  console.log(`已写入 data/conflicts_exam.md（累计 ${entries.length} 条）`);
}
