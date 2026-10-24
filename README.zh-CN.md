# pi-skill-autopilot

**给 [pi](https://pi.dev) 的计划感知技能供给插件。**

当 agent 写出计划或创建目标后，本插件会逐个步骤预测需要什么能力，在 [SkillHub](https://skillhub.cn) 商店里给每个步骤量化打分，一次性把所有候选列给你确认，装好之后把每个步骤对应的 `SKILL.md` 绝对路径交给 agent，让它**在同一轮**继续执行计划。

![演示](assets/demo.zh-CN.gif)

<sub>这张 GIF 是 [`tools/render-demo.py`](tools/render-demo.py) 生成的脚本化渲染，不是录屏。英文版：[`assets/demo.gif`](assets/demo.gif)。</sub>

```
你：把这个 ESG 报告的 PDF 提取成结构化数据，做图表并输出 Word 汇总
Agent：写出计划 …

Plan:
1. 读取 PDF 并提取排放数据表格
2. 整理成 Excel 工作簿并做透视表
3. 生成逐年 Scope 1/2/3 对比柱状图
4. 输出 Word 版汇报文档

        ↓  一次批量确认

  步骤 1 → pdf-image-text-extractor v1.0.13（相关度 6）
  步骤 2 → excel-spreadsheet-cellcog v1.0.14（相关度 12）
  步骤 3 → aihive-en-spreadsheet-chart-builder v1.0.0（相关度 8）
  步骤 4 → word-docx v1.0.2（相关度 7）

        ↓  你确认 → 顺序安装

  步骤 1 → …/pdf-image-text-extractor/SKILL.md
  步骤 2 → …/excel-spreadsheet-cellcog/SKILL.md
  …
        ↓  agent 读取这些 SKILL.md 并执行计划
```

## 为什么做这个

Agent 经常遇到"装个技能就能解决"的任务，然后要么放弃，要么凑合一个更差的方案。现有做法各有问题：

- **只做 skill** —— skill 是被动 Markdown，无法观察计划、无法执行安装、无法把结论注入后续轮次
- **静默自动安装** —— 未经同意就从互联网安装第三方代码不可接受
- **只在用户输入时做关键词匹配** —— 等到匹配用户那句话时，agent 已经选定了做法

**计划阶段才是正确时机**：工作被拆解、能力变具体、而且什么都还没执行。

## 触发来源

| 来源 | 示例 | 提取方式 |
|---|---|---|
| 助手消息里的 markdown 计划 | `Plan:` / `计划：` + 编号步骤 | `turn_end` 钩子 |
| 计划/目标类工具的结构化入参 | `set_goal_tasks`、`create_goal`、`todo_write`、`update_plan` | `tool_result` 钩子，通用遍历参数 |
| 计划文件 | `PLAN.md`、`.pi/tasks.json`、`roadmap.md` | 从写入内容解析 |

工具名只要匹配 `plan|goal|task|todo`（可用 `planToolPattern` 改）就会被识别；`get_*` 只读工具会被忽略。

## 每一步做什么

1. **提能力** —— 把步骤归一到规范能力短语（`pdf` / `excel spreadsheet` / `chart data visualization` / `word document`）
2. **检索 + 打分** —— 本地目录（~300 条 showcase + 历史检索命中）量化打分；本地无命中才做一次限时实时检索
3. **去重** —— 多个步骤都要同一技能时，只在最早的步骤算一次
4. **过滤** —— 去掉已安装、命中黑名单、低相关的
5. **一次批量确认** —— 对话框列出 `步骤 N → 技能（相关度 X）`
6. **顺序安装** —— 带状态栏进度
7. **交接** —— 注入 `步骤 N → /绝对路径/SKILL.md`，agent 按步骤读对应文件

### 勾选要装哪些

检测到多个缺口时给你的是勾选框，不是单选：

```
❯ [x] 1. pdf-image-text-extractor v1.0.13   相关度 6
        需求：pdf
        从图片或 PDF 文档中识别并提取文字内容，支持多种图片格式…
  [x] 2. excel-spreadsheet-cellcog v1.0.14  相关度 12
        需求：excel spreadsheet
  [x] 3. aihive-en-spreadsheet-chart-builder v1.0.0  相关度 8
        需求：chart data visualization

↑↓ 移动   space 勾选/取消   a 全选/全不选   enter 安装选中的   esc 跳过
```

- **每行都说明为什么装**：第一行是命中的能力（或计划步骤），第二行是该技能自己的说明。
- **默认全部勾上**——直接 Enter 就是全装；想减掉哪个按 space。
- **一个能力只出一个技能**：「把这个 PDF 转成 Excel 并画图」会出三行（pdf / excel / chart），重复覆盖同一能力的第二个技能不会列出来。
- 没有终端的模式（RPC、`--print`、`--mode json`）退化成一次性「全装或都不装」确认。

## 评估到底用提示词还是量化？

这部分值得说清楚，因为"让模型自己判断要不要装"很诱人但不可靠。

| 层 | 谁做 | 产出 |
|---|---|---|
| 1. 这一步需要什么能力 | **模型**（步骤是它写的）+ 内置中英能力词表归一 | 规范短语 |
| 2. 商店里哪个能满足、可信吗 | **代码量化** | `score = 3×slug命中 + 2×名称命中 + 1×描述命中`，同分按下载量 |
| 3. 装不装 | **你** | 一次批量确认 |

同类项目的实际做法：

| 项目 | 评估方式 | 用 LLM？ |
|---|---|---|
| `pi-context-decisions` | 决策/分类模型打分，每轮最多加 12 个 | ✅ 专用分类模型（需显式配置，有调用成本） |
| `pi-skill-shiori` | 策略检索，只有标记 triggerable 的才算候选 | ❌ 确定性 |
| `pi-skill-router` | 每个技能集合配 routing terms | ❌ 确定性 |
| `@spences10/pi-skills` | 不评估，preview → 人工确认 → 装 | ❌ |
| `pi-agent-skills` | 固定规则审批脚本执行 | ❌ |

**没有一个是"纯提示词让模型逐个判断"**：不可复现、每候选一次调用、会幻觉。共同形态是**确定性闸门 + 人工确认**。本插件补上了缺的一块：把商店匹配量化出来并显示分数。

第 2 层不调模型的原因：每次计划多一次调用（延迟 + 费用）、结果不可复现、还要把技能元数据送出本机。而它本质是机械匹配，算术足够且可审计。

## 安装

```bash
# 直接从 GitHub 装，不需要 npm 账号
pi install git:github.com/chenchenjunren90-collab/pi-skill-autopilot

# 上到 npm 之后
pi install npm:pi-skill-autopilot

# 或从本地目录
pi install /path/to/pi-skill-autopilot
```

重启 pi（或 `/reload`）后执行 `/skill-autopilot status`。

### 依赖

- pi `>= 1.4`，Node `>= 22`
- 安装需要 `skillhub` CLI（检索直接走 HTTP API）：

  ```bash
  curl -fsSL https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/install/install.sh | bash
  ```

  没有 CLI 仍能检测和提示，但无法安装。

## 使用

只有 **一个** 命令 `/skill-autopilot`，子命令：

| 子命令 | 作用 |
|---|---|
| `status` | 模式、阈值、预算、目录大小、已装数量 |
| `on` / `off` | 启用 / 停用 |
| `mode confirm\|suggest\|off` | 改行为 |
| `plan <路径>` | 对计划文件手动跑一遍完整流程 |
| `stores` | 列出已注册的商店及其能否安装 |
| `catalog [refresh]` | 查看 / 刷新本地目录 |
| `detect <文本>` | 对任意文本试跑检测（不安装） |
| `log [n]` | 查看最近决策 |

模型侧工具：`skill_ensure({ query, install?, slug?, namespace? })`，同样会弹确认。

### 模式

| mode | 行为 |
|---|---|
| `confirm`（默认） | 装前询问；同意后本轮继续 |
| `suggest` | 绝不安装，只注入候选 |
| `off` | 停用 |

**没有静默安装模式。** 早期版本的 `auto` 已被有意移除。

## 配置

`~/.pi/agent/skill-autopilot/config.json`，所有字段可选：

```json
{
  "enabled": true,
  "mode": "confirm",
  "minScore": 6,
  "confirmMinScore": 6,
  "planEnabled": true,
  "planMinScore": 6,
  "maxPlanInstalls": 6,
  "planToolPattern": "plan|goal|task|todo",
  "store": "skillhub",
  "scanBeforeInstall": true,
  "blockOnCritical": true,
  "maxInstallsPerSession": 6,
  "maxInstallsPerDay": 15,
  "catalogTtlMs": 604800000,
  "maxCandidatesInNote": 3,
  "skillsDir": "~/.pi/agent/skills",
  "extraSkillDirs": [],
  "denyPatterns": ["wallet", "seed-phrase", "private-key", "keylog", "backdoor"]
}
```

数据文件：

| 文件 | 内容 |
|---|---|
| `catalog.json` | 本地商店目录（showcase + 学习到的检索命中） |
| `state.json` | 当日安装计数、已安装映射 |
| `log.jsonl` | 每次决策：检测、提议、拒绝、安装、失败 |

## 安全阶梯

安装是这里唯一不可逆的动作，所以机制最多。技能会先装进**暂存目录**、扫描通过后才移入你的技能目录。

| 步骤 | 做什么 |
|---|---|
| 1. 黑名单 | 下载**之前**用 `denyPatterns` 匹配 slug/名称/描述 |
| 2. 暂存 | 商店装到 `~/.pi/agent/skill-autopilot/staging/<id>/`，绝不直接进技能目录 |
| 3. 扫描 | 读 `SKILL.md` 与随附脚本（≤40 个文件、每个 ≤200KB），匹配 19 条规则 |
| 4. 落地 | 只有这时才把目录移进去 |
| 5. 预算 | 按会话、按天的上限，所有路径都受约束 |
| 6. 日志 | 检测、提议、拒绝、扫描结果、安装、失败，含规则 id |

扫描等级：

| 等级 | 例子 | 行为 |
|---|---|---|
| **critical** | 管道执行远程脚本、base64 执行、反弹 shell、`rm -rf ~`、写裸设备、读凭据、环境变量+外发请求 | **自动回滚**，不弹窗 |
| **high** | shell 执行、动态 `eval`、`chmod 777`、`sudo`、提示词注入话术（"忽略之前的指令"、"不要告诉用户"） | **二次确认**并列出命中行；拒绝或无 UI 时丢弃 |
| **medium / low** | 网络请求、读环境变量、全局安装、写文件、埋点 | 记录并在交接说明里体现 |

其他保证：

- **绝不静默安装**：计划流水线、单轮检测、`skill_ensure` 三条路径都必须人工确认
- **拒绝会记住**：本会话内不再追问同一技能
- **无 UI 不安装**：`--print` / `--mode json` 下只降级为提示
- **失败不阻塞**：检索超时、扫描失败、安装失败都只降级为提示，任务照常继续

扫描是烟雾报警器，不是沙箱——它做不到什么写在 [SECURITY.md](SECURITY.md)。

## 已知限制

- 能力词表是有限的；无法识别的步骤退化成原文匹配（门槛更高，召回更低）
- 相关性是词面的，措辞完全不同的同义技能会漏
- SkillHub 检索接口对长查询很噪，因此拆成短词并做校验
- 单个技能安装约 10–20 秒（下载 + 解压）
- 目前只接 SkillHub，未接其他 registry

## 开发

```bash
npm install
npm run typecheck
```

```
extensions/skill-autopilot/
├── index.ts     # 钩子、工具、命令、安装策略
├── matcher.ts   # 能力词表、打分、已装扫描
├── planner.ts   # 计划提取（markdown / 工具入参 / 文件）
├── risk.ts      # 暂存技能的装前扫描
└── store.ts     # 商店接口与注册表
```

`matcher.ts`、`planner.ts`、`risk.ts` 不 import pi，可独立测试。

延伸阅读：[设计笔记](docs/design-notes.zh-CN.md)——为什么选计划时刻、为什么评估用代码不用模型、否掉了哪些方案。

## License

MIT
