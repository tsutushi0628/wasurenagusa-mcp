import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { copyFile as copyFilePromise } from "node:fs/promises";
import { Writable } from "node:stream";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  archiveTranscripts,
  formatAllArchiveSummary,
  getDefaultArchivePaths,
  parseArchiveArguments,
  writeAllArchiveSummary,
} from "./archive-transcripts.mjs";

const scratchRoot = join(process.cwd(), ".tmp", "codex-T11");
const scratchDirectories: string[] = [];

function createScratchDirectory(): string {
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, "archive-transcripts-"));
  scratchDirectories.push(scratch);
  return scratch;
}

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("会話記録アーカイブ", () => {
  it("既存の単一指定を保ち、--allを追加で解釈する", () => {
    expect(parseArchiveArguments(["--source", "source", "--project-root", "project"])).toEqual({
      sourceDirectory: "source",
      projectDirectory: "project",
      dryRun: false,
    });
    expect(parseArchiveArguments(["--all", "--dry-run"])).toEqual({ all: true, dryRun: true });
  });

  it("プロジェクトの起動場所からsourceと保存先を決める", () => {
    expect(getDefaultArchivePaths("/Users/example/projects/firebase-kit", "/Users/example")).toEqual({
      projectDirectory: "/Users/example/projects/firebase-kit",
      sourceDirectory: "/Users/example/.claude/projects/-Users-example-projects-firebase-kit",
      destinationDirectory: "/Users/example/projects/firebase-kit/.wasurenagusa/transcripts-archive/firebase-kit",
    });
  });

  it("archiveのローカルimport先もnpm packageに含める", () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { files: string[] };

    expect(packageJson.files).toContain("scripts/maintenance/archive-transcripts.mjs");
    expect(packageJson.files).toContain("scripts/replay/lib/session-project.mjs");
  });

  it("コピー中に原本が変わったファイルを飛ばし、他フォルダとindex更新を続ける", async () => {
    const scratch = createScratchDirectory();
    const projectDirectory = join(scratch, "wasurenagusa-mcp");
    const homeDirectory = join(scratch, "home");
    const projectsDirectory = join(homeDirectory, ".claude", "projects");
    const firstLaunch = join(projectsDirectory, "first-launch");
    const secondLaunch = join(projectsDirectory, "second-launch");
    mkdirSync(firstLaunch, { recursive: true });
    mkdirSync(secondLaunch, { recursive: true });
    const changedSourcePath = join(firstLaunch, "changes.jsonl");
    const sameLaunchSourcePath = join(firstLaunch, "continues.jsonl");
    const nextLaunchSourcePath = join(secondLaunch, "also-continues.jsonl");
    writeFileSync(changedSourcePath, "original transcript\n");
    writeFileSync(sameLaunchSourcePath, "same launch transcript\n");
    writeFileSync(nextLaunchSourcePath, "next launch transcript\n");
    const changedMtime = new Date("2026-10-01T00:00:00.000Z");
    utimesSync(changedSourcePath, changedMtime, changedMtime);

    const result = await archiveTranscripts({
      all: true,
      projectDirectory,
      projectsDirectory,
      homeDirectory,
      copyFileImpl: async (sourcePath: string, destinationPath: string) => {
        await copyFilePromise(sourcePath, destinationPath);
        if (sourcePath === changedSourcePath) {
          writeFileSync(changedSourcePath, "changed while archive copy was in progress\n");
          const nextMtime = new Date("2026-10-02T00:00:00.000Z");
          utimesSync(changedSourcePath, nextMtime, nextMtime);
        }
      },
    });

    const archiveRoot = join(projectDirectory, ".wasurenagusa", "transcripts-archive");
    const logsDirectory = join(projectDirectory, ".wasurenagusa", "logs");
    const operationFile = readdirSync(logsDirectory).find((name) => /^operation-.*\.jsonl$/u.test(name));
    const operationLines = readFileSync(join(logsDirectory, operationFile as string), "utf8").trim().split("\n");
    const summary = formatAllArchiveSummary(result, false);
    let stdoutText = "";
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutText += chunk.toString();
        callback();
      },
    });
    writeAllArchiveSummary(result, false, stdout);

    expect(result).toMatchObject({ plannedCount: 3, copiedCount: 2, skippedCount: 1 });
    expect(() => statSync(join(archiveRoot, "first-launch", "changes.jsonl"))).toThrow();
    expect(readFileSync(join(archiveRoot, "first-launch", "continues.jsonl"), "utf8")).toBe("same launch transcript\n");
    expect(readFileSync(join(archiveRoot, "second-launch", "also-continues.jsonl"), "utf8")).toBe("next launch transcript\n");
    expect(JSON.parse(readFileSync(join(archiveRoot, "sessions-index.json"), "utf8")).sessions).toHaveLength(2);
    expect(operationLines).toHaveLength(1);
    expect(JSON.parse(operationLines[0])).toMatchObject({
      operation_type: "archive_transcripts",
      status: "completed_with_skips",
      skipped_count: 1,
    });
    expect(summary).toContain("skipped=1");
    expect(stdoutText).toContain("skipped=1");
  });

  it("直下のJSONLだけを新規コピーし、dry-runと再実行では変更しない", async () => {
    const projectDirectory = join(createScratchDirectory(), "firebase-kit");
    const sourceDirectory = join(projectDirectory, "source");
    const nestedDirectory = join(sourceDirectory, "subagents");
    mkdirSync(nestedDirectory, { recursive: true });
    const sourcePath = join(sourceDirectory, "session.jsonl");
    const original = JSON.stringify({ type: "user", message: { content: "合成テスト文" } }) + "\n";
    writeFileSync(sourcePath, original);
    writeFileSync(join(nestedDirectory, "nested.jsonl"), original);
    const sourceMtime = new Date("2026-10-01T00:00:00.000Z");
    utimesSync(sourcePath, sourceMtime, sourceMtime);
    const destinationDirectory = join(projectDirectory, ".wasurenagusa", "transcripts-archive", "firebase-kit");

    const dryRun = await archiveTranscripts({ projectDirectory, sourceDirectory, dryRun: true });
    expect(dryRun.plannedCount).toBe(1);
    expect(() => statSync(destinationDirectory)).toThrow();

    const firstRun = await archiveTranscripts({ projectDirectory, sourceDirectory });
    const destinationPath = join(destinationDirectory, "session.jsonl");
    expect(firstRun.copiedCount).toBe(1);
    expect(readFileSync(destinationPath, "utf8")).toBe(original);
    expect(statSync(destinationPath).mtimeMs).toBe(statSync(sourcePath).mtimeMs);
    expect(statSync(sourcePath).mtimeMs).toBe(sourceMtime.getTime());
    expect(readdirSync(destinationDirectory)).toEqual(["session.jsonl"]);

    const secondRun = await archiveTranscripts({ projectDirectory, sourceDirectory });
    expect(secondRun.plannedCount).toBe(0);
  });

  it("分数mtimeを保ち、再実行で更新対象にならない", async () => {
    const projectDirectory = createScratchDirectory();
    const sourceDirectory = join(projectDirectory, "source");
    mkdirSync(sourceDirectory, { recursive: true });
    const sourcePath = join(sourceDirectory, "fractional-time.jsonl");
    writeFileSync(sourcePath, "synthetic timestamp fixture\n");
    const timestampSeconds = Date.parse("2026-10-01T00:00:00.000Z") / 1000 + 0.123456;
    utimesSync(sourcePath, timestampSeconds, timestampSeconds);
    const sourceMtime = statSync(sourcePath).mtimeMs;

    await archiveTranscripts({ projectDirectory, sourceDirectory });

    const destinationPath = join(
      projectDirectory,
      ".wasurenagusa",
      "transcripts-archive",
      basename(projectDirectory),
      "fractional-time.jsonl",
    );
    expect(statSync(destinationPath).mtimeMs).toBe(sourceMtime);
    utimesSync(destinationPath, sourceMtime / 1000, sourceMtime / 1000 - 0.000001);
    const representableMtimeDifference = Math.abs(statSync(sourcePath).mtimeMs - statSync(destinationPath).mtimeMs);
    expect(representableMtimeDifference).toBeGreaterThan(0);
    expect(representableMtimeDifference).toBeLessThanOrEqual(0.002);
    await expect(archiveTranscripts({ projectDirectory, sourceDirectory })).resolves.toMatchObject({ plannedCount: 0 });
  });

  it("--allで複数起動フォルダを退避し、合成session indexを本文なしで作る", async () => {
    const scratch = createScratchDirectory();
    const projectDirectory = join(scratch, "wasurenagusa-mcp");
    const homeDirectory = join(scratch, "home");
    const projectsDirectory = join(homeDirectory, ".claude", "projects");
    const firebaseLaunch = join(projectsDirectory, "-Users-example-projects-firebase-kit");
    const legacyLaunch = join(projectsDirectory, "legacy-launch");
    const firebaseProject = join(homeDirectory, "projects", "firebase-kit");
    const wasurenagusaProject = join(homeDirectory, "projects", "wasurenagusa-mcp");
    const worklogPath = join(homeDirectory, "projects", "legaltech-lab", "docs", "findings", "worklog-synthetic.md");
    mkdirSync(join(firebaseLaunch, "session-a", "subagents"), { recursive: true });
    mkdirSync(firebaseLaunch, { recursive: true });
    mkdirSync(legacyLaunch, { recursive: true });
    mkdirSync(firebaseProject, { recursive: true });
    mkdirSync(wasurenagusaProject, { recursive: true });
    mkdirSync(join(homeDirectory, "projects", "legaltech-lab", "docs", "findings"), { recursive: true });
    writeFileSync(join(firebaseProject, "app.ts"), "synthetic file\n");
    writeFileSync(join(wasurenagusaProject, "app.ts"), "synthetic file\n");
    writeFileSync(worklogPath, "synthetic note\n");
    writeFileSync(join(firebaseLaunch, "session-a.jsonl"), JSON.stringify({
      type: "assistant",
      timestamp: "2026-10-01T00:00:00.000Z",
      message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: join(firebaseProject, "app.ts") } }] },
    }) + "\n");
    writeFileSync(join(firebaseLaunch, "session-b.jsonl"), JSON.stringify({
      type: "assistant",
      timestamp: "2026-10-01T00:00:00.500Z",
      message: { content: [{ type: "tool_use", name: "Write", input: { file_path: join(wasurenagusaProject, "app.ts") } }] },
    }) + "\n");
    writeFileSync(join(firebaseLaunch, "session-a", "subagents", "nested.jsonl"), "synthetic nested transcript\n");
    writeFileSync(join(legacyLaunch, "session-b.jsonl"), "synthetic launch transcript\n");
    writeFileSync(join(legacyLaunch, "session-c.jsonl"), JSON.stringify({
      type: "assistant",
      timestamp: "2026-10-01T00:00:01.000Z",
      message: { content: [{ type: "tool_use", name: "Write", input: { file_path: worklogPath } }] },
    }) + "\n");

    const dryRun = await archiveTranscripts({
      all: true,
      projectDirectory,
      projectsDirectory,
      homeDirectory,
      dryRun: true,
    });
    const archiveRoot = join(projectDirectory, ".wasurenagusa", "transcripts-archive");
    expect(dryRun.plannedCount).toBe(4);
    expect(dryRun.launchDirectories).toEqual([
      { launchDir: "firebase-kit", plannedCount: 2, copiedCount: 0 },
      { launchDir: "legacy-launch", plannedCount: 2, copiedCount: 0 },
    ]);
    const dryRunOutput = formatAllArchiveSummary(dryRun, true);
    expect(dryRunOutput).toContain("launchDir=firebase-kit plannedCopies=2 copied=0");
    expect(dryRunOutput).toContain("project=firebase-kit sessions=1");
    expect(dryRunOutput).toContain("project=wasurenagusa-mcp sessions=1");
    expect(dryRunOutput).toContain("launchProject=firebase-kit project=firebase-kit sessions=1");
    expect(dryRunOutput).toContain("launchProject=firebase-kit project=wasurenagusa-mcp sessions=1");
    expect(dryRunOutput).toContain("project=legacy-launch sessions=1");
    expect(dryRunOutput).toContain("launchProject=legacy-launch project=legaltech-lab sessions=1");
    expect(dryRunOutput).not.toContain(scratch);
    expect(dryRunOutput).not.toContain("synthetic transcript body");
    expect(() => readdirSync(archiveRoot)).toThrow();

    const archived = await archiveTranscripts({
      all: true,
      projectDirectory,
      projectsDirectory,
      homeDirectory,
    });
    expect(archived.copiedCount).toBe(4);
    expect(readdirSync(join(archiveRoot, "firebase-kit"))).toEqual(["session-a.jsonl", "session-b.jsonl"]);
    expect(readdirSync(join(archiveRoot, "legacy-launch"))).toEqual(["session-b.jsonl", "session-c.jsonl"]);
    expect(() => statSync(join(archiveRoot, "firebase-kit", "nested.jsonl"))).toThrow();

    const indexPath = join(archiveRoot, "sessions-index.json");
    const indexText = readFileSync(indexPath, "utf8");
    expect(indexText).not.toContain(scratch);
    expect(indexText).not.toContain("synthetic launch transcript");
    expect(indexText).not.toContain("synthetic nested transcript");
    expect(indexText).not.toContain("worklog-synthetic");
    expect(JSON.parse(indexText)).toEqual({
      version: 1,
      sessions: [
        {
          sessionId: "session-a",
          launchDir: "firebase-kit",
          project: "firebase-kit",
          basis: "written_files",
          projects: { "firebase-kit": 1 },
        },
        {
          sessionId: "session-b",
          launchDir: "firebase-kit",
          project: "wasurenagusa-mcp",
          basis: "written_files",
          projects: { "wasurenagusa-mcp": 1 },
        },
        {
          sessionId: "session-b",
          launchDir: "legacy-launch",
          project: "legacy-launch",
          basis: "launch_dir",
          projects: {},
        },
        {
          sessionId: "session-c",
          launchDir: "legacy-launch",
          project: "legaltech-lab",
          basis: "worklog_only",
          projects: { "legaltech-lab": 1 },
        },
      ],
    });
  });

  it("mtimeまたはsizeが変わったJSONLを更新する", async () => {
    const projectDirectory = createScratchDirectory();
    const sourceDirectory = join(projectDirectory, "source");
    mkdirSync(sourceDirectory, { recursive: true });
    const sourcePath = join(sourceDirectory, "session.jsonl");
    const firstMtime = new Date("2026-10-01T00:00:00.000Z");
    writeFileSync(sourcePath, "original text\n");
    utimesSync(sourcePath, firstMtime, firstMtime);
    await archiveTranscripts({ projectDirectory, sourceDirectory });

    const secondMtime = new Date("2026-10-02T00:00:00.000Z");
    writeFileSync(sourcePath, "updated! text\n");
    utimesSync(sourcePath, secondMtime, secondMtime);
    const mtimeUpdate = await archiveTranscripts({ projectDirectory, sourceDirectory });
    const destinationPath = join(projectDirectory, ".wasurenagusa", "transcripts-archive", basename(projectDirectory), "session.jsonl");
    expect(mtimeUpdate.copiedCount).toBe(1);
    expect(readFileSync(destinationPath, "utf8")).toBe("updated! text\n");

    writeFileSync(sourcePath, "updated and longer text\n");
    utimesSync(sourcePath, secondMtime, secondMtime);
    const sizeUpdate = await archiveTranscripts({ projectDirectory, sourceDirectory });

    expect(sizeUpdate.copiedCount).toBe(1);
    expect(readFileSync(destinationPath, "utf8")).toBe("updated and longer text\n");
  });

  it("source directoryがまだ無いときは0件で終了し、ファイルを作らない", async () => {
    const projectDirectory = createScratchDirectory();
    const sourceDirectory = join(projectDirectory, "not-started");

    const result = await archiveTranscripts({ projectDirectory, sourceDirectory, dryRun: true });

    expect(result).toEqual({ plannedCount: 0, copiedCount: 0, skippedCount: 0 });
    expect(() => statSync(join(projectDirectory, ".wasurenagusa"))).toThrow();
  });

  it("通常実行の失敗をoperationログへ1行記録する", async () => {
    const projectDirectory = createScratchDirectory();
    const sourceDirectory = join(projectDirectory, "not-a-directory");
    writeFileSync(sourceDirectory, "synthetic non-directory source");

    await expect(archiveTranscripts({ projectDirectory, sourceDirectory })).rejects.toThrow();

    const logsDirectory = join(projectDirectory, ".wasurenagusa", "logs");
    const logFiles = readdirSync(logsDirectory).filter((name) => /^operation-.*\.jsonl$/u.test(name));
    expect(logFiles).toHaveLength(1);
    const lines = readFileSync(join(logsDirectory, logFiles[0]), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ operation_type: "archive_transcripts", status: "failed" });
  });
});
