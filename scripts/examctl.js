#!/usr/bin/env node
// 分步考试控制：浏览器常驻，每条命令都是短命进程，断了随时重连，不丢试卷。
//
//   node scripts/examctl.js chrome           启动常驻有头 Chrome（带调试端口，detached，退出后仍在）
//   node scripts/examctl.js status           打印当前标签页状态
//   node scripts/examctl.js open   <tag>     打开考试页（未开考则停在“开始考试”页）
//   node scripts/examctl.js start  <tag>     开考（已在答题页则直接沿用），导出题目并匹配题库
//   node scripts/examctl.js fill   <tag>     把 answers.ready.json 填进页面（不提交）
//   node scripts/examctl.js submit <tag>     交卷 + 存 result.html + 解析得分
//   node scripts/examctl.js merge  <tag>     把 parsed.json 合并进题库
//
// 环境变量: EXAM_COOKIE(必填)、CDP_PORT(默认 9611)、CHROME_PATH、EXAM_URL、MATCH_MIN、HOLD_SEC
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const RUNS = path.join(ROOT, "runs");
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = parseInt(process.env.CDP_PORT || "9611", 10);
const PROFILE = process.env.CHROME_PROFILE || path.join(os.homedir(), ".dy-lib-chrome");
const EXAM_URL = process.env.EXAM_URL || "https://dy.nankai.edu.cn/Exam/ExamPaper.aspx?EPID=8";
const COOKIE = (process.env.EXAM_COOKIE || "").replace(/^\s*ASP\.NET_SessionId=/i, "").trim();
const MATCH_MIN = parseFloat(process.env.MATCH_MIN || "0.75");
const HOLD_SEC = parseInt(process.env.HOLD_SEC || "0", 10);
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const logs = [];
const log = (m) => { const line = `[${new Date().toISOString()}] ${m}`; logs.push(line); console.log(line); };
const tagDir = (tag) => { const d = path.join(RUNS, tag); fs.mkdirSync(d, { recursive: true }); return d; };

class CDP {
  constructor(u) {
    this.ws = new WebSocket(u); this.id = 0; this.p = new Map(); this.handlers = [];
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error("ws error")); });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.p.has(m.id)) { const { resolve, reject } = this.p.get(m.id); this.p.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }
      else for (const h of this.handlers) h(m);
    };
  }
  send(m, p = {}) { const id = ++this.id; return new Promise((res, rej) => { this.p.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); }); }
  on(fn) { this.handlers.push(fn); }
  close() { try { this.ws.close(); } catch (e) {} }
}

async function chromeAlive() {
  try { const r = await fetch(`${BASE}/json/version`, { signal: AbortSignal.timeout(2000) }); return r.ok; } catch (e) { return false; }
}

// 连上常驻浏览器；没有就报错并给出启动命令
async function attach({ dialogs = false } = {}) {
  if (!(await chromeAlive())) {
    throw new Error(`没有可用的 Chrome 调试端口 ${BASE}。先运行: node scripts/examctl.js chrome`);
  }
  const list = await (await fetch(`${BASE}/json/list`)).json();
  let page = list.find(t => t.type === "page" && /dy\.nankai\.edu\.cn/.test(t.url)) || list.find(t => t.type === "page");
  if (!page) {
    await fetch(`${BASE}/json/new?about:blank`, { method: "PUT" });
    await sleep(500);
    const l2 = await (await fetch(`${BASE}/json/list`)).json();
    page = l2.find(t => t.type === "page");
  }
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  if (dialogs) {
    cdp.on((m) => {
      if (m.method === "Page.javascriptDialogOpening") {
        log(`dialog: ${m.params.type} ${m.params.message}`);
        cdp.send("Page.handleJavaScriptDialog", { accept: true, promptText: "开始考试" }).catch(() => {});
      }
    });
  }
  const html = () => cdp.send("Runtime.evaluate", { expression: "document.documentElement.outerHTML", returnByValue: true }).then(r => r.result.value || "").catch(() => "");
  const evaluate = (expr) => cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }).then(r => r.result && r.result.value).catch(() => undefined);
  return { cdp, html, evaluate, page };
}

