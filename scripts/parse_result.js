#!/usr/bin/env node
// 解析交卷后的结果页：提取每题 题干/选项/参考答案，计算得分
// 用法: node scripts/parse_result.js <tag>
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TAG = process.argv[2] || "run1";
const DIR = path.join(ROOT, "runs", TAG);
const html = fs.readFileSync(path.join(DIR, "result.html"), "utf8");
const readyFile = path.join(DIR, "answers.ready.json");
const mine = fs.existsSync(readyFile) ? JSON.parse(fs.readFileSync(readyFile, "utf8")) : {};

function cleanText(s) {
  return String(s || "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

const ms = [...html.matchAll(/lbQTitle[^>]*>([\s\S]*?)<\/span>/g)];
const qs = [];
for (let k = 0; k < ms.length; k++) {
  const start = ms[k].index;
  // 结果页每题末尾是“参考答案”，用它作为块边界（比下一题标题更可靠）
  const ansPos = html.indexOf("参考答案", start);
  const nextPos = k + 1 < ms.length ? ms[k + 1].index : html.length;
  let end = ansPos >= 0 && ansPos < nextPos ? ansPos + 800 : nextPos;
  const block = html.slice(start, Math.min(end, html.length));
  const title = cleanText(ms[k][1]);
  const labels = [...block.matchAll(/<label[^>]*>([\s\S]*?)<\/label>/g)].map(m => m[1]);
  let ids = [...block.matchAll(/type\s*=\s*["']radio["'][^>]*?value\s*=\s*["'](\d+)["']/gi)].map(m => m[1]);
  if (!ids.length) ids = [...block.matchAll(/value\s*=\s*["'](\d+)["'][^>]*?type\s*=\s*["']radio["']/gi)].map(m => m[1]);
  let ans = null;
  const am = block.match(/参考答案\s*[:：]([\s\S]{0,400}?)<\/li>/);
  if (am) {
    const seg = am[1].replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
    const lm = seg.match(/([A-Da-d])/);
    if (lm) ans = lm[1].toUpperCase();
  }
  const options = ids.map((id, i) => {
    const raw = labels[i] || "";
    // 正确字母优先取 input 的显式 value（=A/B/C/D），否则取 label 内文字前缀，最后才退回顺序字母
    const lm = raw.replace(/<[^>]+>/g, "").match(/^\s*([A-D])[.、．]/);
    return { id, letter: lm ? lm[1] : String.fromCharCode(65 + i), text: cleanText(raw).replace(/^[A-D][.、．]\s*/, "").trim() };
  });
  const myId = mine[String(k)];
  const myOpt = options.find(o => o.id === myId);
  qs.push({
    idx: k, title, options, answer: ans,
    myLetter: myOpt ? myOpt.letter : null,
    myText: myOpt ? myOpt.text : null,
    correct: !!(ans && myOpt && ans === myOpt.letter),
  });
}
const correct = qs.filter(q => q.correct).length;
const withAns = qs.filter(q => q.answer).length;
const result = { questions: qs.length, withAnswer: withAns, myCorrect: correct, score: +(correct * 1.25).toFixed(2) };
console.log(JSON.stringify(result, null, 1));
fs.writeFileSync(path.join(DIR, "parsed.json"), JSON.stringify(qs, null, 1), "utf8");
const wrong = qs.filter(q => q.answer && !q.correct);
if (wrong.length) {
  console.log("\n=== 错题 ===");
  wrong.forEach(q => {
    console.log(`[${q.idx}] ${q.title}`);
    q.options.forEach(o => console.log(`    ${o.letter}. ${o.text}`));
    console.log(`    我选: ${q.myLetter || "-"}  正确: ${q.answer}\n`);
  });
}
