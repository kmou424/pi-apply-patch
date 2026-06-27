import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	getLanguageFromPath,
	highlightCode,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import * as Diff from "diff";
import { Type } from "typebox";
import { writeFileAtomic } from "./write-file-atomic.js";

const APPLY_PATCH_PARAMS = Type.Object({
	input: Type.String({
		description: "The entire contents of the apply_patch command",
	}),
});

type ParsedPatch =
	| { type: "add"; filePath: string; content: string }
	| { type: "delete"; filePath: string }
	| { type: "update"; filePath: string; movePath?: string; chunks: PatchChunk[] };

type PatchChunk = {
	changeContexts: string[];
	oldLines: string[];
	newLines: string[];
	isEndOfFile: boolean;
};

export type FreeformToolFormat = {
	type: "grammar";
	syntax: "lark";
	definition: string;
};

type ApplyPatchToolDefinition = ToolDefinition<
	typeof APPLY_PATCH_PARAMS,
	ApplyPatchToolDetails | undefined,
	ApplyPatchToolRenderState
> & {
	freeform: FreeformToolFormat;
};

export type ApplyPatchExtensionAPI = Pick<ExtensionAPI, "on" | "getActiveTools" | "setActiveTools"> & {
	registerTool: (tool: ApplyPatchToolDefinition) => void;
};

type ApplyPatchParams = {
	input: string;
};

type ApplyPatchOperation = "add" | "delete" | "update";

type ApplyPatchPreviewFile = {
	filePath: string;
	movePath?: string;
	operation: ApplyPatchOperation;
	diff: string;
	added: number;
	removed: number;
};

type ApplyPatchPreview = {
	files: ApplyPatchPreviewFile[];
	added: number;
	removed: number;
};

type ApplyPatchToolDetails = {
	preview?: ApplyPatchPreview;
	progress?: ApplyPatchProgress;
	result?: ApplyPatchResult;
};

type ApplyPatchProgress = {
	applied: number;
	failed: number;
	total: number;
};

type ApplyPatchProgressCallback = (progress: ApplyPatchProgress) => Promise<void> | void;

async function notifyApplyPatchProgress(
	onProgress: ApplyPatchProgressCallback | undefined,
	progress: ApplyPatchProgress,
): Promise<void> {
	try {
		await onProgress?.(progress);
	} catch {
		// Rendering progress must not affect patch application or recovery details.
	}
}

export type ApplyPatchFailure = {
	filePath: string;
	operation: ApplyPatchOperation;
	message: string;
};

export type ApplyPatchRecoveryInstructions = {
	mustReadFiles: string[];
	mustNotReadFiles: string[];
};

export type ApplyPatchResult = {
	summaries: string[];
	appliedFiles: string[];
	failures: ApplyPatchFailure[];
	hasPartialSuccess: boolean;
	recoveryInstructions: ApplyPatchRecoveryInstructions;
	details: {
		fuzz: number;
	};
};

export class ApplyPatchError extends Error {
	public readonly failures: ApplyPatchFailure[];
	public readonly result: ApplyPatchResult;

	constructor(message: string, result: ApplyPatchResult) {
		super(message);
		this.name = "ApplyPatchError";
		this.failures = result.failures;
		this.result = result;
	}

	hasPartialSuccess(): boolean {
		return this.result.hasPartialSuccess;
	}
}

export class PatchParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PatchParseError";
	}
}

export class PatchApplicationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PatchApplicationError";
	}
}

type ApplyPatchRenderState = {
	cwd: string;
	patchText: string;
	callText: string;
};

type ApplyPatchToolRenderState = {
	callComponent?: ApplyPatchCallRenderComponent;
};

type ApplyPatchThemeColor =
	| "accent"
	| "error"
	| "muted"
	| "toolDiffAdded"
	| "toolDiffContext"
	| "toolDiffRemoved"
	| "toolOutput"
	| "toolTitle";

type ApplyPatchThemeBg = "toolErrorBg" | "toolPendingBg" | "toolSuccessBg";

type ApplyPatchTheme = {
	fg: (name: ApplyPatchThemeColor, text: string) => string;
	bg: (name: ApplyPatchThemeBg, text: string) => string;
	bold: (text: string) => string;
	inverse: (text: string) => string;
};

function hasErrorCode(error: unknown, code: string): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

const GPT_APPLY_PATCH_PROVIDERS = new Set(["openai", "openai-codex", "azure-openai-responses", "github-copilot"]);
export const PATCH_PREVIEW_MAX_LINES = 16;
export const PATCH_PREVIEW_MAX_CHARS = 4000;
const PATCH_PREVIEW_HEAD_LINES = 8;
const PATCH_PREVIEW_TAIL_LINES = PATCH_PREVIEW_MAX_LINES - PATCH_PREVIEW_HEAD_LINES - 1;
const PATCH_PREVIEW_TRUNCATION_MARKER = "...";
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const applyPatchRenderStates = new Map<string, ApplyPatchRenderState>();

class ApplyPatchCallRenderComponent extends Box {
	preview: ApplyPatchPreview | undefined;
	progress: ApplyPatchProgress | undefined;
	result: ApplyPatchResult | undefined;
	resultText: string | undefined;
	callText = "Patching";
	cwd = process.cwd();
	patchText = "";
	settledError = false;
}

function getApplyPatchCallRenderComponent(
	state: ApplyPatchToolRenderState,
	lastComponent: unknown,
): ApplyPatchCallRenderComponent {
	if (lastComponent instanceof ApplyPatchCallRenderComponent) {
		state.callComponent = lastComponent;
		return lastComponent;
	}
	if (state.callComponent) {
		return state.callComponent;
	}
	const component = new ApplyPatchCallRenderComponent(1, 1, (text: string) => text);
	state.callComponent = component;
	return component;
}

function getApplyPatchHeaderBg(
	component: ApplyPatchCallRenderComponent,
	theme: ApplyPatchTheme,
): (text: string) => string {
	if (component.settledError || (component.result !== undefined && component.result.failures.length > 0)) {
		return (text: string) => theme.bg("toolErrorBg", text);
	}
	if (component.preview && !component.progress) {
		return (text: string) => theme.bg("toolSuccessBg", text);
	}
	return (text: string) => theme.bg("toolPendingBg", text);
}

function getPatchResultTarget(result: ApplyPatchResult, cwd: string): string {
	const failedFiles = result.failures.map((failure) => displayPath(failure.filePath, cwd));
	if (failedFiles.length === 1 && failedFiles[0]) {
		return failedFiles[0];
	}
	const totalFiles = result.appliedFiles.length + failedFiles.length;
	if (totalFiles > 0) {
		return `${totalFiles} files`;
	}
	return "";
}

function renderPathText(filePath: string, cwd: string, theme: ApplyPatchTheme): string {
	return theme.fg("accent", displayPath(filePath, cwd));
}