function cleanText(s) {
  return String(s || "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

// 从 HTML 抽题目（考场页/结果页同构）
function extractQuestions(html) {
  const ms = [...html.matchAll(/lbQTitle[^>]*>([\s\S]*?)<\/span>/g)];
  const qs = [];
  for (let k = 0; k < ms.length; k++) {
    const start = ms[k].index;
    const ansPos = html.indexOf("参考答案", start);
    const nextPos = k + 1 < ms.length ? ms[k + 1].index : html.length;
    const end = ansPos >= 0 && ansPos < nextPos ? ansPos + 800 : nextPos;
    const block = html.slice(start, Math.min(end, html.length));
    const title = cleanText(ms[k][1]);
    const labels = [...block.matchAll(/<label[^>]*>([\s\S]*?)<\/label>/g)].map(m => m[1]);
    let ids = [...block.matchAll(/type\s*=\s*["']radio["'][^>]*?value\s*=\s*["'](\d+)["']/gi)].map(m => m[1]);
    if (!ids.length) ids = [...block.matchAll(/value\s*=\s*["'](\d+)["'][^>]*?type\s*=\s*["']radio["']/gi)].map(m => m[1]);
    const options = labels.map((raw, i) => {
      const txt = cleanText(raw);
      const lm = txt.match(/^\s*([A-D])[.、．]/);
      return { id: ids[i] || String(i), letter: lm ? lm[1] : String.fromCharCode(65 + i), text: txt.replace(/^\s*[A-D][.、．]\s*/, "").trim() };
    });
    qs.push({ idx: k, title, options });
  }
  return qs;
}

function parseResult(html, mine) {
  const qs = extractQuestions(html);
  const out = [];
  for (const q of qs) {
    const at = html.indexOf(q.title);
    const seg = at >= 0 ? html.slice(at, at + 6000) : "";
    let ans = null;
    const am = seg.match(/参考答案\s*[:：]([\s\S]{0,400}?)<\/li>/);
    if (am) { const s = cleanText(am[1]); const lm = s.match(/([A-Da-d])/); if (lm) ans = lm[1].toUpperCase(); }
    const myId = mine[String(q.idx)];
    const myOpt = q.options.find(o => o.id === myId);
    out.push({ idx: q.idx, title: q.title, options: q.options, answer: ans, myLetter: myOpt ? myOpt.letter : null, myText: myOpt ? myOpt.text : null, correct: !!(ans && myOpt && ans === myOpt.letter) });
  }
  return { questions: out, correct: out.filter(q => q.correct).length };
}

function mergeIntoBank(parsed, tag) {
  const { norm, dice } = require("./lib_match");
  const BANK = path.join(ROOT, "data", "bank.json");
  const bank = JSON.parse(fs.readFileSync(BANK, "utf8"));
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
      else if (nq.length > 8 && (ne.startsWith(nq) || nq.startsWith(ne))) s = Math.max(s, 0.98);
      if (!best || s > best.s) best = { s, e };
    }
    if (best && best.s >= 0.9) {
      const e = best.e;
      const old = e.answer_text;
      if (old && answer_text && norm(old) !== norm(answer_text)) {
        conflicts.push({ stem: q.title, bank: old, exam: answer_text });
        e.altAnswers = [...new Set([...(e.altAnswers || []), old, answer_text])];
      }
      e.options = opts; e.answer = q.answer; e.answer_text = answer_text; e.qtype = "mcq"; e.verified = true;
      updated++;
    } else {
      bank.push({ qtype: "mcq", no: q.idx + 1, stem: q.title, options: opts, answer: q.answer, answer_text, source: `exam-${tag}`, dupCount: 1, verified: true });
      added++;
    }
  }
  fs.writeFileSync(BANK, JSON.stringify(bank, null, 1), "utf8");
  const csv = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
  let out = "\uFEFF题型,题号,题干,A,B,C,D,答案字母,答案文本,重复次数,已核对\n";
  for (const e of bank) out += [csv(e.qtype), csv(e.no), csv(e.stem), csv(e.options?.A), csv(e.options?.B), csv(e.options?.C), csv(e.options?.D), csv(e.answer), csv(e.answer_text), csv(e.dupCount), csv(e.verified ? "是" : "")].join(",") + "\n";
  fs.writeFileSync(path.join(ROOT, "data", "bank.csv"), out, "utf8");
  if (conflicts.length) {
    const f = path.join(ROOT, "data", "conflicts_exam.md");
    const body = fs.existsSync(f) ? fs.readFileSync(f, "utf8").replace(/^# .*\n[\s\S]*?\n\n/, "") : "";
    const entries = body.split(/\r?\n(?=- )/).map(s => s.trim()).filter(s => s.startsWith("- "));
    const key = (s) => s.replace(/\s+/g, "");
    const seen = new Set(entries.map(key));
    for (const c of conflicts) {
      const block = `- ${c.stem}\n  - 题库: ${c.bank}\n  - 考试: ${c.exam}`;
      if (!seen.has(key(block))) { entries.push(block); seen.add(key(block)); }
    }
    let rep = `# 题库与考试答案不一致\n\n共 ${entries.length} 条。\n\n`;
    for (const b of entries) rep += b + "\n\n";
    fs.writeFileSync(f, rep, "utf8");
  }
  return { updated, added, conflicts: conflicts.length, total: bank.length };
}

// 把题库命中的答案与人工补答写进 answers.ready.json
function prepareAnswers(tag, qs) {
  const { loadBank, matchAnswer, pickOption } = require("./lib_match");
  const dir = tagDir(tag);
  const { B } = loadBank(path.join(ROOT, "data", "bank.json"));
  const answers = {}, matched = [], unmatched = [];
  for (const q of qs) {
    const m = matchAnswer(B, q.title);
    if (!m) { unmatched.push(q); continue; }
    const opt = pickOption(q.options, m.answer_text);
    if (!opt || m.score < MATCH_MIN) { unmatched.push({ ...q, bank_answer: m.answer_text, bank_score: m.score }); continue; }
    answers[q.idx] = opt.id;
    matched.push({ idx: q.idx, title: q.title, answer: m.answer_text, option: opt.text, score: m.score });
  }
  fs.writeFileSync(path.join(dir, "answers.json"), JSON.stringify(answers, null, 1), "utf8");
  fs.writeFileSync(path.join(dir, "unmatched.json"), JSON.stringify(unmatched, null, 1), "utf8");
  fs.writeFileSync(path.join(dir, "matched.json"), JSON.stringify(matched, null, 1), "utf8");
  log(`matched=${matched.length} unmatched=${unmatched.length}`);
  return { matched, unmatched, answers };
}

const commands = {
  async chrome() {
    if (await chromeAlive()) { console.log(`Chrome 已在 ${BASE} 运行（profile: ${PROFILE}）`); return; }
    if (!fs.existsSync(CHROME)) throw new Error(`找不到 Chrome: ${CHROME}`);
    const args = [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      "--no-first-run", "--no-default-browser-check",
      "--window-size=1400,1000", "--new-window", "about:blank",
    ];
    if (process.env.HEADLESS === "1") args.unshift("--headless=new");
    const proc = spawn(CHROME, args, { detached: true, stdio: "ignore" });
    proc.unref();
    for (let i = 0; i < 80; i++) { if (await chromeAlive()) break; await sleep(250); }
    if (!(await chromeAlive())) throw new Error(`Chrome 启动后调试端口 ${BASE} 仍不可用`);
    console.log(`已启动有头 Chrome，调试端口 ${BASE}\nprofile: ${PROFILE}\n（关闭浏览器用 node scripts/examctl.js close，或直接关窗口）`);
  },

  async close() {
    const { cdp } = await attach();
    await cdp.send("Browser.close").catch(() => {});
    console.log("已请求关闭浏览器");
  },

  async status() {
    const { cdp, html, page } = await attach();
    const h = await html();
    const qs = extractQuestions(h);
    const info = await cdp.send("Runtime.evaluate", { expression: "JSON.stringify({url:location.href,title:document.title})", returnByValue: true });
    console.log(JSON.stringify({ page: JSON.parse(info.result.value), questions: qs.length, hasStart: h.includes("开始考试"), hasSubmit: /btnSubmit/.test(h) }, null, 1));
    cdp.close();
  },

  async open(tag) {
    const { cdp, html, evaluate } = await attach();
    if (COOKIE) {
      await cdp.send("Network.setCookie", { name: "ASP.NET_SessionId", value: COOKIE, domain: "dy.nankai.edu.cn", path: "/", httpOnly: true });
      log("cookie 已注入 ASP.NET_SessionId");
    }
    log("navigate " + EXAM_URL);
    await cdp.send("Page.navigate", { url: EXAM_URL });
    await sleep(4000);
    const h = await html();
    fs.writeFileSync(path.join(tagDir(tag), "open.html"), h, "utf8");
    const st = { hasStart: h.includes("开始考试"), questions: extractQuestions(h).length, needLogin: /用户登录|登录/.test(cleanText(h)) && !h.includes("开始考试") };
    log("state " + JSON.stringify(st));
    cdp.close();
    return st;
  },

  async start(tag) {
    const dir = tagDir(tag);
    const { cdp, html, evaluate } = await attach({ dialogs: true });
    let h = await html();
    if (COOKIE && !/dy\.nankai\.edu\.cn/.test((await cdp.send("Runtime.evaluate", { expression: "location.href", returnByValue: true })).result.value)) {
      await cdp.send("Network.setCookie", { name: "ASP.NET_SessionId", value: COOKIE, domain: "dy.nankai.edu.cn", path: "/", httpOnly: true });
    }
    // 已在答题页：直接沿用，不重复开考
    if (extractQuestions(h).length) {
      log("页面已有题目：沿用当前试卷，不再点“开始考试”");
    } else {
      if (!h.includes("开始考试")) {
        // 尝试导航过去
        await cdp.send("Page.navigate", { url: EXAM_URL });
        await sleep(4000);
        h = await html();
      }
      if (!h.includes("开始考试")) {
        fs.writeFileSync(path.join(dir, "start-fail.html"), h, "utf8");
        log("未到开考页（cookie 失效/已在考/次数用尽），页面见 start-fail.html");
        cdp.close();
        return { ok: false, reason: "not-at-start-page" };
      }
      log("点击开始考试");
      await cdp.send("Runtime.evaluate", { expression: "document.getElementById('ContentPlaceHolder1_ContentPlaceHolder1_btnStart').click()" });
      for (let i = 0; i < 10; i++) { await sleep(2000); h = await html(); if (extractQuestions(h).length) break; }
    }
    const qs = extractQuestions(h);
    if (!qs.length) { fs.writeFileSync(path.join(dir, "exam.html"), h, "utf8"); log("开考后未解析到题目"); cdp.close(); return { ok: false, reason: "no-questions" }; }
    fs.writeFileSync(path.join(dir, "exam.html"), h, "utf8");
    fs.writeFileSync(path.join(dir, "questions.json"), JSON.stringify(qs, null, 1), "utf8");
    log(`questions=${qs.length}`);
    const r = prepareAnswers(tag, qs);
    cdp.close();
    return { ok: true, total: qs.length, matched: r.matched.length, unmatched: r.unmatched.length };
  },

  async prepare(tag) {
    const dir = tagDir(tag);
    const qs = JSON.parse(fs.readFileSync(path.join(dir, "questions.json"), "utf8"));
    const r = prepareAnswers(tag, qs);
    return { ok: true, total: qs.length, matched: r.matched.length, unmatched: r.unmatched.length };
  },

  async fill(tag) {
    const dir = tagDir(tag);
    const file = path.join(dir, "answers.ready.json");
    if (!fs.existsSync(file)) throw new Error(`没有 ${file}，先补答`);
    const ans = JSON.parse(fs.readFileSync(file, "utf8"));
    const { cdp, html } = await attach();
    const qs = extractQuestions(await html());
    if (!qs.length) { cdp.close(); throw new Error("当前页面没有题目，先用 start 开考"); }
    const r = await cdp.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(()=>{const a=${JSON.stringify(ans)};let ok=0,miss=[];for(const k of Object.keys(a)){const el=document.querySelector("input[type=radio][value='"+a[k]+"']");if(el){el.click();el.checked=true;el.dispatchEvent(new Event('change',{bubbles:true}));ok++;}else miss.push(k);}
      const filled=document.querySelectorAll("input[type=radio]:checked").length;return JSON.stringify({ok,miss,filled});})()`,
    });
    const res = JSON.parse(r.result.value);
    log(`fill ${JSON.stringify(res)}`);
    fs.writeFileSync(path.join(dir, "fill.json"), JSON.stringify(res, null, 1), "utf8");
    cdp.close();
    return res;
  },

  async submit(tag) {
    const dir = tagDir(tag);
    const ready = path.join(dir, "answers.ready.json");
    const mine = fs.existsSync(ready) ? JSON.parse(fs.readFileSync(ready, "utf8")) : {};
    const { cdp, html } = await attach({ dialogs: true });
    let h = await html();
    if (!extractQuestions(h).length) { cdp.close(); throw new Error("当前页面没有题目，无法交卷"); }
    const tStart = Date.now();
    if (HOLD_SEC > 0) { log(`hold ${HOLD_SEC}s 后交卷`); await sleep(HOLD_SEC * 1000); }
    log("submit");
    await cdp.send("Runtime.evaluate", { expression: "document.getElementById('ContentPlaceHolder1_ContentPlaceHolder1_btnSubmit').click()" }).catch(e => log("submit err " + e.message));
    await sleep(4000);
    for (let step = 0; step < 8; step++) {
      h = await html();
      fs.writeFileSync(path.join(dir, `step${step}.html`), h, "utf8");
      const clicked = await cdp.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(()=>{const rx=/(完毕|确认完成|确定|完成|查看答案|查看试卷|提交|继续)/;for(const el of document.querySelectorAll("input[type=button],input[type=submit],button,a")){const t=(el.value||el.textContent||"").trim();if(rx.test(t)&&t.length<20){el.click();return t;}}return null;})()`,
      }).then(r => r.result.value).catch(() => null);
      if (!clicked) break;
      log(`click: ${clicked}`);
      await sleep(3000);
    }
    await sleep(1500);
    const finalHtml = await html();
    fs.writeFileSync(path.join(dir, "result.html"), finalHtml, "utf8");
    log(`result.html len=${finalHtml.length}`);
    const parsed = parseResult(finalHtml, mine);
    fs.writeFileSync(path.join(dir, "parsed.json"), JSON.stringify(parsed.questions, null, 1), "utf8");
    const summary = { questions: parsed.questions.length, withAnswer: parsed.questions.filter(q => q.answer).length, myCorrect: parsed.correct, score: +(parsed.correct * 1.25).toFixed(2), elapsedSec: Math.round((Date.now() - tStart) / 1000) };
    fs.writeFileSync(path.join(dir, "score.json"), JSON.stringify(summary, null, 1), "utf8");
    log("score " + JSON.stringify(summary));
    cdp.close();
    return summary;
  },

  async merge(tag) {
    const dir = tagDir(tag);
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "parsed.json"), "utf8"));
    const info = mergeIntoBank(parsed, tag);
    log("merge " + JSON.stringify(info));
    fs.writeFileSync(path.join(dir, "merge.json"), JSON.stringify(info, null, 1), "utf8");
    return info;
  },

  async list(tag) {
    const dir = tagDir(tag);
    const um = JSON.parse(fs.readFileSync(path.join(dir, "unmatched.json"), "utf8"));
    console.log(JSON.stringify({ total: um.length }, null, 1));
    for (const q of um) {
      console.log(`\n[${q.idx}] ${q.title}`);
      for (const o of q.options || []) console.log(`    ${o.id} = (${o.letter}) ${o.text}`);
      if (q.bank_answer) console.log(`    (题库弱匹配: ${q.bank_answer} score=${q.bank_score})`);
    }
  },

  // 補答合并：node scripts/examctl.js apply <tag> '{"12":"34567"}'
  async apply(tag) {
    const dir = tagDir(tag);
    const raw = process.argv[4] || "{}";
    // 支持 apply <tag> @answers.json —— PowerShell 直传内联 JSON 会被引号规则吃掉
    const text = raw.startsWith("@") ? fs.readFileSync(raw.slice(1), "utf8") : raw;
    const add = JSON.parse(text);
    const baseFile = path.join(dir, "answers.json");
    const base = fs.existsSync(baseFile) ? JSON.parse(fs.readFileSync(baseFile, "utf8")) : {};
    const merged = { ...base, ...add };
    fs.writeFileSync(path.join(dir, "answers.ready.json"), JSON.stringify(merged, null, 1), "utf8");
    log(`apply fromBank=${Object.keys(base).length} manual=${Object.keys(add).length} total=${Object.keys(merged).length}`);
    return { fromBank: Object.keys(base).length, manual: Object.keys(add).length, total: Object.keys(merged).length };
  },
};

(async () => {
  if (require.main !== module) return; // 被 require 时只当库用
  const [cmd = "status", tag = "run1"] = process.argv.slice(2);
  const fn = commands[cmd];
  if (!fn) { console.error("命令: " + Object.keys(commands).join(" | ")); process.exit(1); }
  try {
    const r = await fn(tag);
    if (logs.length) { const d = tagDir(tag); fs.appendFileSync(path.join(d, "run.log"), logs.join("\n") + "\n"); }
    if (r !== undefined) console.log("\n=== RESULT ===\n" + JSON.stringify(r, null, 1));
  } catch (e) { console.error("ERROR: " + e.message); process.exit(4); }
})();

module.exports = { extractQuestions, parseResult, CDP, attach, PORT };
