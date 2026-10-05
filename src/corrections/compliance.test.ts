import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { migrateV10ToV11, migrateV11ToV12 } from "../storage/migration.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import {
  findCorrectionComplianceViolations,
  getLatestAssistantText,
  isCorrectionComplianceEnabled,
  persistCorrectionComplianceViolations,
  type ComplianceRule,
} from "./compliance.js";

const toneRule: ComplianceRule = {
  bundleKey: "synthetic-tone",
  version: 1,
  topicKey: "tone",
  ruleText: "回答は常体で書く",
  polarity: "positive",
};

const documentRule: ComplianceRule = {
  bundleKey: "synthetic-document",
  version: 1,
  topicKey: "document_delivery",
  ruleText: "文書は全文を表示する",
  polarity: "positive",
};

const expressionRule: ComplianceRule = {
  bundleKey: "synthetic-expression",
  version: 1,
  topicKey: "expression_policy",
  ruleText: "工程略号は使わない",
  polarity: "negative",
};

const cases: Array<{
  name: string;
  text: string;
  rules: ComplianceRule[];
  expected: string[];
}> = [
  {
    name: "常体規則があるのに敬体文末が2文ある",
    text: "確認しました。対応します。",
    rules: [toneRule],
    expected: ["tone"],
  },
  {
    name: "3文の敬体文末を数える",
    text: "確認しました。対応します。次も行います。",
    rules: [toneRule],
    expected: ["tone"],
  },
  {
    name: "中略標識を検出する",
    text: "本文を表示する。（中略）",
    rules: [documentRule],
    expected: ["document_delivery"],
  },
  {
    name: "省略標識を検出する",
    text: "本文は以下略",
    rules: [documentRule],
    expected: ["document_delivery"],
  },
  {
    name: "大文字の工程略号を検出する",
    text: "これは P7 で確認する。",
    rules: [expressionRule],
    expected: ["expression_policy"],
  },
  {
    name: "引用文内の敬体を除外する",
    text: "「確認しました。対応します。」と書かれていた。",
    rules: [toneRule],
    expected: [],
  },
  {
    name: "コードフェンス内の工程略号を除外する",
    text: "```ts\nconst stage = 'T9';\n```",
    rules: [expressionRule],
    expected: [],
  },
  {
    name: "インラインコード内の工程略号を除外する",
    text: "例は `T9` です。",
    rules: [expressionRule],
    expected: [],
  },
  {
    name: "敬体文末が1文なら違反にしない",
    text: "確認しました。次の案は plain form で書く。",
    rules: [toneRule],
    expected: [],
  },
  {
    name: "小文字の略号は工程略号として数えない",
    text: "これは p7 で確認する。",
    rules: [expressionRule],
    expected: [],
  },
];

