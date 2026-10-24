# Design notes

Why this plugin looks the way it does, and what I rejected on the way here.

If you only read one section, make it [Evaluating candidates](#evaluating-candidates-the-part-that-matters).

---

## The problem

An agent is asked to turn a PDF report into a structured workbook with charts. Halfway through it discovers it has no PDF table extraction and no charting helper. Three things usually happen:

1. It writes 200 lines of fragile `pdfplumber` glue that sort of works.
2. It tells you the capability is unavailable.
3. It installs something — often silently, often the wrong thing.

Meanwhile a store full of exactly-fitting skills exists. The gap is not capability, it is **discovery plus consent**: nothing connects "this task needs X" to "X is one install away" at a moment when a human can say yes.

### Why not a skill

A skill is Markdown that the model loads when it decides it is relevant. It cannot:

- observe every user turn,
- call an installer,
- inject a message into a run,
- hold state across turns.

So a skill can only *describe* a workflow. This problem needs *execution* — an extension.

### Why not auto-install

The obvious product answer is "just install it automatically". That is unacceptable, and not because of implementation risk: an installed skill is a `SKILL.md` the agent is instructed to follow, plus optional scripts. Installing one is an act of trust. Doing it silently on a heuristic means the machine can be steered by a stranger's text without the operator ever seeing it.

An earlier version of this plugin did exactly that, gated by a relevance threshold and a deny list. It worked, it felt good in a demo, and I removed it. The moment it installs something the user did not want, the time saved is irrelevant.

So: **no silent-install mode exists in the code.** Not disabled by default — absent. `auto` is rejected at the config loader and migrated to `confirm`.

### Why plan time

Prompt-time matching has a fundamental flaw: by the time you match on the user's sentence, the agent has already chosen an approach.

Plan time is different:

| | Prompt time | Plan time |
|---|---|---|
| Work is enumerated | no | yes, as steps |
| Capabilities are concrete | "do something with this PDF" | "extract tables", "chart values" |
| Nothing executed yet | usually not | yes |
| One dialog can cover everything | no | yes |

If the model writes a plan, it has just told you exactly what it intends to do. That is the highest-quality signal available, and it is free.

Hence three triggers, all feeding the same pipeline:

1. `Plan:` / `计划：` in the assistant message (`turn_end`)
2. structured steps passed to a plan/goal tool (`tool_result`)
3. a plan file written to disk (`tool_result`)

Trigger 2 is deliberately generic — the extractor walks the tool arguments looking for arrays of strings or objects with a `title`/`text`/`task` field, plus numbered steps inside long free text. It is not an allowlist of tool names, because that list would rot. `planToolPattern` (default `plan|goal|task|todo`) is configurable; read-only `get_*` tools are skipped.

---

## Evaluating candidates: the part that matters

Once you have steps, you need to answer: *which store skill satisfies this step, and is it worth installing?*

The tempting answer is "ask the model". It is wrong, for three reasons:

1. **Cost and latency scale with candidates.** A five-step plan against a ten-candidate shortlist is fifty judgements per plan.
2. **It is not reproducible.** Same plan, two runs, two answers — and no way to explain either.
3. **It ships data off the machine.** Skill metadata, plus whatever context you include, leaves the host on every plan.

What comparable projects actually do:

| Project | Evaluation | LLM in the loop? |
|---|---|---|
| `pi-context-decisions` | a decision/classifier model scores unadvertised skills; up to 12 added per turn | yes — a dedicated classifier, opt-in, with explicit cost/latency warnings |
| `pi-skill-shiori` | policy-based retrieval: only skills explicitly marked triggerable become candidates | no |
| `pi-skill-router` | per-collection routing terms, matched against the prompt | no |
| `@spences10/pi-skills` | no evaluation; preview → explicit confirmation → install | no |
| `pi-agent-skills` | fixed rules gate script execution | no |

Note the pattern: **deterministic gate, human confirmation.** Nobody does per-candidate prompting. The one project that uses a model uses it for *filtering what to advertise out of an existing library*, which is a different question from *should this be downloaded and installed*.

So this plugin splits the question by what each layer is actually good at:

| Layer | Question | Who | Why |
|---|---|---|---|
| 1 | What capability does this step need? | model (it wrote the step) + a deterministic EN/CN lexicon | semantics — lexical matching fails on "turn this into something the board can read" |
| 2 | Which store skill satisfies it, and how well? | code, quantified | mechanical matching; arithmetic is reproducible and auditable |
| 3 | Install it? | you | it changes your machine |

### The scoring rule

```
score(skill, step) = Σ_kw  ( 3 if kw ∈ slug
                           + 2 if kw ∈ name
                           + 1 if kw ∈ description )
```

- The step's tokens come from the **canonical capability phrase**, not the step text.
- Ranking is `score desc`, then `downloads desc`, then a capped step-text bonus.
- A candidate is only eligible if at least one token hit the slug or the name — description-only matches are noise.
- The number in the confirmation dialog is this score, so the user can audit the recommendation.

### Three bugs this rule surfaced

These are worth recording because each one is a class of error that a model-based evaluator would have hidden behind plausible prose:

**1. A number beat the intent.** Step: `生成逐年 Scope 1/2/3 对比柱状图`. The token `scope` matched a skill called `crypto-scope` — slug hit (+3), name hit (+2) — scoring it above every charting skill. Fix: eligibility is computed from the distilled capability phrase only; the step's own wording is a tie-breaker.

**2. Domain words masqueraded as capabilities.** Step: `读取 ESG 报告 PDF 并提取排放数据表格` selected an ESG *domain* skill instead of a PDF extraction skill. Fix: the lexicon tags `esg`, `financial`, `academic` as `domain`, and `capabilityQuery` prefers capabilities; domain phrases are only used when no capability was recognised at all.

**3. An off-by-one in the score silently dropped matches.** The scoring used `if slug … if name … else if description`, so a token that hit *both* slug and name scored 5 instead of 6 — right at the default threshold of 6. Every single-keyword query (`pdf`) was quietly discarded. Found by printing the score of one known-good entry, not by reading the code.

The general lesson: **a scoring rule you cannot print is a scoring rule you cannot debug.** That is the strongest argument for keeping this layer in code.

### What I did not do

- **Embeddings / semantic similarity.** Would help with synonyms, but needs a model at build time, a vector store, and still does not answer "is this skill trustworthy". Cost is not justified for a first version.
- **An LLM tie-breaker for ambiguous cases.** Tempting as a hybrid (deterministic for recall, model for precision). Deferred: it reintroduces the three problems above for a minority of cases. If added later it should be opt-in and bounded, exactly like `pi-context-decisions`.
- **A curated allowlist of trusted publishers.** Would make the store feel safer, but is a product decision that ages badly and lives outside this repo.

---

## Safety ladder

Installing is the only irreversible action here, so it gets the most machinery:

1. **Deny list** — slug/name/description matched against `denyPatterns` before anything is downloaded.
2. **Stage** — the store installs into `~/.pi/agent/skill-autopilot/staging/<id>/`, never into the live skills directory.
3. **Scan** — `SKILL.md` and bundled scripts are read (≤40 files, ≤200 KB each) and matched against 19 rules across five levels:
   - **critical** — pipe-to-shell, base64-exec, reverse shell, `rm -rf ~`, disk overwrite, credential file reads, env+network exfiltration. **Auto-rollback**, no dialog, because there is no reason to ask.
   - **high** — shell exec, dynamic eval, `chmod 777`, `sudo`, prompt-injection phrasing ("ignore previous instructions", "do not tell the user"). **Second confirmation** listing the offending lines; discarded if declined or if no dialog is available.
   - **medium / low** — network calls, env reads, global installs, file writes, telemetry. Recorded and surfaced in the hand-off note.
4. **Promote** — only then is the directory moved into the skills directory.
5. **Budget** — per-session and per-day caps, enforced for every path including the batch pipeline.
6. **Log** — every detection, proposal, decline, scan result, install and failure, with the rule ids.

Multi-line rules run against the whole file, not line by line — the first version missed `os.environ` followed by `requests.post` three lines later.

**What the scan is not:** a sandbox. It matches text, so obfuscation defeats it. It exists to make the common cases visible and to stop the obviously destructive ones. `SECURITY.md` says this plainly rather than implying a guarantee.

---

## Known limits

- **The lexicon is finite.** A step whose capability is not recognised falls back to raw text with a higher threshold, which trades recall for precision.
- **Lexical relevance.** A skill described in different words than the step will be missed even if it is the right one.
- **Store search is noisy.** SkillHub's API degrades badly on long queries, so queries are split into short terms, searched in parallel, and validated by substring overlap. Long natural-language queries return popular-but-unrelated skills.
- **One store.** The `SkillStore` interface exists and the registry is real, but only SkillHub is implemented. Adding a second registry means implementing four methods.
- **Install latency.** 10–20 s per skill (download + extract). A four-skill plan takes about a minute, which is why it runs behind an explicit confirmation and a progress indicator rather than speculatively.

## Open questions

- Should a plan with **zero** candidates still tell the model "no skill exists for this"? Currently it stays silent, which risks the model not knowing a capability was checked.
- Should declined skills be remembered across sessions, or is per-session the right scope? Re-asking later is annoying; never asking again is wrong.
- Is there a useful middle for **medium** findings — a compact inline warning instead of a note buried in the hand-off?
- When a step needs two capabilities (PDF *and* Excel), the first-mentioned one wins. Usually right, occasionally not. A per-step two-skill allowance would cover it at the cost of more installs.
