# Contributing

Thanks for taking a look. This extension changes what gets installed on a user's machine, so the bar for safety is higher than for a UI tweak.

## Development

```bash
npm install
npm run typecheck
```

Load your working copy without installing it:

```bash
pi install /absolute/path/to/pi-skill-autopilot
```

Then `/reload` inside pi. A local path package is loaded in place, so edits only need a reload.

To activate the extension manually without touching settings:

```bash
pi -e /absolute/path/to/pi-skill-autopilot
```

## Layout

```
extensions/skill-autopilot/
├── index.ts     # pi integration: hooks, tool, command, install policy
├── matcher.ts   # capability lexicon, scoring, installed-skill scan
└── planner.ts   # plan extraction (markdown / tool args / files)
```

`matcher.ts` and `planner.ts` deliberately import nothing from pi so they can be exercised standalone with `jiti` or a small test harness. Keep it that way — it is what makes the parsing and scoring testable.

## Ground rules

1. **No silent installs.** Any code path that installs must go through `askWhichToInstall` or an explicit `ctx.ui.confirm`. A new trigger must not bypass it.
2. **Degrade, don't block.** Search timeouts, network errors and install failures must become a note, never an exception that breaks the user's task.
3. **Fail closed on ambiguity.** If relevance cannot be established, propose nothing rather than guessing.
4. **Keep the score explainable.** The number shown in the dialog must be reproducible from the scoring rule in the README.
5. **Respect the budget.** `maxInstallsPerSession` / `maxInstallsPerDay` apply to every path.

## Adding a plan source

If a plan/goal plugin ships a tool whose arguments carry steps, prefer teaching the generic extractor in `planner.ts` over adding a special case:

- Arrays of strings, or arrays of objects with `title` / `text` / `task` / `step` / `description` / `summary` / `name` field → handled already.
- New container key names → add them to `STEP_LIST_KEYS`.
- Tool names that should be recognised → they either match `planToolPattern` or the user can extend it via config.

Please do not add tool names to an allowlist in `index.ts`; `planToolPattern` exists so users can configure this.

## Adding capability keywords

`KEYWORD_HINTS` in `matcher.ts` maps a regex to a canonical store query.

- Use `"domain"` for subject matter (`esg`, `financial`, `academic`) — domain hits must not drive install decisions on their own.
- Use the default (capability) for tool-shaped needs (`pdf`, `excel spreadsheet`, `web scraping crawler`).
- Match what a store search would return, not what the user said. Short, common phrases search better.

## Reporting bugs

Include:

- `/skill-autopilot status` output
- the relevant lines from `~/.pi/agent/skill-autopilot/log.jsonl`
- the plan text that triggered it (redact anything private)

## License

By contributing you agree that your contributions are licensed under the MIT license.
