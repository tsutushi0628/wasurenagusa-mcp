import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeManifest, parseMakeManifestArguments } from "../make-manifest.mjs";
import { readManifest } from "./simulate-engine.mjs";

function transcriptRow(sessionId: string, timestamp: string, content: string): string {
  return JSON.stringify({
    type: "user",
    origin: { kind: "human" },
    sessionId,
    timestamp,
    message: { content },
  }) + "\n";
}

describe("再生manifest生成", () => {
  it("入力ディレクトリと出力を必須にし、既定除外なしで明示接頭辞を指定できる", () => {
    expect(() => parseMakeManifestArguments([])).toThrow(/--transcripts.*--out/u);
    expect(parseMakeManifestArguments([
      "--transcripts", "transcripts",
      "--out", "manifest.json",
    ])).toMatchObject({
      transcriptsDirectory: "transcripts",
      outputPath: "manifest.json",
      excludePrefixes: [],
      dateStart: "2026-09-23",
      dateEnd: "2026-10-05",
    });
    expect(parseMakeManifestArguments([
      "--transcripts", "transcripts",
      "--out", "manifest.json",
      "--exclude-prefix", "dccb7da4",
      "--exclude-prefix", "custom-id",
      "--exclude-prefix", "other-id",
    ]).excludePrefixes).toEqual(["dccb7da4", "custom-id", "other-id"]);
    expect(parseMakeManifestArguments([
      "--transcripts", "transcripts",
      "--out", "manifest.json",
      "--from", "2026-09-25",
      "--to", "2026-10-01",
    ])).toMatchObject({ dateStart: "2026-09-25", dateEnd: "2026-10-01" });
    expect(parseMakeManifestArguments([
      "--transcripts", "transcripts",
      "--out", "manifest.json",
      "--project", "firebase-kit",
    ])).toMatchObject({ project: "firebase-kit" });
    expect(() => parseMakeManifestArguments([
      "--transcripts", "transcripts",
      "--out", "manifest.json",
      "--project", "../outside",
    ])).toThrow(/single project name/u);
    expect(() => parseMakeManifestArguments([
      "--transcripts", "transcripts",
      "--out", "manifest.json",
      "--from", "2026-10-01",
      "--to", "2026-09-25",
    ])).toThrow(/date range/u);
  });

  it("readManifestが検査する全dispositionと固定prefixだけを記録する", async () => {
    const scratchRoot = join(process.cwd(), ".tmp", "codex-T3b");
    mkdirSync(scratchRoot, { recursive: true });
    const scratch = mkdtempSync(join(scratchRoot, "replay-make-manifest-"));
    const transcriptsDirectory = join(scratch, "transcripts");
    const outputPath = join(scratch, "manifest.json");
    const includedSessionId = "included-session";
    const includedCompleteRow = transcriptRow(includedSessionId, "2026-09-21T15:00:00.000Z", "期間開始の発話");
    const includedEndRow = transcriptRow(includedSessionId, "2026-10-05T14:59:59.999Z", "期間終了の発話");
    const includedCompletePrefix = includedCompleteRow + includedEndRow;
    const includedPartialRow = transcriptRow(includedSessionId, "2026-09-22T01:00:00.000Z", "未完了行").trimEnd();
    try {
      mkdirSync(transcriptsDirectory);
      writeFileSync(join(transcriptsDirectory, `${includedSessionId}.jsonl`), includedCompletePrefix + includedPartialRow);
      writeFileSync(join(transcriptsDirectory, "dccb7da4-excluded.jsonl"), transcriptRow(
        "dccb7da4-excluded", "2026-09-25T01:00:00.000Z", "除外対象",
      ));
      writeFileSync(join(transcriptsDirectory, "outside-session.jsonl"), transcriptRow(
        "outside-session", "2026-09-21T14:59:00.000Z", "期間外",
      ));
      writeFileSync(join(transcriptsDirectory, "empty-session.jsonl"), JSON.stringify({
        type: "assistant",
        sessionId: "empty-session",
        timestamp: "2026-09-25T01:00:00.000Z",
        message: { content: "assistant only" },
      }) + "\n");

      const result = await makeManifest({
        transcriptsDirectory,
        outputPath,
        excludePrefixes: ["dccb7da4"],
        dateStart: "2026-09-23",
        dateEnd: "2026-10-05",
      });
      expect(result.fileAudit).toEqual({ fileCount: 4, included: 1, excluded: 1, noHuman: 1, outsidePeriod: 1 });

      const manifestText = readFileSync(outputPath, "utf8");
      expect(manifestText).not.toContain(scratch);
      expect(manifestText).not.toContain("期間開始の発話");
      const manifest = JSON.parse(manifestText);
      expect(manifest.sessions).toHaveLength(1);
      expect(manifest.sessions[0]).toMatchObject({
        sessionId: includedSessionId,
        readEndByteOffset: Buffer.byteLength(includedCompletePrefix),
        prefixSha256: createHash("sha256").update(includedCompletePrefix).digest("hex"),
      });
      expect(isAbsolute(manifest.sessions[0].path)).toBe(false);
      expect(manifest.dateRangeJst).toEqual({ start: "2026-09-23", end: "2026-10-05" });
      expect(manifest.files.map((entry: { disposition: string }) => entry.disposition).sort()).toEqual([
        "excluded", "included", "no-human", "outside-period",
      ]);
      await expect(readManifest(outputPath)).resolves.toMatchObject({
        fileAudit: { fileCount: 4, included: 1, excluded: 1, noHuman: 1, outsidePeriod: 1 },
        sessions: [{
          sessionId: includedSessionId,
          humanInputs: [{ text: "期間開始の発話" }, { text: "期間終了の発話" }],
        }],
      });

      writeFileSync(join(transcriptsDirectory, `${includedSessionId}.jsonl`), includedCompletePrefix + includedPartialRow + "\n");
      await expect(readManifest(outputPath)).resolves.toMatchObject({
        sessions: [{ snapshotMeta: { size: Buffer.byteLength(includedCompletePrefix) } }],
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("--projectでsessions-index.jsonの実プロジェクトだけをmanifestへ入れる", async () => {
    const scratchRoot = join(process.cwd(), ".tmp", "codex-T3b");
    mkdirSync(scratchRoot, { recursive: true });
    const scratch = mkdtempSync(join(scratchRoot, "replay-project-manifest-"));
    const transcriptsDirectory = join(scratch, "firebase-kit");
    const outputPath = join(scratch, "manifest.json");
    try {
      mkdirSync(transcriptsDirectory);
      writeFileSync(join(transcriptsDirectory, "session-a.jsonl"), transcriptRow(
        "session-a", "2026-10-01T01:00:00.000Z", "合成プロジェクトAの発話",
      ));
      writeFileSync(join(transcriptsDirectory, "session-b.jsonl"), transcriptRow(
        "session-b", "2026-10-01T01:00:00.000Z", "合成プロジェクトBの発話",
      ));
      writeFileSync(join(scratch, "sessions-index.json"), JSON.stringify({
        version: 1,
        sessions: [
          { sessionId: "session-a", launchDir: "firebase-kit", project: "project-a", basis: "written_files", projects: { "project-a": 1 } },
          { sessionId: "session-b", launchDir: "firebase-kit", project: "project-b", basis: "launch_dir", projects: {} },
        ],
      }));

      const result = await makeManifest({
        transcriptsDirectory,
        outputPath,
        project: "project-a",
        dateStart: "2026-09-23",
        dateEnd: "2026-10-05",
      });

      expect(result.fileAudit).toEqual({ fileCount: 1, included: 1, excluded: 0, noHuman: 0, outsidePeriod: 0 });
      expect(JSON.parse(readFileSync(outputPath, "utf8")).sessions).toHaveLength(1);
      expect(JSON.parse(readFileSync(outputPath, "utf8")).sessions[0].sessionId).toBe("session-a");
      await expect(makeManifest({
        transcriptsDirectory,
        outputPath,
        project: "missing-project",
        dateStart: "2026-09-23",
        dateEnd: "2026-10-05",
      })).rejects.toThrow(/project/u);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
