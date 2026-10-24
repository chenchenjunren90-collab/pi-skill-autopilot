/**
 * skill-autopilot
 *
 * 在每轮用户输入后，预测本轮/后续工作是否需要某个"尚未安装"的技能，
 * 并从 SkillHub 商店自动安装。
 *
 * 三层机制：
 *   1. 本地预测  — 用 showcase 榜单缓存做关键词/文件类型匹配（毫秒级，零网络）
 *   2. 提示注入  — 高置信度缺口在 agent 启动前注入一条提醒，让模型知道缺什么
 *   3. 主动安装  — mode=auto 时高置信度直接装；否则暴露 skill_ensure 工具按需装
 *
 * 命令：/skill-autopilot [status|on|off|mode <m>|catalog [refresh]|detect <text>|log [n]]
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import {
	appendFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
	deriveSearchTerms,
	detectNeeds,
	hasCanonicalNeed,
	isInstalled,
	normalizeId,
	rankCandidates,
	scanInstalledSkills,
	scoreEntry,
	splitSlug,
	tokenize,
	type CatalogEntry,
	type Candidate,
	type InstalledSkill,
	type NeedSignal,
} from "./matcher.ts";
import { describeLevel, formatFindings, scanSkillDirectory, type RiskReport } from "./risk.ts";
import { listStores, registerStore, resolveStore, type SkillStore } from "./store.ts";
import {
	capabilityQuery,
	extractPlanSteps,
	extractStepsFromText,
	extractStepsFromToolInput,
	isPlanFilePath,
	planSignature,
	stepTokens,
	type PlanStep,
} from "./planner.ts";

/* ------------------------------------------------------------------ paths */

const HOME = homedir();
const DATA_DIR = join(HOME, ".pi", "agent", "skill-autopilot");
const CONFIG_PATH = join(DATA_DIR, "config.json");
const CATALOG_PATH = join(DATA_DIR, "catalog.json");
const STATE_PATH = join(DATA_DIR, "state.json");
const LOG_PATH = join(DATA_DIR, "log.jsonl");

const SKILLHUB_CLI = join(HOME, ".skillhub", "skills_store_cli.py");
const SHOWCASE_SECTIONS = ["hot", "featured", "newest", "recommended", "trending"] as const;
const SHOWCASE_HOST = "https://api.skillhub.cn";

/* ----------------------------------------------------------------- config */

export interface AutopilotConfig {
	enabled: boolean;
	/** off = 停用；suggest = 只提示不装；confirm = 先弹确认，确认并装好后本轮继续执行原任务 */
	mode: "off" | "suggest" | "confirm";
	/** 本地匹配进入候选的最低分 */
	minScore: number;
	/** 弹出确认询问的最低匹配分 */
	confirmMinScore: number;
	/** 规划完成后自动整理计划所需技能（turn_end 钩子） */
	planEnabled: boolean;
	/** 计划阶段每个步骤进入候选的最低分 */
	planMinScore: number;
	/** 单轮计划最多安装几个 */
	maxPlanInstalls: number;
	/** 哪些工具名算作「计划/目标」工具（正则源码，不区分大小写） */
	planToolPattern: string;
	/** 技能商店 id（见 store.ts 注册表） */
	store: string;
	/** 安装前扫描暂存目录里的 SKILL.md 与脚本 */
	scanBeforeInstall: boolean;
	/** 扫描到 critical 级风险时直接回滚，不再询问 */
	blockOnCritical: boolean;
	maxInstallsPerSession: number;
	maxInstallsPerDay: number;
	catalogTtlMs: number;
	maxCandidatesInNote: number;
	/** 安装目标目录（pi 用户级 skills 目录） */
	skillsDir: string;
	/** 额外参与"已安装"扫描的目录 */
	extraSkillDirs: string[];
	/** slug/name/description 命中即拒绝安装 */
	denyPatterns: string[];
}

const DEFAULT_CONFIG: AutopilotConfig = {
	enabled: true,
	mode: "confirm",
	minScore: 6,
	confirmMinScore: 6,
	planEnabled: true,
	planMinScore: 6,
	maxPlanInstalls: 6,
	planToolPattern: "plan|goal|task|todo",
	store: "skillhub",
	scanBeforeInstall: true,
	blockOnCritical: true,
	maxInstallsPerSession: 6,
	maxInstallsPerDay: 15,
	catalogTtlMs: 7 * 24 * 60 * 60 * 1000,
	maxCandidatesInNote: 3,
	skillsDir: join(HOME, ".pi", "agent", "skills"),
	extraSkillDirs: [join(HOME, ".agents", "skills"), join(HOME, ".pi", "agent", "npm", "node_modules")],
	denyPatterns: [
		"wallet", "seed-phrase", "seedphrase", "private-key", "keylog", "backdoor",
		"reverse-shell", "credential-steal", "exfiltrat", "rootkit", "crypto-min",
	],
};

function ensureDir() {
	try {
		mkdirSync(DATA_DIR, { recursive: true });
	} catch {
		/* ignore */
	}
}

function readJson<T>(path: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

function writeJson(path: string, value: unknown) {
	try {
		ensureDir();
		writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
	} catch {
		/* ignore */
	}
}

function loadConfig(): AutopilotConfig {
	const raw = readJson<Record<string, unknown>>(CONFIG_PATH, {});
	const cfg = { ...DEFAULT_CONFIG, ...raw } as AutopilotConfig & Record<string, unknown>;
	// migrate the removed "auto" mode: installs always require confirmation now
	const legacyMode = (cfg as any).mode;
	if (legacyMode === "auto") cfg.mode = "confirm";
	if (cfg.mode !== "off" && cfg.mode !== "suggest" && cfg.mode !== "confirm") cfg.mode = DEFAULT_CONFIG.mode;
	delete (cfg as any).minScoreAuto;
	delete (cfg as any).autoInstallOnDetection;
	if (!cfg.skillsDir) cfg.skillsDir = DEFAULT_CONFIG.skillsDir;
	if (typeof cfg.confirmMinScore !== "number") cfg.confirmMinScore = cfg.minScore ?? DEFAULT_CONFIG.confirmMinScore;
	if (typeof cfg.planMinScore !== "number") cfg.planMinScore = cfg.confirmMinScore;
	return cfg as AutopilotConfig;
}

function saveConfig(cfg: AutopilotConfig) {
	writeJson(CONFIG_PATH, cfg);
}

/* ------------------------------------------------------------------- state */

interface State {
	day: string;
	installsToday: number;
	installed: Record<string, { at: string; dir: string; via: string }>;
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

function loadState(): State {
	const s = readJson<State>(STATE_PATH, { day: today(), installsToday: 0, installed: {} });
	if (s.day !== today()) {
		s.day = today();
		s.installsToday = 0;
	}
	if (!s.installed) s.installed = {};
	return s;
}

let state: State | undefined;
function getState(): State {
	if (!state) state = loadState();
	return state;
}

function log(event: Record<string, unknown>) {
	try {
		ensureDir();
		appendFileSync(LOG_PATH, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", "utf8");
	} catch {
		/* ignore */
	}
}

/* ------------------------------------------------------------------- shell */

interface CliResult {
	ok: boolean;
	code: number;
	stdout: string;
	stderr: string;
	ms: number;
}

function pythonCandidates(): string[] {
	const envP = process.env.SKILLHUB_PYTHON;
	const list = envP ? [envP] : [];
	if (process.platform === "win32") list.push("python", "python3", "py");
	else list.push("python3", "python");
	return [...new Set(list)];
}

function runOnce(bin: string, args: string[], timeoutMs: number): Promise<CliResult> {
	return new Promise((resolve) => {
		const started = Date.now();
		let child;
		try {
			child = spawn(bin, args, {
				env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
				windowsHide: true,
			});
		} catch (err) {
			resolve({ ok: false, code: -1, stdout: "", stderr: String(err), ms: 0 });
			return;
		}
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (code: number, extra?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				ok: code === 0,
				code,
				stdout,
				stderr: stderr + (extra || ""),
				ms: Date.now() - started,
			});
		};
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				/* ignore */
			}
			finish(-2, "\n[skill-autopilot] timed out");
		}, timeoutMs);
		child.stdout?.on("data", (d) => (stdout += String(d)));
		child.stderr?.on("data", (d) => (stderr += String(d)));
		child.on("error", (err) => finish(-1, String(err)));
		child.on("close", (code) => finish(code ?? -1));
	});
}

