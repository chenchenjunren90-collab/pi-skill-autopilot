/**
 * Pre-activation risk scan for installed skills.
 *
 * A skill is a `SKILL.md` plus optional scripts that the agent is instructed to
 * follow. Installing one is therefore an act of trust. This module reads the
 * staged files before they are moved into the live skills directory and reports
 * dangerous patterns.
 *
 * This is a smoke detector, not a sandbox: it matches text, so an obfuscated
 * payload can slip through. Its job is to make the common cases visible and to
 * stop the obviously destructive ones.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

export type RiskLevel = "none" | "low" | "medium" | "high" | "critical";

export interface RiskFinding {
	level: RiskLevel;
	/** stable rule id, for logs and tests */
	rule: string;
	/** file relative to the skill directory */
	file: string;
	line?: number;
	/** trimmed offending text */
	excerpt: string;
	/** what the rule is worried about */
	why: string;
}

export interface RiskReport {
	/** worst level across findings */
	level: RiskLevel;
	findings: RiskFinding[];
	filesScanned: number;
	/** true when the scan stopped early because of size/count limits */
	truncated: boolean;
}

const LEVEL_ORDER: Record<RiskLevel, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

interface Rule {
	id: string;
	level: RiskLevel;
	re: RegExp;
	why: string;
	/** which files the rule applies to */
	scope: "any" | "md" | "script";
}

