/**
 * Pure matching / detection logic for skill-autopilot.
 * No pi imports so it can be unit-tested standalone.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";

/* ------------------------------------------------------------------ types */

export interface CatalogEntry {
	slug: string;
	publicSlug?: string;
	name?: string;
	description?: string;
	version?: string;
	downloads?: number;
	stars?: number;
	namespace?: string;
}

export interface InstalledSkill {
	slug: string; // directory or frontmatter name
	name: string;
	description: string;
	dir: string;
	skillFile: string;
}

export interface NeedSignal {
	kind: "extension" | "keyword" | "domain" | "explicit";
	/** human label, e.g. "pdf" */
	label: string;
	/** suggested SkillHub search query */
	query: string;
	/** character offset where the signal was first seen in the text */
	pos?: number;
}

export interface Candidate {
	entry: CatalogEntry;
	score: number;
	slug: string;
	publicSlug: string;
	namespace?: string;
}

/* ------------------------------------------------------------- tokenizing */

const EN_STOP = new Set([
	"the", "and", "for", "with", "this", "that", "you", "your", "yours", "are", "can", "could", "would", "should",
	"use", "used", "uses", "using", "please", "help", "make", "made", "from", "into", "need", "needs", "want",
	"wants", "will", "then", "than", "them", "they", "their", "there", "also", "just", "like", "more", "most",
	"some", "such", "only", "over", "very", "our", "ours", "its", "have", "has", "had", "was", "were", "been",
	"about", "must", "when", "what", "which", "how", "why", "who", "all", "any", "but", "not", "now", "new",
	"file", "files", "tool", "tools", "skill", "skills", "task", "work", "based", "support", "supports",
	"one", "two", "get", "set", "add", "run", "let", "way", "may", "own", "same", "here", "each", "other",
]);

const CJK_RE = /[\u3400-\u9FFF\uF900-\uFAFF]/;
const CJK_RUN_RE = /[\u3400-\u9FFF\uF900-\uFAFF]+/g;

/** Tokenize mixed CJK/latin text into matchable features. */
export function tokenize(text: string): string[] {
	const out = new Set<string>();
	const lower = (text || "").toLowerCase();

	// latin / alphanumeric words
	for (const raw of lower.split(/[^a-z0-9+#.]+/)) {
		const w = raw.replace(/^[.]+|[.]+$/g, "");
		if (!w || w.length < 3) continue;
		if (/^\d+$/.test(w)) continue;
		if (EN_STOP.has(w)) continue;
		out.add(w);
	}

	// CJK bigrams (plus single chars for length-1 runs)
	const runs = lower.match(CJK_RUN_RE) || [];
	for (const run of runs) {
		if (run.length === 1) {
			out.add(run);
			continue;
		}
		for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2));
	}
	return [...out];
}

/* ------------------------------------------------------ capability signals */

const EXT_HINTS: Record<string, string> = {
	pdf: "pdf", xlsx: "excel spreadsheet", xls: "excel spreadsheet", csv: "csv data",
	docx: "word document", doc: "word document", pptx: "powerpoint slides", ppt: "powerpoint slides",
	key: "keynote slides",
	mp4: "video processing", mov: "video processing", avi: "video processing", mkv: "video processing",
	mp3: "audio processing", wav: "audio processing", m4a: "audio processing", flac: "audio processing",
	zip: "archive zip", tar: "archive tar", gz: "archive gzip", rar: "archive extraction",
	epub: "epub ebook", sql: "database sql", db: "database sqlite", sqlite: "database sqlite",
	tex: "latex", ipynb: "jupyter notebook", json: "json data", xml: "xml data",
	yaml: "yaml config", yml: "yaml config", html: "html page", md: "markdown",
	txt: "plain text", log: "log analysis", ipa: "ios app", apk: "android app",
	shp: "shapefile gis", geojson: "geojson gis", parquet: "parquet data", tif: "geotiff raster",
};

/**
 * [regex, canonical search query, category]
 * "cap"   = a tool capability (pdf, excel, scraping…) — drives install decisions
 * "domain" = subject matter (esg, finance, papers…) — context, not a capability
 */
