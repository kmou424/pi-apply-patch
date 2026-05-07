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

	it("#given absolute workspace paths #when executed #then applies patch like codex", async () => {
		// given
		const directory = await createTempDirectory();
		const absoluteAddPath = path.join(directory, "absolute-add.txt");
		const absoluteDeletePath = path.join(directory, "absolute-delete.txt");
		const absoluteUpdatePath = path.join(directory, "absolute-update.txt");
		const absoluteMoveSourcePath = path.join(directory, "absolute-move-source.txt");
		const absoluteMoveDestinationPath = path.join(directory, "nested", "absolute-move-destination.txt");
		await writeFile(absoluteDeletePath, "delete me\n", "utf-8");
		await writeFile(absoluteUpdatePath, "before\n", "utf-8");
		await writeFile(absoluteMoveSourcePath, "move me\n", "utf-8");
		const patch = `*** Begin Patch
*** Add File: ${absoluteAddPath}
+created
*** Delete File: ${absoluteDeletePath}
*** Update File: ${absoluteUpdatePath}
@@
-before
+after
*** Update File: ${absoluteMoveSourcePath}
*** Move to: ${absoluteMoveDestinationPath}
@@
-move me
+moved
*** End Patch`;

		// when
		await applyPatch(directory, patch);

		// then
		expect(await readFile(absoluteAddPath, "utf-8")).toBe("created");
		await expect(readFile(absoluteDeletePath, "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(absoluteUpdatePath, "utf-8")).toBe("after\n");
		await expect(readFile(absoluteMoveSourcePath, "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(absoluteMoveDestinationPath, "utf-8")).toBe("moved\n");
	});

	it("#given absolute path outside workspace #when executed #then rejects patch", async () => {
		// given
		const directory = await createTempDirectory();
		const outsidePath = path.join(path.dirname(directory), "outside-apply-patch.txt");
		const patch = `*** Begin Patch
*** Add File: ${outsidePath}
+outside
*** End Patch`;

		// when / then
		await expect(applyPatch(directory, patch)).rejects.toThrow(
			"File references must stay within the current workspace.",
		);
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