/** Run the SkillHub CLI, preferring the python entry point. */
async function runCli(args: string[], timeoutMs = 30_000): Promise<CliResult> {
	if (existsSync(SKILLHUB_CLI)) {
		let last: CliResult | undefined;
		for (const py of pythonCandidates()) {
			const r = await runOnce(py, [SKILLHUB_CLI, ...args], timeoutMs);
			if (r.code !== -1) return r;
			last = r;
		}
		if (last) return last;
	}
	// fallback: PATH executable
	return runOnce(process.platform === "win32" ? "skillhub" : "skillhub", args, timeoutMs);
}

function extractJson<T = any>(raw: string): T | undefined {
	const attempts: string[] = [];
	const trimmed = (raw || "").trim();
	if (trimmed.startsWith("{")) attempts.push(trimmed);
	const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().startsWith("{"));
	for (let i = lines.length - 1; i >= 0; i--) attempts.push(lines[i].trim());
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start >= 0 && end > start) attempts.push(trimmed.slice(start, end + 1));
	for (const a of attempts) {
		try {
			return JSON.parse(a) as T;
		} catch {
			/* next */
		}
	}
	return undefined;
}

/* ----------------------------------------------------------------- catalog */

interface CatalogFile {
	updatedAt: number;
	source: string;
	skills: CatalogEntry[];
}

let catalog: CatalogFile | undefined;
let refreshing = false;

function normalizeShowcaseSkill(raw: any): CatalogEntry | undefined {
	const slug = raw?.slug;
	if (!slug) return undefined;
	const ns =
		(typeof raw.namespace === "string" ? raw.namespace : raw.namespace?.handle) ||
		raw.ownerName ||
		(typeof raw.namespace === "object" ? raw.namespace?.displayName : undefined);
	return {
		slug,
		publicSlug: raw.publicSlug || (typeof slug === "string" && slug.includes("/") ? slug.split("/").pop() : slug),
		name: raw.name || "",
		description: raw.description || raw.description_zh || "",
		version: raw.version || "",
		downloads: raw.downloads ?? 0,
		stars: raw.stars ?? 0,
		namespace: ns,
	};
}

function seedFromLocalIndex(): CatalogEntry[] {
	const p = join(HOME, ".skillhub", "skills_index.local.json");
	const idx = readJson<{ skills?: any[] }>(p, {});
	const out: CatalogEntry[] = [];
	for (const s of idx.skills || []) {
		const n = normalizeShowcaseSkill(s);
		if (n) out.push(n);
	}
	return out;
}

async function refreshCatalog(signal?: AbortSignal): Promise<CatalogFile> {
	const merged = new Map<string, CatalogEntry>();
	const store = resolveStore(undefined);
	let label = "local-index";
	if (store) {
		try {
			for (const e of await store.showcase()) merged.set(e.slug, e);
			label = `${store.label} catalog`;
		} catch {
			/* store unavailable: fall through to the local index */
		}
	}
	for (const s of seedFromLocalIndex()) {
		if (!merged.has(s.slug)) merged.set(s.slug, s);
	}
	const file: CatalogFile = {
		updatedAt: Date.now(),
		source: `${label}+local-index`,
		skills: [...merged.values()],
	};
	if (file.skills.length > 0) {
		catalog = file;
		writeJson(CATALOG_PATH, file);
	}
	return file;
}

function loadCatalog(): CatalogFile {
	if (catalog) return catalog;
	const onDisk = readJson<CatalogFile | undefined>(CATALOG_PATH, undefined);
	if (onDisk && Array.isArray(onDisk.skills) && onDisk.skills.length > 0) {
		catalog = onDisk;
		return catalog;
	}
	const seeded: CatalogFile = {
		updatedAt: 0,
		source: "local-index",
		skills: seedFromLocalIndex(),
	};
	catalog = seeded;
	return seeded;
}

function catalogIsStale(file: CatalogFile, cfg: AutopilotConfig): boolean {
	return Date.now() - (file.updatedAt || 0) > cfg.catalogTtlMs;
}

/** Refresh in the background; never blocks a turn. */
function refreshCatalogInBackground() {
	if (refreshing) return;
	refreshing = true;
	void refreshCatalog()
		.then((f) => log({ kind: "catalog-refresh", size: f.skills.length, source: f.source }))
		.catch((e) => log({ kind: "catalog-refresh-error", error: String(e) }))
		.finally(() => {
			refreshing = false;
		});
}

/* --------------------------------------------------------------- installed */

let extraSkillDirsCache: string[] | undefined;

function expandExtraDirs(cfg: AutopilotConfig): string[] {
	if (extraSkillDirsCache) return extraSkillDirsCache;
	const dirs: string[] = [];
	for (const d of cfg.extraSkillDirs) {
		if (!existsSync(d)) continue;
		// a package directory that contains other packages: look one level for */skills
		if (d.includes("node_modules")) {
			try {
				for (const name of readdirSync(d)) {
					if (name.startsWith(".")) continue;
					const pkgDir = join(d, name);
					if (name.startsWith("@")) {
						try {
							for (const sub of readdirSync(pkgDir)) {
								const s = join(pkgDir, sub, "skills");
								if (existsSync(s)) dirs.push(s);
							}
						} catch {
							/* ignore */
						}
					} else {
						const s = join(pkgDir, "skills");
						if (existsSync(s)) dirs.push(s);
					}
				}
			} catch {
				/* ignore */
			}
		} else {
			dirs.push(d);
		}
	}
	extraSkillDirsCache = dirs;
	return dirs;
}

function installedDirs(cfg: AutopilotConfig): string[] {
	const dirs = [cfg.skillsDir, ...expandExtraDirs(cfg)];
	try {
		dirs.push(join(process.cwd(), ".pi", "skills"));
	} catch {
		/* ignore */
	}
	return [...new Set(dirs)];
}

function installedSkills(cfg: AutopilotConfig): InstalledSkill[] {
	return scanInstalledSkills(installedDirs(cfg));
}

/* ------------------------------------------------------------------ policy */

function isDenied(candidate: Candidate, cfg: AutopilotConfig): boolean {
	const hay = `${candidate.publicSlug} ${candidate.entry.name || ""} ${candidate.entry.description || ""}`.toLowerCase();
	return cfg.denyPatterns.some((p) => hay.includes(p.toLowerCase()));
}

function budgetLeft(cfg: AutopilotConfig, sessionInstalls: number): boolean {
	const st = getState();
	return sessionInstalls < cfg.maxInstallsPerSession && st.installsToday < cfg.maxInstallsPerDay;
}

/** Slugs the user already declined in this session — don't nag again. */
const declinedSlugs = new Set<string>();

function usableCandidates(candidates: Candidate[], cfg: AutopilotConfig): Candidate[] {
	return candidates.filter(
		(c) => !isDenied(c, cfg) && !declinedSlugs.has(normalizeId(c.publicSlug)) && !inFlight.has(normalizeId(c.publicSlug)),
	);
}

function describeCandidate(c: Candidate): string {
	const desc = (c.entry.description || "").replace(/\s+/g, " ").slice(0, 70);
	return `${c.publicSlug} v${c.entry.version || "?"}（相关度 ${c.score}）${desc ? ` — ${desc}` : ""}`;
}

/**
 * Ask the user which skill (if any) to install.
 * Returns undefined when the user skips or no dialog is available.
 */
