/**
 * Skill store abstraction.
 *
 * Everything store-specific lives behind this interface so a second registry
 * (clawhub, skills.sh, an internal registry…) is a contained addition instead of
 * a rewrite: implement `SkillStore`, call `registerStore`, set `store` in config.
 *
 * The active store is resolved per call from config, so switching stores does
 * not require a restart beyond the config write.
 */

import type { CatalogEntry } from "./matcher.ts";

export interface StoreInstallOptions {
	publicSlug: string;
	namespace?: string;
	/** directory to install into (the caller stages it, then moves it) */
	dir: string;
}

export interface StoreInstallResult {
	ok: boolean;
	code: number;
	stdout: string;
	stderr: string;
	ms: number;
}

export interface SkillStore {
	/** config value, e.g. "skillhub" */
	id: string;
	/** human label for status output */
	label: string;
	/** can this store install, or is it search-only right now? */
	canInstall(): boolean;
	/** why `canInstall()` is false, for status output */
	installHint(): string;
	/** search by a short capability phrase */
	search(term: string, limit: number): Promise<CatalogEntry[]>;
	/** bulk catalog for local prediction (may be empty for stores that lack one) */
	showcase(): Promise<CatalogEntry[]>;
	/** install one skill into `opts.dir` */
	install(opts: StoreInstallOptions, timeoutMs: number): Promise<StoreInstallResult>;
}

const registry = new Map<string, SkillStore>();

export function registerStore(store: SkillStore): void {
	registry.set(store.id, store);
}

export function listStores(): string[] {
	return [...registry.keys()];
}

export function getStore(id: string): SkillStore | undefined {
	return registry.get(id) ?? registry.get("skillhub");
}

export function resolveStore(id: string | undefined): SkillStore | undefined {
	return id ? getStore(id) : registry.values().next().value;
}