const KEYWORD_HINTS: Array<[RegExp, string, ("cap" | "domain")?]> = [
	[/爬虫|抓取|采集|\bscrap(e|ing)\b|\bcrawl(er|ing)?\b|spider/, "web scraping crawler"],
	[/浏览器|自动化操作网页|\bbrowser\b|playwright|puppeteer|selenium/, "browser automation"],
	[/图表|绘图|可视化|柱状图|折线图|饼图|散点图|热力图|看板|仪表盘|\bchart\b|\bplot\b|\bgraph\b|plotly|matplotlib|echarts|d3\.js|dashboard/, "chart data visualization"],
	[/幻灯片|ppt|演示文稿|slides?|powerpoint/i, "powerpoint slides"],
	[/思维导图|mind\s?map/, "mind map"],
	[/翻译|\btranslat(e|ion)\b/, "translation"],
	[/语音|朗读|tts|\basr\b|speech\s?to\s?text/, "speech tts asr"],
	[/ocr|文字识别|图片识别/, "ocr text recognition"],
	[/视频剪辑|视频处理|视频转换|视频|\bvideo\b/, "video processing"],
	[/音频处理|音频提取|音频|\baudio\b/, "audio processing"],
	[/转写|字幕|transcri(be|pt)/, "speech to text transcript"],
	[/部署|上线|\bdeploy(ment)?\b|nginx|kubernetes|k8s|dockerfile/, "deployment devops"],
	[/数据库|\bdatabase\b|\bsql\b|postgres|mysql|sqlite/, "database sql"],
	[/正则|regexp?|regex/, "regex"],
	[/单元测试|测试用例|\bunit\s?test/, "unit testing"],
	[/邮件|\bemail\b|\bsmtp\b/, "email sending"],
	[/日历|\bcalendar\b/, "calendar"],
	[/地图|\bmaps?\b|高德|geocod/, "maps geocoding"],
	[/简历|\bresume\b|\bcv\b/, "resume builder"],
	[/论文|文献|\bpaper\b|arxiv|文献综述/, "academic paper research", "domain"],
	[/财报|财务|估值|\bfinancial\b|\bvaluation\b/, "financial analysis", "domain"],
	[/\besg\b|可持续|碳排放|carbon|绿色金融/, "esg sustainability", "domain"],
	[/报表|表格|\bexcel\b|\bspreadsheet\b|xlsx|透视表|数据表|工作簿/, "excel spreadsheet"],
	[/\bword\b|文档转换|docx|汇报文档|报告排版/, "word document"],
	[/\bpdf\b/, "pdf"],
	[/架构图|流程图|mermaid|diagram|drawio/, "diagram flowchart"],
	[/api|接口文档|openapi|swagger/, "api integration"],
	[/爬取|download|下载器|\bdownloader\b/, "downloader"],
	[/加密|解密|加密算法|encrypt|decrypt/, "encryption"],
	[/图像处理|抠图|修图|image\s?process/, "image processing"],
	[/爬|数据清洗|etl|\bpipeline\b/, "data cleaning etl"],
	[/知识库|rag|向量|embedding/, "rag knowledge base"],
];

/** Extract capability signals from free text. */
export function detectNeeds(text: string): NeedSignal[] {
	const lower = (text || "").toLowerCase();
	const signals: NeedSignal[] = [];
	const seen = new Set<string>();

	const push = (s: NeedSignal) => {
		// dedupe by query so "pdf" from extension + keyword collapses into one
		const key = s.query || s.label;
		if (seen.has(key)) return;
		seen.add(key);
		signals.push(s);
	};

	// explicit "install a skill" requests
	if (/(装|安装|找个|找一下|搜索).{0,6}(技能|skill)|install.{0,12}skill|skillhub/i.test(text)) {
		push({ kind: "explicit", label: "explicit-skill-request", query: "", pos: 0 });
	}

/**
 * Image extensions only count when the text also asks for image *work*.
 * A bare `C:\...\screenshot.png` is an attachment the model can already read;
 * treating it as a capability need used to propose image-generation and
 * speech-to-text skills for every screenshot (issue #1).
 */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "tif", "heic", "svg", "avif"]);

const IMAGE_ACTION_RE =
	/(生成|绘制|画一|画个|画张|设计|制作|压缩|裁剪|缩放|转成|转换|改尺寸|修图|抠图|合成|渲染|海报|封面|插画|create|generate|draw|render|convert|resize|compress|crop|retouch|design)/i;


	// file extensions: "a.pdf" and bare "pdf" both count
	for (const m of lower.matchAll(/[\w\u4e00-\u9fff-]+\.([a-z0-9]{1,8})\b/g)) {
		const ext = m[1];
		const q = EXT_HINTS[ext];
		if (q) push({ kind: "extension", label: ext, query: q, pos: m.index ?? 0 });
	}
	// images are only a need when the text asks for image work
	if (IMAGE_ACTION_RE.test(lower)) {
		for (const m of lower.matchAll(/(?:^|[^a-z0-9])([a-z0-9]{2,5})(?![a-z0-9])/g)) {
			if (!IMAGE_EXTS.has(m[1])) continue;
			push({ kind: "extension", label: m[1], query: "image processing", pos: m.index ?? 0 });
		}
	}

	// capability / domain keywords
	for (const [re, query, category] of KEYWORD_HINTS) {
		const m = re.exec(lower);
		if (!m) continue;
		const needle = m[0];
		// locate the matched Chinese term precisely (regex .index already does it)
		push({
			kind: category === "domain" ? "domain" : "keyword",
			label: query,
			query,
			pos: m.index ?? lower.indexOf(needle),
		});
	}

	// earliest mention first: the first capability named is usually the action's object
	signals.sort((a, b) => (a.pos ?? Number.MAX_SAFE_INTEGER) - (b.pos ?? Number.MAX_SAFE_INTEGER));
	return signals;
}

