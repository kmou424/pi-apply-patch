import { Box, Text, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	clearApplyPatchRenderState,
	createApplyPatchTool,
	displayPath,
	formatInFlightCallText,
	formatPatchPreview,
	PATCH_PREVIEW_MAX_CHARS,
	truncatePreview,
} from "../src/index.js";

const identityTheme = {
	fg: (_name: string, text: string) => text,
	bg: (_name: string, text: string) => text,
	bold: (text: string) => text,
	inverse: (text: string) => text,
};

const markerTheme = {
	fg: (name: string, text: string) => `<fg:${name}>${text}</fg:${name}>`,
	bg: (name: string, text: string) => `<bg:${name}>${text}</bg:${name}>`,
	bold: (text: string) => `<bold>${text}</bold>`,
	inverse: (text: string) => `<inverse>${text}</inverse>`,
};

const successBg = "\x1b[48;2;40;50;40m";
const bgReset = "\x1b[49m";
const ansiTheme = {
	fg: (_name: string, text: string) => text,
	bg: (name: string, text: string) => {
		const start = name === "toolSuccessBg" ? successBg : "\x1b[48;2;40;40;50m";
		return `${start}${text}${bgReset}`;
	},
	bold: (text: string) => text,
	inverse: (text: string) => text,
};

const edgeTheme = {
	fg: (name: string, text: string) => {
		const color = name === "toolDiffAdded" ? "32" : name === "toolDiffRemoved" ? "31" : "36";
		return `\x1b[${color}m${text}\x1b[39m`;
	},
	bg: (name: string, text: string) => {
		const start = name === "toolSuccessBg" ? successBg : "\x1b[48;2;40;40;50m";
		return `${start}${text}${bgReset}`;
	},
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	inverse: (text: string) => `\x1b[7m${text}\x1b[27m`,
};

function renderApplyPatchCallWithResult(
	result: Parameters<NonNullable<ReturnType<typeof createApplyPatchTool>["renderResult"]>>[0],
	theme: typeof identityTheme | typeof markerTheme | typeof ansiTheme | typeof edgeTheme = identityTheme,
	args = { input: "" },
): { callRendered: string; resultRendered: string } {
	const tool = createApplyPatchTool();
	const state = {};
	const callComponent = tool.renderCall?.(
		args,
		theme as never,
		{
			args,
			argsComplete: true,
			cwd: "/workspace/project",
			executionStarted: true,
			expanded: false,
			invalidate: () => undefined,
			isError: false,
			isPartial: true,
			lastComponent: undefined,
			showImages: false,
			state,
			toolCallId: "render-helper",
		} as never,
	);
	const resultComponent = tool.renderResult?.(
		result,
		{ expanded: false, isPartial: false },
		theme as never,
		{
			args,
			argsComplete: true,
			cwd: "/workspace/project",
			executionStarted: true,
			expanded: false,
			invalidate: () => undefined,
			isError: false,
			isPartial: false,
			lastComponent: undefined,
			showImages: false,
			state,
			toolCallId: "render-helper",
		} as never,
	);

	return {
		callRendered: callComponent?.render(240).join("\n") ?? "",
		resultRendered: resultComponent?.render(240).join("\n") ?? "",
	};
}

function renderInsideDefaultToolShell(
	inner: ReturnType<NonNullable<ReturnType<typeof createApplyPatchTool>["renderCall"]>>,
): string {
	const shell = new Box(1, 1, (text: string) => ansiTheme.bg("toolSuccessBg", text));
	shell.addChild(inner);
	return shell.render(80).join("\n");
}

