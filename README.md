# 南开大学大学语文题库（dy_lib）

南开大学《大学语文》在线测试（`dy.nankai.edu.cn`）题库与答案，供学习参考与社区共建。
非官方项目；题目与答案会随题库更新变化，一切以考试系统显示的"参考答案"为准。

## 目录结构

```
dy_lib/
├── README.md
├── AGENTS.md                 # 给 AI Agent 的工作说明
├── CONTRIBUTING.md
├── LICENSE
├── .gitignore
├── data/
│   ├── bank.json              # 主题库（844 条，唯一题）
│   ├── bank.csv               # Excel 可读版
│   ├── bank.md                # 人类可读版
│   ├── conflicts.md           # 同题多答案清单
│   ├── conflicts_exam.md      # 题库与考试答案不一致清单
│   ├── answers_for_exam.json  # 已采样考试题的匹配结果
│   └── raw/
│       ├── 大语题库.docx      # 原始题库文件
│       └── 大语题库.txt       # 转写文本
├── examples/
│   └── questions.sample.json  # 查询示例输入
├── scripts/
│   ├── lib_match.js           # 匹配核心库
│   ├── get_cookie.js          # 有头 Chrome 取 cookie（带登录校验）
│   ├── answer_paper.js        # 题库查询 CLI
│   ├── prepare_answers.js     # 为一次考试生成答案
│   ├── merge_ready.js         # 合并命中答案 + 补答 -> answers.ready.json
│   ├── exam_runner.js         # 开考/答题/暂停/交卷 runner（CDP）
│   ├── parse_result.js        # 解析交卷结果页
│   ├── merge_exam.js          # 合并新答案进题库
│   ├── build_bank.js          # 从 raw 文本重建题库
│   └── extract_docx_text.ps1  # docx -> txt
└── runs/                      # 运行时产物（已被 .gitignore 忽略）
```

## 题库格式（`data/bank.json`）

```json
{
  "qtype": "mcq",
  "no": 1,
  "stem": "下面著作里面不属于周作人的是",
  "options": { "A": "《鲁迅小说里的人物》", "B": "《谈虎集》", "C": "《猛虎集》", "D": "《自己的园地》" },
  "answer": "C",
  "answer_text": "《猛虎集》",
  "dupCount": 2,
  "verified": true
}
```

| 字段 | 说明 |
|---|---|
| `qtype` | `mcq`（选择题）或 `inline`（题干内嵌答案条目） |
| `stem` | 题干 |
| `options` | `{A,B,C,D}`，仅 `mcq` |
| `answer` | 答案字母（仅 `mcq`，且只对生成时的选项顺序有效） |
| `answer_text` | **答案文本，推荐使用** |
| `dupCount` | 原始文档中的重复次数 |
| `altAnswers` | 出现过的不同答案（用于排查冲突） |
| `verified` | 是否已由真实考试答案核对 |

> 注意：考试每次会打乱选项顺序，**不要直接使用 `answer` 字母**，应按 `answer_text` 与当前选项文本匹配。

## 查询题库

### 1. 直接看

- Excel：打开 `data/bank.csv`
- 阅读：`data/bank.md`

### 2. 命令行查询（推荐）

```bash
node scripts/answer_paper.js examples/questions.sample.json
```

输入：

```json
[
  { "title": "题干", "options": [ { "id": "1", "text": "A. ..." } ] }
]
```

输出：

```json
[
  {
    "q": "题干",
    "matched": "题库里匹配到的题干",
    "score": 1,
    "answer_text": "答案文本",
    "option_id": "3",
    "option_text": "C. ..."
  }
]
```

不带选项时只返回 `answer_text`。

### 3. jq 查询

```bash
jq '.[] | select(.stem | contains("周作人")) | {stem, answer_text}' data/bank.json
```

## Cookie 说明（重要）

`exam_runner.js` 需要登录后的会话 cookie `ASP.NET_SessionId`。

> 坑：这个 cookie 在**未登录时也会下发**，所以“拿到 cookie”不等于“已登录”。
> 必须确认该 session 能打开考试页（页面出现「开始考试」）才算有效。

### 一条命令取 cookie（推荐）

```bash
node scripts/get_cookie.js
```

1. 脚本会用独立 profile 打开**有头 Chrome**（调试端口 9333）；
2. 在窗口里正常登录 `dy.nankai.edu.cn`；
3. 脚本检测到「该 session 能打开考试页」后，自动打印 cookie 和可复制的 `$env:EXAM_COOKIE="..."`。

登录态缓存在 `%TEMP%\dy-lib-chrome-profile`，下次同一条命令可直接复用。
常用选项：`--port=9334`、`--timeout=900`、`--value-only`（只打印值）、`--json`、`--attach-only`。

### 手动取

1. 浏览器登录 `https://dy.nankai.edu.cn`
2. 打开 DevTools → Application → Cookies → `https://dy.nankai.edu.cn`
3. 复制 `ASP.NET_SessionId` 的值
4. 通过环境变量传入（**不要写进任何文件**）：

```powershell
# PowerShell
$env:EXAM_COOKIE = "你的 ASP.NET_SessionId"
node scripts/exam_runner.js run1
```

```bash
# bash
export EXAM_COOKIE="你的 ASP.NET_SessionId"
node scripts/exam_runner.js run1
```

`runs/`、`.env`、`*.cookie` 已在 `.gitignore` 中，请勿提交任何 cookie。

## 完整使用流程（人或 Agent）