/** True when at least one real tool capability was recognised (not just a domain word). */
export function hasCanonicalNeed(text: string): boolean {
	return detectNeeds(text).some((s) => s.kind !== "domain" && !!s.query);
}

/* -------------------------------------------------------------- scoring */

export function scoreEntry(entry: CatalogEntry, tokens: string[]): number {
	const slug = (entry.publicSlug || entry.slug || "").toLowerCase();
	const name = (entry.name || "").toLowerCase();
	const desc = (entry.description || "").toLowerCase();
	let score = 0;
	let strong = false;
	for (const t of tokens) {
		if (!t) continue;
		if (slug.includes(t)) {
			score += 3;
			strong = true;
		}
		if (name.includes(t)) {
			score += 2;
			strong = true;
		}
		if (desc.includes(t)) score += 1;
	}
	return strong ? score : 0;
}

export function splitSlug(entry: CatalogEntry): { publicSlug: string; namespace?: string } {
	const raw = entry.slug || entry.publicSlug || "";
	if (raw.startsWith("@") && raw.includes("/")) {
		const [ns, ...rest] = raw.slice(1).split("/");
		return { publicSlug: rest.join("/"), namespace: entry.namespace || ns };
	}
	return { publicSlug: entry.publicSlug || raw, namespace: entry.namespace };
}

export function normalizeId(s: string): string {
	return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function isInstalled(entry: CatalogEntry, installed: InstalledSkill[]): boolean {
	const { publicSlug } = splitSlug(entry);
	const targets = new Set(
		[normalizeId(publicSlug), normalizeId(entry.name || "")].filter((x) => x && x.length >= 4),
	);
	for (const s of installed) {
		if (targets.has(normalizeId(s.slug))) return true;
		if (targets.has(normalizeId(s.name))) return true;
	}
	return false;
}

export function rankCandidates(
	entries: CatalogEntry[],
	tokens: string[],
	opts: { minScore?: number; limit?: number; skip?: (e: CatalogEntry) => boolean } = {},
): Candidate[] {
	const minScore = opts.minScore ?? 6;
	const limit = opts.limit ?? 3;
	const out: Candidate[] = [];
	for (const entry of entries) {
		if (opts.skip?.(entry)) continue;
		const score = scoreEntry(entry, tokens);
		if (score < minScore) continue;
		const { publicSlug, namespace } = splitSlug(entry);
		out.push({ entry, score, slug: entry.slug, publicSlug, namespace });
	}
	out.sort((a, b) => b.score - a.score || (b.entry.downloads ?? 0) - (a.entry.downloads ?? 0));
	return out.slice(0, limit);
}

/**
 * The SkillHub search endpoint degrades badly on long multi-word queries
 * (it starts returning popular-but-unrelated skills). Short, single-token
 * queries are far more precise, so we split a capability phrase into a few
 * focused terms and merge the result sets.
 */
export function deriveSearchTerms(query: string): string[] {
	const raw = (query || "").trim();
	if (!raw) return [];
	const ascii = tokenize(raw).filter((t) => /^[a-z0-9+#.]+$/.test(t) && t.length >= 3);
	const terms = [...new Set(ascii)].sort((a, b) => b.length - a.length).slice(0, 3);
	if (terms.length) return terms;
	// CJK: use the longest runs from the raw text
	try {
		const runs = raw.match(CJK_RUN_RE) || [];
		const uniq = [...new Set(runs)].sort((a, b) => b.length - a.length).slice(0, 2);
		if (uniq.length) return uniq;
	} catch {
		/* ignore */
	}
	return [raw];
}

/* ------------------------------------------------------------ installed */

function parseFrontmatter(md: string): Record<string, string> {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md || "");
	if (!m) return {};
	const out: Record<string, string> = {};
	for (const line of m[1].split(/\r?\n/)) {
		const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
		if (!kv) continue;
		let v = kv[2].trim();
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
			v = v.slice(1, -1);
		}
		if (v === ">" || v === "|" || v === "") continue;
		out[kv[1]] = v;
	}
	return out;
}

/** Recursively find SKILL.md files (max depth 4) under each directory. */
export function scanInstalledSkills(dirs: string[]): InstalledSkill[] {
	const found: InstalledSkill[] = [];
	const walk = (dir: string, depth: number) => {
		if (depth > 4) return;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			if (name === "node_modules" || name.startsWith(".")) continue;
			const full = join(dir, name);
			let st;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				const skillFile = join(full, "SKILL.md");
				if (existsSync(skillFile)) {
					let md = "";
					try {
						md = readFileSync(skillFile, "utf8");
					} catch {
						/* ignore */
					}
					const fm = parseFrontmatter(md);
					found.push({
						slug: basename(full),
						name: fm.name || basename(full),
						description: fm.description || "",
						dir: full,
						skillFile,
					});
				}
				walk(full, depth + 1);
			}
		}
	};
	for (const d of dirs) walk(d, 0);
	return found;
}