function renderPatchFilePath(file: ApplyPatchPreviewFile, cwd: string, theme: ApplyPatchTheme): string {
	const filePath = renderPathText(file.filePath, cwd, theme);
	if (!file.movePath) {
		return filePath;
	}
	return `${filePath} ${theme.fg("muted", "→")} ${renderPathText(file.movePath, cwd, theme)}`;
}

function renderPatchFileHeader(file: ApplyPatchPreviewFile, cwd: string, theme: ApplyPatchTheme): string {
	return `${theme.fg("toolTitle", formatPatchOperation(file.operation))} ${renderPatchFilePath(file, cwd, theme)} ${theme.fg("muted", formatLineCountSummary(file.added, file.removed))}`;
}

function renderPatchPreviewTarget(preview: ApplyPatchPreview, cwd: string, theme: ApplyPatchTheme): string {
	const file = preview.files[0];
	if (preview.files.length === 1 && file) {
		return renderPatchFilePath(file, cwd, theme);
	}
	return theme.fg("accent", `${preview.files.length} files`);
}

function renderPatchResultTarget(result: ApplyPatchResult, cwd: string, theme: ApplyPatchTheme): string {
	const target = getPatchResultTarget(result, cwd);
	return target.length > 0 ? theme.fg("accent", target) : "";
}

function renderPendingCallTitle(component: ApplyPatchCallRenderComponent, theme: ApplyPatchTheme): string {
	const toolName = theme.fg("toolTitle", theme.bold("apply_patch"));
	try {
		const hunks = parsePatch(component.patchText);
		if (hunks.length === 1) {
			const hunk = hunks[0];
			if (hunk) {
				const pathText = renderPathText(hunk.filePath, component.cwd, theme);
				if (hunk.type === "update" && hunk.movePath !== undefined) {
					return `${toolName} ${theme.fg("toolTitle", "Patching")} ${pathText} ${theme.fg("muted", "→")} ${renderPathText(hunk.movePath, component.cwd, theme)}`;
				}
				return `${toolName} ${theme.fg("toolTitle", "Patching")} ${pathText}`;
			}
		}
		if (hunks.length > 1) {
			return `${toolName} ${theme.fg("toolTitle", "Patching")} ${theme.fg("accent", `${hunks.length} files`)}`;
		}
	} catch {
		// Fall through to the resilient text path for incomplete patch input.
	}

	return component.callText.length > 0 ? `${toolName} ${theme.fg("toolTitle", component.callText)}` : toolName;
}

function renderApplyPatchCallTitle(component: ApplyPatchCallRenderComponent, theme: ApplyPatchTheme): string {
	const toolName = theme.fg("toolTitle", theme.bold("apply_patch"));
	if (component.preview) {
		const target = renderPatchPreviewTarget(component.preview, component.cwd, theme);
		const lineSummary = theme.fg("muted", formatLineCountSummary(component.preview.added, component.preview.removed));
		if (component.progress) {
			return `${toolName} ${theme.fg("toolTitle", `${component.progress.applied + component.progress.failed}/${component.progress.total}`)} ${target} ${lineSummary}`;
		}
		if (component.result && component.result.failures.length > 0) {
			return `${toolName} ${target} ${lineSummary} ${theme.fg("error", "failed")}`;
		}
		return `${toolName} ${target} ${lineSummary}`;
	}

	if (component.result) {
		const target = renderPatchResultTarget(component.result, component.cwd, theme);
		if (component.result.failures.length > 0) {
			return target.length > 0
				? `${toolName} ${target} ${theme.fg("error", "failed")}`
				: `${toolName} ${theme.fg("error", "failed")}`;
		}
		return target.length > 0 ? `${toolName} ${target}` : toolName;
	}

	return renderPendingCallTitle(component, theme);
}

function buildApplyPatchCallComponent(
	component: ApplyPatchCallRenderComponent,
	theme: ApplyPatchTheme,
): ApplyPatchCallRenderComponent {
	component.setBgFn(getApplyPatchHeaderBg(component, theme));
	component.clear();
	component.addChild(new Text(renderApplyPatchCallTitle(component, theme), 0, 0));
	if (component.preview) {
		const body = renderPatchPreview(component.preview, component.cwd, theme, true, { omitSingleFileHeader: true });
		if (body.length > 0) {
			component.addChild(new Spacer(1));
			component.addChild(new Text(body, 0, 0));
		}
	}
	if (component.resultText !== undefined && component.resultText.length > 0) {
		component.addChild(new Spacer(1));
		const color = component.result?.failures.length ? "error" : "toolOutput";
		component.addChild(new Text(theme.fg(color, component.resultText), 0, 0));
	}
	return component;
}

function updateApplyPatchCallComponent(
	component: ApplyPatchCallRenderComponent,
	details: ApplyPatchToolDetails | undefined,
	cwd: string,
	theme: ApplyPatchTheme,
	settledError: boolean,
	resultText?: string,
): ApplyPatchCallRenderComponent {
	component.cwd = cwd;
	component.preview = details?.preview;
	component.progress = details?.progress;
	component.result = details?.result;
	component.resultText = resultText;
	component.settledError = settledError;
	return buildApplyPatchCallComponent(component, theme);
}

function isChangedPreviewLine(line: string): boolean {
	return /^[+-]\s*\d+\s/.test(line);
}

function countWindowLines(lines: string[], start: number, end: number): number {
	return end - start + (start > 0 ? 1 : 0) + (end < lines.length ? 1 : 0);
}

function getDiffLineNumberWidth(lines: string[]): number {
	let width = 1;
	for (const line of lines) {
		const match = line.match(/^[+\- ](\s*\d+)\s/);
		if (match?.[1]) {
			width = Math.max(width, match[1].length);
		}
	}
	return width;
}

function formatDiffTruncationLine(lines: string[]): string {
	return ` ${"".padStart(getDiffLineNumberWidth(lines), " ")} ${PATCH_PREVIEW_TRUNCATION_MARKER}`;
}

function formatPreviewWindow(lines: string[], start: number, end: number): string {
	const previewLines = lines.slice(start, end);
	const truncationLine = formatDiffTruncationLine(lines);
	if (start > 0) {
		previewLines.unshift(truncationLine);
	}
	if (end < lines.length) {
		previewLines.push(truncationLine);
	}
	return previewLines.join("\n");
}

function createChangedHunkPreview(lines: string[]): string | undefined {
	const firstChangedLine = lines.findIndex(isChangedPreviewLine);
	if (firstChangedLine === -1) {
		return undefined;
	}

	let start = firstChangedLine;
	let end = firstChangedLine + 1;
	while (end < lines.length) {
		const line = lines[end];
		if (line === undefined || !isChangedPreviewLine(line)) {
			break;
		}
		end++;
	}

	const changedHunkEnd = end;
	while (end > start && countWindowLines(lines, start, end) > PATCH_PREVIEW_MAX_LINES) {
		end--;
	}

	while (countWindowLines(lines, start, end) < PATCH_PREVIEW_MAX_LINES) {
		const canAddBefore = start > 0;
		const canAddAfter = end < lines.length;
		if (!canAddBefore && !canAddAfter) {
			break;
		}

		const beforeContextLines = firstChangedLine - start;
		const afterContextLines = end - changedHunkEnd;
		if (canAddBefore && (!canAddAfter || beforeContextLines <= afterContextLines)) {
			start--;
		} else {
			end++;
		}
	}

	return formatPreviewWindow(lines, start, end);
}

