import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { migrateV10ToV11, migrateV11ToV12, migrateV12ToV13 } from "../storage/migration.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { serializeCorrectionRuleInput } from "./rule-template.js";
import {
  assessCorrectionCompliance,
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

function toneRuleConditions(conditionKey: string, audience = "owner", conditions: string[] = []): string {
  return serializeCorrectionRuleInput({
    version: 2,
    topicKey: "tone",
    actionKey: "use_casual",
    polarity: "positive",
    requiredValues: { audience, style: "常体" },
    conditions,
    boundaryKey: conditionKey,
    lifetimeKind: "inferred",
    continuationBasis: "synthetic-fixture",
    directive: true,
    plainCommandEligible: false,
    question: false,
    toneException: false,
    conditionKnown: true,
  });
}

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
  const sourceDocument = Array.from({ length: 4 }, (_, paragraphIndex) =>
    Array.from({ length: 8 }, (_, sentenceIndex) =>
      `第${paragraphIndex + 1}段落の${sentenceIndex + 1}項では、背景、手順、判断理由、確認結果を順に記録する。`,
    ).join("")
  ).join("\n\n");
  const longSummary = Array.from({ length: 4 }, (_, paragraphIndex) =>
    Array.from({ length: 2 }, (_, sentenceIndex) =>
      `要約段落${paragraphIndex + 1}の要点${sentenceIndex + 1}では、` + "方針と結果を整理して伝える。".repeat(10),
    ).join("")
  ).join("\n\n");

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

  it("違反なしと証拠ありを分け、短い要約は全文遵守の証拠にしない", () => {
    const shortSummary = "要点は三つ。手続きの遅れと対応方針を簡潔にまとめた。";

    expect(assessCorrectionCompliance(shortSummary, [documentRule])).toEqual([{
      bundleKey: documentRule.bundleKey,
      version: documentRule.version,
      checker: "document_delivery",
      outcome: "unproven",
    }]);
    expect(findCorrectionComplianceViolations(shortSummary, [documentRule])).toEqual([]);
  });

  it("照合元がない長い要約は全文遵守の証拠にしない", () => {
    expect(longSummary.replace(/\s/gu, "").length).toBeGreaterThanOrEqual(1000);
    expect(assessCorrectionCompliance(longSummary, [documentRule])).toEqual([{
      bundleKey: documentRule.bundleKey,
      version: documentRule.version,
      checker: "document_delivery",
      outcome: "unproven",
    }]);
  });

  it("照合元がある要約は全文遵守にしない", () => {
    expect(assessCorrectionCompliance(longSummary, [documentRule], sourceDocument)).toEqual([{
      bundleKey: documentRule.bundleKey,
      version: documentRule.version,
      checker: "document_delivery",
      outcome: "violation",
    }]);
  });

  it("照合元の全文を応答が含む場合だけ全文遵守の証拠にする", () => {
    expect(assessCorrectionCompliance(sourceDocument, [documentRule], sourceDocument)).toEqual([{
      bundleKey: documentRule.bundleKey,
      version: documentRule.version,
      checker: "document_delivery",
      outcome: "compliant",
    }]);
  });

  it("常体の明示文末と略号のない実質回答を証拠にし、短い断片は証拠にしない", () => {
    expect(assessCorrectionCompliance("今後は常体で回答する。", [toneRule])).toEqual([{
      bundleKey: toneRule.bundleKey,
      version: toneRule.version,
      checker: "tone",
      outcome: "compliant",
    }]);
    expect(assessCorrectionCompliance("工程の順序を確認する。", [expressionRule])).toEqual([{
      bundleKey: expressionRule.bundleKey,
      version: expressionRule.version,
      checker: "expression_policy",
      outcome: "compliant",
    }]);
    expect(assessCorrectionCompliance("了解。", [expressionRule])).toEqual([{
      bundleKey: expressionRule.bundleKey,
      version: expressionRule.version,
      checker: "expression_policy",
      outcome: "unproven",
    }]);
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

  it("根拠追加だけの版更新では旧注入規則を検査し、規則変更後は外す", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "correction-compliance-version-store-"));
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
        const insertVersionedRule = (
          bundleKey: string,
          sessionIdHash: string,
          currentRuleText: string,
          currentBodyHash: string,
        ): void => {
          const initialRuleText = "回答は常体で書く";
          const memory = save({
            category: "dont",
            title: "Synthetic " + bundleKey,
            content: currentRuleText,
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
            ) VALUES (?, ?, ?, 'tone', 'positive', 'general', 'fixture-project', 'general', 'owner',
              'confirmed', 3, 2, 2, '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z',
              '2026-10-10T00:00:00.000Z', 'explicit_continuing', 'synthetic',
              '2026-10-01T00:00:00.000Z', 2, NULL, NULL, 'none')
          `).run(bundleKey, memory.id, currentRuleText);
          db.prepare(`
            INSERT INTO owner_correction_versions (
              bundle_key, version, rule_text, body_hash, conditions, condition_key, polarity, visibility,
              status, confirmed_at, expires_at, lifetime_kind, continuation_basis, evidence_event_ids,
              effective_from, change_reason
            ) VALUES (?, 1, ?, 'synthetic-rule-hash', 'synthetic-conditions', 'general', 'positive', 'owner',
              'confirmed', '2026-10-01T00:00:00.000Z', '2026-10-04T00:00:00.000Z',
              'explicit_continuing', 'synthetic', '["event-one"]', '2026-10-01T00:00:00.000Z', 'synthetic')
          `).run(bundleKey, initialRuleText);
          db.prepare(`
            INSERT INTO owner_correction_versions (
              bundle_key, version, rule_text, body_hash, conditions, condition_key, polarity, visibility,
              status, confirmed_at, expires_at, lifetime_kind, continuation_basis, evidence_event_ids,
              effective_from, change_reason
            ) VALUES (?, 2, ?, ?, 'synthetic-conditions', 'general', 'positive', 'owner', 'confirmed',
              '2026-10-01T00:00:00.000Z', '2026-10-10T00:00:00.000Z', 'explicit_continuing', 'synthetic',
              '["event-one","event-two"]', '2026-10-02T00:00:00.000Z', 'bundle_updated')
          `).run(bundleKey, currentRuleText, currentBodyHash);
          db.prepare(`
            INSERT INTO owner_correction_injections (
              session_id_hash, compact_epoch, bundle_key, version, human_ordinal, trigger, emitted_at,
              output_order, body_hash, output_hash, token_estimate, body_included, stdout_status
            ) VALUES (?, 0, ?, 1, 1, 'start', '2026-10-02T00:00:00.000Z', 1,
              'synthetic-output-body', 'synthetic-output', 20, 1, 'emitted')
          `).run(sessionIdHash, bundleKey);
        };

        insertVersionedRule("same-meaning", "synthetic-same-session", "回答は常体で書く", "synthetic-rule-hash");
        insertVersionedRule("changed-meaning", "synthetic-changed-session", "回答は短く書く", "synthetic-changed-rule-hash");
      });

      const input = {
        humanOrdinal: 2,
        assistantText: "確認しました。対応します。",
        detectedAt: "2026-10-03T00:00:00.000Z",
      };
      expect(persistCorrectionComplianceViolations(storage, {
        ...input,
        sessionIdHash: "synthetic-same-session",
      })).toEqual([{ bundleKey: "same-meaning", version: 1, checker: "tone" }]);
      expect(persistCorrectionComplianceViolations(storage, {
        ...input,
        sessionIdHash: "synthetic-changed-session",
      })).toEqual([]);
    } finally {
      storage.close();
      if (previousValue === undefined) delete process.env.WASURENAGUSA_CORRECTION_COMPLIANCE;
      else process.env.WASURENAGUSA_CORRECTION_COMPLIANCE = previousValue;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("原則は構成元のtopicと検査可能な条件を引き継ぐ", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "correction-compliance-principle-"));
    const dbPath = join(tempDir, "memory.db");
    const initialStorage = new SQLiteStorage(dbPath);
    initialStorage.initialize();
    initialStorage.close();
    const setupDb = new Database(dbPath);
    migrateV10ToV11(setupDb);
    migrateV11ToV12(setupDb);
    migrateV12ToV13(setupDb);
    setupDb.close();
    const storage = SQLiteStorage.openExistingForHook(dbPath, { mode: "correction" });
    const previousValue = process.env.WASURENAGUSA_CORRECTION_COMPLIANCE;
    process.env.WASURENAGUSA_CORRECTION_COMPLIANCE = "on";

    try {
      storage.runCorrectionTransaction(({ db, save }) => {
        const insertRule = (input: {
          bundleKey: string;
          topicKey: string;
          ruleText: string;
          conditionKey: string;
          conditions: string;
        }): void => {
          const at = "2026-10-01T00:00:00.000Z";
          const lifetimeKind = input.conditionKey.startsWith("task:") ? "task" : "inferred";
          const memory = save({
            category: "dont",
            title: "Synthetic " + input.bundleKey,
            content: input.ruleText,
            tags: ["synthetic"],
            project: "owner",
            scope: "owner",
            intensity: 3,
          });
          db.prepare("INSERT INTO owner_correction_bundles (bundle_key, memory_id, rule_text, topic_key, polarity, condition_key, project, scope, visibility, status, intensity, occurrence_count, session_count, first_seen_at, last_seen_at, expires_at, lifetime_kind, continuation_basis, confirmed_at, version, counterevidence_event_id, last_confirmation_asked_at, confirmation_state) VALUES (?, ?, ?, ?, 'positive', ?, 'owner', 'owner', 'owner', 'confirmed', 3, 1, 1, ?, ?, NULL, ?, 'synthetic', ?, 1, NULL, NULL, 'none')").run(
            input.bundleKey,
            memory.id,
            input.ruleText,
            input.topicKey,
            input.conditionKey,
            at,
            at,
            lifetimeKind,
            at,
          );
          db.prepare("INSERT INTO owner_correction_versions (bundle_key, version, rule_text, body_hash, conditions, condition_key, polarity, visibility, status, confirmed_at, expires_at, lifetime_kind, continuation_basis, evidence_event_ids, effective_from, change_reason) VALUES (?, 1, ?, ?, ?, ?, 'positive', 'owner', 'confirmed', ?, NULL, ?, 'synthetic', '[]', ?, 'synthetic-fixture')").run(
            input.bundleKey,
            input.ruleText,
            "synthetic-body-" + input.bundleKey,
            input.conditions,
            input.conditionKey,
            at,
            lifetimeKind,
            at,
          );
        };
        const insertPrinciple = (
          principleKey: string,
          sourceKey: string,
          conditionKey: string,
          audience = "owner",
          sourceRuleText = "回答は常体で書く",
          sourceConditions: string[] = [],
        ): void => {
          insertRule({
            bundleKey: sourceKey,
            topicKey: "tone",
            ruleText: sourceRuleText,
            conditionKey,
            conditions: toneRuleConditions(conditionKey, audience, sourceConditions),
          });
          insertRule({
            bundleKey: principleKey,
            topicKey: "principle",
            ruleText: "同じ書き方を続ける",
            conditionKey: "general",
            conditions: "[]",
          });
          db.prepare("INSERT INTO owner_correction_principle_members (principle_key, member_key, attached_at, attach_source) VALUES (?, ?, '2026-10-01T00:00:00.000Z', 'cluster')").run(principleKey, sourceKey);
          db.prepare("INSERT INTO owner_correction_injections (session_id_hash, compact_epoch, bundle_key, version, human_ordinal, trigger, emitted_at, output_order, body_hash, output_hash, token_estimate, body_included, stdout_status) VALUES (?, 0, ?, 1, 1, 'start', '2026-10-01T00:00:00.000Z', 1, 'synthetic-body', 'synthetic-output', 20, 1, 'emitted')").run("synthetic-session-" + sourceKey, principleKey);
        };

        insertPrinciple("pr:v1:synthetic-general-principle", "synthetic-general-source", "general");
        insertPrinciple(
          "pr:v1:synthetic-client-principle",
          "synthetic-client-source",
          "general;audience:client",
          "client",
          "顧客向けの回答は常体で書く",
        );
        insertPrinciple(
          "pr:v1:synthetic-conditioned-principle",
          "synthetic-conditioned-source",
          "general",
          "owner",
          "報告は常体で書く",
          ["報告作成時"],
        );
      });

      const input = {
        humanOrdinal: 2,
        assistantText: "確認しました。対応します。",
        detectedAt: "2026-10-01T00:00:01.000Z",
      };
      expect(persistCorrectionComplianceViolations(storage, {
        ...input,
        sessionIdHash: "synthetic-session-synthetic-general-source",
      })).toEqual([{
        bundleKey: "pr:v1:synthetic-general-principle",
        version: 1,
        checker: "tone",
      }]);
      expect(persistCorrectionComplianceViolations(storage, {
        ...input,
        sessionIdHash: "synthetic-session-synthetic-client-source",
      })).toEqual([]);
      expect(persistCorrectionComplianceViolations(storage, {
        ...input,
        sessionIdHash: "synthetic-session-synthetic-conditioned-source",
      })).toEqual([]);
    } finally {
      storage.close();
      if (previousValue === undefined) delete process.env.WASURENAGUSA_CORRECTION_COMPLIANCE;
      else process.env.WASURENAGUSA_CORRECTION_COMPLIANCE = previousValue;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("未注入でも有効な検査器つき規則を検査し、violationsには書かない", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "correction-compliance-effective-check-"));
    const dbPath = join(tempDir, "memory.db");
    const initialStorage = new SQLiteStorage(dbPath);
    initialStorage.initialize();
    initialStorage.close();
    const setupDb = new Database(dbPath);
    migrateV10ToV11(setupDb);
    migrateV11ToV12(setupDb);
    migrateV12ToV13(setupDb);
    setupDb.close();
    const storage = SQLiteStorage.openExistingForHook(dbPath, { mode: "correction" });
    const previousValue = process.env.WASURENAGUSA_CORRECTION_COMPLIANCE;
    process.env.WASURENAGUSA_CORRECTION_COMPLIANCE = "on";

    try {
      storage.runCorrectionTransaction(({ db }) => {
        db.prepare(`
          INSERT INTO owner_correction_bundles (
            bundle_key, memory_id, rule_text, topic_key, polarity, condition_key, project, scope,
            visibility, status, intensity, occurrence_count, session_count, first_seen_at, last_seen_at,
            expires_at, lifetime_kind, continuation_basis, confirmed_at, version,
            counterevidence_event_id, last_confirmation_asked_at, confirmation_state
          ) VALUES (?, NULL, '回答は常体で書く', 'tone', 'positive', 'general', 'owner', 'owner',
            'owner', 'confirmed', 3, 1, 1, ?, ?, NULL, 'explicit_continuing', 'synthetic', ?, 1,
            NULL, NULL, 'none')
        `).run("oc:v2:synthetic-effective-tone", "2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
        db.prepare(`
          INSERT INTO owner_correction_versions (
            bundle_key, version, rule_text, body_hash, conditions, condition_key, polarity, visibility,
            status, confirmed_at, expires_at, lifetime_kind, continuation_basis, evidence_event_ids,
            effective_from, change_reason
          ) VALUES (?, 1, '回答は常体で書く', 'synthetic-rule-hash', '[]', 'general', 'positive',
            'owner', 'confirmed', ?, NULL, 'explicit_continuing', 'synthetic', '[]', ?, 'fixture')
        `).run("oc:v2:synthetic-effective-tone", "2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
      });

      expect(persistCorrectionComplianceViolations(storage, {
        sessionIdHash: "synthetic-session",
        humanOrdinal: 1,
        assistantText: "確認しました。対応します。",
        detectedAt: "2026-10-01T00:01:00.000Z",
      })).toEqual([]);
      expect(assessCorrectionCompliance("確認しました。", [toneRule])[0]?.outcome).toBe("unproven");
      expect(persistCorrectionComplianceViolations(storage, {
        sessionIdHash: "synthetic-session",
        humanOrdinal: 2,
        assistantText: "確認しました。",
        detectedAt: "2026-10-01T00:02:00.000Z",
      })).toEqual([]);
      expect(storage.connection.prepare(`
        SELECT human_ordinal, bundle_key, version, checker, is_compliant
        FROM owner_correction_compliance_checks
      `).all()).toEqual([{
        human_ordinal: 1,
        bundle_key: "oc:v2:synthetic-effective-tone",
        version: 1,
        checker: "tone",
        is_compliant: 0,
      }]);
      expect(storage.connection.prepare("SELECT bundle_key FROM owner_correction_violations").all()).toEqual([]);
    } finally {
      storage.close();
      if (previousValue === undefined) delete process.env.WASURENAGUSA_CORRECTION_COMPLIANCE;
      else process.env.WASURENAGUSA_CORRECTION_COMPLIANCE = previousValue;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