```bash
# 0) 依赖：Node 22+、本机 Chrome
node scripts/get_cookie.js        # 取 cookie（有头 Chrome，登录后自动打印）
export EXAM_COOKIE="..."

# 1) 开考并导出题目（脚本会等待 answers.ready.json）
node scripts/exam_runner.js run1

# 2) 用题库匹配
node scripts/prepare_answers.js run1
#    -> runs/run1/answers.json    已命中（idx -> optionId）
#    -> runs/run1/unmatched.json  未命中，需要补答

# 3) 补答未命中的题后，合并成 ready 文件
#    （Agent 依据 unmatched.json 的选项作答，写入 runs/run1/overrides.json，格式 {"idx":"optionId"}）
node scripts/merge_ready.js run1 runs/run1/overrides.json
#    -> runs/run1/answers.ready.json （runner 看到它就停止等待，先挂起 HOLD_SEC 秒再交卷）

# 4) runner 检测到 ready 后自动交卷，输出 runs/run1/result.html
# 5) 解析结果页（含全部参考答案）并计算得分
node scripts/parse_result.js run1

# 6) 合并进题库（去重、更新、记录冲突）
node scripts/merge_exam.js run1
```

跑完一次后，题库会新增/更新本次 40 题的答案（`verified: true`）。

### Agent 使用要点

- **匹配**：用题干匹配 `bank.json`（`lib_match.js` 已处理标点、括号占位符、Dice 相似度、前缀匹配）。
- **作答**：命中则取 `answer_text`，在当前四个选项里按文本相似度选最接近的一项（`pickOption`）。
- **未命中**：让模型依据题目与选项作答，不要留空。
- **交卷后**：`parse_result.js` 会解析每题"参考答案"，`merge_exam.js` 自动入库，形成正循环。
- **不要**把 cookie、`runs/` 提交到仓库。

## 脚本一览

| 脚本 | 作用 | 用法 |
|---|---|---|
| `get_cookie.js` | 有头 Chrome 登录后取 `ASP.NET_SessionId`（带登录校验） | `node scripts/get_cookie.js` |
| `answer_paper.js` | 题库查询 | `node scripts/answer_paper.js <questions.json>` |
| `prepare_answers.js` | 为一次考试匹配答案 | `node scripts/prepare_answers.js <tag>` |
| `merge_ready.js` | 合并命中答案 + 补答，生成 `answers.ready.json` | `node scripts/merge_ready.js <tag> [overrides.json]` |
| `exam_runner.js` | 开考→导出题目→等待答案→**答完后暂停 `HOLD_SEC` 秒**→交卷→存结果页与截图 | `EXAM_COOKIE=... node scripts/exam_runner.js <tag>` |
| `parse_result.js` | 解析结果页与得分 | `node scripts/parse_result.js <tag>` |
| `merge_exam.js` | 合并答案进题库 | `node scripts/merge_exam.js <tag>` |
| `build_bank.js` | 从 `data/raw` 文本重建题库 | `node scripts/build_bank.js` |
| `extract_docx_text.ps1` | docx 转文本 | `pwsh -File scripts/extract_docx_text.ps1 -Docx data/raw/大语题库.docx -Out data/raw/大语题库.txt` |

`exam_runner.js` 的运行产物都在 `runs/<tag>/`：`questions.json`、`00-before-start.png`、`01-questions.png`、
`02-answered.png`、`03-result.png`、`result.html`、`run.log`，便于人工复核。

环境变量：

| 变量 | 说明 |
|---|---|
| `EXAM_COOKIE` | 必填，`ASP.NET_SessionId` 的值。四种写法都支持（自动提取）：纯值 / `ASP.NET_SessionId=...` / 整行 `Cookie:` 头 / DevTools 的 `Copy as cURL` 整段 |
| `CHROME_PATH` | 可选，Chrome 路径 |
| `HEADLESS` | `1` 无头模式（默认有头，可见浏览器窗口） |
| `HOLD_SEC` | **答完题后**暂停多少秒再交卷（默认 120 = 2 分钟） |
| `KEEP_OPEN` | `1` 交卷后保持浏览器打开，直到手动关闭 |
| `EXAM_URL` | 可选，默认 `.../ExamPaper.aspx?EPID=8` |
| `COOKIE_PORT` / `COOKIE_PROFILE` | `get_cookie.js` 的调试端口 / profile 目录 |

## 给 AI Agent

仓库根部有 AGENTS.md，说明了铁律（选项乱序、cookie 不入库、以结果页为准）、完整命令流程与故障排查。让 Agent 先读它。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。核心流程：

1. 新增题目/答案直接改 `data/bank.json`（按上面的字段格式），或跑一次考试后 `merge_exam.js` 自动入库。
2. `data/bank.csv` 由 `merge_exam.js` 自动重建；如果手工改了 `bank.json`，请同步 `bank.csv`。
3. 提交 PR / 直接 push。

## 推送到 GitHub

仓库地址：<https://github.com/Zhen-WushuiLingchun/dy_lib.git>

首次推送：

```bash
git init
git add .
git commit -m "init: 南开大学大学语文题库"
git branch -M main
git remote add origin https://github.com/Zhen-WushuiLingchun/dy_lib.git
git push -u origin main
```

之后更新：

```bash
git add data/bank.json data/bank.csv
git commit -m "add: 新增 N 题答案"
git push
```

> 推送前请确认 `git status` 中没有 `runs/`、cookie、`.env` 等敏感文件。

## 说明

- 题目与答案来自公开整理与考试结果页，仅供学习参考。
- 若同一题出现多个答案，见 `data/conflicts.md` 与 `data/conflicts_exam.md`。
- 欢迎补充新题、修正错误答案。
