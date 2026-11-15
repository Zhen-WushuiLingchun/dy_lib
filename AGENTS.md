# AGENTS.md

本文件面向在本仓库中工作的 AI Agent。

## 项目是什么

南开大学《大学语文》在线测试（`dy.nankai.edu.cn/Exam/ExamPaper.aspx?EPID=8`）的题库与答案仓库。
核心资产是 `data/bank.json`：题干 → 答案文本。考试每次**随机抽 40 题**且**打乱选项顺序**。

## 三条铁律

1. **选项顺序每次不同**：绝不能用题库里的 `answer` 字母直接选；必须用 `answer_text` 与当前选项文本匹配（`lib_match.js` 的 `pickOption`）。
2. **cookie 与 runs/ 绝不入库**：`EXAM_COOKIE` 只能来自环境变量；`runs/`、`.env`、`*.cookie` 已在 `.gitignore`。
3. **答案以考试结果页为准**：题库只是缓存；交卷结果页的"参考答案"才是权威，冲突时以它更新题库并记录到 `data/conflicts_exam.md`。

## 快速命令

```bash
# 查询（不需要 cookie）
node scripts/answer_paper.js examples/questions.sample.json

# 完整一轮（需要 cookie）。浏览器常驻，每条命令都是短命进程，断了随时重连不丢试卷
export EXAM_COOKIE="ASP.NET_SessionId 的值"
node scripts/examctl.js chrome            # 启动常驻有头 Chrome（调试端口 9611），只需一次
node scripts/examctl.js open  run1        # 打开考试页（未开考则停在“开始考试”页）
node scripts/examctl.js start run1        # 开考 -> questions.json + 题库匹配 -> answers.json / unmatched.json
node scripts/examctl.js list  run1        # 看需要补答的题（含题库弱匹配参考）
node scripts/examctl.js apply run1 '{"12":"34567"}'   # 补答：键=题目 idx，值=option.id
node scripts/examctl.js fill  run1        # 填进页面（不提交），可反复执行
node scripts/examctl.js submit run1       # 交卷 -> result.html -> parsed.json -> score.json
node scripts/examctl.js merge run1        # 合并进 data/bank.json + bank.csv，冲突写 data/conflicts_exam.md
node scripts/examctl.js status            # 随时查看当前标签页状态
node scripts/examctl.js close             # 关闭常驻浏览器
```

`submit` 前会打印页面勾选数量，`fill` 输出 `{ok, miss, filled}`，务必确认 `miss` 为空、`filled` 等于题数再交卷。

`examctl.js` 环境变量：`EXAM_COOKIE`（必填）、`CDP_PORT`（默认 9611）、`CHROME_PROFILE`（默认 `~/.dy-lib-chrome`）、`CHROME_PATH`、`EXAM_URL`、`MATCH_MIN`（默认 0.75）、`HOLD_SEC`（交卷前等待秒数，默认 0）。

> 为什么不建议用整条流水线的长进程：进程一旦被杀（工具超时、作业回收）浏览器随之退出，试卷就丢了。常驻浏览器 + 短命令没有这个问题。

旧的单进程脚本（`exam_runner.js` / `prepare_answers.js` / `parse_result.js` / `merge_exam.js`）仍保留可用，但需要自己起 Chrome 且一条链路跑完，调试时才用。

## 回答流程（Agent 视角）

1. `examctl.js start` 输出 `matched` / `unmatched`，结果落在 `runs/<tag>/`。
2. 对 `unmatched.json` 中每题：读题干与四个选项，按文学知识作答；不要留空。
3. `examctl.js apply <tag> '<json>'` 把补答合并进 `answers.ready.json`（键是题目下标，值是 `option.id`，不是字母）。
4. `examctl.js fill` 填进页面，确认 `miss` 为空、`filled` 等于题数。
5. `examctl.js submit` 交卷并自动解析，检查 `score.json` 的 `myCorrect`/`score`。
6. `examctl.js merge` 入库，检查 `updated`/`added`/`conflicts`；有冲突写入 `data/conflicts_exam.md`。
7. 若 `score` 未满分，可再跑一轮；题库会随轮次变大。

## 数据格式

`data/bank.json` 条目：

```json
{
  "qtype": "mcq | inline",
  "no": 1,
  "stem": "题干",
  "options": { "A": "...", "B": "...", "C": "...", "D": "..." },
  "answer": "C",
  "answer_text": "答案文本",
  "dupCount": 2,
  "altAnswers": ["..."],
  "verified": true
}
```

- `inline` 表示原文档是"题干+答案"连写；`answer_text` 可能为 null，匹配时由 `lib_match` 从前缀尾部抽取。
- 手工新增条目时，至少提供 `qtype`、`stem`、`answer_text`；`mcq` 尽量补全 `options` 与 `answer`。

## 脚本职责

| 脚本 | 职责 |
|---|---|
| `scripts/examctl.js` | 分步控制（推荐）：chrome/open/start/list/apply/fill/submit/merge/status/close |
| `scripts/shot.js` | 对常驻浏览器截图并统计勾选数量，交卷前核对 |
| `scripts/lib_match.js` | 归一化、Dice 相似度、题干匹配、选项匹配 |
| `scripts/answer_paper.js` | 单次查询 CLI |
| `scripts/exam_runner.js` | CDP 驱动 Chrome：开考、导出题目、等待答案、交卷、存结果页 |
| `scripts/prepare_answers.js` | 用题库为一次考试生成答案 |
| `scripts/parse_result.js` | 解析结果页（含参考答案）并算分 |
| `scripts/merge_exam.js` | 合并答案、去重、重建 CSV、记录冲突 |
| `scripts/build_bank.js` | 从 `data/raw/大语题库.txt` 重建题库（`--force` 覆盖前会备份） |
| `scripts/repair_bank.js` | 定点修复"题干里拼进选项和下一题"的脏条目并重建 CSV（`--dry` 只报告） |
| `scripts/extract_docx_text.ps1` | docx → txt |

## 故障排查

| 现象 | 处理 |
|---|---|
| 未到开考页 / 跳登录 | cookie 过期：重新登录并更新 `EXAM_COOKIE` |
| 交卷后卡住 | 页面会弹 `alert("成功交卷")`；runner 已自动 accept。若自定义脚本，需处理 `Page.javascriptDialogOpening` |
| 无头模式异常 | 默认有头（`HEADLESS=0`）；必要时设 `HEADLESS=1` |
| 匹配不到 | 题目措辞差异大：先用 `answer_paper.js` 看 `matched` 与 `score`，再决定是否手工补充 |
| 选项匹配错 | 检查是否误用了 `answer` 字母而非 `answer_text` |

## 提交规范

- 只提交 `data/`、`scripts/`、文档；不要提交 `runs/` 与任何凭据。
- 提交信息示例：`add: 新增 12 题答案（run3）`、`fix: 修正《XXX》答案`。
- 修改 `bank.json` 后确保 `bank.csv` 同步（`merge_exam.js` 会自动重建；手工改动请重跑一次合并或自行导出）。
