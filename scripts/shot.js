// 开发辅助：对当前常驻浏览器截图并统计页面状态
// 用法: node scripts/shot.js <tag> [outName]
const fs = require("fs");
const path = require("path");
const { attach } = require("./examctl.js");

(async () => {
  const tag = process.argv[2] || "run3";
  const out = process.argv[3] || "before-submit.png";
  const dir = path.join(__dirname, "..", "runs", tag);
  fs.mkdirSync(dir, { recursive: true });
  const { cdp } = await attach();
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const file = path.join(dir, out);
  fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
  const expr = "JSON.stringify({url:location.href,title:document.title,checked:document.querySelectorAll('input[type=radio]:checked').length,total:document.querySelectorAll('input[type=radio]').length})";
  const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true });
  console.log(JSON.stringify({ file, ...JSON.parse(r.result.value) }, null, 1));
  cdp.close();
})().catch(e => { console.error("ERROR", e.message); process.exit(1); });
