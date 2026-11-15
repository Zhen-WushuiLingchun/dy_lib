#!/usr/bin/env node
// 一条命令取 dy.nankai.edu.cn 的登录 cookie（ASP.NET_SessionId）
//
// 用法（推荐）：
//   node scripts/get_cookie.js
//       -> 自动用独立 profile 打开有头 Chrome（调试端口 9333）
//       -> 你在窗口里登录 dy.nankai.edu.cn
//       -> 登录成功（能用该 session 打开考试页）后自动打印 cookie
//
// 关键点：ASP.NET_SessionId 在未登录时也会下发，所以必须校验「该 session 能打开考试页」，
//        否则会拿到一个未登录的匿名 session（这是最容易踩的坑）。
//
// 选项：
//   --port=9333        调试端口（默认 9333）
//   --profile=DIR      Chrome profile 目录（默认 %TEMP%\dy-lib-chrome-profile，登录状态会保留）
//   --timeout=600      最多等多少秒（默认 600）
//   --value-only       只打印 cookie 的值
//   --json             打印 JSON
//   --no-verify        不校验登录态，拿到 cookie 就返回（不推荐）
//   --attach-only      不启动浏览器，只连已在跑的那个
//
// 依赖：本机 Chrome；Node 22+（内置 WebSocket / fetch）
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const arg = (name, def) => {
  const hit = process.argv.slice(2).find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const v = hit.includes("=") ? hit.split("=").slice(1).join("=") : true;
  return v === true ? def : v;
};
const flag = (name) => process.argv.slice(2).some(a => a === `--${name}`);

const PORT = parseInt(arg("port", process.env.COOKIE_PORT || "9333"), 10);
const PROFILE = arg("profile", process.env.COOKIE_PROFILE || path.join(os.tmpdir(), "dy-lib-chrome-profile"));
const TIMEOUT = parseInt(String(arg("timeout", "600")), 10) * 1000;
const HOST = "dy.nankai.edu.cn";
const LOGIN_URL = "https://dy.nankai.edu.cn/";
const CHECK_URL = "https://dy.nankai.edu.cn/Exam/ExamPaper.aspx?EPID=8";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const say = (s) => process.stdout.write(s + "\n");

class CDP {
  constructor(u) {
    this.ws = new WebSocket(u); this.id = 0; this.p = new Map();
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error("ws error")); });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.p.has(m.id)) {
        const { resolve, reject } = this.p.get(m.id);
        this.p.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    };
  }
  send(m, p = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.p.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); });
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

async function version() {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); return r.ok ? await r.json() : null; }
  catch (e) { return null; }
}

// 未登录时考试页会内嵌 Login.aspx 登录表单；登录成功才是「开始考试」
async function checkSession(value) {
  try {
    const r = await fetch(CHECK_URL, { headers: { Cookie: `ASP.NET_SessionId=${value}` }, redirect: "follow" });
    const t = await r.text();
    if (t.includes("Login.aspx") || /name="?txtPassword/.test(t)) return "login";
    if (t.includes("开始考试")) return "ready";
    if (/提交试卷|交卷|已交卷|查看答案/.test(t)) return "ready";
    return "other";
  } catch (e) { return "error:" + e.message; }
}

(async () => {
  let launched = false;
  if (!(await version()) && !flag("attach-only")) {
    if (!fs.existsSync(CHROME)) { say(`找不到 Chrome：${CHROME}（可用 CHROME_PATH 指定）`); process.exit(2); }
    fs.mkdirSync(PROFILE, { recursive: true });
    const proc = spawn(CHROME, [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      "--no-first-run", "--no-default-browser-check",
      "--window-size=1280,900",
      LOGIN_URL,
    ], { stdio: "ignore", detached: true });
    proc.unref();
    launched = true;
    say("已打开有头 Chrome（本工具专用 profile），请在窗口里登录 dy.nankai.edu.cn ……");
    for (let i = 0; i < 40 && !(await version()); i++) await sleep(250);
    if (!(await version())) {
      say("调试端口没起来：同一 profile 的 Chrome 可能已在运行（先全部关掉再试），或端口被占用（--port=9334）。");
      process.exit(3);
    }
  } else {
    say(`复用已在运行、开着调试端口 ${PORT} 的 Chrome`);
  }

  const ver = await version();
  const cdp = new CDP(ver.webSocketDebuggerUrl);
  await cdp.ready;

  const deadline = Date.now() + TIMEOUT;
  let cookie = null, state = "none", lastCheck = "";
  say("等待登录（检测到「能用该 session 打开考试页」才算成功）…");
  let n = 0;
  while (Date.now() < deadline) {
    try {
      const { cookies } = await cdp.send("Storage.getCookies", {});
      const hit = (cookies || []).find(c => c.name === "ASP.NET_SessionId" && String(c.domain || "").includes(HOST));
      if (hit && hit.value) {
        cookie = hit;
        if (flag("no-verify")) { state = "unverified"; break; }
        if (hit.value !== lastCheck) {
          lastCheck = hit.value;
          state = await checkSession(hit.value);
          if (state !== "login") break;
        } else if (state === "login" && n % 10 === 0) {
          say("  还没登录成功，继续等待…");
        }
      }
    } catch (e) {}
    n++;
    await sleep(2000);
  }
  if (!cookie) { say("超时：没拿到 ASP.NET_SessionId。"); cdp.close(); process.exit(5); }
  if (state === "login") { say("超时：cookie 拿到了，但这个 session 还是未登录状态（多半没有真正登录成功）。"); cdp.close(); process.exit(6); }

  const value = cookie.value;
  const ok = state === "ready" || (state === "unverified" && flag("value-only"));
  if (flag("json")) {
    say(JSON.stringify({ name: "ASP.NET_SessionId", value, state, domain: cookie.domain }, null, 1));
  } else if (flag("value-only")) {
    say(value);
  } else {
    say("");
    say("=== 复制下面任意一行给 Agent ===");
    say(`ASP.NET_SessionId=${value}`);
    say("");
    say("# PowerShell 里可直接用：");
    say(`$env:EXAM_COOKIE="${value}"`);
    say("");
    say(
      state === "ready" ? "校验：已登录，能打开考试页，cookie 可用 ✅"
      : state === "unverified" ? "未校验（--no-verify）"
      : `校验：已登录，但考试页是「${state}」状态（可能已开考/已交卷），cookie 本身有效`
    );
    if (launched) say("（这个 Chrome 窗口可以关掉；登录态缓存在专用 profile 里，下次同一条命令可复用）");
  }
  cdp.close();
  process.exit(ok || state === "other" ? 0 : 4);
})().catch(e => { say("FATAL " + e.message); process.exit(1); });