async function askWhichToInstall(
	candidates: Candidate[],
	cfg: AutopilotConfig,
	ctx: ExtensionContext,
	title: string,
): Promise<Candidate | undefined> {
	const usable = usableCandidates(candidates, cfg).slice(0, 3);
	if (!usable.length) return undefined;
	if (!ctx.hasUI) {
		// no dialog available (print/json mode): never install silently
		log({ kind: "confirm-skipped", reason: "no-ui", candidates: usable.map((c) => c.publicSlug) });
		return undefined;
	}

	const skipLabel = "跳过 —— 不安装，继续执行我的任务";
	try {
		if (usable.length === 1) {
			const ok = await ctx.ui.confirm(title, `${describeCandidate(usable[0])}\n\n安装后本轮会立即读取并使用它继续执行。`);
			if (!ok) {
				declinedSlugs.add(normalizeId(usable[0].publicSlug));
				log({ kind: "declined", slug: usable[0].publicSlug });
				return undefined;
			}
			return usable[0];
		}

		const options = usable.map((c) => `安装 ${describeCandidate(c)}`);
		options.push(skipLabel);
		const picked = await ctx.ui.select(title, options);
		const idx = picked ? options.indexOf(picked) : -1;
		if (idx < 0 || idx >= usable.length) {
			for (const c of usable) declinedSlugs.add(normalizeId(c.publicSlug));
			log({ kind: "declined", slugs: usable.map((c) => c.publicSlug) });
			return undefined;
		}
		return usable[idx];
	} catch (err) {
		log({ kind: "confirm-error", error: String(err) });
		return undefined;
	}
}

/* --------------------------------------------------------------- installing */

let sessionInstalls = 0;
const inFlight = new Set<string>();

function findSkillDirIn(root: string, slug: string): string | undefined {
	const norm = normalizeId(slug);
	const found = scanInstalledSkills([root]);
	return (
		found.find((s) => normalizeId(s.dir).includes(norm)) ??
		found.find((s) => normalizeId(s.name).includes(norm)) ??
		found.find((s) => norm.includes(normalizeId(s.dir))) ??
		found[0]
	)?.dir;
}

interface InstallOutcome {
	ok: boolean;
	slug: string;
	path?: string;
	message: string;
	ms: number;
	/** present when the staged files were scanned */
	risk?: RiskReport;
	/** true when the install was discarded because of the scan */
	blocked?: boolean;
}

/** Move a staged skill into the live skills directory. */
function promoteStaged(stagedDir: string, stagingRoot: string, cfg: AutopilotConfig): string {
	const rel = relative(stagingRoot, stagedDir);
	const target = join(cfg.skillsDir, rel);
	mkdirSync(dirname(target), { recursive: true });
	try {
		renameSync(stagedDir, target);
	} catch {
		// cross-device or locked: copy then remove
		cpSync(stagedDir, target, { recursive: true, force: true });
		rmSync(stagedDir, { recursive: true, force: true });
	}
	return target;
}

