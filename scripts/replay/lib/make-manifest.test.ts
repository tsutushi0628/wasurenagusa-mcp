import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("入力ディレクトリと出力を必須にし、除外接頭辞を指定できる", () => {
    expect(() => parseMakeManifestArguments([])).toThrow(/--transcripts.*--out/u);
    expect(parseMakeManifestArguments([
      "--transcripts", "transcripts",
      "--out", "manifest.json",
    ])).toMatchObject({
      transcriptsDirectory: "transcripts",
      outputPath: "manifest.json",
      excludePrefixes: ["dccb7da4", "57b0207c"],
    });
    expect(parseMakeManifestArguments([
      "--transcripts", "transcripts",
      "--out", "manifest.json",
      "--exclude-prefix", "custom-id",
      "--exclude-prefix", "other-id",
    ]).excludePrefixes).toEqual(["custom-id", "other-id"]);
  });

  it("readManifestが検査する全dispositionと固定prefixだけを記録する", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "replay-make-manifest-"));
    const transcriptsDirectory = join(scratch, "transcripts");
    const outputPath = join(scratch, "manifest.json");
    const includedSessionId = "included-session";
    const includedCompleteRow = transcriptRow(includedSessionId, "2026-09-21T15:00:00.000Z", "期間開始の発話");
    const includedEndRow = transcriptRow(includedSessionId, "2026-10-02T14:59:59.999Z", "期間終了の発話");
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

      const result = await makeManifest({ transcriptsDirectory, outputPath });
      expect(result.fileAudit).toEqual({ fileCount: 4, included: 1, excluded: 1, noHuman: 1, outsidePeriod: 1 });

      const manifest = JSON.parse(readFileSync(outputPath, "utf8"));
      expect(manifest.sessions).toHaveLength(1);
      expect(manifest.sessions[0]).toMatchObject({
        sessionId: includedSessionId,
        readEndByteOffset: Buffer.byteLength(includedCompletePrefix),
        prefixSha256: createHash("sha256").update(includedCompletePrefix).digest("hex"),
      });
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
});
