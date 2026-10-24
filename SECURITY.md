# Security Policy

## What this extension can do

`pi-skill-autopilot` installs third-party skills from the [SkillHub](https://skillhub.cn) store into your pi skills directory. An installed skill is a `SKILL.md` file, optionally with scripts, that the agent is instructed to follow. A malicious skill can therefore influence the agent to run commands, read files, or send data — this is inherent to the Agent Skills model, not specific to this extension.

## Built-in mitigations

| Control | Behaviour |
|---|---|
| Explicit confirmation | Every install path (plan pipeline, detection, `skill_ensure`) requires an interactive confirmation. There is no silent-install mode. |
| Staged install | Skills are installed into a staging directory first, never directly into the skills directory. |
| Pre-activation scan | `SKILL.md` and bundled scripts are scanned for dangerous patterns before the skill is moved into place. Critical findings abort the install. |
| Second confirmation | High-risk findings trigger a separate confirmation that lists the offending lines. |
| Deny list | Slugs, names and descriptions matching `denyPatterns` are refused before download. |
| Budget | Per-session and per-day install caps. |
| Audit log | Every detection, proposal, decline, install, scan result and failure is appended to `~/.pi/agent/skill-autopilot/log.jsonl`. |
| Fail closed | When no dialog is available (print/JSON mode) nothing is installed. |

## What the scan does not do

The scan is a heuristic blocklist over text. It does not sandbox skills, does not evaluate intent, and can be bypassed by an obfuscated payload. Treat it as a smoke detector, not a guarantee. Review the `SKILL.md` of anything you approve.

## Reporting a vulnerability

Please **do not** open a public issue for:

- a bypass of the confirmation step,
- a way to install without an interactive prompt,
- a scan evasion that results in code execution,
- path traversal in the staging/move step,
- or anything that leaks local data.

Report privately via GitHub Security Advisories:
`https://github.com/chenchenjunren90-collab/pi-skill-autopilot/security/advisories/new`

Include the version, the skill involved (if public), and the smallest reproduction you can.

## Scope

In scope: this extension's own code and defaults.

Out of scope: the content or behaviour of third-party skills; the SkillHub service itself; vulnerabilities in pi itself (report those upstream).