describe("確定規則の遵守検査", () => {
  it.each(cases)("$name", ({ text, rules, expected }) => {
    const violations = findCorrectionComplianceViolations(text, rules);
    expect(violations.map((violation) => violation.checker)).toEqual(expected);
  });

  it("逆向きの確定規則を遵守違反として数えない", () => {
    const oppositeRules: ComplianceRule[] = [
      { ...toneRule, polarity: "negative", ruleText: "応答は常体では書かない" },
      { ...documentRule, polarity: "negative", ruleText: "文書は全文を表示しない" },
      { ...expressionRule, polarity: "positive", ruleText: "工程略号を使う" },
    ];

    expect(findCorrectionComplianceViolations("確認しました。対応します。（中略）P7", oppositeRules)).toEqual([]);
  });

  it("遵守検査は既定で有効、環境変数offで無効", () => {
    expect(isCorrectionComplianceEnabled({})).toBe(true);
    expect(isCorrectionComplianceEnabled({ WASURENAGUSA_CORRECTION_COMPLIANCE: "off" })).toBe(false);
    expect(isCorrectionComplianceEnabled({ WASURENAGUSA_CORRECTION_COMPLIANCE: "ON" })).toBe(true);
  });

  it("最後の人間発話より後の直近assistant textを使う", () => {
    const text = getLatestAssistantText([
      {
        byteOffset: 0,
        byteEndOffset: 10,
        entry: { type: "assistant", message: { role: "assistant", content: "古い回答" } },
      },
      {
        byteOffset: 10,
        byteEndOffset: 20,
        entry: { type: "user", origin: { kind: "human" }, message: { role: "user", content: "合成依頼" } },
      },
      {
        byteOffset: 20,
        byteEndOffset: 30,
        entry: { type: "assistant", message: { role: "assistant", content: "新しい回答" } },
      },
    ]);

    expect(text).toBe("新しい回答");
  });

  it("Stopで当該sessionに本文が届いた確定規則だけを一度記録する", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "correction-compliance-store-"));
    const dbPath = join(tempDir, "memory.db");
    const initialStorage = new SQLiteStorage(dbPath);
    initialStorage.initialize();
    initialStorage.close();
    const setupDb = new Database(dbPath);
    migrateV10ToV11(setupDb);
    migrateV11ToV12(setupDb);
    setupDb.close();
    const storage = SQLiteStorage.openExistingForHook(dbPath, { mode: "correction" });
    const previousValue = process.env.WASURENAGUSA_CORRECTION_COMPLIANCE;
    process.env.WASURENAGUSA_CORRECTION_COMPLIANCE = "on";

    try {
      storage.runCorrectionTransaction(({ db, save }) => {
        const insertRule = (
          bundleKey: string,
          topicKey: string,
          status: "confirmed" | "candidate",
        ): void => {
          const ruleText = "回答は常体で書く";
          const saved = save({
            category: "dont",
            title: "Synthetic " + bundleKey,
            content: ruleText,
            tags: ["synthetic"],
            project: "fixture-project",
            scope: "general",
            intensity: 3,
          });
          db.prepare(`
            INSERT INTO owner_correction_bundles (
              bundle_key, memory_id, rule_text, topic_key, polarity, condition_key, project, scope,
              visibility, status, intensity, occurrence_count, session_count, first_seen_at, last_seen_at,
              expires_at, lifetime_kind, continuation_basis, confirmed_at, version, counterevidence_event_id,
              last_confirmation_asked_at, confirmation_state
            ) VALUES (?, ?, ?, ?, 'positive', 'general', 'fixture-project', 'general', 'owner', ?, 3, 2, 2,
              '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', NULL, 'explicit_continuing',
              'synthetic', '2026-10-01T00:00:00.000Z', 1, NULL, NULL, 'none')
          `).run(bundleKey, saved.id, ruleText, topicKey, status);
          db.prepare(`
            INSERT INTO owner_correction_versions (
              bundle_key, version, rule_text, body_hash, conditions, condition_key, polarity, visibility,
              status, confirmed_at, expires_at, lifetime_kind, continuation_basis, evidence_event_ids,
              effective_from, change_reason
            ) VALUES (?, 1, ?, 'synthetic-hash', '[]', 'general', 'positive', 'owner', ?,
              '2026-10-01T00:00:00.000Z', NULL, 'explicit_continuing', 'synthetic', '[]',
              '2026-10-01T00:00:00.000Z', 'synthetic')
          `).run(bundleKey, ruleText, status);
        };
        insertRule("emitted-confirmed", "tone", "confirmed");
        insertRule("emitted-candidate", "tone", "candidate");
        insertRule("omitted-confirmed", "tone", "confirmed");
        insertRule("failed-confirmed", "tone", "confirmed");

        const insertEmission = (bundleKey: string, bodyIncluded: 0 | 1, stdoutStatus: "emitted" | "failed"): void => {
          db.prepare(`
            INSERT INTO owner_correction_injections (
              session_id_hash, compact_epoch, bundle_key, version, human_ordinal, trigger, emitted_at,
              output_order, body_hash, output_hash, token_estimate, body_included, stdout_status
            ) VALUES ('synthetic-session', 0, ?, 1, 1, 'start', '2026-10-02T00:00:00.000Z', 1,
              'synthetic-body-hash', 'synthetic-output-hash', 20, ?, ?)
          `).run(bundleKey, bodyIncluded, stdoutStatus);
        };
        insertEmission("emitted-confirmed", 1, "emitted");
        insertEmission("emitted-candidate", 1, "emitted");
        insertEmission("omitted-confirmed", 0, "emitted");
        insertEmission("failed-confirmed", 1, "failed");
      });

      const input = {
        sessionIdHash: "synthetic-session",
        humanOrdinal: 1,
        assistantText: "確認しました。対応します。",
        detectedAt: "2026-10-03T00:00:00.000Z",
      };
      expect(persistCorrectionComplianceViolations(storage, input)).toEqual([
        { bundleKey: "emitted-confirmed", version: 1, checker: "tone" },
      ]);
      expect(persistCorrectionComplianceViolations(storage, input)).toEqual([]);
      expect(storage.connection.prepare("SELECT bundle_key, checker FROM owner_correction_violations").all())
        .toEqual([{ bundle_key: "emitted-confirmed", checker: "tone" }]);
    } finally {
      storage.close();
      if (previousValue === undefined) delete process.env.WASURENAGUSA_CORRECTION_COMPLIANCE;
      else process.env.WASURENAGUSA_CORRECTION_COMPLIANCE = previousValue;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
