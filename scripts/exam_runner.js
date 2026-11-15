#!/usr/bin/env node
// 考试自动答题 Runner（南开大学大学语文在线测试）
// 用法: EXAM_COOKIE="ASP.NET_SessionId=..." node scripts/exam_runner.js <tag>
// 依赖: 本机 Chrome；无需 puppeteer（直接走 CDP）
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const RUNS = path.join(ROOT, "runs");
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const COOKIE_RAW = process.env.EXAM_COOKIE || "";

// EXAM_COOKIE 支持多种粘贴形式，统一解析成 cookie 列表：
//   1) 纯值：dwerurlxrlzqdlqnnqncnhm2
//   2) 单条：ASP.NET_SessionId=dwer...
//   3) 整行 Cookie 头：ASP.NET_SessionId=...; .ASPXAUTH=...
//   4) 整段 curl（Copy as cURL）：... -H 'Cookie: ASP.NET_SessionId=...; ...'
function parseCookieInput(raw) {
  const s = String(raw || "").trim().replace(/^["']|["']$/g, "");
  if (!s) return { list: [], sessionId: "" };
  if (!s.includes("=")) return { list: [["ASP.NET_SessionId", s]], sessionId: s };
  let src = s;
  const m = s.match(/cookie\s*:\s*([^'"\\]+)/i);
  if (m) src = m[1];
  const list = [];
  const seen = new Set();
  const re = /([A-Za-z0-9_.\-]+)=([^;'"\s\\]+)/g;
  let mm;
  while ((mm = re.exec(src))) {
    const name = mm[1], value = mm[2];
    if (!/^(ASP\.NET_SessionId|\.?ASPXAUTH|\.ASPXANONYMOUS|__RequestVerificationToken|JSESSIONID|SESSION|sessionId|token)$/i.test(name)) continue;
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    list.push([name, value]);
  }
  const pair = list.find(p => /^ASP\.NET_SessionId$/i.test(p[0]));
  return { list, sessionId: pair ? pair[1] : "" };
}
const CK = parseCookieInput(COOKIE_RAW);
const COOKIE = CK.sessionId;
const HEADLESS = process.env.HEADLESS === "1";
const HOLD_SEC = parseInt(process.env.HOLD_SEC || "120", 10);
const TAG = process.argv[2] || "run1";
const OUT = path.join(RUNS, TAG);
const URL_EXAM = process.env.EXAM_URL || "https://dy.nankai.edu.cn/Exam/ExamPaper.aspx?EPID=8";
const PORT = 9600 + (parseInt(TAG.replace(/\D/g, "") || "1", 10) % 80);
const PROFILE = path.join(require("os").tmpdir(), `dy-lib-chrome-${TAG}`);

if (!COOKIE) {
  console.error("缺少 EXAM_COOKIE（或其中没有 ASP.NET_SessionId=）。");
  console.error("请先在浏览器登录 dy.nankai.edu.cn，然后任选一种粘进来：");
  console.error("  A) DevTools → Network → 任一请求 → Request Headers → 复制整行 Cookie:");
  console.error("  B) 右键请求 → Copy → Copy as cURL (bash) → 整段粘贴（会自动提取）");
  console.error("  C) 或直接运行 node scripts/get_cookie.js（有头 Chrome，登录后自动打印）");
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (m) => { const line = `[${new Date().toISOString()}] ${m}`; fs.appendFileSync(path.join(OUT, "run.log"), line + "\n"); console.log(line); };

class CDP {
  constructor(u){this.ws=new WebSocket(u);this.id=0;this.p=new Map();this.handlers=[];this.ready=new Promise((res,rej)=>{this.ws.onopen=res;this.ws.onerror=()=>rej(new Error("ws error"))});this.ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id&&this.p.has(m.id)){const{resolve,reject}=this.p.get(m.id);this.p.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result)}else{for(const h of this.handlers)h(m);}};}
  send(m,p={}){const id=++this.id;return new Promise((res,rej)=>{this.p.set(id,{resolve:res,reject:rej});this.ws.send(JSON.stringify({id,method:m,params:p}))});}
  on(fn){this.handlers.push(fn);}
}

(async () => {
  fs.writeFileSync(path.join(OUT, "run.log"), "");
  const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, "--no-first-run", "--no-default-browser-check", "--window-size=1400,1000"];
  if (HEADLESS) args.unshift("--headless=new");
  const proc = spawn(CHROME, [...args, "about:blank"], { stdio: "ignore" });
  try {
    for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch (e) {} await sleep(250); }
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find(t => t.type === "page");
    const cdp = new CDP(page.webSocketDebuggerUrl); await cdp.ready;
    await cdp.send("Page.enable"); await cdp.send("Network.enable");
    cdp.on((m) => {
      if (m.method === "Page.javascriptDialogOpening") {
        log(`dialog: ${m.params.type} ${m.params.message}`);
        cdp.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
      }
    });
    const snap = async (name) => {
      try {
        const r = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
        fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(r.data, "base64"));
        log(`shot ${name}.png`);
      } catch (e) { log(`shot err ${name}: ${e.message}`); }
    };
    // 点击按钮：先按 id 片段，再按文案正则兜底
    const clickBy = async (idPart, rxSrc) => {
      const expr = `(()=>{const els=[...document.querySelectorAll("input[type=button],input[type=submit],button,a")];
        const byId=els.find(e=>(e.id||"").includes(${JSON.stringify(idPart)}));
        if(byId){byId.click();return "id:"+byId.id;}
        const rx=new RegExp(${JSON.stringify(rxSrc)});
        for(const e of els){const t=(e.value||e.textContent||"").trim();if(t&&t.length<20&&rx.test(t)){e.click();return "txt:"+t;}}
        return null;})()`;
      return (await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;
    };
    const getHtml = () => cdp.send("Runtime.evaluate", { expression: "document.documentElement.outerHTML", returnByValue: true }).then(r => r.result.value).catch(() => "");
    for (const [name, value] of CK.list) {
      await cdp.send("Network.setCookie", { name, value, domain: "dy.nankai.edu.cn", path: "/", httpOnly: true, secure: true });
    }
    log(`cookie set: ${CK.list.map(p => p[0]).join(", ")}`);

    log("navigate");
    await cdp.send("Page.navigate", { url: URL_EXAM });
    await sleep(3500);
    log("page: " + (await cdp.send("Runtime.evaluate", { expression: "location.href + ' | ' + document.title", returnByValue: true })).result.value);
    const preHtml = await getHtml();
    fs.writeFileSync(path.join(OUT, "page-before.html"), preHtml || "", "utf8");
    await snap("00-before-start");
    if (!preHtml.includes("开始考试")) { log("未到开考页（cookie 可能失效 / 未登录），已保存 page-before.html"); return; }

    const tStart = Date.now();
    const clickedStart = await clickBy("btnStart", "开始考试");
    log("click start -> " + clickedStart);
    if (!clickedStart) { log("找不到「开始考试」按钮"); return; }
    await sleep(6000);
    const html = await getHtml();

    const qs = [];
    const ms = [...html.matchAll(/lbQTitle[^>]*>([\s\S]*?)<\/span>/g)];
    for (let k = 0; k < ms.length; k++) {
      const start = ms[k].index;
      const end = k + 1 < ms.length ? ms[k + 1].index : html.length;
      const block = html.slice(start, end);
      const title = ms[k][1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
      const labels = [...block.matchAll(/<label[^>]*>([\s\S]*?)<\/label>/g)].map(m => m[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim());
      const ids = [...block.matchAll(/type="radio"[^>]*?value="(\d+)"/g)].map(m => m[1]);
      const ids2 = ids.length ? ids : [...block.matchAll(/value="(\d+)"[^>]*?type="radio"/g)].map(m => m[1]);
      qs.push({ idx: k, title, options: ids2.map((id, i) => ({ id, text: labels[i] || "" })) });
    }
    fs.writeFileSync(path.join(OUT, "questions.json"), JSON.stringify(qs, null, 1), "utf8");
    log(`questions=${qs.length}`);
    await snap("01-questions");
    if (!qs.length) {
      fs.writeFileSync(path.join(OUT, "page-questions.html"), html || "", "utf8");
      log("解析到 0 题，页面结构可能变化，已保存 page-questions.html");
      return;
    }

    const ready = path.join(OUT, "answers.ready.json");
    log("waiting answers.ready.json");
    for (let i = 0; i < 900; i++) { if (fs.existsSync(ready)) break; await sleep(2000); }
    if (!fs.existsSync(ready)) { log("超时未收到答案"); return; }
    const ans = JSON.parse(fs.readFileSync(ready, "utf8"));
    const applied = await cdp.send("Runtime.evaluate", { expression: `(()=>{const a=${JSON.stringify(ans)};let ok=0,miss=[];for(const k of Object.keys(a)){const el=document.querySelector("input[type=radio][value='"+a[k]+"']");if(el){el.checked=true;el.dispatchEvent(new Event('click',{bubbles:true}));ok++;}else miss.push(k);}return JSON.stringify({ok,miss});})()`, returnByValue: true });
    log("apply " + applied.result.value);
    try {
      const info = JSON.parse(applied.result.value);
      if (info.miss && info.miss.length) log(`WARN 未点选成功的题: ${info.miss.join(",")}`);
      log(`answered=${Object.keys(ans).length}/${qs.length}`);
    } catch (e) {}
    await snap("02-answered");

    // 需求：答完题后先停 HOLD_SEC 秒（默认 120s）再交卷，留出人工复核时间；不按开考时刻倒扣
    const tAnswered = Date.now();
    log(`hold ${HOLD_SEC}s after answering (before submit)`);
    await sleep(HOLD_SEC * 1000);
    log(`hold done, elapsed since answering ${Math.round((Date.now() - tAnswered) / 1000)}s`);

    log("submit");
    const clickedSubmit = await clickBy("btnSubmit", "交卷|提交|完成考试");
    log("click submit -> " + clickedSubmit);
    await sleep(4000);

    for (let step = 0; step < 6; step++) {
      const h = await cdp.send("Runtime.evaluate", { expression: "document.documentElement.outerHTML", returnByValue: true }).then(r => r.result.value).catch(() => "");
      fs.writeFileSync(path.join(OUT, `step${step}.html`), h || "", "utf8");
      const clicked = await cdp.send("Runtime.evaluate", { expression: `(()=>{const rx=/(完毕|确认完成|确定|完成|查看答案|查看试卷|答案|提交|继续)/;for(const el of document.querySelectorAll("input[type=button],input[type=submit],button,a")){const t=(el.value||el.textContent||"").trim();if(rx.test(t)&&t.length<20){el.click();return t;}}return null;})()`, returnByValue: true }).then(r => r.result.value).catch(() => null);
      if (!clicked) break;
      log(`click: ${clicked}`);
      await sleep(3000);
    }
    await sleep(1500);
    await snap("03-result");
    const finalHtml = await cdp.send("Runtime.evaluate", { expression: "document.documentElement.outerHTML", returnByValue: true }).then(r => r.result.value).catch(() => "");
    fs.writeFileSync(path.join(OUT, "result.html"), finalHtml || "", "utf8");
    log(`result.html len=${(finalHtml || "").length}`);
    if (process.env.KEEP_OPEN === "1") {
      log("KEEP_OPEN=1：浏览器保持打开，关闭该窗口后本进程自动退出");
      for (let i = 0; i < 3600; i++) {
        try { await fetch(`http://127.0.0.1:${PORT}/json/version`); } catch (e) { break; }
        await sleep(2000);
      }
    }
  } catch (e) {
    log("FATAL " + e.message);
  } finally {
    try { proc.kill(); } catch (e) {}
  }
})();
