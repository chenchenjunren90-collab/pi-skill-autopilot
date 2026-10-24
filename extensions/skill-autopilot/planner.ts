/**
 * Plan parsing helpers for skill-autopilot.
 *
 * Supports several conventions so the plugin works with different plan/goal
 * plugins instead of only one:
 *
 *  1. Markdown plans in the assistant message (pi's own plan-mode convention):
 *       Plan:
 *       1. First step
 *       2. Second step
 *     Also accepts 计划 / 实施步骤 / Steps / ## Plan headers.
 *
 *  2. Structured plans passed to a plan/goal tool (pi-goal-x's
 *     `set_goal_tasks({tasks:[{title}]})`, todo tools, update_plan, …) via
 *     `extractStepsFromToolInput`, which walks the arguments generically.
 *
 *  3. Plan files written to disk (PLAN.md, .pi/tasks.json, …) via
 *     `extractPlanFromFilePath` + `extractStepsFromText`.
 */

import { detectNeeds, tokenize } from "./matcher.ts";

export interface PlanStep {
	/** 1-based step number */
	step: number;
	text: string;
}

const PLAN_HEADER_RE =
	/^(?:plan|execution plan|implementation plan|steps|task list|tasks|计划|实施步骤|执行计划|步骤|任务|任务列表)\s*[:：]?$/i;

const STATUS_WORD_RE =
	/^(done|todo|to-do|pending|in[ _-]?progress|completed?|blocked|skipped|cancell?ed|active|paused|open|closed|new|waiting|failed)$/i;