function countLines(text: string): number {
	if (text.length === 0) {
		return 0;
	}
	let lines = 1;
	for (let index = 0; index < text.length; index++) {
		if (text.charCodeAt(index) === 10) {
			lines += 1;
		}
	}
	return lines;
}

function enforcePreviewCharLimit(preview: string): string {
	if (preview.length <= PATCH_PREVIEW_MAX_CHARS) {
		return preview;
	}

	return `${preview.slice(0, PATCH_PREVIEW_MAX_CHARS - PATCH_PREVIEW_TRUNCATION_MARKER.length).trimEnd()}${PATCH_PREVIEW_TRUNCATION_MARKER}`;
}

export function truncatePreview(text: string): string {
	if (text.length <= PATCH_PREVIEW_MAX_CHARS && countLines(text) <= PATCH_PREVIEW_MAX_LINES) {
		return text;
	}

	const lines = text.split("\n");
	const changedHunkPreview = createChangedHunkPreview(lines);
	const previewText =
		changedHunkPreview ??
		[
			...lines.slice(0, PATCH_PREVIEW_HEAD_LINES),
			formatDiffTruncationLine(lines),
			...lines.slice(-PATCH_PREVIEW_TAIL_LINES),
		].join("\n");
	return enforcePreviewCharLimit(previewText);
}

function normalizeApplyPatchArguments(args: unknown): ApplyPatchParams {
	if (typeof args === "string") {
		return { input: args };
	}

	if (args && typeof args === "object" && "input" in args) {
		const input = (args as { input?: unknown }).input;
		if (typeof input === "string") {
			return { input };
		}
	}

	return { input: "" };
}

const STANDARD_EDIT_TOOL_NAMES = ["edit", "write"] as const;
export const APPLY_PATCH_FREEFORM_DESCRIPTION =
	"Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.";
export const APPLY_PATCH_LARK_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;

export function isOpenAIGptModel(model: Pick<Model<string>, "provider" | "id"> | undefined): boolean {
	return model !== undefined && GPT_APPLY_PATCH_PROVIDERS.has(model.provider) && model.id.startsWith("gpt-");
}