async function installSkill(
	candidate: Candidate,
	cfg: AutopilotConfig,
	reason: string,
	ctx?: ExtensionContext,
	timeoutMs = 120_000,
): Promise<InstallOutcome> {
	const publicSlug = candidate.publicSlug || candidate.entry.publicSlug || candidate.entry.slug;
	const key = normalizeId(publicSlug);
	if (inFlight.has(key)) {
		return { ok: false, slug: publicSlug, message: "install already in progress", ms: 0 };
	}
	inFlight.add(key);

	const store = resolveStore(cfg.store);
	if (!store) {
		inFlight.delete(key);
		return { ok: false, slug: publicSlug, message: `no store registered for "${cfg.store}"`, ms: 0 };
	}

	let stagingRoot: string | undefined;
	try {
		if (isDenied(candidate, cfg)) {
			log({ kind: "install-blocked", slug: publicSlug, reason: "deny-pattern", via: reason });
			return { ok: false, slug: publicSlug, message: "blocked by deny policy", ms: 0 };
		}
		if (!store.canInstall()) {
			log({ kind: "install-blocked", slug: publicSlug, reason: "store-cannot-install", via: reason });
			return { ok: false, slug: publicSlug, message: store.installHint(), ms: 0 };
		}

		ensureDir();
		mkdirSync(cfg.skillsDir, { recursive: true });

		// 1. stage, so nothing enters the live skills directory before it is scanned
		stagingRoot = join(DATA_DIR, "staging", `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
		mkdirSync(stagingRoot, { recursive: true });

		const res = await store.install(
			{ publicSlug, namespace: candidate.namespace, dir: stagingRoot },
			timeoutMs,
		);

		const staged = res.ok ? findSkillDirIn(stagingRoot, publicSlug) : undefined;
		const parsed = extractJson<{ success?: boolean; error?: string }>(res.stdout);
		const cliError = parsed?.success === false ? parsed.error : undefined;
		if (!res.ok || !staged) {
			const message = `install failed (code ${res.code})${cliError ? `: ${cliError}` : `: ${(res.stderr || res.stdout).slice(-300)}`}`;
			log({ kind: "install-failed", slug: publicSlug, via: reason, code: res.code, stderr: res.stderr.slice(-400) });
			return { ok: false, slug: publicSlug, message, ms: res.ms };
		}

		// 2. scan the staged files
		const report = cfg.scanBeforeInstall
			? scanSkillDirectory(staged)
			: ({ level: "none", findings: [], filesScanned: 0, truncated: false } as RiskReport);
		log({
			kind: "scan",
			slug: publicSlug,
			via: reason,
			level: report.level,
			files: report.filesScanned,
			rules: [...new Set(report.findings.map((f) => f.rule))],
		});

		if (cfg.scanBeforeInstall && report.level !== "none") {
			const fatal = report.level === "critical" && cfg.blockOnCritical;
			const needsReview = report.level === "high" || report.level === "critical";

			if (fatal) {
				const message = `已回滚：扫描到严重风险（${[...new Set(report.findings.map((f) => f.rule))].join(", ")}）`;
				log({ kind: "install-blocked", slug: publicSlug, reason: "scan-critical", via: reason });
				return { ok: false, slug: publicSlug, message, ms: res.ms, risk: report, blocked: true };
			}

			if (needsReview) {
				// no dialog available means no consent: discard
				if (!ctx?.hasUI) {
					const message = `已回滚：扫描到${describeLevel(report.level)}风险，但当前模式无法确认`;
					log({ kind: "install-blocked", slug: publicSlug, reason: "scan-no-ui", via: reason });
					return { ok: false, slug: publicSlug, message, ms: res.ms, risk: report, blocked: true };
				}
				const proceed = await ctx.ui.confirm(
					`${publicSlug} 包含${describeLevel(report.level)}风险指令，仍要安装？`,
					`${formatFindings(report)}\n\n拒绝则丢弃已下载的文件。`,
				);
				if (!proceed) {
					log({ kind: "install-declined-risk", slug: publicSlug, level: report.level, via: reason });
					return {
						ok: false,
						slug: publicSlug,
						message: `已丢弃：你拒绝了${describeLevel(report.level)}风险的 ${publicSlug}`,
						ms: res.ms,
						risk: report,
						blocked: true,
					};
				}
			}
		}

		// 3. promote into the live skills directory
		const dir = promoteStaged(staged, stagingRoot, cfg);
		sessionInstalls += 1;
		const st = getState();
		st.installsToday += 1;
		st.installed[publicSlug] = { at: new Date().toISOString(), dir, via: reason };
		writeJson(STATE_PATH, st);

		log({
			kind: "installed",
			slug: publicSlug,
			namespace: candidate.namespace,
			via: reason,
			dir,
			ms: res.ms,
			risk: report.level,
		});
		return {
			ok: true,
			slug: publicSlug,
			path: dir,
			message: `installed to ${dir}`,
			ms: res.ms,
			risk: report,
		};
	} finally {
		if (stagingRoot) {
			try {
				rmSync(stagingRoot, { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		}
		inFlight.delete(key);
	}
}

/* ---------------------------------------------------------------- detection */

interface Detection {
	needs: NeedSignal[];
	installed: InstalledSkill[];
	candidates: Candidate[];
}

async function detect(prompt: string, cfg: AutopilotConfig, opts: { live?: boolean } = {}): Promise<Detection> {
	const cat = loadCatalog();
	const needs = detectNeeds(prompt);
	const installed = installedSkills(cfg);
	// match on the raw prompt plus the canonical capability queries it implied
	const needQuery = needs
		.map((n) => n.query)
		.filter(Boolean)
		.join(" ");
	const tokens = [...new Set([...tokenize(prompt), ...tokenize(needQuery)])];
	const rankOpts = {
		minScore: cfg.minScore,
		limit: cfg.maxCandidatesInNote,
		skip: (e: CatalogEntry) => isInstalled(e, installed),
	};
	let candidates = rankCandidates(cat.skills, tokens, rankOpts);

	// Local catalog missed but the turn clearly needs a capability: ask the store.
	if (opts.live && candidates.length === 0 && needQuery) {
		try {
			const { results } = await Promise.race([
				searchSkillHub(needQuery),
				new Promise<{ results: CatalogEntry[] }>((resolve) => setTimeout(() => resolve({ results: [] }), 4000)),
			]);
			if (results.length) {
				candidates = rankCandidates([...results, ...cat.skills], tokens, rankOpts);
				mergeIntoCatalog(results);
			}
		} catch {
			/* stay with local results */
		}
	}
	return { needs, installed, candidates };
}

/** Remember live search hits so local prediction improves over time. */
function mergeIntoCatalog(entries: CatalogEntry[]) {
	if (!entries.length) return;
	const cat = loadCatalog();
	const bySlug = new Map(cat.skills.map((s) => [s.slug, s]));
	for (const e of entries) bySlug.set(e.slug, { ...bySlug.get(e.slug), ...e });
	const merged: CatalogFile = { ...cat, skills: [...bySlug.values()] };
	catalog = merged;
	writeJson(CATALOG_PATH, merged);
}

function renderNote(d: Detection, cfg: AutopilotConfig, confirmedInstalls: InstallOutcome[]): string {
	const lines: string[] = [];
	lines.push("[skill-autopilot] 能力检查 (mode=" + cfg.mode + ")");
	if (d.needs.length) {
		lines.push("检测到的能力需求: " + d.needs.map((n) => `${n.label}`).join(", "));
	}
	if (d.installed.length) {
		const names = d.installed.map((s) => s.name || s.slug).slice(0, 24);
		lines.push(`已安装技能 (${d.installed.length}): ${names.join(", ")}${d.installed.length > 24 ? ", …" : ""}`);
	} else {
		lines.push("已安装技能: 无");
	}
	if (confirmedInstalls.length) {
		for (const r of confirmedInstalls) {
			if (r.ok) {
				const risk = r.risk && r.risk.level !== "none" ? `，扫描：${describeLevel(r.risk.level)}风险` : "";
				lines.push(
					`已安装（用户确认）: ${r.slug}${risk} -> ${r.path}/SKILL.md。本轮任务现在就应该先用 read 读取该 SKILL.md 并遵循它执行。`,
				);
			} else {
				lines.push(`安装未完成: ${r.slug} (${r.message})。不要因此停下，用现有能力继续任务。`);
			}
		}
	}
	if (d.candidates.length) {
		lines.push("商店中存在但未安装的相关技能:");
		for (const c of d.candidates) {
			const desc = (c.entry.description || "").replace(/\s+/g, " ").slice(0, 110);
			lines.push(`  - ${c.publicSlug} v${c.entry.version || "?"} (score ${c.score}) — ${desc}`);
		}
	}
	lines.push(
		"行动指引: 若本轮任务确实需要某个未安装的能力，调用 skill_ensure({query:\"<能力关键词>\", install:true}) 自动检索并安装；若任务与以上内容无关，直接忽略本提示，不要提及它。",
	);
	return lines.join("\n");
}

/* ---------------------------------------------------------------- searching */

const SEARCH_API = "https://api.skillhub.cn/api/v1/search";
const searchCache = new Map<string, { at: number; results: CatalogEntry[] }>();
const SEARCH_TTL_MS = 10 * 60 * 1000;

/** Normalize a raw search-API record (different shape from showcase records). */
function normalizeSearchResult(raw: any): CatalogEntry | undefined {
	const slug = raw?.slug;
	if (!slug) return undefined;
	return {
		slug,
		publicSlug: raw.namespace?.publicSlug || (typeof slug === "string" && slug.includes("/") ? slug.split("/").pop() : slug),
		name: raw.displayName || raw.name || "",
		description: raw.summary || raw.description || raw.description_zh || "",
		version: raw.version || "",
		downloads: raw.downloads ?? raw.installs ?? 0,
		stars: raw.stars ?? 0,
		namespace: raw.namespace?.handle || raw.owner_name || raw.ownerName,
	};
}

async function searchTerm(term: string): Promise<CatalogEntry[]> {
	const hit = searchCache.get(term);
	if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit.results;
	let out: CatalogEntry[] = [];
	const store = resolveStore(undefined);
	if (store) {
		try {
			out = await store.search(term, 10);
		} catch {
			/* store failure is non-fatal: an empty result degrades to no candidate */
		}
	}
	if (out.length) searchCache.set(term, { at: Date.now(), results: out });
	return out;
}

/** Merge focused single-term searches into one deduped candidate pool. */
async function searchSkillHub(query: string): Promise<{ terms: string[]; results: CatalogEntry[] }> {
	const terms = deriveSearchTerms(query);
	if (!terms.length) return { terms, results: [] };
	const batches = await Promise.all(terms.map((t) => searchTerm(t).catch(() => [] as CatalogEntry[])));
	const seen = new Set<string>();
	const results: CatalogEntry[] = [];
	for (const batch of batches) {
		for (const entry of batch) {
			const { publicSlug, namespace } = splitSlug(entry);
			const key = `${namespace || ""}/${normalizeId(publicSlug)}`;
			if (seen.has(key)) continue;
			seen.add(key);
			results.push(entry);
		}
	}
	return { terms, results };
}

/* ------------------------------------------------------------- plan pipeline */

interface PlanNeed {
	step: PlanStep;
	query: string;
	chosen: Candidate;
}

/** Plans already handled in this session, so the same plan is not asked twice. */
const processedPlans = new Set<string>();

function assistantText(message: any): string {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((b: any) => b && b.type === "text" && typeof b.text === "string")
		.map((b: any) => b.text)
		.join("\n");
}

/**
 * For each plan step, find the single best not-installed skill and quantify it.
 * Steps run in order; a skill is only planned once (first step that needs it wins).
 */
async function planNeeds(steps: PlanStep[], cfg: AutopilotConfig): Promise<PlanNeed[]> {
	const cat = loadCatalog();
	const installed = installedSkills(cfg);
	let pool: CatalogEntry[] = [...cat.skills];
	const learned: CatalogEntry[] = [];
	const usedSlugs = new Set<string>();
	const needs: PlanNeed[] = [];

	for (const step of steps) {
		const canonical = hasCanonicalNeed(step.text);
		const query = capabilityQuery(step.text);
		const queryTokens = tokenize(query);
		const stepToks = tokenize(step.text);
		// when no canonical capability was recognised the query is just the raw
		// step, so demand a higher bar before proposing anything
		const rankOpts = {
			minScore: canonical ? cfg.planMinScore : cfg.planMinScore + 4,
			limit: 8,
			skip: (e: CatalogEntry) => isInstalled(e, installed),
		};

		// Eligibility comes from the distilled capability phrase only, so an
		// incidental word in the step text (e.g. "Scope 1/2/3") cannot drag in
		// an unrelated skill. Step words only refine the ranking afterwards.
		let candidates = rankCandidates(pool, queryTokens, rankOpts);
		if (!candidates.length) {
			// bounded live search for this one step
			try {
				const raced = await Promise.race([
					searchSkillHub(query),
					new Promise<{ results: CatalogEntry[] }>((resolve) => setTimeout(() => resolve({ results: [] }), 5000)),
				]);
				if (raced.results.length) {
					learned.push(...raced.results);
					pool = [...raced.results, ...pool];
					candidates = rankCandidates(pool, queryTokens, rankOpts);
				}
			} catch {
				/* keep local results */
			}
		}

		// Ranking for a plan step:
		//   1. query relevance (mandatory)
		//   2. downloads — a cheap quality proxy from the store
		//   3. step wording (tiny tie-break only, so an incidental word in the
		//      step cannot promote a niche skill over the obvious one)
		const stepBonus = (entry: CatalogEntry) => Math.min(scoreEntry(entry, stepToks), 6);
		const rescored = candidates
			.sort(
				(a, b) =>
					b.score - a.score ||
					(b.entry.downloads ?? 0) - (a.entry.downloads ?? 0) ||
					stepBonus(b.entry) - stepBonus(a.entry),
			);

		const usable = usableCandidates(rescored, cfg);
		if (!usable.length) continue;
		const best = usable[0];
		const key = normalizeId(best.publicSlug);
		if (usedSlugs.has(key)) continue;
		usedSlugs.add(key);
		needs.push({ step, query, chosen: best });
	}

	mergeIntoCatalog(learned);
	return needs;
}

function renderPlanNote(needs: PlanNeed[], outcomes: InstallOutcome[], skipped: PlanNeed[]): string {
	const lines: string[] = ["[skill-autopilot] 计划所需技能（用户已确认）"];
	for (let i = 0; i < needs.length; i++) {
		const need = needs[i];
		const outcome = outcomes[i];
		if (outcome?.ok) {
			const risk =
				outcome.risk && outcome.risk.level !== "none" ? `，扫描：${describeLevel(outcome.risk.level)}风险` : "";
			lines.push(
				`步骤 ${need.step.step} → ${outcome.slug}（相关度 ${need.chosen.score}${risk}）: ${outcome.path}/SKILL.md`,
			);
		} else {
			lines.push(`步骤 ${need.step.step} → ${need.chosen.publicSlug} 安装失败：${outcome?.message ?? "未尝试"}`);
		}
	}
	if (skipped.length) {
		lines.push(`本轮未安装（超过上限）：${skipped.map((s) => s.chosen.publicSlug).join(", ")}`);
	}
	lines.push(
		"执行计划时，涉及上述步骤请先用 read 读取对应 SKILL.md 并按其说明操作；安装失败的步骤请用现有能力完成，不要因此中断。",
	);
	return lines.join("\n");
}

interface PlanRunResult {
	needs: PlanNeed[];
	outcomes: InstallOutcome[];
	skipped: PlanNeed[];
	note: string;
	asked: boolean;
}

/** Shared by the turn_end hook and the /skill-autopilot plan command. */
async function runPlanPipeline(
	steps: PlanStep[],
	cfg: AutopilotConfig,
	ctx: ExtensionContext,
): Promise<PlanRunResult | undefined> {
	const needs = await planNeeds(steps, cfg);
	if (!needs.length) return undefined;

	const st = getState();
	const budget = Math.max(
		0,
		Math.min(cfg.maxPlanInstalls, cfg.maxInstallsPerSession - sessionInstalls, cfg.maxInstallsPerDay - st.installsToday),
	);
	if (budget <= 0) {
		try {
			ctx.ui.notify("SkillHub: 计划需要技能，但安装预算已用尽，继续执行任务", "warning");
		} catch {
			/* ignore */
		}
		return undefined;
	}

	const shown = needs.slice(0, budget);
	const skipped = needs.slice(budget);

	const lines = shown.map(
		(n) => `  步骤 ${n.step.step} → ${n.chosen.publicSlug} v${n.chosen.entry.version || "?"}（相关度 ${n.chosen.score}）`,
	);
	const message = [
		...lines,
		"",
		"评估依据：与计划步骤的关键词相关性（slug×3 / 名称×2 / 描述×1），已排除已安装项与策略禁止项。",
		skipped.length ? `另有 ${skipped.length} 个超出本轮安装预算，本轮不装。` : "",
	]
		.filter(Boolean)
		.join("\n");

	let ok = false;
	if (ctx.hasUI) {
		try {
			ok = await ctx.ui.confirm(`计划需要 ${shown.length} 个技能，安装后继续执行？`, message);
		} catch {
			ok = false;
		}
	}
	if (!ok) {
		for (const n of shown) declinedSlugs.add(normalizeId(n.chosen.publicSlug));
		log({ kind: "plan-declined", skills: shown.map((n) => n.chosen.publicSlug) });
		return { needs, outcomes: [], skipped, asked: ctx.hasUI, note: "" };
	}

	const outcomes: InstallOutcome[] = [];
	for (let i = 0; i < shown.length; i++) {
		const n = shown[i];
		try {
			ctx.ui.setStatus("skill-autopilot", `安装 ${n.chosen.publicSlug}（${i + 1}/${shown.length}）…`);
		} catch {
			/* ignore */
		}
		outcomes.push(await installSkill(n.chosen, cfg, `plan:step${n.step.step}`, ctx));
	}
	try {
		ctx.ui.setStatus("skill-autopilot", undefined);
	} catch {
		/* ignore */
	}

	const okCount = outcomes.filter((o) => o.ok).length;
	log({
		kind: "plan-install",
		steps: shown.map((n) => ({ step: n.step.step, slug: n.chosen.publicSlug, score: n.chosen.score, ok: outcomes[shown.indexOf(n)]?.ok })),
		okCount,
	});
	try {
		ctx.ui.notify(`计划所需技能已安装 ${okCount}/${shown.length}，继续执行任务`, okCount ? "info" : "warning");
	} catch {
		/* ignore */
	}

	return { needs, outcomes, skipped, asked: true, note: renderPlanNote(shown, outcomes, skipped) };
}

/* ------------------------------------------------------------------ stores */

/**
 * Built-in SkillHub provider. Search and catalog use the HTTP API directly
 * (an order of magnitude faster than the CLI, which also takes a global lock);
 * installing still goes through the CLI because that is where signature and
 * archive handling live.
 */
const skillhubStore: SkillStore = {
	id: "skillhub",
	label: "SkillHub",
	canInstall: () => existsSync(SKILLHUB_CLI),
	installHint: () =>
		`未找到 skillhub CLI（${SKILLHUB_CLI}）。安装后即可自动下载技能：
` +
		"curl -fsSL https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/install/install.sh | bash",

	async search(term, limit) {
		let out: CatalogEntry[] = [];
		try {
			const res = await fetch(`${SEARCH_API}?q=${encodeURIComponent(term)}&limit=${limit}`, {
				signal: AbortSignal.timeout(6000),
			});
			if (res.ok) {
				const data: any = await res.json();
				for (const raw of data?.results || []) {
					const n = normalizeSearchResult(raw);
					if (n) out.push(n);
				}
			}
		} catch {
			/* fall through to the CLI */
		}
		if (out.length) return out;

		const cli = await runCli(["--skip-self-upgrade", "search", "--json", "--search-limit", String(limit), term], 40_000).catch(
			() => undefined,
		);
		const parsed = cli ? extractJson<{ results?: any[]; skills?: any[] }>(cli.stdout) : undefined;
		for (const raw of parsed?.results || parsed?.skills || []) {
			const n = normalizeShowcaseSkill(raw);
			if (n) out.push(n);
		}
		return out;
	},

	async showcase() {
		const merged = new Map<string, CatalogEntry>();
		for (const section of SHOWCASE_SECTIONS) {
			try {
				const res = await fetch(`${SHOWCASE_HOST}/api/v1/showcase/${section}?limit=100`, {
					signal: AbortSignal.timeout(9000),
				});
				if (!res.ok) continue;
				const data: any = await res.json();
				for (const raw of data?.skills || []) {
					const n = normalizeShowcaseSkill(raw);
					if (n) merged.set(n.slug, n);
				}
			} catch {
				/* one section failing should not drop the rest */
			}
		}
		return [...merged.values()];
	},

	async install(opts, timeoutMs) {
		const args = ["--skip-self-upgrade", "install", opts.publicSlug, "--dir", opts.dir, "--json", "--force"];
		// accept "@handle", "handle", or a canonical "@handle/slug"
		const nsRaw = opts.namespace ? opts.namespace.split("/")[0].replace(/^@/, "").trim() : "";
		if (nsRaw && !nsRaw.includes("/")) args.push("--namespace", nsRaw);
		return runCli(args, timeoutMs);
	},
};

registerStore(skillhubStore);

/* ------------------------------------------------------------------- tool */

const skillEnsureTool = defineTool({
	name: "skill_ensure",
	label: "Ensure Skill",
	description:
		"Check the SkillHub skill store for a capability the current task needs and, with the user's explicit confirmation, install the best matching skill into pi's skills directory. Use this when you are about to do work that requires a specialized capability (pdf/docx/xlsx handling, web scraping, OCR, media processing, domain-specific tooling) and no installed skill covers it. This tool shows the user a confirmation dialog; only install when the user agrees. Returns ranked candidates and, when installed, the absolute path of SKILL.md that you should read and follow in the same turn.",
	promptSnippet: "Find and install a missing skill from SkillHub (asks the user first)",
	promptGuidelines: [
		"Call skill_ensure before telling the user a capability is unavailable.",
		"skill_ensure asks the user to confirm; never claim a skill was installed when the user declined.",
		"After skill_ensure installs a skill, read its SKILL.md and follow it in the same turn.",
	],
	parameters: Type.Object({
		query: Type.String({ description: "Capability needed, in a few keywords, e.g. 'excel xlsx generation' or 'pdf table extraction'" }),
		install: Type.Optional(Type.Boolean({ description: "Ask the user to install the best match. Defaults to true; the user must still confirm in a dialog." })),
		slug: Type.Optional(Type.String({ description: "Exact public slug to install directly, skipping the search." })),
		namespace: Type.Optional(Type.String({ description: "Namespace handle for the slug, when known." })),
	}),
	async execute(_toolCallId, params, _signal, onUpdate, ctx) {
		const cfg = loadConfig();
		const installed = installedSkills(cfg);

		if (!cfg.enabled || cfg.mode === "off") {
			return {
				content: [{ type: "text" as const, text: "skill-autopilot is disabled. Install manually: skillhub install <slug> --dir " + cfg.skillsDir }],
				details: { disabled: true },
			};
		}

		/* ---- direct slug install ---- */
		if (params.slug) {
			const candidate: Candidate = {
				entry: { slug: params.slug, publicSlug: params.slug.split("/").pop() || params.slug, name: params.slug },
				score: 0,
				slug: params.slug,
				publicSlug: params.slug.split("/").pop() || params.slug,
				namespace: params.namespace,
			};
			if (isInstalled(candidate.entry, installed)) {
				return { content: [{ type: "text" as const, text: `Already installed: ${candidate.publicSlug}` }], details: { alreadyInstalled: true } };
			}
			onUpdate?.({ content: [{ type: "text" as const, text: `installing ${candidate.publicSlug}…` }], details: {} });
			const outcome = await installSkill(candidate, cfg, "tool:explicit-slug", ctx);
			return {
				content: [
					{
						type: "text" as const,
						text: outcome.ok
							? `Installed ${outcome.slug} to ${outcome.path}. Read ${outcome.path}/SKILL.md and follow it now.`
							: `Install failed for ${outcome.slug}: ${outcome.message}`,
					},
				],
				details: { outcome },
				isError: !outcome.ok,
			} as any;
		}

		/* ---- live search ---- */
		onUpdate?.({ content: [{ type: "text" as const, text: `searching SkillHub for "${params.query}"…` }], details: {} });
		const { terms, results } = await searchSkillHub(params.query);

		// feed the local catalog so future predictions improve
		mergeIntoCatalog(results);

		if (!results.length) {
			return {
				content: [
					{
						type: "text" as const,
						text: `SkillHub 未返回任何结果（检索词: ${terms.join(", ") || params.query}）。可以换一个更具体的单词重试，或者不用技能直接继续。`,
					},
				],
				details: { query: params.query, terms, results: 0 },
			};
		}

		const tokens = tokenize(params.query);
		// Merged results come from several single-term searches, so local keyword
		// relevance is the only comparable signal. Downloads break ties.
		const seenKey = new Set<string>();
		const scored = results
			.map((entry) => {
				const { publicSlug, namespace } = splitSlug(entry);
				return {
					entry,
					score: scoreEntry(entry, tokens),
					slug: entry.slug,
					publicSlug,
					namespace,
				} as Candidate;
			})
			.filter((c) => {
				if (isInstalled(c.entry, installed)) return false;
				const key = `${c.namespace || ""}/${normalizeId(c.publicSlug)}`;
				if (seenKey.has(key)) return false;
				seenKey.add(key);
				return true;
			});
		scored.sort((a, b) => b.score - a.score || (b.entry.downloads ?? 0) - (a.entry.downloads ?? 0));
		const pool = scored.slice(0, 5);

		const already = results.filter((e) => isInstalled(e, installed));

		if (!pool.length) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Every SkillHub match for "${params.query}" is already installed.\nInstalled: ${already.map((e) => e.publicSlug || e.slug).join(", ")}`,
					},
				],
				details: { query: params.query, alreadyInstalled: already.map((e) => e.slug) },
			};
		}

		const wantInstall = params.install !== false && cfg.mode !== "suggest";
		const best = pool[0];

		// Relevance guard: the store's search sometimes returns popular-but-unrelated
		// skills. Only install when the query actually hit the candidate's slug/name.
		const relevant = pool.filter((c) => c.score > 0);
		if (wantInstall && relevant.length === 0) {
			const list = pool.map((c) => `- ${c.publicSlug} — ${(c.entry.description || "").replace(/\s+/g, " ").slice(0, 90)}`).join("\n");
			return {
				content: [
					{
						type: "text" as const,
						text: `没有关键词相关的匹配（SkillHub 对 "${params.query}" 只返回了不相关的结果），因此未安装任何技能。\n建议换一个更具体的能力关键词重试。商店返回的最近结果仅供参照（相关度未确认）：\n${list}`,
					},
				],
				details: { query: params.query, relevant: 0, suggested: pool.map((c) => c.publicSlug) },
			};
		}

		if (cfg.mode === "suggest" || !wantInstall) {
			const list = pool.map((c) => `- ${c.publicSlug} v${c.entry.version || "?"}${c.score > 0 ? ` (score ${c.score})` : " (低相关)"} — ${(c.entry.description || "").slice(0, 120)}`).join("\n");
			return {
				content: [
					{
						type: "text" as const,
						text: `候选（未安装，mode=${cfg.mode}）：\n${list}\n请先向用户确认，由用户决定后再安装：skillhub install <slug> --namespace <ns> --dir "${cfg.skillsDir}"`,
					},
				],
				details: { query: params.query, candidates: pool.map((c) => ({ slug: c.publicSlug, ns: c.namespace, score: c.score })) },
			};
		}

		if (!budgetLeft(cfg, sessionInstalls)) {
			return {
				content: [
					{
						type: "text" as const,
						text: `安装预算已用尽（会话 ${sessionInstalls}/${cfg.maxInstallsPerSession}，今日 ${getState().installsToday}/${cfg.maxInstallsPerDay}）。最佳候选：${best.publicSlug}。继续任务，若确实需要请让用户手动安装。`,
					},
				],
				details: { query: params.query, budgetExhausted: true, best: best.publicSlug },
			};
		}

		const chosen = relevant[0];

		// mode=confirm: a human decides. No silent installs, ever.
		if (cfg.mode === "confirm") {
			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text" as const,
							text: `无法弹出确认窗口（当前模式无 UI），因此未安装。最佳候选：${chosen.publicSlug}（相关度 ${chosen.score}）。请用一句话向用户说明并征得同意后再让用户安装。`,
						},
					],
					details: { query: params.query, needsUserConfirm: true, best: chosen.publicSlug },
				};
			}
			const ok = await ctx.ui.confirm("安装这个技能后继续任务？", describeCandidate(chosen));
			if (!ok) {
				declinedSlugs.add(normalizeId(chosen.publicSlug));
				log({ kind: "declined", slug: chosen.publicSlug, via: "tool" });
				return {
					content: [
						{
							type: "text" as const,
							text: `用户拒绝安装 ${chosen.publicSlug}。不要再次询问同一个技能，直接用现有能力继续任务，需要时告知用户缺少什么。`,
						},
					],
					details: { query: params.query, declined: chosen.publicSlug },
				};
			}
		}

		onUpdate?.({ content: [{ type: "text" as const, text: `installing ${chosen.publicSlug}…` }], details: {} });
		const outcome = await installSkill(chosen, cfg, "tool:search", ctx);
		const others = pool.filter((c) => c !== chosen).map((c) => c.publicSlug);
		const riskNote =
			outcome.risk && outcome.risk.level !== "none"
				? `Scan: ${describeLevel(outcome.risk.level)} risk (${[...new Set(outcome.risk.findings.map((f) => f.rule))].join(", ")}); review its SKILL.md before relying on it.`
				: "";
		const text = outcome.ok
			? [
					`Installed ${outcome.slug} (v${chosen.entry.version || "?"}, 相关度 ${chosen.score}) to ${outcome.path}.`,
					`Next step: read ${outcome.path}/SKILL.md and follow its instructions for this task.`,
					riskNote,
					others.length ? `Other candidates available if it does not fit: ${others.join(", ")}` : "",
				]
					.filter(Boolean)
					.join("\n")
			: `Install failed for ${chosen.publicSlug}: ${outcome.message}\nOther candidates: ${others.join(", ") || "none"}`;
		return {
			content: [{ type: "text" as const, text }],
			details: { query: params.query, outcome, candidates: pool.map((c) => c.publicSlug) },
			isError: !outcome.ok,
		} as any;
	},
});

