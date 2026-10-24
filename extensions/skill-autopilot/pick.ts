/**
 * Selection model for the multi-skill picker.
 *
 * Kept free of pi imports so the behaviour (default-all-selected, toggle, toggle
 * all, clamping to budget) can be tested without a terminal.
 */

import type { Candidate } from "./matcher.ts";

export interface PickItem {
	candidate: Candidate;
	/** why this skill is being proposed — a detected need or a plan step */
	reason: string;
}

export interface PickState {
	/** cursor position */
	index: number;
	/** one flag per item; defaults to all true so Enter installs everything */
	selected: boolean[];
}

export function createPickState(items: PickItem[], allSelected = true): PickState {
	return { index: 0, selected: items.map(() => allSelected) };
}

export function moveCursor(state: PickState, delta: number, count: number): PickState {
	if (count <= 0) return state;
	const index = (((state.index + delta) % count) + count) % count;
	return { ...state, index };
}

export function toggleAt(state: PickState, at: number): PickState {
	if (at < 0 || at >= state.selected.length) return state;
	const selected = state.selected.slice();
	selected[at] = !selected[at];
	return { ...state, selected };
}

/** Select all when anything is unselected, otherwise clear everything. */
export function toggleAll(state: PickState): PickState {
	const anyOff = state.selected.some((s) => !s);
	return { ...state, selected: state.selected.map(() => anyOff) };
}

export function chosenItems(state: PickState, items: PickItem[], limit = Number.POSITIVE_INFINITY): PickItem[] {
	const out: PickItem[] = [];
	for (let i = 0; i < items.length; i++) {
		if (!state.selected[i]) continue;
		if (out.length >= limit) break;
		out.push(items[i]);
	}
	return out;
}

export function selectedCount(state: PickState): number {
	return state.selected.filter(Boolean).length;
}

/** Compact, plain-text rendering shared by the TUI fallback and the log. */
export function describeItem(item: PickItem, maxDesc = 90): string[] {
	const c = item.candidate;
	const version = c.entry.version ? ` v${c.entry.version}` : "";
	const head = `${c.publicSlug}${version} — 相关度 ${c.score}`;
	const desc = (c.entry.description || "").replace(/\s+/g, " ").trim();
	const tail = desc.length > maxDesc ? `${desc.slice(0, maxDesc - 1)}…` : desc;
	return tail ? [head, `  ${item.reason} · ${tail}`] : [head, `  ${item.reason}`];
}