function normalizePatchText(patchText: string): string {
	return patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripHeredoc(input: string): string {
	const heredocMatch = input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
	if (heredocMatch) {
		return heredocMatch[2] ?? input;
	}
	return input;
}

function normalizeSeekLine(line: string): string {
	return line
		.trim()
		.replace(/[‐‑‒–—―−]/g, "-")
		.replace(/[‘’‚‛]/g, "'")
		.replace(/[“”„‟]/g, '"')
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function seekSequence(
	lines: string[],
	pattern: string[],
	start: number,
	eof: boolean,
): { index: number; fuzz: 0 | 1 | 100 | 10000 } | undefined {
	if (pattern.length === 0) {
		return { index: start, fuzz: 0 };
	}
	if (pattern.length > lines.length) {
		return undefined;
	}

	const searchStart = eof && lines.length >= pattern.length ? lines.length - pattern.length : start;
	const lastStart = lines.length - pattern.length;
	const matches = (index: number, compare: (left: string, right: string) => boolean): boolean => {
		for (let patternIndex = 0; patternIndex < pattern.length; patternIndex++) {
			const line = lines[index + patternIndex];
			const expected = pattern[patternIndex];
			if (line === undefined || expected === undefined || !compare(line, expected)) {
				return false;
			}
		}
		return true;
	};
	const matchesPrepared = (index: number, preparedLines: string[], preparedPattern: string[]): boolean => {
		for (let patternIndex = 0; patternIndex < preparedPattern.length; patternIndex++) {
			const line = preparedLines[index + patternIndex];
			const expected = preparedPattern[patternIndex];
			if (line === undefined || expected === undefined || line !== expected) {
				return false;
			}
		}
		return true;
	};

	for (let index = searchStart; index <= lastStart; index++) {
		if (matches(index, (line, expected) => line === expected)) {
			return { index, fuzz: 0 };
		}
	}
	const linesTrimEnd = lines.map((line) => line.trimEnd());
	const patternTrimEnd = pattern.map((line) => line.trimEnd());
	for (let index = searchStart; index <= lastStart; index++) {
		if (matchesPrepared(index, linesTrimEnd, patternTrimEnd)) {
			return { index, fuzz: 1 };
		}
	}
	const linesTrim = lines.map((line) => line.trim());
	const patternTrim = pattern.map((line) => line.trim());
	for (let index = searchStart; index <= lastStart; index++) {
		if (matchesPrepared(index, linesTrim, patternTrim)) {
			return { index, fuzz: 100 };
		}
	}
	const linesNormalized = lines.map(normalizeSeekLine);
	const patternNormalized = pattern.map(normalizeSeekLine);
	for (let index = searchStart; index <= lastStart; index++) {
		if (matchesPrepared(index, linesNormalized, patternNormalized)) {
			return { index, fuzz: 10000 };
		}
	}

	return undefined;
}

export function extractPatchedPaths(patchText: string): string[] {
	const normalized = stripHeredoc(normalizePatchText(patchText));
	const matches = normalized.matchAll(/^\*\*\* (?:(?:Add|Delete|Update) File|Move to): (.+)$/gm);
	return Array.from(matches, (match) => match[1] ?? "");
}

function createPatchDiff(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; added: number; removed: number } {
	const parts = Diff.diffLines(oldContent, newContent);
	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const lineNumWidth = String(Math.max(oldLines.length, newLines.length)).length;
	const output: string[] = [];
	let oldLineNum = 1;
	let newLineNum = 1;
	let added = 0;
	let removed = 0;
	let lastWasChange = false;

	for (let partIndex = 0; partIndex < parts.length; partIndex++) {
		const part = parts[partIndex];
		if (!part) {
			continue;
		}
		const rawLines = part.value.split("\n");
		if (rawLines[rawLines.length - 1] === "") {
			rawLines.pop();
		}

		if (part.added || part.removed) {
			for (const line of rawLines) {
				if (part.added) {
					output.push(`+${String(newLineNum).padStart(lineNumWidth, " ")} ${line}`);
					newLineNum++;
					added++;
					continue;
				}

				output.push(`-${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
				oldLineNum++;
				removed++;
			}
			lastWasChange = true;
			continue;
		}

		const nextPart = parts[partIndex + 1];
		const nextPartIsChange = nextPart !== undefined && Boolean(nextPart.added || nextPart.removed);
		const hasLeadingChange = lastWasChange;
		const hasTrailingChange = nextPartIsChange;

		if (hasLeadingChange && hasTrailingChange) {
			if (rawLines.length <= contextLines * 2) {
				for (const line of rawLines) {
					output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				const leadingLines = rawLines.slice(0, contextLines);
				const trailingLines = rawLines.slice(rawLines.length - contextLines);
				const skippedLines = rawLines.length - leadingLines.length - trailingLines.length;

				for (const line of leadingLines) {
					output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
				output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				oldLineNum += skippedLines;
				newLineNum += skippedLines;
				for (const line of trailingLines) {
					output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			}
		} else if (hasLeadingChange) {
			const shownLines = rawLines.slice(0, contextLines);
			const skippedLines = rawLines.length - shownLines.length;
			for (const line of shownLines) {
				output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
				oldLineNum++;
				newLineNum++;
			}
			if (skippedLines > 0) {
				output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				oldLineNum += skippedLines;
				newLineNum += skippedLines;
			}
		} else if (hasTrailingChange) {
			const skippedLines = Math.max(0, rawLines.length - contextLines);
			if (skippedLines > 0) {
				output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				oldLineNum += skippedLines;
				newLineNum += skippedLines;
			}
			for (const line of rawLines.slice(skippedLines)) {
				output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
				oldLineNum++;
				newLineNum++;
			}
		} else {
			oldLineNum += rawLines.length;
			newLineNum += rawLines.length;
		}

		lastWasChange = false;
	}

	return { diff: output.join("\n"), added, removed };
}

function normalizePathInput(input: string): string {
	let normalized = input.replace(UNICODE_SPACES, " ");
	if (normalized.startsWith("@")) {
		normalized = normalized.slice(1);
	}
	if (normalized === "~") {
		return homedir();
	}
	if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		return path.join(homedir(), normalized.slice(2));
	}
	if (/^file:\/\//.test(normalized)) {
		return fileURLToPath(normalized);
	}
	return normalized;
}

function resolvePathToCwd(filePath: string, cwd: string): string {
	const normalizedPath = normalizePathInput(filePath);
	const normalizedCwd = normalizePathInput(cwd);
	return path.isAbsolute(normalizedPath) ? path.resolve(normalizedPath) : path.resolve(normalizedCwd, normalizedPath);
}

async function readExistingFileForPreview(absolutePath: string): Promise<string> {
	try {
		return await readFile(absolutePath, "utf-8");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return "";
		}
		throw error;
	}
}

function formatLineCountSummary(added: number, removed: number): string {
	return `(+${added} -${removed})`;
}

function formatPatchFileSummary(file: ApplyPatchPreviewFile, cwd: string): string {
	return `${formatPatchFilePath(file, cwd)} ${formatLineCountSummary(file.added, file.removed)}`;
}

function formatPatchFileHeader(file: ApplyPatchPreviewFile, cwd: string): string {
	return `${formatPatchOperation(file.operation)} ${formatPatchFileSummary(file, cwd)}`;
}

function normalizeDisplayPath(filePath: string): string {
	return filePath.replaceAll(path.sep, "/");
}

export function displayPath(filePath: string, cwd: string): string {
	if (!path.isAbsolute(filePath)) {
		return normalizeDisplayPath(filePath);
	}

	const absoluteCwd = path.resolve(cwd);
	const relativePath = path.relative(absoluteCwd, filePath);
	if (
		relativePath === "" ||
		(!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath))
	) {
		return normalizeDisplayPath(relativePath || ".");
	}

	return normalizeDisplayPath(filePath);
}

export function formatPatchFilePath(file: ApplyPatchPreviewFile, cwd: string = process.cwd()): string {
	const filePath = displayPath(file.filePath, cwd);
	if (!file.movePath) {
		return filePath;
	}
	return `${filePath} → ${displayPath(file.movePath, cwd)}`;
}

function formatPatchOperation(operation: ApplyPatchOperation): string {
	if (operation === "add") {
		return "Added";
	}
	if (operation === "delete") {
		return "Deleted";
	}
	return "Edited";
}

export function formatPatchPreview(
	preview: ApplyPatchPreview,
	cwd: string = process.cwd(),
	expanded: boolean = true,
	options: { omitSingleFileHeader?: boolean } = {},
): string {
	const blocks: string[] = [];
	for (const file of preview.files) {
		const lines: string[] = [];
		if (!(options.omitSingleFileHeader && preview.files.length === 1)) {
			lines.push(formatPatchFileHeader(file, cwd));
		}
		if (expanded && file.diff) {
			lines.push(...truncatePreview(file.diff).split("\n"));
		}
		if (lines.length > 0) {
			blocks.push(lines.join("\n"));
		}
	}
	return blocks.join("\n\n");
}

function getApplyPatchRenderState(toolCallId: string, cwd: string, patchText: string): ApplyPatchRenderState {
	const existing = applyPatchRenderStates.get(toolCallId);
	if (existing && existing.cwd === cwd && existing.patchText === patchText) {
		return existing;
	}

	const callText = formatInFlightCallText(patchText, cwd);
	const nextState: ApplyPatchRenderState = { cwd, patchText, callText };
	applyPatchRenderStates.set(toolCallId, nextState);
	return nextState;
}

export function clearApplyPatchRenderState(): void {
	applyPatchRenderStates.clear();
}

export function formatInFlightCallText(patchText: string, cwd: string = process.cwd()): string {
	try {
		const hunks = parsePatch(patchText);
		if (hunks.length === 0) {
			return "Patching";
		}
		if (hunks.length === 1) {
			const hunk = hunks[0];
			if (!hunk) {
				return "Patching";
			}
			return hunk.type === "update" && hunk.movePath !== undefined
				? `Patching ${displayPath(hunk.filePath, cwd)} → ${displayPath(hunk.movePath, cwd)}`
				: `Patching ${displayPath(hunk.filePath, cwd)}`;
		}
		return `Patching ${hunks.length} files`;
	} catch {
		const paths = extractPatchedPaths(patchText);
		if (paths.length === 0) {
			return "Patching";
		}
		return paths.length === 1 ? `Patching ${displayPath(paths[0] ?? "", cwd)}` : `Patching ${paths.length} files`;
	}
}

function formatPendingPatchPaths(patchText: string): string {
	const text = formatInFlightCallText(patchText);
	if (text === "Patching") {
		return "Patching";
	}
	return `${text}...`;
}

type RenderableAddedDiffLine = { content: string; kind: "added"; lineNumber: string; sign: "+" };
type RenderableRemovedDiffLine = { content: string; kind: "removed"; lineNumber: string; sign: "-" };
type RenderableContextDiffLine = { content: string; kind: "context"; lineNumber: string; sign: " " };
type RenderableContentDiffLine = RenderableAddedDiffLine | RenderableContextDiffLine | RenderableRemovedDiffLine;
type RenderableDiffLine = RenderableContentDiffLine | { kind: "meta"; text: string };

function parseRenderableDiffLine(line: string): RenderableDiffLine {
	const match = line.match(/^([+\- ])(\s*\d*)\s(.*)$/);
	if (!match) {
		return { kind: "meta", text: line };
	}

	const sign = match[1];
	const lineNumber = match[2];
	if ((sign !== "+" && sign !== "-" && sign !== " ") || lineNumber === undefined) {
		return { kind: "meta", text: line };
	}

	const content = match[3] ?? "";
	if (sign === "+") {
		return { content, kind: "added", lineNumber, sign };
	}
	if (sign === "-") {
		return { content, kind: "removed", lineNumber, sign };
	}
	return { content, kind: "context", lineNumber, sign };
}

function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

function highlightDiffContent(content: string, filePath: string): string {
	const plainContent = replaceTabs(content);
	const language = getLanguageFromPath(filePath);
	try {
		return highlightCode(plainContent, language)[0] ?? plainContent;
	} catch {
		return plainContent;
	}
}

function renderInlineDiff(
	oldContent: string,
	newContent: string,
	theme: ApplyPatchTheme,
): { added: string; removed: string } {
	const parts = Diff.diffWords(replaceTabs(oldContent), replaceTabs(newContent));
	let added = "";
	let removed = "";
	let firstAdded = true;
	let firstRemoved = true;

	for (const part of parts) {
		if (part.added) {
			let value = part.value;
			if (firstAdded) {
				const leadingWhitespace = value.match(/^(\s*)/)?.[1] ?? "";
				added += leadingWhitespace;
				value = value.slice(leadingWhitespace.length);
				firstAdded = false;
			}
			if (value) {
				added += theme.inverse(value);
			}
			continue;
		}

		if (part.removed) {
			let value = part.value;
			if (firstRemoved) {
				const leadingWhitespace = value.match(/^(\s*)/)?.[1] ?? "";
				removed += leadingWhitespace;
				value = value.slice(leadingWhitespace.length);
				firstRemoved = false;
			}
			if (value) {
				removed += theme.inverse(value);
			}
			continue;
		}

		added += part.value;
		removed += part.value;
	}

	return { added, removed };
}

function renderOpenCodeLikeDiffLine(
	line: RenderableContentDiffLine,
	filePath: string,
	theme: ApplyPatchTheme,
	contentOverride?: string,
): string {
	const lineNumber = theme.fg("muted", line.lineNumber);
	if (line.kind === "context") {
		return `${theme.fg("toolDiffContext", line.sign)}${lineNumber} ${highlightDiffContent(line.content, filePath)}`;
	}

	const diffColor = line.kind === "added" ? "toolDiffAdded" : "toolDiffRemoved";
	const content =
		contentOverride === undefined
			? highlightDiffContent(line.content, filePath)
			: theme.fg(diffColor, replaceTabs(contentOverride));
	return theme.fg(diffColor, `${line.sign}${lineNumber} ${content}`);
}

function renderOpenCodeLikeDiff(diffText: string, filePath: string, theme: ApplyPatchTheme): string {
	const parsedLines = diffText.split("\n").map(parseRenderableDiffLine);
	const rendered: string[] = [];
	let index = 0;

	while (index < parsedLines.length) {
		const line = parsedLines[index];
		if (!line) {
			index++;
			continue;
		}

		if (line.kind !== "removed") {
			rendered.push(
				line.kind === "meta"
					? theme.fg("toolDiffContext", line.text)
					: renderOpenCodeLikeDiffLine(line, filePath, theme),
			);
			index++;
			continue;
		}

		const removedLines: RenderableRemovedDiffLine[] = [];
		while (parsedLines[index]?.kind === "removed") {
			const removedLine = parsedLines[index];
			if (removedLine?.kind === "removed") {
				removedLines.push(removedLine);
			}
			index++;
		}

		const addedLines: RenderableAddedDiffLine[] = [];
		while (parsedLines[index]?.kind === "added") {
			const addedLine = parsedLines[index];
			if (addedLine?.kind === "added") {
				addedLines.push(addedLine);
			}
			index++;
		}

		const pairedCount = Math.min(removedLines.length, addedLines.length);
		for (let pairIndex = 0; pairIndex < pairedCount; pairIndex++) {
			const removedLine = removedLines[pairIndex];
			const addedLine = addedLines[pairIndex];
			if (!removedLine || !addedLine) {
				continue;
			}

			const inline = renderInlineDiff(removedLine.content, addedLine.content, theme);
			rendered.push(renderOpenCodeLikeDiffLine(removedLine, filePath, theme, inline.removed));
			rendered.push(renderOpenCodeLikeDiffLine(addedLine, filePath, theme, inline.added));
		}

		for (const removedLine of removedLines.slice(pairedCount)) {
			rendered.push(renderOpenCodeLikeDiffLine(removedLine, filePath, theme));
		}
		for (const addedLine of addedLines.slice(pairedCount)) {
			rendered.push(renderOpenCodeLikeDiffLine(addedLine, filePath, theme));
		}
	}

	return rendered.join("\n");
}

function renderPatchPreview(
	preview: ApplyPatchPreview,
	cwd: string,
	theme: ApplyPatchTheme,
	expanded: boolean,
	options: { omitSingleFileHeader?: boolean } = {},
): string {
	if (expanded) {
		try {
			const renderFile = (file: ApplyPatchPreviewFile, omitHeader: boolean): string => {
				const lines: string[] = [];
				if (!omitHeader) {
					lines.push(theme.bold(renderPatchFileHeader(file, cwd, theme)));
				}
				if (!file.diff) {
					return lines.join("\n");
				}
				const previewDiff = truncatePreview(file.diff);
				const renderedDiff = renderOpenCodeLikeDiff(previewDiff, file.movePath ?? file.filePath, theme);
				lines.push(renderedDiff);
				return lines.join("\n");
			};

			if (preview.files.length === 1) {
				const file = preview.files[0];
				return file ? renderFile(file, options.omitSingleFileHeader === true) : "";
			}

			return preview.files.map((file) => renderFile(file, false)).join("\n\n");
		} catch {
			// fall back to manual themed line rendering
		}
	}

	return formatPatchPreview(preview, cwd, expanded, options)
		.split("\n")
		.map((line) => {
			const trimmed = line.trimStart();
			if (trimmed.startsWith("+")) {
				return theme.fg("toolDiffAdded", line);
			}
			if (trimmed.startsWith("-")) {
				return theme.fg("toolDiffRemoved", line);
			}
			if (/^(Added|Deleted|Edited)\b/.test(trimmed)) {
				return theme.fg("toolTitle", theme.bold(line));
			}
			return theme.fg("toolDiffContext", line);
		})
		.join("\n");
}

async function createPatchPreview(cwd: string, hunks: ParsedPatch[]): Promise<ApplyPatchPreview> {
	const files: ApplyPatchPreviewFile[] = [];
	for (const hunk of hunks) {
		const absolutePath = resolvePatchPath(cwd, hunk.filePath);
		if (hunk.type === "add") {
			const oldContent = await readExistingFileForPreview(absolutePath);
			const diff = createPatchDiff(oldContent, hunk.content);
			files.push({ filePath: hunk.filePath, operation: oldContent.length > 0 ? "update" : "add", ...diff });
			continue;
		}

		if (hunk.type === "delete") {
			const oldContent = await readFile(absolutePath, "utf-8");
			const diff = createPatchDiff(oldContent, "");
			files.push({ filePath: hunk.filePath, operation: "delete", ...diff });
			continue;
		}

		const oldContent = await readFile(absolutePath, "utf-8");
		const newContent =
			hunk.chunks.length === 0 ? oldContent : replaceChunks(oldContent, hunk.filePath, hunk.chunks).content;
		if (hunk.movePath) {
			resolvePatchPath(cwd, hunk.movePath);
		}
		const diff = createPatchDiff(oldContent, newContent);
		const file = { filePath: hunk.filePath, operation: "update", ...diff } satisfies ApplyPatchPreviewFile;
		files.push(hunk.movePath !== undefined ? { ...file, movePath: hunk.movePath } : file);
	}

	return {
		files,
		added: files.reduce((sum, file) => sum + file.added, 0),
		removed: files.reduce((sum, file) => sum + file.removed, 0),
	};
}

function parsePatch(patchText: string): ParsedPatch[] {
	const normalized = stripHeredoc(normalizePatchText(patchText).trim()).trim();
	const lines = normalized.split("\n");
	const beginIndex = lines[0]?.trim() === "*** Begin Patch" ? 0 : -1;
	const lastLine = lines[lines.length - 1];
	const endIndex = lastLine?.trim() === "*** End Patch" ? lines.length - 1 : -1;

	if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
		throw new PatchParseError("Invalid patch format: expected *** Begin Patch ... *** End Patch envelope");
	}

	const hunks: ParsedPatch[] = [];
	let index = beginIndex + 1;
	while (index < endIndex) {
		const line = lines[index] ?? "";
		if (!line.startsWith("*** ")) {
			index++;
			continue;
		}

		if (line.startsWith("*** Add File: ")) {
			const filePath = line.slice("*** Add File: ".length);
			index++;
			const contentLines: string[] = [];
			while (index < endIndex) {
				const nextLine = lines[index] ?? "";
				if (nextLine.startsWith("*** ")) {
					break;
				}
				if (!nextLine.startsWith("+")) {
					throw new PatchParseError(`Invalid patch format: Add File lines must start with '+'`);
				}
				contentLines.push(nextLine.slice(1));
				index++;
			}
			hunks.push({
				type: "add",
				filePath,
				content: contentLines.length === 0 ? "" : `${contentLines.join("\n")}\n`,
			});
			continue;
		}

		if (line.startsWith("*** Delete File: ")) {
			hunks.push({ type: "delete", filePath: line.slice("*** Delete File: ".length) });
			index++;
			continue;
		}

		if (line.startsWith("*** Update File: ")) {
			const filePath = line.slice("*** Update File: ".length);
			index++;
			let movePath: string | undefined;
			if ((lines[index] ?? "").startsWith("*** Move to: ")) {
				movePath = (lines[index] ?? "").slice("*** Move to: ".length);
				index++;
			}

			const chunks: PatchChunk[] = [];
			while (index < endIndex) {
				const nextLine = lines[index] ?? "";
				if (nextLine.trim() === "") {
					index++;
					continue;
				}
				if (nextLine.startsWith("*** ")) {
					break;
				}

				const allowMissingContext = chunks.length === 0;
				const changeContexts: string[] = [];
				if (nextLine.startsWith("@@")) {
					while (index < endIndex) {
						const contextLine = lines[index] ?? "";
						if (contextLine === "@@") {
							index++;
							continue;
						}
						if (contextLine.startsWith("@@ ")) {
							changeContexts.push(contextLine.slice("@@ ".length));
							index++;
							continue;
						}
						break;
					}
				} else if (!allowMissingContext) {
					throw new PatchParseError(`Expected update hunk to start with a @@ context marker, got: '${nextLine}'`);
				}

				const oldLines: string[] = [];
				const newLines: string[] = [];
				let isEndOfFile = false;
				let parsedLines = 0;
				while (index < endIndex) {
					const hunkLine = lines[index] ?? "";
					if (hunkLine === "*** End of File") {
						if (parsedLines === 0) {
							throw new PatchParseError("Update hunk does not contain any lines");
						}
						isEndOfFile = true;
						index++;
						break;
					}
					if (hunkLine.startsWith("@@") || hunkLine.startsWith("*** ")) {
						break;
					}
					const prefix = hunkLine[0];
					const value = hunkLine.slice(1);
					if (prefix === undefined) {
						oldLines.push("");
						newLines.push("");
					} else if (prefix === " ") {
						oldLines.push(value);
						newLines.push(value);
					} else if (prefix === "-") {
						oldLines.push(value);
					} else if (prefix === "+") {
						newLines.push(value);
					} else if (parsedLines > 0) {
						break;
					} else {
						throw new PatchParseError(
							`Unexpected line found in update hunk: '${hunkLine}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
						);
					}
					parsedLines++;
					index++;
				}

				if (parsedLines === 0) {
					throw new PatchParseError("Update hunk does not contain any lines");
				}
				chunks.push({ changeContexts, oldLines, newLines, isEndOfFile });
			}
			if (chunks.length === 0 && !movePath) {
				throw new PatchParseError(`Update file hunk for path '${filePath}' is empty`);
			}

			hunks.push(
				movePath !== undefined
					? { type: "update", filePath, movePath, chunks }
					: { type: "update", filePath, chunks },
			);
			continue;
		}

		throw new PatchParseError(
			`'${line}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
		);
	}

	return hunks;
}

function parseNonEmptyPatch(patchText: string): ParsedPatch[] {
	const hunks = parsePatch(patchText);
	if (hunks.length > 0) {
		return hunks;
	}

	const normalized = normalizePatchText(patchText).trim();
	if (normalized === "*** Begin Patch\n*** End Patch") {
		throw new PatchParseError("patch rejected: empty patch");
	}
	throw new PatchParseError("apply_patch verification failed: no hunks found");
}

function splitFileLines(content: string): string[] {
	const lines = normalizePatchText(content).split("\n");
	if (lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

function replaceChunks(content: string, filePath: string, chunks: PatchChunk[]): { content: string; fuzz: number } {
	const originalLines = splitFileLines(content);
	const replacements: { start: number; oldLength: number; newLines: string[] }[] = [];
	let lineIndex = 0;
	let fuzz = 0;

	for (const chunk of chunks) {
		for (const changeContext of chunk.changeContexts) {
			const contextMatch = seekSequence(originalLines, [changeContext], lineIndex, false);
			if (contextMatch === undefined) {
				throw new PatchApplicationError(`Failed to find context '${changeContext}' in ${filePath}`);
			}
			fuzz += contextMatch.fuzz;
			lineIndex = contextMatch.index + 1;
		}

		if (chunk.oldLines.length === 0) {
			const insertionIndex =
				originalLines[originalLines.length - 1] === "" ? originalLines.length - 1 : originalLines.length;
			replacements.push({ start: insertionIndex, oldLength: 0, newLines: chunk.newLines });
			continue;
		}

		let pattern = chunk.oldLines;
		let newLines = chunk.newLines;
		let foundAt = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
		if (foundAt === undefined && pattern[pattern.length - 1] === "") {
			pattern = pattern.slice(0, -1);
			if (newLines[newLines.length - 1] === "") {
				newLines = newLines.slice(0, -1);
			}
			foundAt = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
		}

		if (foundAt === undefined) {
			throw new PatchApplicationError(`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`);
		}

		fuzz += foundAt.fuzz;
		replacements.push({ start: foundAt.index, oldLength: pattern.length, newLines });
		lineIndex = foundAt.index + pattern.length;
	}

	const nextLines = [...originalLines];
	for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
		nextLines.splice(replacement.start, replacement.oldLength, ...replacement.newLines);
	}
	nextLines.push("");
	return { content: nextLines.join("\n"), fuzz };
}

async function applySingleHunk(
	cwd: string,
	hunk: ParsedPatch,
): Promise<{ summary: string; appliedFile: string; fuzz: number }> {
	const absolutePath = resolvePatchPath(cwd, hunk.filePath);
	if (hunk.type === "add") {
		await mkdir(path.dirname(absolutePath), { recursive: true });
		await writeFileAtomic(absolutePath, hunk.content);
		return { summary: `add: ${hunk.filePath}`, appliedFile: hunk.filePath, fuzz: 0 };
	}

	if (hunk.type === "delete") {
		await stat(absolutePath);
		await rm(absolutePath);
		return { summary: `delete: ${hunk.filePath}`, appliedFile: hunk.filePath, fuzz: 0 };
	}

	const currentContent = await readFile(absolutePath, "utf-8");
	const chunkResult =
		hunk.chunks.length === 0
			? { content: currentContent, fuzz: 0 }
			: replaceChunks(currentContent, hunk.filePath, hunk.chunks);
	const nextContent = chunkResult.content;

	if (hunk.movePath) {
		const absoluteMovePath = resolvePatchPath(cwd, hunk.movePath);
		await mkdir(path.dirname(absoluteMovePath), { recursive: true });
		await writeFileAtomic(absoluteMovePath, nextContent);
		if (absoluteMovePath !== absolutePath) {
			await rm(absolutePath);
		}
		return {
			summary: `move: ${hunk.filePath} -> ${hunk.movePath}`,
			appliedFile: hunk.movePath,
			fuzz: chunkResult.fuzz,
		};
	}

	await writeFileAtomic(absolutePath, nextContent);
	return { summary: `update: ${hunk.filePath}`, appliedFile: hunk.filePath, fuzz: chunkResult.fuzz };
}

export async function applyPatchDetailed(
	cwd: string,
	patchText: string,
	onProgress?: ApplyPatchProgressCallback,
): Promise<ApplyPatchResult> {
	return applyParsedPatchDetailed(cwd, parseNonEmptyPatch(patchText), onProgress);
}

async function applyParsedPatchDetailed(
	cwd: string,
	hunks: ParsedPatch[],
	onProgress?: ApplyPatchProgressCallback,
): Promise<ApplyPatchResult> {
	const summaries: string[] = [];
	const appliedFiles: string[] = [];
	const failures: ApplyPatchFailure[] = [];
	let fuzz = 0;

	for (const hunk of hunks) {
		try {
			const { summary, appliedFile, fuzz: hunkFuzz } = await applySingleHunk(cwd, hunk);
			summaries.push(summary);
			appliedFiles.push(appliedFile);
			fuzz += hunkFuzz;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			failures.push({ filePath: hunk.filePath, operation: hunk.type, message });
		}
		await notifyApplyPatchProgress(onProgress, {
			applied: appliedFiles.length,
			failed: failures.length,
			total: hunks.length,
		});
	}

	const result: ApplyPatchResult = {
		summaries,
		appliedFiles,
		failures,
		hasPartialSuccess: appliedFiles.length > 0 && failures.length > 0,
		recoveryInstructions: { mustReadFiles: [], mustNotReadFiles: [] },
		details: { fuzz },
	};
	result.recoveryInstructions = createRecoveryInstructions(result);
	return result;
}

function createRecoveryInstructions(
	result: Pick<ApplyPatchResult, "appliedFiles" | "failures">,
): ApplyPatchRecoveryInstructions {
	const mustReadFiles = [...new Set(result.failures.map((failure) => failure.filePath))];
	const mustReadFileSet = new Set(mustReadFiles);
	const mustNotReadFiles = [...new Set(result.appliedFiles.filter((filePath) => !mustReadFileSet.has(filePath)))];
	return { mustReadFiles, mustNotReadFiles };
}

export async function applyPatch(cwd: string, patchText: string): Promise<string[]> {
	const hunks = parseNonEmptyPatch(patchText);

	const summaries: string[] = [];
	const appliedFiles: string[] = [];
	for (const hunk of hunks) {
		try {
			const { summary, appliedFile } = await applySingleHunk(cwd, hunk);
			summaries.push(summary);
			appliedFiles.push(appliedFile);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const failure = { filePath: hunk.filePath, operation: hunk.type, message } satisfies ApplyPatchFailure;
			const result: ApplyPatchResult = {
				summaries,
				appliedFiles,
				failures: [failure],
				hasPartialSuccess: appliedFiles.length > 0,
				recoveryInstructions: createRecoveryInstructions({
					appliedFiles,
					failures: [failure],
				}),
				details: { fuzz: 0 },
			};
			throw new ApplyPatchError(message, result);
		}
	}

	return summaries;
}

async function createPendingPatchUpdate(
	cwd: string,
	patchText: string,
	progress?: ApplyPatchProgress,
	previewOverride?: ApplyPatchPreview,
	parsedHunks?: ParsedPatch[],
): Promise<{ text: string; details: ApplyPatchToolDetails | undefined }> {
	const title = progress
		? `${formatInFlightCallText(patchText, cwd)} ${progress.applied + progress.failed}/${progress.total}`
		: formatInFlightCallText(patchText, cwd);
	if (previewOverride) {
		const details: ApplyPatchToolDetails = { preview: previewOverride };
		if (progress) details.progress = progress;
		return {
			text: `${title}\n${formatPatchPreview(previewOverride, cwd, true, { omitSingleFileHeader: true })}`,
			details,
		};
	}

	try {
		const hunks = parsedHunks ?? parsePatch(patchText);
		if (hunks.length === 0) {
			return { text: title, details: progress ? { progress } : undefined };
		}

		const preview = await createPatchPreview(cwd, hunks);
		if (preview.files.some((file) => file.diff.trim().length > 0)) {
			const details: ApplyPatchToolDetails = { preview };
			if (progress) details.progress = progress;
			return {
				text: `${title}\n${formatPatchPreview(preview, cwd, true, { omitSingleFileHeader: true })}`,
				details,
			};
		}
	} catch {
		return {
			text: progress ? title : formatPendingPatchPaths(patchText),
			details: progress ? { progress } : undefined,
		};
	}

	return { text: progress ? title : formatPendingPatchPaths(patchText), details: progress ? { progress } : undefined };
}

function withoutExtensionManagedEditTools(toolNames: string[]): string[] {
	return toolNames.filter(
		(toolName) =>
			toolName !== "apply_patch" && !STANDARD_EDIT_TOOL_NAMES.some((editToolName) => editToolName === toolName),
	);
}

function replaceEditToolsWithApplyPatch(toolNames: string[]): string[] {
	return [...withoutExtensionManagedEditTools(toolNames), "apply_patch"];
}

function replaceApplyPatchWithEditTools(toolNames: string[]): string[] {
	return [...withoutExtensionManagedEditTools(toolNames), ...STANDARD_EDIT_TOOL_NAMES];
}

function resolvePatchPath(cwd: string, filePath: string): string {
	return resolvePathToCwd(filePath, cwd);
}

function syncToolset(
	pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
	model: Model<string> | undefined,
): void {
	const currentToolNames = pi.getActiveTools();
	if (isOpenAIGptModel(model)) {
		pi.setActiveTools(replaceEditToolsWithApplyPatch(currentToolNames));
		return;
	}

	pi.setActiveTools(replaceApplyPatchWithEditTools(currentToolNames));
}

export function createApplyPatchTool(): ApplyPatchToolDefinition {
	const tool = defineTool({
		name: "apply_patch",
		label: "ApplyPatch",
		description: APPLY_PATCH_FREEFORM_DESCRIPTION,
		parameters: APPLY_PATCH_PARAMS,
		prepareArguments: normalizeApplyPatchArguments,
		promptSnippet: "Apply Codex-format file patches with apply_patch",
		promptGuidelines: [
			"Use apply_patch for file edits instead of mutating files through bash, Python scripts, heredocs, or shell redirection.",
			"After apply_patch succeeds, do not re-read the edited files just to confirm the patch applied.",
		],
		async execute(
			_toolCallId,
			params,
			_signal,
			onUpdate,
			ctx,
		): Promise<AgentToolResult<ApplyPatchToolDetails | undefined>> {
			const normalizedParams = normalizeApplyPatchArguments(params);
			if (!normalizedParams.input) {
				throw new Error("input is required");
			}

			let parsedHunks: ParsedPatch[] | undefined;
			try {
				parsedHunks = parseNonEmptyPatch(normalizedParams.input);
			} catch {
				// createPendingPatchUpdate keeps incomplete or invalid patch text renderable.
			}
			const totalOperations = parsedHunks?.length ?? 0;
			const initialProgress = totalOperations > 0 ? { applied: 0, failed: 0, total: totalOperations } : undefined;
			const pendingUpdate = await createPendingPatchUpdate(
				ctx.cwd,
				normalizedParams.input,
				initialProgress,
				undefined,
				parsedHunks,
			);
			onUpdate?.({
				content: [{ type: "text", text: pendingUpdate.text }],
				details: pendingUpdate.details,
			});

			const preview = pendingUpdate.details?.preview;
			const result = await applyParsedPatchDetailed(
				ctx.cwd,
				parsedHunks ?? parseNonEmptyPatch(normalizedParams.input),
				async (progress) => {
					const progressUpdate = await createPendingPatchUpdate(
						ctx.cwd,
						normalizedParams.input,
						progress,
						preview,
						parsedHunks,
					);
					onUpdate?.({
						content: [{ type: "text", text: progressUpdate.text }],
						details: progressUpdate.details,
					});
				},
			);
			if (result.failures.length > 0) {
				const mustReadFiles = result.recoveryInstructions.mustReadFiles;
				const failed = mustReadFiles.join(", ");
				const mustReadText = mustReadFiles.join(" and ");
				return {
					content: [
						{
							type: "text",
							text: [
								"apply_patch partially failed.",
								`Failed: ${failed}`,
								`Recovery: MUST read ${mustReadText} before retrying.`,
								result.appliedFiles.length > 0
									? "Earlier file actions in this patch were already applied."
									: "No file actions were applied.",
								result.recoveryInstructions.mustNotReadFiles.length > 0
									? "Recovery: MUST NOT reread other files from this patch unless a specific dependency requires it."
									: "",
							]
								.filter((line) => line.length > 0)
								.join("\n"),
						},
					],
					details: preview ? { preview, result } : { result },
				};
			}

			return {
				content: [{ type: "text", text: result.summaries.join("\n") }],
				details: preview ? { preview, result } : { result },
			};
		},
		renderCall(args, theme, context) {
			const component = getApplyPatchCallRenderComponent(context.state, context.lastComponent);
			component.cwd = context.cwd;
			component.progress = undefined;
			component.result = undefined;
			component.resultText = undefined;
			component.settledError = false;
			const normalizedArgs = normalizeApplyPatchArguments(args);
			component.patchText = normalizedArgs.input;
			if (!context.argsComplete) {
				component.preview = undefined;
				component.callText = "Patching";
				return buildApplyPatchCallComponent(component, theme);
			}

			const renderState = getApplyPatchRenderState(context.toolCallId, context.cwd, normalizedArgs.input);
			component.callText = renderState.callText;
			return buildApplyPatchCallComponent(component, theme);
		},
		renderResult(result, _options, theme, context) {
			const component = new Container();
			const callComponent = context.state.callComponent;
			const hasFailures = Boolean(result.details?.result?.failures.length);
			const text = result.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.filter((value) => typeof value === "string" && value.length > 0)
				.join("\n");
			const visibleResultText = hasFailures || !result.details?.preview ? text : undefined;
			if (callComponent) {
				updateApplyPatchCallComponent(
					callComponent,
					result.details,
					context.cwd,
					theme,
					context.isError || hasFailures,
					visibleResultText,
				);
			}
			return component;
		},
	});

	return Object.assign(tool, {
		freeform: {
			type: "grammar",
			syntax: "lark",
			definition: APPLY_PATCH_LARK_GRAMMAR,
		} satisfies FreeformToolFormat,
	});
}

export function registerApplyPatchExtension(pi: ApplyPatchExtensionAPI): void {
	pi.registerTool(createApplyPatchTool());

	pi.on("session_start", async (_event, ctx) => {
		syncToolset(pi, ctx.model);
	});

	pi.on("model_select", async (event) => {
		syncToolset(pi, event.model);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		syncToolset(pi, ctx.model);
	});
}

export default registerApplyPatchExtension;