const RULES: Rule[] = [
	// ---------------------------------------------------------------- critical
	{
		id: "pipe-to-shell",
		level: "critical",
		scope: "any",
		re: /\b(curl|wget)\b[^\n|]{0,240}\|\s*(?:sudo\s+)?(?:ba|z|k|da)?sh\b/i,
		why: "downloads and executes a remote script",
	},
	{
		id: "base64-exec",
		level: "critical",
		scope: "any",
		re: /\bbase64\b[^\n]{0,80}(?:-d|--decode|-D)[^\n]{0,120}\|\s*(?:ba)?sh\b/i,
		why: "decodes an obfuscated payload straight into a shell",
	},
	{
		id: "reverse-shell",
		level: "critical",
		scope: "any",
		re: /\b(?:nc|ncat|netcat)\b[^\n]{0,80}\s-e\s+\S+|bash\s+-i\s*>&\s*\/dev\/tcp\//i,
		why: "opens an interactive shell back to a remote host",
	},
	{
		id: "rm-root",
		level: "critical",
		scope: "any",
		re: /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f?|-[a-zA-Z]*f[a-zA-Z]*r)\s+(?:\/|~|\$HOME)(?:\s|$|\/\s*)/,
		why: "recursively deletes a home or root path",
	},
	{
		id: "disk-destroy",
		level: "critical",
		scope: "any",
		re: /\b(?:mkfs(?:\.\w+)?\b|dd\b[^\n]{0,60}\bof=\/dev\/)/i,
		why: "writes directly to a block device",
	},
	{
		id: "credential-read",
		level: "critical",
		scope: "any",
		re: /(?:\.ssh\/id_[a-z0-9]+|\.aws\/credentials|\/etc\/shadow|\.config\/gh\/hosts\.yml|\.npmrc\b)/i,
		why: "reads stored credentials or keys",
	},
	{
		id: "credential-exfil",
		level: "critical",
		scope: "script",
		re: /(?:process\.env|os\.environ|getenv)[\s\S]{0,300}?(?:fetch\s*\(|axios\.|requests\.(?:post|put)|urllib\.request|https?:\/\/)/i,
		why: "combines environment variables with an outbound request",
	},

	// -------------------------------------------------------------------- high
	{
		id: "shell-exec",
		level: "high",
		scope: "script",
		re: /\b(?:os\.system|subprocess\.(?:run|call|Popen|check_output)|child_process\.(?:exec|execSync|spawn|spawnSync)|Invoke-Expression)\b/,
		why: "executes external commands",
	},
	{
		id: "dynamic-eval",
		level: "high",
		scope: "script",
		re: /\beval\s*\(|\bnew\s+Function\s*\(|\bexec\s*\(\s*(?:compile|open)\b/,
		why: "evaluates dynamically constructed code",
	},
	{
		id: "permissions-open",
		level: "high",
		scope: "any",
		re: /\bchmod\s+(?:-R\s+)?(?:777|666)\b/i,
		why: "grants world-writable permissions",
	},
	{
		id: "privilege-escalation",
		level: "high",
		scope: "any",
		re: /(?:^|[\s;&|])sudo\s+\S/i,
		why: "requests elevated privileges",
	},
	{
		id: "prompt-injection",
		level: "high",
		scope: "md",
		re: /(?:ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above)\s+instructions?|disregard\s+(?:the\s+)?(?:system|previous)\s+(?:prompt|instructions?)|do\s+not\s+(?:tell|inform|mention\s+to)\s+the\s+user|without\s+(?:telling|informing)\s+the\s+user|忽略(?:之前|以上|前面|先前)的?(?:所有)?(?:指令|提示|规则)|不要(?:告诉|告知|提醒)用户)/i,
		why: "tries to override the surrounding instructions or hide activity from you",
	},

	// ------------------------------------------------------------------ medium
	{
		id: "network-call",
		level: "medium",
		scope: "script",
		re: /\b(?:fetch\s*\(|axios\b|requests\.(?:get|post|put|delete)|urllib\.request|http\.client|Invoke-WebRequest|Invoke-RestMethod)\b/,
		why: "makes outbound network requests",
	},
	{
		id: "env-access",
		level: "medium",
		scope: "script",
		re: /\b(?:process\.env|os\.environ|os\.getenv|System\.getenv)\b/,
		why: "reads environment variables, which may hold secrets",
	},
	{
		id: "global-install",
		level: "medium",
		scope: "any",
		re: /\bnpm\s+(?:i|install)\s+(?:-g|--global)\b|\bpip3?\s+install\b|\bbrew\s+install\b|\bapt(?:-get)?\s+install\b/i,
		why: "modifies the machine outside the skill directory",
	},

	// --------------------------------------------------------------------- low
	{
		id: "file-write",
		level: "low",
		scope: "script",
		re: /(?:writeFileSync|writeFile\s*\(|open\s*\([^)]*['"][wa]b?['"])/,
		why: "writes files",
	},
	{
		id: "telemetry",
		level: "low",
		scope: "any",
		re: /\b(?:telemetry|analytics|amplitude|mixpanel|posthog|segment\.io)\b/i,
		why: "mentions usage tracking",
	},
];

const SCRIPT_EXT = new Set([
	".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".cmd",
	".py", ".js", ".mjs", ".cjs", ".ts", ".rb", ".pl", ".php",
	".jsx", ".tsx", ".go", ".rs", ".java", ".kt",
]);

const MAX_FILES = 40;
const MAX_FILE_BYTES = 200 * 1024;

function kindOf(file: string): "md" | "script" | "other" {
	const ext = extname(file).toLowerCase();
	if (ext === ".md" || ext === ".markdown" || ext === ".mdx") return "md";
	if (SCRIPT_EXT.has(ext)) return "script";
	return "other";
}

function excerptOf(line: string): string {
	const t = line.replace(/\s+/g, " ").trim();
	return t.length > 140 ? `${t.slice(0, 137)}…` : t;
}

/** 1-based line number for a character offset. */
function lineOf(text: string, index: number): number {
	let n = 1;
	for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") n++;
	return n;
}

/**
 * Rules that need to look across lines (e.g. "environment variables" on one line
 * and an outbound request a few lines later). They run against the whole file
 * instead of line by line.
 */
const MULTILINE_RULES = new Set(["credential-exfil", "pipe-to-shell", "rm-root", "disk-destroy"]);

function collectFiles(dir: string, out: string[], depth = 0) {
	if (depth > 4 || out.length >= MAX_FILES) return;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		if (out.length >= MAX_FILES) return;
		if (name === "node_modules" || name === ".git") continue;
		const full = join(dir, name);
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) collectFiles(full, out, depth + 1);
		else if (st.isFile() && st.size <= MAX_FILE_BYTES) out.push(full);
	}
}

function scanText(text: string, file: string, kind: "md" | "script" | "other", report: RiskReport) {
	const lines = text.split(/\r?\n/);
	for (const rule of RULES) {
		if (rule.scope === "md" && kind !== "md") continue;
		if (rule.scope === "script" && kind !== "script") continue;

		if (MULTILINE_RULES.has(rule.id)) {
			const m = rule.re.exec(text);
			if (!m) continue;
			const at = lineOf(text, m.index);
			report.findings.push({
				level: rule.level,
				rule: rule.id,
				file,
				line: at,
				excerpt: excerptOf(lines[at - 1] ?? m[0]),
				why: rule.why,
			});
			continue;
		}

		// single-line rules: cheaper and gives a precise line number
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line.length < 4) continue;
			if (!rule.re.test(line)) continue;
			report.findings.push({
				level: rule.level,
				rule: rule.id,
				file,
				line: i + 1,
				excerpt: excerptOf(line),
				why: rule.why,
			});
			break; // one hit per rule per file is enough
		}
	}
}

/** Scan a staged skill directory. Never throws. */
export function scanSkillDirectory(dir: string): RiskReport {
	const report: RiskReport = { level: "none", findings: [], filesScanned: 0, truncated: false };
	if (!dir || !existsSync(dir)) return report;

	const files: string[] = [];
	collectFiles(dir, files);
	report.truncated = files.length >= MAX_FILES;

	for (const full of files) {
		let text: string;
		try {
			text = readFileSync(full, "utf8");
		} catch {
			continue;
		}
		// skip obvious binaries
		if (text.includes("\u0000")) continue;
		report.filesScanned++;
		scanText(text, relative(dir, full).replace(/\\/g, "/"), kindOf(full), report);
	}

	for (const f of report.findings) {
		if (LEVEL_ORDER[f.level] > LEVEL_ORDER[report.level]) report.level = f.level;
	}
	// most severe first, then by file/line
	report.findings.sort(
		(a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level] || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0),
	);
	return report;
}

/** Compact text block for a confirmation dialog. */
export function formatFindings(report: RiskReport, limit = 6): string {
	const shown = report.findings.slice(0, limit);
	const lines = shown.map(
		(f) => `[${f.level}] ${f.file}${f.line ? `:${f.line}` : ""}  ${f.rule}\n    ${f.excerpt}\n    → ${f.why}`,
	);
	if (report.findings.length > shown.length) lines.push(`…另有 ${report.findings.length - shown.length} 条`);
	return lines.join("\n");
}

export function describeLevel(level: RiskLevel): string {
	switch (level) {
		case "critical":
			return "严重";
		case "high":
			return "高";
		case "medium":
			return "中";
		case "low":
			return "低";
		default:
			return "无";
	}
}
