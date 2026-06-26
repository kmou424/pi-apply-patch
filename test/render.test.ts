import { describe, expect, it } from "vitest";
import {
	clearApplyPatchRenderState,
	createApplyPatchTool,
	displayPath,
	formatInFlightCallText,
	formatPatchPreview,
	PATCH_PREVIEW_MAX_CHARS,
	PATCH_PREVIEW_MAX_LINES,
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

function renderApplyPatchCallWithResult(
	result: Parameters<NonNullable<ReturnType<typeof createApplyPatchTool>["renderResult"]>>[0],
	theme: typeof identityTheme | typeof markerTheme | typeof ansiTheme = identityTheme,
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

describe("render helpers", () => {
	it("#given plain text diff #when truncating #then falls back to head and tail", () => {
		// given
		const lines = Array.from({ length: PATCH_PREVIEW_MAX_LINES + 12 }, (_, index) => `line-${index + 1}`);
		const diff = lines.join("\n");

		// when
		const preview = truncatePreview(diff);

		// then
		expect(preview).toContain("line-1");
		expect(preview).toContain(`line-${lines.length}`);
		expect(preview).toContain("…");
		expect(preview.split("\n")).toHaveLength(PATCH_PREVIEW_MAX_LINES);
	});

	it("#given huge payload #when truncating #then enforces max chars", () => {
		// given
		const diff = `${"x".repeat(PATCH_PREVIEW_MAX_CHARS + 500)}\nend`;

		// when
		const preview = truncatePreview(diff);

		// then
		expect(preview.length).toBeLessThanOrEqual(PATCH_PREVIEW_MAX_CHARS);
		expect(preview.split("\n").length).toBeLessThanOrEqual(PATCH_PREVIEW_MAX_LINES);
		expect(preview).toContain("…");
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
		expect(preview).toContain("…");
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
					diff: "-1 old\n+1 new",
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
		expect(collapsed).not.toContain("+1 new");
		expect(expanded).toContain("+1 new");
	});

	it("#given omitted optional args #when formatting preview #then keeps backward compatible defaults", () => {
		// given
		const preview = {
			files: [
				{
					filePath: "src/foo.ts",
					operation: "update" as const,
					diff: "-1 old\n+1 new",
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
		expect(rendered).toContain("+1 new");
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
							diff: "-1 old\n+1 new",
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
		expect(callRendered).toContain("-1 old");
		expect(callRendered).toContain("+1 new");
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
							diff: "-1 alpha old\n+1 alpha new\n 2 same",
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
		expect(rendered).toContain("<bg:toolErrorBg><fg:toolDiffRemoved>-</fg:toolDiffRemoved><fg:muted>1</fg:muted>");
		expect(rendered).toContain("<fg:toolDiffRemoved>alpha <inverse>old</inverse></fg:toolDiffRemoved>");
		expect(rendered).toContain("<bg:toolSuccessBg><fg:toolDiffAdded>+</fg:toolDiffAdded><fg:muted>1</fg:muted>");
		expect(rendered).toContain("<fg:toolDiffAdded>alpha <inverse>new</inverse></fg:toolDiffAdded>");
		expect(rendered).toContain("<fg:toolDiffContext> </fg:toolDiffContext><fg:muted>2</fg:muted> same");
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
							diff: "-1 alpha old\n+1 alpha new",
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
		expect(rendered).toContain("<bold>apply_patch 1/2 src/foo.ts (+1 -1)</bold>");
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
						{ filePath: "src/a.ts", operation: "update" as const, diff: "+1 one", added: 1, removed: 0 },
						{ filePath: "src/b.ts", operation: "update" as const, diff: "+1 two", added: 1, removed: 0 },
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
		expect(rendered).toContain("+1 one");
		expect(resultRendered.trim()).toBe("");
	});

	it("#given highlighted diff row #when rendering result in success box #then outer background resumes after row reset", () => {
		// given
		const result = {
			content: [{ type: "text" as const, text: "update: src/foo.ts" }],
			details: {
				preview: {
					files: [
						{
							filePath: "src/foo.ts",
							operation: "update" as const,
							diff: "+1 const value = 1;",
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
		expect(rendered).toContain(`${bgReset}${successBg}`);
	});

	it("#given large preview #when rendering result expanded #then shows truncation marker", () => {
		// given
		const diff = Array.from({ length: 50 }, (_, index) => `+${index + 1} line`).join("\n");
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
		expect(rendered).toContain("…");
	});
});