/** Strip markdown noise that would pollute keyword matching. */
function cleanStep(raw: string): string {
	let t = (raw || "").trim();
	t = t.replace(/\[DONE:\d+\]/gi, "");
	t = t.replace(/\[[ xX]\]/g, "");
	t = t.replace(/^[\s>*\-–—•]+/, "");
	t = t.replace(/\*\*/g, "").replace(/`/g, "");
	t = t.replace(/\s+/g, " ").trim();
	return t;
}

function isStepLike(text: string): boolean {
	// CJK says more with fewer characters
	const minLen = /[\u4e00-\u9fff]/.test(text) ? 5 : 8;
	if (text.length < minLen) return false;
	if (STATUS_WORD_RE.test(text)) return false;
	if (text.startsWith("/") || text.startsWith("```")) return false;
	if (/^https?:\/\//i.test(text)) return false;
	return true;
}

/** Normalize a line enough to test whether it is a bare plan header. */
function isPlanHeader(line: string): boolean {
	let t = line.trim().replace(/^#{1,6}[ \t]*/, "");
	t = t.replace(/^[*_`+\-]+/, "").replace(/[*_`]+$/, "").trim();
	return PLAN_HEADER_RE.test(t);
}

/**
 * Parse numbered (preferred) or bulleted items starting at `start`.
 * A bullet list is only accepted when no numbered list is present.
 */
function parseStepLines(lines: string[], start: number, maxSteps: number): PlanStep[] {
	const steps: PlanStep[] = [];
	let sawNumber = false;
	let started = false;

	for (let i = start; i < lines.length && steps.length < maxSteps; i++) {
		const line = lines[i].trim();
		if (!line) continue;
		if (/^#{1,6}[ \t]+\S/.test(line)) break; // next section heading

		const num = /^(\d{1,3})[.)][ \t]+(.+)$/.exec(line);
		if (num) {
			const body = cleanStep(num[2]);
			if (isStepLike(body)) {
				steps.push({ step: steps.length + 1, text: body });
				sawNumber = true;
				started = true;
			}
			continue;
		}

		const bullet = /^[-*+][ \t]+(.+)$/.exec(line);
		if (bullet) {
			if (sawNumber) continue; // sub-bullets of a numbered step are not steps
			const body = cleanStep(bullet[1]);
			if (isStepLike(body)) {
				steps.push({ step: steps.length + 1, text: body });
				started = true;
			}
			continue;
		}

		// prose after the list starts means the plan section is over
		if (started) break;
	}
	return steps;
}

/**
 * Pull numbered steps out of a message that contains an explicit plan header.
 * Returns [] when there is no header, which keeps arbitrary numbered lists from
 * triggering the pipeline.
 */
export function extractPlanSteps(text: string, maxSteps = 20): PlanStep[] {
	if (!text) return [];
	const lines = text.split(/\r?\n/);
	const headerIdx = lines.findIndex(isPlanHeader);
	if (headerIdx < 0) return [];
	return parseStepLines(lines, headerIdx + 1, maxSteps);
}

/**
 * Pull numbered steps without requiring a header.
 * Used for free text embedded in a plan tool's arguments (e.g. an objective
 * that already lists ordered steps).
 */
export function extractNumberedSteps(text: string, maxSteps = 20): PlanStep[] {
	if (!text) return [];
	const lines = text.split(/\r?\n/);
	const hasNumbered = lines.some((l) => /^\s*\d{1,3}[.)]\s+/.test(l));
	if (!hasNumbered) return [];
	return parseStepLines(lines, 0, maxSteps);
}

/** Read a plan out of a text blob of any supported flavour. */
export function extractStepsFromText(text: string, maxSteps = 20): PlanStep[] {
	const withHeader = extractPlanSteps(text, maxSteps);
	if (withHeader.length) return withHeader;
	return extractNumberedSteps(text, maxSteps);
}

const STEP_LIST_KEYS = new Set([
	"tasks",
	"task",
	"steps",
	"step",
	"plan",
	"plans",
	"todos",
	"todo",
	"items",
	"subtasks",
	"sub_tasks",
	"objectives",
	"milestones",
	"checklist",
]);

const STEP_TEXT_KEYS = ["title", "text", "task", "step", "description", "summary", "name", "label", "content", "goal"];

/**
 * Generic extractor for plan/goal tool arguments.
 *
 * Walks the argument object looking for arrays of strings or arrays of objects
 * with a title/text/task/… field, then falls back to numbered steps embedded in
 * long free-text fields (such as a goal's objective).
 */
export function extractStepsFromToolInput(input: unknown, maxSteps = 20): PlanStep[] {
	const texts: string[] = [];
	const seen = new Set<string>();

	const push = (raw: string) => {
		const c = cleanStep(raw);
		if (!isStepLike(c)) return;
		if (texts.length >= maxSteps) return;
		const k = c.toLowerCase();
		if (seen.has(k)) return;
		seen.add(k);
		texts.push(c);
	};

	const visit = (v: unknown, depth: number) => {
		if (depth > 4 || texts.length >= maxSteps) return;
		if (Array.isArray(v)) {
			// only treat arrays of objects/strings as step lists when they look like one
			for (const item of v) {
				if (typeof item === "string") push(item);
				else if (item && typeof item === "object") {
					const obj = item as Record<string, unknown>;
					const hit = STEP_TEXT_KEYS.map((k) => obj[k]).find((x) => typeof x === "string") as string | undefined;
					if (hit) push(hit);
					else visit(obj, depth + 1);
				}
			}
			return;
		}
		if (v && typeof v === "object") {
			const obj = v as Record<string, unknown>;
			// step lists first, so their entries win over incidental strings
			for (const [k, val] of Object.entries(obj)) {
				if (STEP_LIST_KEYS.has(k.toLowerCase())) visit(val, depth + 1);
			}
			for (const [k, val] of Object.entries(obj)) {
				if (STEP_LIST_KEYS.has(k.toLowerCase())) continue;
				if (typeof val === "string") {
					if (val.length > 40) for (const s of extractNumberedSteps(val)) push(s.text);
				} else if (val && typeof val === "object") {
					visit(val, depth + 1);
				}
			}
		}
	};

	visit(input, 0);
	return texts.map((text, i) => ({ step: i + 1, text }));
}

const PLAN_FILE_RE =
	/(^|[\\/])(plan|plans|task|tasks|todo|todos|roadmap|checklist|milestone|milestones)[^\\/]*\.(md|markdown|txt|json|ya?ml)$/i;

/** True when a path looks like a plan/task document. */
export function isPlanFilePath(p: string): boolean {
	return !!p && PLAN_FILE_RE.test(p);
}

/** Stable-ish identity for a plan so the same plan is not asked about twice. */
export function planSignature(steps: PlanStep[]): string {
	return steps
		.map((s) => s.text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ""))
		.filter(Boolean)
		.join("|");
}

/**
 * Turn a plan step into the shortest useful store query.
 * Capabilities win over domain words: for "read the ESG PDF and extract tables"
 * the capability is pdf handling, not "esg". Domain phrases are only used when
 * no capability was recognised at all.
 */
export function capabilityQuery(stepText: string): string {
	const needs = detectNeeds(stepText);
	const caps = needs.filter((n) => n.kind !== "domain" && n.query);
	if (caps.length) return caps[0].query; // detectNeeds returns earliest mention first
	const domains = needs.filter((n) => n.kind === "domain" && n.query);
	if (domains.length) return domains[0].query;
	return stepText.slice(0, 80);
}

/** Tokens used for quantified relevance scoring of one plan step. */
export function stepTokens(stepText: string, query: string): string[] {
	return [...new Set([...tokenize(stepText), ...tokenize(query)])];
}
