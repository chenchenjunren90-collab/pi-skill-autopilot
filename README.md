# pi-skill-autopilot

**Plan-aware skill provisioning for [pi](https://pi.dev).**

When the agent writes a plan or creates a goal, this extension predicts which skills each step needs, scores what the [SkillHub](https://skillhub.cn) store can satisfy, shows you the whole batch in one confirmation dialog, installs what you approve, and hands the agent the exact `SKILL.md` paths so it can keep going — in the same turn.

![Demo](assets/demo.gif)

<sub>The GIF is a scripted render produced by [`tools/render-demo.py`](tools/render-demo.py) — not a screen recording. Chinese version: [`assets/demo.zh-CN.gif`](assets/demo.zh-CN.gif).</sub>

```
You: "Turn this ESG PDF into a structured dataset with charts and a Word summary."
Agent: writes a plan …

Plan:
1. Extract the emission tables from the PDF
2. Build an Excel workbook with pivot tables
3. Chart Scope 1/2/3 across years
4. Write the Word report

        ↓  one confirmation dialog

  步骤 1 → pdf-image-text-extractor v1.0.13   (relevance 6)
  步骤 2 → excel-spreadsheet-cellcog v1.0.14  (relevance 12)
  步骤 3 → aihive-en-spreadsheet-chart-builder v1.0.0 (relevance 8)
  步骤 4 → word-docx v1.0.2                   (relevance 7)

        ↓  you approve → installs run in order

  step 1 → …/pdf-image-text-extractor/SKILL.md
  step 2 → …/excel-spreadsheet-cellcog/SKILL.md
  …
        ↓  agent reads those SKILL.md files and executes the plan
```

## Why

Agents routinely hit a task that an installable skill would solve, then either give up or improvise a worse solution. The obvious fixes are bad:

- **Skill-only approach** — a skill is passive Markdown; it cannot observe a plan, run an installer, or inject context into another turn.
- **Silent auto-install** — installing arbitrary third-party code from the internet without consent is not acceptable.
- **Keyword match at prompt time only** — by the time you match on the user's sentence, the agent has already chosen an approach.

Plan time is the right moment: the work is enumerated, the capabilities are concrete, and nothing has been executed yet.

## How it works

### Trigger 1 — a plan (primary)

The assistant message contains a `Plan:` / `计划：` header plus numbered steps → the `turn_end` hook takes over.

### Trigger 2 — a plan/goal tool (structured)

A plan or goal tool receives structured steps → the `tool_result` hook extracts them.

| Source | Example tool | Extracted from |
|---|---|---|
| pi-goal-x | `set_goal_tasks` | `tasks[].title` |
| pi-goal-x | `create_goal` | numbered steps inside `objective` |
| todo-style tools | `todo_write`, `update_plan` | `todos[]`, `plan[]` |
| any tool matching `plan\|goal\|task\|todo` | — | arrays of strings/objects with a `title`/`text`/`task` field, walked generically |

### Trigger 3 — a plan file

A write to `PLAN.md`, `.pi/tasks.json`, `roadmap.md`, … → parsed from the written content.

### Then, for every trigger

1. **Capability per step** — each step is reduced to a canonical phrase (`pdf`, `excel spreadsheet`, `chart data visualization`, `word document`) using a built-in EN/CN capability lexicon.
2. **Search + score** — the local catalog (~300 showcase entries, grown by every live search) is scored per candidate; a bounded live search runs only when the local catalog misses.
3. **Dedupe** — a skill needed by several steps is planned once, at the earliest step.
4. **Filter** — drop already-installed skills, deny-listed skills, and low-relevance matches.
5. **One batch confirmation** — the dialog lists `step N → skill (relevance X)` for every proposal.
6. **Install in order** — sequential with a status-bar progress indicator.
7. **Hand off** — a `custom_message` lists `step N → /abs/path/SKILL.md` so the agent reads the right file for the right step.

### Choosing what to install

When more than one gap is detected you get a checkbox list, not a single-choice prompt:

```
❯ [x] 1. pdf-image-text-extractor v1.0.13   相关度 6
        需求：pdf
        从图片或 PDF 文档中识别并提取文字内容，支持多种图片格式…
  [x] 2. excel-spreadsheet-cellcog v1.0.14  相关度 12
        需求：excel spreadsheet
  [x] 3. aihive-en-spreadsheet-chart-builder v1.0.0  相关度 8
        需求：chart data visualization

↑↓ move   space toggle   a all/none   enter install selected   esc skip
```

- **Every row says why.** The first line under each skill is the capability that matched (or the plan step); the second is the store's own description.
- **All boxes start ticked** — press Enter to install everything, Space to drop the ones you do not want.
- **One skill per detected capability.** "Convert this PDF to Excel and chart it" yields three rows (pdf / excel / chart), and a second skill that only duplicates an already-covered capability is not offered.
- In modes without a terminal (RPC, `--print`, `--mode json`) the list degrades to a single all-or-nothing confirmation.

## How candidates are evaluated

This is the part worth being explicit about, because "let the model decide whether to install" is tempting and wrong.

| Layer | Who does it | Output |
|---|---|---|
| 1. Which capability does this step need? | **Model** (it wrote the step) + a deterministic EN/CN capability lexicon | canonical phrase |
| 2. Which store skill satisfies it, and is it any good? | **Quantified, in code** | `score = 3×slug hit + 2×name hit + 1×description hit`, tie-broken by downloads |
| 3. Install or not? | **You** | one batch confirm |

How comparable projects do it:

| Project | Evaluation | Uses an LLM? |
|---|---|---|
| `pi-context-decisions` | decision/classifier model scores unadvertised skills, ≤12 added per turn | ✅ dedicated classifier (opt-in, costs a call) |
| `pi-skill-shiori` | policy-based retrieval; only explicitly triggerable skills become candidates | ❌ deterministic |
| `pi-skill-router` | per-collection routing terms | ❌ deterministic |
| `@spences10/pi-skills` | no evaluation; preview → explicit confirmation → install | ❌ |
| `pi-agent-skills` | fixed rules gate script execution | ❌ |

No one does "pure prompt: ask the model if it wants each skill" — it is non-reproducible, costs one call per candidate, and hallucinates. The common shape is a **deterministic gate plus a human confirmation**. This extension adds the missing piece: quantifying the store match and showing the number.

**Why the score is code and not a model call:** a per-plan model call adds latency and cost, is not reproducible, and ships skill metadata off the machine. Layer 2 is mechanical matching — arithmetic is enough, and you can audit it.

## Install

```bash
# straight from GitHub — no npm account needed
pi install git:github.com/chenchenjunren90-collab/pi-skill-autopilot

# once it is on npm
pi install npm:pi-skill-autopilot

# or from a local checkout
pi install /path/to/pi-skill-autopilot
```

Restart pi (or run `/reload`), then:

```
/skill-autopilot status
```

### Requirements

- pi `>= 1.4`
- Node `>= 22`
- The `skillhub` CLI for installs (search uses the HTTP API directly). Install it with:

  ```bash
  curl -fsSL https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/install/install.sh | bash
  ```

  Without the CLI the extension still detects and proposes, but cannot install.

## Usage

### Slash command

`/skill-autopilot` is the only command. Subcommands:

| Subcommand | Purpose |
|---|---|
| `status` | mode, thresholds, budget, catalog size, installed count |
| `on` / `off` | enable / disable |
| `mode confirm\|suggest\|off` | change behaviour |
| `plan <path>` | run the whole pipeline against a plan file, manually |
| `stores` | list registered stores and whether they can install |
| `catalog [refresh]` | inspect / refresh the local store catalog |
| `detect <text>` | dry-run detection on arbitrary text (no install) |
| `log [n]` | show the last decisions |

### Model-facing tool

`skill_ensure({ query, install?, slug?, namespace? })` — the agent can ask for a capability directly. It searches, ranks, **asks you to confirm**, installs, and returns the `SKILL.md` path.

### Modes

| mode | Behaviour |
|---|---|
| `confirm` (default) | asks before installing; after you approve, the run continues |
| `suggest` | never installs, only injects the candidate list |
| `off` | disabled |

There is **no silent-install mode**. `auto` existed in early versions and was removed deliberately.

## Configuration

`~/.pi/agent/skill-autopilot/config.json` — every field is optional.

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

| Field | Meaning |
|---|---|
| `minScore` / `confirmMinScore` | relevance needed to become a candidate / to prompt |
| `planMinScore` | relevance needed per plan step |
| `maxPlanInstalls` | cap per plan |
| `planToolPattern` | which tool names count as plan/goal tools (regex source) |
| `store` | active store id (see `stores`) |
| `scanBeforeInstall` | scan staged files before promoting (default on) |
| `blockOnCritical` | roll back automatically on critical findings instead of asking |
| `maxInstallsPerSession` / `maxInstallsPerDay` | hard budget |
| `catalogTtlMs` | how often the local catalog refreshes (background) |
| `skillsDir` | install target (must be a directory pi discovers) |
| `denyPatterns` | matched against slug/name/description; blocked skills are never installed |

Data lives next to it:

| File | Contents |
|---|---|
| `catalog.json` | local store catalog (showcase + learned search hits) |
| `state.json` | daily install counter, installed map |
| `log.jsonl` | every decision: detected, proposed, declined, installed, failed |

## Safety ladder

Installing is the only irreversible action here, so it gets the most machinery. A skill is installed into a **staging directory**, scanned, and only then moved into your skills directory.

| Step | What happens |
|---|---|
| 1. Deny list | Slug/name/description matched against `denyPatterns` **before** anything is downloaded |
| 2. Stage | The store installs into `~/.pi/agent/skill-autopilot/staging/<id>/`, never the live skills dir |
| 3. Scan | `SKILL.md` + bundled scripts (≤40 files, ≤200 KB each) matched against 19 rules |
| 4. Promote | Only then is the directory moved into place |
| 5. Budget | Per-session and per-day caps, enforced for every path |
| 6. Log | Detection, proposal, decline, scan result, install, failure — with rule ids |

Scan levels:

| Level | Examples | Behaviour |
|---|---|---|
| **critical** | pipe-to-shell, base64 exec, reverse shell, `rm -rf ~`, disk overwrite, credential reads, env+network exfiltration | **auto-rollback**, no dialog |
| **high** | shell exec, dynamic `eval`, `chmod 777`, `sudo`, prompt-injection phrasing ("ignore previous instructions", "do not tell the user") | **second confirmation** listing the offending lines; discarded if declined or no dialog |
| **medium / low** | network calls, env reads, global installs, file writes, telemetry | recorded and shown in the hand-off note |

Other guarantees:

- **No silent installs.** Every path — plan pipeline, ad-hoc detection, `skill_ensure` — requires confirmation.
- **Declines stick.** A skill you decline is not offered again in that session.
- **No UI, no install.** In `--print` / `--mode json` runs the extension degrades to suggestions.
- **Non-blocking failure.** Search timeouts, scan failures and install failures degrade to a note; the task continues.

The scan is a smoke detector, not a sandbox — see [SECURITY.md](SECURITY.md) for what it does not do.

## Limitations

- The capability lexicon is finite. A step it does not recognise falls back to raw text with a higher score threshold, which reduces recall.
- Relevance is lexical. Semantically related but differently-worded skills can be missed.
- SkillHub's search API returns noisy results for long queries, so queries are split into short terms and validated.
- Installing takes roughly 10–20 s per skill (download + extract).
- The store is SkillHub; it is not wired to other registries yet.

## Development

```bash
npm install
npm run typecheck
```

Layout:

```
extensions/skill-autopilot/
├── index.ts     # hooks, tool, command, install policy
├── matcher.ts   # capability lexicon, scoring, installed-skill scan
├── planner.ts   # plan extraction (markdown / tool args / files)
├── risk.ts      # pre-activation scanning of staged skills
└── store.ts     # store interface + registry
```

`matcher.ts`, `planner.ts` and `risk.ts` have no pi imports, so they can be exercised standalone.

More: [design notes](docs/design-notes.md) — why plan time, why the scoring is code and not a model, what was rejected.

## License

MIT
