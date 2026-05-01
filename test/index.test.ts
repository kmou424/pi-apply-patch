import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	APPLY_PATCH_FREEFORM_DESCRIPTION,
	APPLY_PATCH_LARK_GRAMMAR,
	type ApplyPatchExtensionAPI,
	applyPatch,
	type createApplyPatchTool,
	extractPatchedPaths,
	type FreeformToolFormat,
	isOpenAIGptModel,
	registerApplyPatchExtension,
} from "../src/index.js";

const tempDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(process.cwd(), "test-temp-"));
	tempDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	while (tempDirectories.length > 0) {
		const directory = tempDirectories.pop();
		if (directory) {
			await rm(directory, { recursive: true, force: true });
		}
	}
});

describe("pi-apply-patch", () => {
	it("#given extension #when registered #then exposes codex freeform apply_patch tool", () => {
		// given
		let capturedToolName: string | undefined;
		let capturedDescription: string | undefined;
		let capturedFreeform: FreeformToolFormat | undefined;
		const extensionApi = {
			registerTool(tool: ReturnType<typeof createApplyPatchTool>) {
				capturedToolName = tool.name;
				capturedDescription = tool.description;
				capturedFreeform = tool.freeform;
			},
			on() {},
			getActiveTools() {
				return ["read", "write", "edit"];
			},
			setActiveTools() {},
		} satisfies ApplyPatchExtensionAPI;

		// when
		registerApplyPatchExtension(extensionApi);

		// then
		expect(capturedToolName).toBe("apply_patch");
		expect(capturedDescription).toBe(APPLY_PATCH_FREEFORM_DESCRIPTION);
		expect(capturedFreeform).toEqual({
			type: "grammar",
			syntax: "lark",
			definition: APPLY_PATCH_LARK_GRAMMAR,
		});
	});

	it("#given raw codex patch #when executed #then applies file update", async () => {
		// given
		const directory = await createTempDirectory();
		await writeFile(path.join(directory, "sample.txt"), "before\n", "utf-8");
		const patch = `*** Begin Patch
*** Update File: sample.txt
@@
-before
+after
*** End Patch`;

		// when
		await applyPatch(directory, patch);

		// then
		expect(await readFile(path.join(directory, "sample.txt"), "utf-8")).toBe("after\n");
	});

	it("#given patch text #when extracting paths #then returns touched files", () => {
		// given
		const patch = `*** Begin Patch
*** Update File: src/app.ts
@@
-old
+new
*** Add File: src/new.ts
+content
*** End Patch`;

		// when / then
		expect(extractPatchedPaths(patch)).toEqual(["src/app.ts", "src/new.ts"]);
	});

	it("#given model metadata #when checking GPT activation #then only OpenAI GPT models match", () => {
		expect(isOpenAIGptModel({ provider: "openai", id: "gpt-5" })).toBe(true);
		expect(isOpenAIGptModel({ provider: "openai", id: "o1" })).toBe(false);
		expect(isOpenAIGptModel({ provider: "anthropic", id: "gpt-5" })).toBe(false);
	});
});
