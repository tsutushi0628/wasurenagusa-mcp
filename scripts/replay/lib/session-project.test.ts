import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inferSessionProject, launchDirectoryName } from "./session-project.mjs";

const scratchRoot = join(process.cwd(), ".tmp", "codex-T3b");
const scratchDirectories: string[] = [];

function createScratchDirectory(): string {
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, "session-project-"));
  scratchDirectories.push(scratch);
  return scratch;
}

function assistantWrite(timestamp: string, name: string, pathField: string, path: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    message: { content: [{ type: "tool_use", name, input: { [pathField]: path } }] },
  }) + "\n";
}

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("session project inference", () => {
  it("realpath resolves a shared .claude symlink and ignores weak votes when ordering strong ties", async () => {
    const scratch = createScratchDirectory();
    const homeDirectory = join(scratch, "home");
    const projectsDirectory = join(homeDirectory, "projects");
    const firebaseClaudeDirectory = join(projectsDirectory, "firebase-kit", ".claude");
    const wasurenagusaDirectory = join(projectsDirectory, "wasurenagusa-mcp");
    const worklogDirectory = join(wasurenagusaDirectory, "docs", "findings");
    const transcriptPath = join(scratch, "session.jsonl");
    const subagentsDirectory = join(scratch, "session", "subagents");
    mkdirSync(firebaseClaudeDirectory, { recursive: true });
    mkdirSync(worklogDirectory, { recursive: true });
    mkdirSync(subagentsDirectory, { recursive: true });
    writeFileSync(join(firebaseClaudeDirectory, "shared.ts"), "synthetic file\n");
    writeFileSync(join(wasurenagusaDirectory, "app.ts"), "synthetic file\n");
    writeFileSync(join(worklogDirectory, "worklog-synthetic.md"), "synthetic note\n");
    symlinkSync(firebaseClaudeDirectory, join(wasurenagusaDirectory, ".claude"), "dir");
    writeFileSync(transcriptPath,
      assistantWrite("2026-10-01T00:00:00.000Z", "Write", "file_path", join(worklogDirectory, "worklog-synthetic.md"))
      + assistantWrite("2026-10-01T00:00:01.000Z", "Edit", "file_path", join(wasurenagusaDirectory, ".claude", "shared.ts")));
    writeFileSync(join(subagentsDirectory, "agent.jsonl"), assistantWrite(
      "2026-10-01T00:00:01.000Z", "Write", "file_path", join(wasurenagusaDirectory, "app.ts"),
    ));

    await expect(inferSessionProject({
      transcriptPath,
      subagentsDirectory,
      launchDir: "wasurenagusa-mcp",
      homeDirectory,
    })).resolves.toEqual({
      project: "firebase-kit",
      basis: "written_files",
      projects: { "wasurenagusa-mcp": 2, "firebase-kit": 1 },
    });
  });

  it("ignores .tmp writes, uses worklog votes only when no other project was written", async () => {
    const scratch = createScratchDirectory();
    const homeDirectory = join(scratch, "home");
    const projectDirectory = join(homeDirectory, "projects", "wasurenagusa-mcp");
    const transcriptPath = join(scratch, "worklog.jsonl");
    const subagentsDirectory = join(scratch, "worklog", "subagents");
    const findingsDirectory = join(projectDirectory, "docs", "findings");
    mkdirSync(findingsDirectory, { recursive: true });
    mkdirSync(join(projectDirectory, ".tmp"), { recursive: true });
    mkdirSync(subagentsDirectory, { recursive: true });
    const worklogPath = join(findingsDirectory, "worklog-2026-10-01.md");
    writeFileSync(worklogPath, "synthetic note\n");
    writeFileSync(transcriptPath,
      assistantWrite("2026-10-01T00:00:00.000Z", "Write", "file_path", join(projectDirectory, ".tmp", "scratch.ts"))
      + assistantWrite("2026-10-01T00:00:01.000Z", "Write", "file_path", worklogPath));

    await expect(inferSessionProject({
      transcriptPath,
      subagentsDirectory,
      launchDir: "wasurenagusa-mcp",
      homeDirectory,
    })).resolves.toEqual({
      project: "wasurenagusa-mcp",
      basis: "worklog_only",
      projects: { "wasurenagusa-mcp": 1 },
    });
  });

  it("falls back to the launch directory when only .tmp files were written", async () => {
    const scratch = createScratchDirectory();
    const homeDirectory = join(scratch, "home");
    const projectDirectory = join(homeDirectory, "projects", "firebase-kit");
    const transcriptPath = join(scratch, "temporary-only.jsonl");
    const subagentsDirectory = join(scratch, "temporary-only", "subagents");
    mkdirSync(join(projectDirectory, ".tmp"), { recursive: true });
    mkdirSync(subagentsDirectory, { recursive: true });
    writeFileSync(transcriptPath, assistantWrite(
      "2026-10-01T00:00:00.000Z", "NotebookEdit", "notebook_path", join(projectDirectory, ".tmp", "draft.ipynb"),
    ));

    await expect(inferSessionProject({
      transcriptPath,
      subagentsDirectory,
      launchDir: "firebase-kit",
      homeDirectory,
    })).resolves.toEqual({ project: "firebase-kit", basis: "launch_dir", projects: {} });
  });

  it("extracts the launch directory suffix and falls back to the source directory name", () => {
    expect(launchDirectoryName("-Users-example-projects-firebase-kit")).toBe("firebase-kit");
    expect(launchDirectoryName("-Users-example-projects-my-projects-tool")).toBe("my-projects-tool");
    expect(launchDirectoryName("legacy-project-name")).toBe("legacy-project-name");
  });
});