describe("render helpers", () => {
	it("#given long line-bounded diff #when truncating #then keeps all lines", () => {
		// given
		const lines = Array.from({ length: 40 }, (_, index) => `line-${index + 1}`);
		const diff = lines.join("\n");

		// when
		const preview = truncatePreview(diff);

		// then
		expect(preview).toBe(diff);
	});

	it("#given huge payload #when truncating #then enforces max chars", () => {
		// given
		const diff = `${"x".repeat(PATCH_PREVIEW_MAX_CHARS + 500)}\nend`;

		// when
		const preview = truncatePreview(diff);

		// then
		expect(preview.length).toBeLessThanOrEqual(PATCH_PREVIEW_MAX_CHARS);
		expect(preview).toContain("...");
		expect(preview).not.toContain("…");
	});

	it("#given oversized changed hunk #when truncating #then keeps max chars strict", () => {
		// given
		const diff = [
			...Array.from({ length: 20 }, (_, index) => ` ${index + 1} line-${index + 1}`),
			`-21 ${"x".repeat(PATCH_PREVIEW_MAX_CHARS + 500)}`,
			"+21 changed",
		].join("\n");

		// when
		const preview = truncatePreview(diff);

		// then
		expect(preview.length).toBeLessThanOrEqual(PATCH_PREVIEW_MAX_CHARS);
		expect(preview).toContain("...");
		expect(preview).not.toContain("…");
	});

	it("#given absolute path under cwd #when displaying #then returns relative path", () => {
		// given
		const cwd = "/workspace/project";
		const absolute = "/workspace/project/src/index.ts";

		// when
		const rendered = displayPath(absolute, cwd);

		// then
		expect(rendered).toBe("src/index.ts");
	});

	it("#given absolute path outside cwd #when displaying #then keeps absolute path", () => {
		// given
		const cwd = "/workspace/project";
		const absolute = "/tmp/file.ts";

		// when
		const rendered = displayPath(absolute, cwd);

		// then
		expect(rendered).toBe(absolute);
	});

	it("#given expanded false #when formatting preview #then renders headers only", () => {
		// given
		const preview = {
			files: [
				{
					filePath: "/workspace/project/src/foo.ts",
					operation: "update" as const,
					diff: "- 1   old\n+   1 new",
					added: 1,
					removed: 1,
				},
			],
			added: 1,
			removed: 1,
		};

		// when
		const collapsed = formatPatchPreview(preview, "/workspace/project", false);
		const expanded = formatPatchPreview(preview, "/workspace/project", true);

		// then
		expect(collapsed).toContain("Edited src/foo.ts (+1 -1)");
		expect(collapsed).not.toContain("+   1 new");
		expect(expanded).toContain("+   1 new");
	});

	it("#given omitted optional args #when formatting preview #then keeps backward compatible defaults", () => {
		// given
		const preview = {
			files: [
				{
					filePath: "src/foo.ts",
					operation: "update" as const,
					diff: "- 1   old\n+   1 new",
					added: 1,
					removed: 1,
				},
			],
			added: 1,
			removed: 1,
		};

		// when
		const rendered = formatPatchPreview(preview);

		// then
		expect(rendered).toContain("Edited src/foo.ts (+1 -1)");
		expect(rendered).toContain("+   1 new");
	});

	it("#given cached state #when clearing #then reset helper is callable", () => {
		// given/when/then
		expect(() => clearApplyPatchRenderState()).not.toThrow();
	});

	it("#given parseable call text #when formatting in-flight label #then includes count and paths", () => {
		// given
		const patch = `*** Begin Patch
*** Update File: src/a.ts
*** Add File: src/b.ts
*** End Patch`;

		// when
		const callText = formatInFlightCallText(patch);

		// then
		expect(callText).toBe("Patching 2 files");
	});

	it("#given partial args #when rendering call #then shows patching placeholder", () => {
		// given
		const tool = createApplyPatchTool();

		// when
		const component = tool.renderCall?.(
			{ input: "{" },
			identityTheme as never,
			{
				argsComplete: false,
				cwd: "/workspace/project",
				state: {},
				toolCallId: "call-1",
			} as never,
		);
		const rendered = component?.render(120).join("\n") ?? "";

		// then
		expect(rendered).toContain("apply_patch Patching");
	});

	it("#given patch args #when rendering call #then shows paths and count", () => {
		// given
		const tool = createApplyPatchTool();
		const args = {
			input: `*** Begin Patch
*** Update File: src/a.ts
*** Add File: src/b.ts
*** End Patch`,
		};

		// when
		const component = tool.renderCall?.(
			args,
			identityTheme as never,
			{
				argsComplete: true,
				cwd: "/workspace/project",
				state: {},
				toolCallId: "call-2",
			} as never,
		);
		const rendered = component?.render(200).join("\n") ?? "";

		// then
		expect(rendered).toContain("apply_patch Patching 2 files");
	});

	it("#given apply_patch tool #when registered #then renders its own shell", () => {
		// given / when
		const tool = createApplyPatchTool();

		// then
		expect(tool.renderShell).toBe("self");
	});

	it("#given nested tool boxes #when rendering ansi output #then default shell would leave a right-edge gap", () => {
		// given
		const inner = new Box(1, 1, (text: string) => ansiTheme.bg("toolSuccessBg", text));
		inner.addChild(new Text("body", 0, 0));

		// when
		const rendered = renderInsideDefaultToolShell(inner);

		// then
		expect(rendered).toContain(`${bgReset} ${bgReset}`);
	});

	it("#given self rendered apply_patch #when rendering ansi output #then avoids nested background reset gap", () => {
		// given
		const result = {
			content: [{ type: "text" as const, text: "update: src/foo.ts" }],
			details: {
				preview: {
					files: [
						{
							filePath: "src/foo.ts",
							operation: "update" as const,
							diff: '+   1 "qdsdk/util/secrets"',
							added: 1,
							removed: 0,
						},
					],
					added: 1,
					removed: 0,
				},
			},
		};

		// when
		const { callRendered } = renderApplyPatchCallWithResult(result, ansiTheme);

		// then
		expect(callRendered).not.toContain(`${bgReset} ${bgReset}`);
	});

	it("#given preview #when rendering result #then updates call component and leaves result empty", () => {
		// given
		const result = {
			content: [{ type: "text" as const, text: "update: src/foo.ts" }],
			details: {
				preview: {
					files: [
						{
							filePath: "src/foo.ts",
							operation: "update" as const,
							diff: "- 1   old\n+   1 new",
							added: 1,
							removed: 1,
						},
					],
					added: 1,
					removed: 1,
				},
			},
		};

		// when
		const { callRendered, resultRendered } = renderApplyPatchCallWithResult(result);

		// then
		expect(callRendered).toContain("apply_patch src/foo.ts (+1 -1)");
		expect(callRendered).toContain("- 1   old");
		expect(callRendered).toContain("+   1 new");
		expect(resultRendered.trim()).toBe("");
	});

	it("#given expanded preview #when rendering result #then uses OpenCode-like highlighted diff rows", () => {
		// given
		const result = {
			content: [{ type: "text" as const, text: "update: src/foo.ts" }],
			details: {
				preview: {
					files: [
						{
							filePath: "src/foo.ts",
							operation: "update" as const,
							diff: "- 1   alpha old\n+   1 alpha new\n  2 2 same",
							added: 1,
							removed: 1,
						},
					],
					added: 1,
					removed: 1,
				},
			},
		};

		// when
		const { callRendered: rendered, resultRendered } = renderApplyPatchCallWithResult(result, markerTheme);

		// then
		expect(resultRendered.trim()).toBe("");
		expect(rendered).toContain("<fg:accent>src/foo.ts</fg:accent>");
		expect(rendered).toContain("<fg:toolDiffRemoved>-</fg:toolDiffRemoved> <fg:muted>1</fg:muted>");
		expect(rendered).toContain("<fg:toolDiffRemoved>alpha <inverse>old</inverse></fg:toolDiffRemoved>");
		expect(rendered).toContain(
			"<fg:toolDiffAdded>+</fg:toolDiffAdded> <fg:muted> </fg:muted> <fg:muted>1</fg:muted>",
		);
		expect(rendered).toContain("<fg:toolDiffAdded>alpha <inverse>new</inverse></fg:toolDiffAdded>");
		expect(rendered).toContain(
			"<fg:toolDiffContext> </fg:toolDiffContext> <fg:muted>2</fg:muted> <fg:muted>2</fg:muted> same",
		);
	});

	it("#given partial progress preview #when rendering result #then shows realtime progress in pending widget", () => {
		// given
		const result = {
			content: [{ type: "text" as const, text: "progress" }],
			details: {
				progress: { applied: 1, failed: 0, total: 2 },
				preview: {
					files: [
						{
							filePath: "src/foo.ts",
							operation: "update" as const,
							diff: "- 1   alpha old\n+   1 alpha new",
							added: 1,
							removed: 1,
						},
					],
					added: 1,
					removed: 1,
				},
			},
		};

		// when
		const { callRendered: rendered, resultRendered } = renderApplyPatchCallWithResult(result, markerTheme);

		// then
		expect(resultRendered.trim()).toBe("");
		expect(rendered).toContain("<bg:toolPendingBg>");
		expect(rendered).toContain("<fg:toolTitle>1/2</fg:toolTitle>");
		expect(rendered).toContain("<fg:accent>src/foo.ts</fg:accent>");
		expect(rendered).toContain("<fg:muted>(+1 -1)</fg:muted>");
		expect(rendered).toContain("<fg:toolDiffRemoved>alpha <inverse>old</inverse></fg:toolDiffRemoved>");
		expect(rendered).toContain("<fg:toolDiffAdded>alpha <inverse>new</inverse></fg:toolDiffAdded>");
	});

	it("#given multi-file preview #when rendering result collapsed #then shows grouped summary", () => {
		// given
		const result = {
			content: [{ type: "text" as const, text: "update: src/a.ts\nupdate: src/b.ts" }],
			details: {
				preview: {
					files: [
						{ filePath: "src/a.ts", operation: "update" as const, diff: "+   1 one", added: 1, removed: 0 },
						{ filePath: "src/b.ts", operation: "update" as const, diff: "+   1 two", added: 1, removed: 0 },
					],
					added: 2,
					removed: 0,
				},
			},
		};

		// when
		const { callRendered: rendered, resultRendered } = renderApplyPatchCallWithResult(result);

		// then
		expect(rendered).toContain("apply_patch 2 files (+2 -0)");
		expect(rendered).toContain("Edited src/a.ts (+1 -0)");
		expect(rendered).toContain("Edited src/b.ts (+1 -0)");
		expect(rendered).toContain("+   1 one");
		expect(resultRendered.trim()).toBe("");
	});

	it("#given highlighted diff row #when rendering result #then keeps diff foreground inside success box", () => {
		// given
		const result = {
			content: [{ type: "text" as const, text: "update: src/foo.ts" }],
			details: {
				preview: {
					files: [
						{
							filePath: "src/foo.ts",
							operation: "update" as const,
							diff: "+   1 const value = 1;",
							added: 1,
							removed: 0,
						},
					],
					added: 1,
					removed: 0,
				},
			},
		};

		// when
		const { callRendered: rendered } = renderApplyPatchCallWithResult(result, ansiTheme);

		// then
		expect(rendered).toContain(successBg);
		expect(rendered).toContain("+   1 const value = 1;");
	});

	it("#given ansi styled diff #when rendering result #then every block line has the same width", () => {
		// given
		const result = {
			content: [{ type: "text" as const, text: "update: src/foo.ts" }],
			details: {
				preview: {
					files: [
						{
							filePath: "src/foo.ts",
							operation: "update" as const,
							diff: "- 1   alpha old\n+   1 alpha new\n  2 2 same",
							added: 1,
							removed: 1,
						},
					],
					added: 1,
					removed: 1,
				},
				result: {
					appliedFiles: ["src/foo.ts"],
					details: { fuzz: 0 },
					failures: [],
					hasPartialSuccess: false,
					recoveryInstructions: { mustNotReadFiles: [], mustReadFiles: [] },
					summaries: ["update: src/foo.ts"],
				},
			},
		};

		// when
		const { callRendered } = renderApplyPatchCallWithResult(result, edgeTheme);
		const widths = callRendered.split("\n").map((line) => visibleWidth(line));

		// then
		expect(new Set(widths)).toEqual(new Set([240]));
	});

	it("#given failed patch result #when rendering result #then shows recovery text in call component", () => {
		// given
		const result = {
			content: [
				{
					type: "text" as const,
					text: [
						"apply_patch partially failed.",
						"Failed: src/foo.ts",
						"Recovery: MUST read src/foo.ts before retrying.",
						"No file actions were applied.",
					].join("\n"),
				},
			],
			details: {
				preview: {
					files: [
						{
							filePath: "src/foo.ts",
							operation: "update" as const,
							diff: "- 1   old\n+   1 new",
							added: 1,
							removed: 1,
						},
					],
					added: 1,
					removed: 1,
				},
				result: {
					appliedFiles: [],
					details: { fuzz: 0 },
					failures: [{ filePath: "src/foo.ts", operation: "update" as const, message: "missing context" }],
					hasPartialSuccess: false,
					recoveryInstructions: { mustNotReadFiles: [], mustReadFiles: ["src/foo.ts"] },
					summaries: [],
				},
			},
		};

		// when
		const { callRendered, resultRendered } = renderApplyPatchCallWithResult(result, markerTheme);

		// then
		expect(callRendered).toContain("<bg:toolErrorBg>");
		expect(callRendered).toContain("<fg:error>failed</fg:error>");
		expect(callRendered).toContain("apply_patch partially failed.");
		expect(callRendered).toContain("Recovery: MUST read src/foo.ts before retrying.");
		expect(resultRendered.trim()).toBe("");
	});

	it("#given large line-bounded preview #when rendering result expanded #then keeps all diff lines", () => {
		// given
		const diff = Array.from({ length: 50 }, (_, index) => `+    ${String(index + 1).padStart(2, " ")} line`).join(
			"\n",
		);
		const result = {
			content: [{ type: "text" as const, text: "update: src/large.ts" }],
			details: {
				preview: {
					files: [{ filePath: "src/large.ts", operation: "update" as const, diff, added: 50, removed: 0 }],
					added: 50,
					removed: 0,
				},
			},
		};

		// when
		const { callRendered: rendered } = renderApplyPatchCallWithResult(result);

		// then
		expect(rendered).toContain("apply_patch src/large.ts (+50 -0)");
		expect(rendered).toContain("+     1 line");
		expect(rendered).toContain("+    50 line");
		expect(rendered).not.toContain("...");
		expect(rendered).not.toContain("…");
	});
});