/* --------------------------------------------------------------- extension */

export default function skillAutopilot(pi: ExtensionAPI) {
	ensureDir();

	pi.registerTool(skillEnsureTool);

	/* ---------------- proactive detection before each user turn ---------------- */
	pi.on("before_agent_start", async (event, ctx) => {
		const cfg = loadConfig();
		if (!cfg.enabled || cfg.mode === "off") return;
		if (event.messageType !== "user") return;

		const prompt = (event.prompt || "").trim();
		if (prompt.length < 4) return;
		if (prompt.startsWith("/")) return; // slash command / skill command

		const cat = loadCatalog();
		if (cat.skills.length === 0 || catalogIsStale(cat, cfg)) refreshCatalogInBackground();

		let detection: Detection;
		try {
			detection = await detect(prompt, cfg, { live: true });
		} catch (err) {
			log({ kind: "detect-error", error: String(err) });
			return;
		}

		const confirmedInstalls: InstallOutcome[] = [];
		const explicit = detection.needs.some((n) => n.kind === "explicit");

		// mode=confirm: ask the user first, then install and continue THIS turn.
		// Nothing is ever installed without an explicit yes.
		if (cfg.mode === "confirm" && detection.candidates.length > 0) {
			const top = detection.candidates[0];
			if (top.score >= cfg.confirmMinScore) {
				if (!budgetLeft(cfg, sessionInstalls)) {
					const st = getState();
					try {
						ctx.ui.notify(
							`SkillHub: 已达安装上限（会话 ${sessionInstalls}/${cfg.maxInstallsPerSession}，今日 ${st.installsToday}/${cfg.maxInstallsPerDay}），本轮不安装，继续执行任务`,
							"warning",
						);
					} catch {
						/* ignore */
					}
				} else {
					const chosen = await askWhichToInstall(
						detection.candidates,
						cfg,
						ctx,
						"检测到缺失的技能，安装后继续执行本轮任务？",
					);
					if (chosen) {
						try {
							ctx.ui.setStatus("skill-autopilot", `正在安装 ${chosen.publicSlug} …`);
							ctx.ui.notify(`正在安装 ${chosen.publicSlug} …（约 10–20 秒）`, "info");
						} catch {
							/* ignore */
						}
						const outcome = await installSkill(chosen, cfg, "confirm", ctx);
						try {
							ctx.ui.setStatus("skill-autopilot", undefined);
						} catch {
							/* ignore */
						}
						confirmedInstalls.push(outcome);
						if (outcome.ok) {
							// stop advertising what is now installed
							detection.candidates = detection.candidates.filter(
								(c) => normalizeId(c.publicSlug) !== normalizeId(chosen.publicSlug),
							);
							try {
								ctx.ui.notify(`已安装 ${outcome.slug}，继续执行你的任务`, "info");
							} catch {
								/* ignore */
							}
						} else {
							try {
								ctx.ui.notify(`安装失败：${outcome.message}（继续执行任务）`, "error");
							} catch {
								/* ignore */
							}
						}
					}
				}
			}
		}

		// Only speak up when something is actionable.
		const worthNote = confirmedInstalls.length > 0 || (explicit && !!prompt) || detection.candidates.length > 0;
		if (!worthNote) {
			log({
				kind: "turn",
				needs: detection.needs.map((n) => n.label),
				candidates: 0,
				installed: detection.installed.length,
			});
			return;
		}

		log({
			kind: "turn",
			needs: detection.needs.map((n) => n.label),
			candidates: detection.candidates.map((c) => ({ slug: c.publicSlug, score: c.score })),
			installed: detection.installed.length,
			confirmedInstalls: confirmedInstalls.map((a) => a.slug),
			mode: cfg.mode,
		});

		return {
			message: {
				customType: "skill-autopilot",
				content: renderNote(detection, cfg, confirmedInstalls),
				display: false,
			},
		};
	});

	/* ------------------- plan-driven batch provisioning ------------------- */

	function planToolRegex(cfg: AutopilotConfig): RegExp | undefined {
		try {
			return new RegExp(cfg.planToolPattern || DEFAULT_CONFIG.planToolPattern, "i");
		} catch {
			return /plan|goal|task|todo/i;
		}
	}

	async function handlePlanSteps(steps: PlanStep[], ctx: ExtensionContext) {
		const cfg = loadConfig();
		if (!cfg.enabled || cfg.mode === "off" || !cfg.planEnabled) return;
		if (steps.length < 2) return;

		const sig = planSignature(steps);
		if (!sig || processedPlans.has(sig)) return;
		processedPlans.add(sig);
		if (processedPlans.size > 50) {
			const first = processedPlans.values().next().value;
			if (first !== undefined) processedPlans.delete(first);
		}

		try {
			const result = await runPlanPipeline(steps, cfg, ctx);
			if (!result?.note) return;
			// sendMessage keeps the mapping in context for the next request in this run
			pi.sendMessage(
				{ customType: "skill-autopilot-plan", content: result.note, display: false },
				{ triggerTurn: false },
			);
		} catch (err) {
			log({ kind: "plan-error", error: String(err) });
		}
	}

	// (1) plans written as markdown in the assistant message (plan-mode convention)
	pi.on("turn_end", async (event, ctx) => {
		const cfg = loadConfig();
		if (!cfg.enabled || cfg.mode === "off" || !cfg.planEnabled) return;
		const text = assistantText(event.message);
		if (!text) return;
		const steps = extractPlanSteps(text);
		if (steps.length < 2) return;
		await handlePlanSteps(steps, ctx);
	});

	// (2) plans passed to a plan/goal tool (pi-goal-x set_goal_tasks, todo tools, …)
	// (3) plan files written to disk (PLAN.md, .pi/tasks.json, …)
	pi.on("tool_result", async (event, ctx) => {
		const cfg = loadConfig();
		if (!cfg.enabled || cfg.mode === "off" || !cfg.planEnabled) return;
		if (event.isError) return;

		const name = String(event.toolName || "");
		if (/^get[_-]/i.test(name)) return; // read-only getters never define a plan

		let steps: PlanStep[] = [];
		const re = planToolRegex(cfg);
		if (re?.test(name)) steps = extractStepsFromToolInput(event.input);

		if (steps.length < 2) {
			const input = (event.input || {}) as Record<string, unknown>;
			const path = typeof input.path === "string" ? input.path : "";
			if (path && isPlanFilePath(path)) {
				const body = typeof input.content === "string" ? input.content : "";
				if (body) steps = extractStepsFromText(body);
			}
		}

		if (steps.length < 2) return;
		await handlePlanSteps(steps, ctx);
	});

	/* ------------------------------- command ------------------------------- */
	pi.registerCommand("skill-autopilot", {
		description:
			"SkillHub 自动补技能：status | on | off | mode <confirm|suggest|off> | plan <路径> | stores | catalog [refresh] | detect <文本> | log [n]",
		getArgumentCompletions: (prefix) => {
			const words = ["status", "on", "off", "mode confirm", "mode suggest", "mode off", "plan ", "stores", "catalog", "catalog refresh", "detect ", "log"];
			const hit = words.filter((w) => w.startsWith(prefix));
			return hit.length ? hit.map((w) => ({ value: w, label: w })) : null;
		},
		handler: async (args, ctx) => {
			const input = (args || "").trim();
			const [cmd, ...rest] = input.split(/\s+/);
			const cfg = loadConfig();

			const showStatus = () => {
				const st = getState();
				const cat = loadCatalog();
				const inst = installedSkills(cfg);
				const age = cat.updatedAt ? `${Math.round((Date.now() - cat.updatedAt) / 3600000)}h ago` : "never";
				ctx.ui.notify(
					[
						`skill-autopilot  enabled=${cfg.enabled}  mode=${cfg.mode}`,
						`阈值: minScore=${cfg.minScore} confirm=${cfg.confirmMinScore}  预算: 会话 ${sessionInstalls}/${cfg.maxInstallsPerSession}, 今日 ${st.installsToday}/${cfg.maxInstallsPerDay}`,
						`已拒装: ${declinedSlugs.size} 个（本会话内不再追问）`,
						`目录: ${cfg.skillsDir}`,
						`商店: ${cfg.store}   安装前扫描: ${cfg.scanBeforeInstall ? (cfg.blockOnCritical ? "开（critical 回滚）" : "开") : "关"}`,
						`已安装技能: ${inst.length}   本地目录: ${cat.skills.length} 条 (更新于 ${age})`,
						`配置: ${CONFIG_PATH}`,
					].join("\n"),
					"info",
				);
			};

			switch (cmd) {
				case "":
				case "status":
					showStatus();
					return;
				case "on":
					cfg.enabled = true;
					if (cfg.mode === "off") cfg.mode = "confirm";
					saveConfig(cfg);
					ctx.ui.notify("skill-autopilot 已启用（mode=confirm：安装前会先问你）", "info");
					return;
				case "off":
					cfg.enabled = false;
					saveConfig(cfg);
					ctx.ui.notify("skill-autopilot 已停用", "info");
					return;
				case "mode": {
					const m = rest[0];
					if (m === "auto") {
						ctx.ui.notify("auto 模式已移除（不允许静默安装），请用 confirm | suggest | off", "warning");
						return;
					}
					if (m !== "confirm" && m !== "suggest" && m !== "off") {
						ctx.ui.notify("用法: /skill-autopilot mode confirm|suggest|off", "warning");
						return;
					}
					cfg.mode = m;
					cfg.enabled = m !== "off";
					saveConfig(cfg);
					ctx.ui.notify(`mode = ${m}`, "info");
					return;
				}
				case "plan": {
					const path = rest.join(" ").trim();
					if (!path) {
						ctx.ui.notify("用法: /skill-autopilot plan <计划文件路径>", "warning");
						return;
					}
					let text = "";
					try {
						text = readFileSync(path, "utf8");
					} catch (err) {
						ctx.ui.notify(`读不到计划文件: ${path}\n${String(err)}`, "error");
						return;
					}
					const planSteps = extractPlanSteps(text);
					if (planSteps.length < 1) {
						ctx.ui.notify("文件里没找到计划（需要 `Plan:` / `计划：` 标题 + 编号步骤）", "warning");
						return;
					}
					ctx.ui.notify(`解析到 ${planSteps.length} 个步骤，正在评估所需技能…`, "info");
					const planResult = await runPlanPipeline(planSteps, cfg, ctx);
					if (!planResult) {
						ctx.ui.notify("没有找到需要安装的技能（都已具备或无可信匹配）", "info");
						return;
					}
					if (planResult.note) ctx.ui.notify(planResult.note, "info");
					return;
				}
				case "stores": {
					const active = resolveStore(undefined);
					const lines = listStores().map((id) => {
						const st = resolveStore(id);
						const mark = st?.id === cfg.store ? "*" : " ";
						const can = st?.canInstall() ? "可安装" : "仅检索";
						return `${mark} ${id} (${st?.label ?? id}) — ${can}`;
					});
					ctx.ui.notify(
						[
							`当前 store: ${cfg.store}${active ? ` (${active.label})` : " (未注册)"}`,
							...lines,
							"",
							"改 store：编辑配置文件里的 \"store\" 字段，然后 /reload",
						].join("\n"),
						"info",
					);
					return;
				}
				case "catalog": {
					if (rest[0] === "refresh") {
						ctx.ui.notify("正在刷新 SkillHub 目录…", "info");
						const f = await refreshCatalog();
						ctx.ui.notify(`目录已刷新: ${f.skills.length} 条 (${f.source})`, "info");
						return;
					}
					const cat = loadCatalog();
					ctx.ui.notify(`本地目录: ${cat.skills.length} 条\n来源: ${cat.source}\n更新: ${cat.updatedAt ? new Date(cat.updatedAt).toLocaleString() : "never"}\n用 /skill-autopilot catalog refresh 立即刷新`, "info");
					return;
				}
				case "detect": {
					const text = rest.join(" ");
					if (!text) {
						ctx.ui.notify("用法: /skill-autopilot detect <文本>", "warning");
						return;
					}
					const d = await detect(text, cfg, { live: true });
					ctx.ui.notify(renderNote(d, cfg, []), "info");
					return;
				}
				case "log": {
					const n = Number(rest[0] || 8) || 8;
					let lines: string[] = [];
					try {
						lines = readFileSync(LOG_PATH, "utf8").trim().split("\n").slice(-n);
					} catch {
						ctx.ui.notify("暂无日志", "info");
						return;
					}
					ctx.ui.notify(lines.map((l) => l.slice(0, 220)).join("\n"), "info");
					return;
				}
				default:
					ctx.ui.notify(
						"用法: /skill-autopilot [status|on|off|mode <confirm|suggest|off>|plan <路径>|catalog [refresh]|detect <text>|log [n]]",
						"warning",
					);
			}
		},
	});

	/* --------------------------- startup housekeeping --------------------------- */
	pi.on("session_start", async () => {
		const cfg = loadConfig();
		if (!cfg.enabled || cfg.mode === "off") return;
		const cat = loadCatalog();
		if (cat.skills.length === 0 || catalogIsStale(cat, cfg)) refreshCatalogInBackground();
	});
}
