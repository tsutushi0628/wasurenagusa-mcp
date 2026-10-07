import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeCorrectionSchema } from "../storage/correction-schema.js";
import { migrateV11ToV12, migrateV12ToV13 } from "../storage/migration.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import {
  extractCorrectionQuery,
  retrieveCorrectionCandidates,
  scoreCorrectionRelevance,
} from "./retrieval.js";

interface RuleInput {
  bundleKey: string;
  ruleText: string;
  topicKey: string;
  conditionKey?: string;
  visibility?: "owner" | "project";
  project?: string;
  scope?: string;
  status?: "confirmed" | "disputed";
  expiresAt?: string | null;
  lifetimeKind?: "explicit_continuing" | "inferred" | "task" | "routing";
  intensity?: number;
  sessionCount?: number;
  lastSeenAt?: string;
  confirmedAt?: string | null;
  versionConfirmedAt?: string | null;
}

describe("owner correction retrieval", () => {
  let tempDir: string;
  let dbPath: string;
  let storage: SQLiteStorage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "correction-retrieval-"));
    dbPath = join(tempDir, "memory.db");
    const initialStorage = new SQLiteStorage(dbPath);
    initialStorage.initialize();
    initialStorage.close();
    const db = new Database(dbPath);
    initializeCorrectionSchema(db);
    db.close();
    storage = new SQLiteStorage(dbPath);
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function addRule(input: RuleInput): void {
    storage.runCorrectionTransaction(({ db, save }) => {
      const saved = save({
        category: "dont",
        title: `Synthetic ${input.bundleKey}`,
        content: input.ruleText,
        tags: ["synthetic"],
        project: input.project ?? "fixture-project",
        scope: input.scope ?? "backend",
        intensity: input.intensity ?? 3,
      });
      const at = input.lastSeenAt ?? "2026-10-01T00:00:00.000Z";
      const expiresAt = input.expiresAt === undefined ? null : input.expiresAt;
      const visibility = input.visibility ?? "owner";
      const status = input.status ?? "confirmed";
      const lifetimeKind = input.lifetimeKind ?? "explicit_continuing";
      const confirmedAt = input.confirmedAt === undefined
        ? status === "confirmed" ? at : null
        : input.confirmedAt;
      const versionConfirmedAt = input.versionConfirmedAt === undefined ? confirmedAt : input.versionConfirmedAt;
      db.prepare(`
        INSERT INTO owner_correction_bundles (
          bundle_key, memory_id, rule_text, topic_key, polarity, condition_key, project, scope,
          visibility, status, intensity, occurrence_count, session_count, first_seen_at, last_seen_at,
          expires_at, lifetime_kind, continuation_basis, confirmed_at, version, counterevidence_event_id,
          last_confirmation_asked_at, confirmation_state
        ) VALUES (?, ?, ?, ?, 'negative', ?, ?, ?, ?, ?, ?, 2, ?, ?, ?, ?, ?, 'synthetic-continuation', ?, 1, NULL, NULL, 'none')
      `).run(
        input.bundleKey,
        saved.id,
        input.ruleText,
        input.topicKey,
        input.conditionKey ?? "general",
        input.project ?? "fixture-project",
        input.scope ?? "backend",
        visibility,
        status,
        input.intensity ?? 3,
        input.sessionCount ?? 2,
        at,
        at,
        expiresAt,
        lifetimeKind,
        confirmedAt,
      );
      db.prepare(`
        INSERT INTO owner_correction_versions (
          bundle_key, version, rule_text, body_hash, conditions, condition_key, polarity, visibility,
          status, confirmed_at, expires_at, lifetime_kind, continuation_basis, evidence_event_ids,
          effective_from, change_reason
        ) VALUES (?, 1, ?, 'synthetic-hash', '[]', ?, 'negative', ?, ?, ?, ?, ?, 'synthetic-continuation', '[]', ?, 'synthetic-fixture')
      `).run(
        input.bundleKey,
        input.ruleText,
        input.conditionKey ?? "general",
        visibility,
        status,
        versionConfirmedAt,
        expiresAt,
        lifetimeKind,
        at,
      );
    });
  }

  it("引用を除外し、2000文字・8語に制限する", () => {
    const parsed = extractCorrectionQuery(
      `出典確認を続ける 「引用だけの合成語」 alpha beta gamma delta epsilon zeta eta theta iota ${"長文".repeat(1100)}`,
    );

    expect(Array.from(parsed.text).length).toBeLessThanOrEqual(2000);
    expect(parsed.text).not.toContain("引用だけの合成語");
    expect(parsed.terms.length).toBeLessThanOrEqual(8);
    expect(parsed.terms).not.toContain("引用だけの合成語");

    const multilineQuote = extractCorrectionQuery("出典を確認する\n「複数行の引用語\n引用語の続き」\n継続する合成文");
    expect(multilineQuote.text).not.toContain("引用語");
    expect(multilineQuote.text).toContain("継続する合成文");
  });

  it("検索用語がモデル名だけなら関連規則にしない", () => {
    const score = scoreCorrectionRelevance({
      query: "Claude Sonnet",
      queryTerms: ["Claude", "Sonnet"],
      ruleText: "Claude Sonnet 向けの合成ルール",
      topicKey: "model_routing",
    });

    expect(score).toBeNull();
  });

  it("R=0.55を採用し、下回る候補を落とす", () => {
    const atThreshold = scoreCorrectionRelevance({
      query: "abcdefgh",
      queryTerms: ["abc", "xyz", "uvw"],
      ruleText: "abcdefghij",
      topicKey: "unrelated-topic",
    });
    const belowThreshold = scoreCorrectionRelevance({
      query: "abcdefgh",
      queryTerms: ["abc", "xyz", "uvw"],
      ruleText: "abcdefghijk",
      topicKey: "unrelated-topic",
    });

    expect(atThreshold).toBeCloseTo(0.55, 5);
    expect(belowThreshold).toBeNull();
  });

  it("対象語から推定したtopic keyが一致すればR=1にする", () => {
    const score = scoreCorrectionRelevance({
      query: "全文提示",
      queryTerms: ["全文提示"],
      ruleText: "全文提示の合成規則",
      topicKey: "document_delivery",
    });

    expect(score).toBe(1);
  });

  it("常時規則も関連候補へ含め、冷却後は関連分から再提示する", () => {
    addRule({ bundleKey: "always-related", ruleText: "全文提示は条件を守る合成規則", topicKey: "document_delivery" });

    const first = retrieveCorrectionCandidates(storage, {
      project: "fixture-project",
      scope: "backend",
      query: "全文提示",
      at: "2026-10-03T00:00:00.000Z",
    });

    expect(first.alwaysOn.map((rule) => rule.bundleKey)).toContain("always-related");
    expect(first.related.map((rule) => rule.bundleKey)).toContain("always-related");
  });

  it("文案・報告の型対象でFTS語が重ならないtopic規則を取得する", () => {
    addRule({ bundleKey: "topic-only", ruleText: "照合して提示する", topicKey: "document_delivery" });

    const result = retrieveCorrectionCandidates(storage, {
      project: "fixture-project",
      scope: "backend",
      query: "報告文案を作る",
      at: "2026-10-03T00:00:00.000Z",
    });

    expect(result.related.map((rule) => rule.bundleKey)).toContain("topic-only");
    expect(result.related.find((rule) => rule.bundleKey === "topic-only")?.relevance).toBe(1);
  });

  it("model_routingはモデル名だけで一致せず、作業種別と完全なモデルが一致する", () => {
    addRule({
      bundleKey: "route-implementation-sonnet",
      ruleText: "実装はClaude Sonnetで担当する",
      topicKey: "model_routing",
      conditionKey: "routing;route:implementation=claude sonnet",
    });

    const modelOnly = retrieveCorrectionCandidates(storage, {
      project: "fixture-project",
      scope: "backend",
      query: "Claude Sonnet",
      at: "2026-10-03T00:00:00.000Z",
    });
    const matchingWork = retrieveCorrectionCandidates(storage, {
      project: "fixture-project",
      scope: "backend",
      query: "Claude Sonnetで実装",
      at: "2026-10-03T00:00:00.000Z",
    });
    const otherWork = retrieveCorrectionCandidates(storage, {
      project: "fixture-project",
      scope: "backend",
      query: "Claude Sonnetで設計",
      at: "2026-10-03T00:00:00.000Z",
    });

    expect(modelOnly.related.map((rule) => rule.bundleKey)).not.toContain("route-implementation-sonnet");
    expect(matchingWork.related.map((rule) => rule.bundleKey)).toContain("route-implementation-sonnet");
    expect(otherWork.related.map((rule) => rule.bundleKey)).not.toContain("route-implementation-sonnet");
  });

  it("owner規則と一致 project の規則だけを取り、期限切れ・相反を除く", () => {
    addRule({ bundleKey: "owner-rule", ruleText: "出典確認の合成規則", topicKey: "verification" });
    addRule({
      bundleKey: "project-rule",
      ruleText: "出典確認の別の合成規則",
      topicKey: "verification",
      visibility: "project",
    });
    addRule({
      bundleKey: "other-project",
      ruleText: "出典確認の別案件規則",
      topicKey: "verification",
      visibility: "project",
      project: "other-project",
    });
    addRule({
      bundleKey: "other-scope",
      ruleText: "出典確認の別範囲規則",
      topicKey: "verification",
      visibility: "project",
      scope: "frontend",
    });
    addRule({
      bundleKey: "expired-rule",
      ruleText: "出典確認の期限切れ規則",
      topicKey: "verification",
      expiresAt: "2026-09-01T00:00:00.000Z",
    });
    addRule({
      bundleKey: "disputed-rule",
      ruleText: "出典確認の相反規則",
      topicKey: "verification",
      status: "disputed",
    });

    const result = retrieveCorrectionCandidates(storage, {
      project: "fixture-project",
      scope: "backend",
      query: "出典確認",
      at: "2026-10-03T00:00:00.000Z",
    });

    expect(result.alwaysOn.map((rule) => rule.bundleKey)).toContain("owner-rule");
    expect(result.related.map((rule) => rule.bundleKey)).toContain("project-rule");
    expect(result.related.map((rule) => rule.bundleKey)).not.toContain("other-project");
    expect(result.related.map((rule) => rule.bundleKey)).not.toContain("other-scope");
    expect(result.related.map((rule) => rule.bundleKey)).not.toContain("expired-rule");
    expect(result.related.map((rule) => rule.bundleKey)).not.toContain("disputed-rule");
  });

  it("話し方のproject規則だけを明示on時に他projectへ読み出し、保存visibilityは変えない", () => {
    addRule({
      bundleKey: "cross-project-response-topic",
      ruleText: "会話では敬語で答える",
      topicKey: "tone",
      visibility: "project",
      project: "source-project",
      scope: "backend",
    });
    addRule({
      bundleKey: "cross-project-response-terms",
      ruleText: "質問には簡潔に答え、分からない言葉を使わない。",
      topicKey: "response_policy",
      visibility: "project",
      project: "source-project",
      scope: "backend",
    });
    addRule({
      bundleKey: "cross-project-full-text",
      ruleText: "全文出して",
      topicKey: "document_delivery",
      visibility: "project",
      project: "source-project",
      scope: "backend",
    });
    addRule({
      bundleKey: "cross-project-brief-response",
      ruleText: "簡潔に",
      topicKey: "document_delivery",
      visibility: "project",
      project: "source-project",
      scope: "backend",
    });
    addRule({
      bundleKey: "cross-project-no-repeat",
      ruleText: "同じ注意書きを繰り返すな",
      topicKey: "response_policy",
      visibility: "project",
      project: "source-project",
      scope: "backend",
    });
    addRule({
      bundleKey: "cross-project-plain-words",
      ruleText: "分からない言葉を使うな",
      topicKey: "expression_policy",
      visibility: "project",
      project: "source-project",
      scope: "backend",
    });
    addRule({
      bundleKey: "cross-project-answer-question",
      ruleText: "質問に答えろ",
      topicKey: "response_policy",
      visibility: "project",
      project: "source-project",
      scope: "backend",
    });
    addRule({
      bundleKey: "source-project-storage-rule",
      ruleText: "合成データは reports/ 配下に保存する。",
      topicKey: "storage_location",
      visibility: "project",
      project: "source-project",
      scope: "backend",
    });
    addRule({
      bundleKey: "source-project-document-rule",
      ruleText: "社外向け文書は毎回全文を表示する",
      topicKey: "document_delivery",
      visibility: "project",
      project: "source-project",
      scope: "backend",
    });
    addRule({
      bundleKey: "source-project-brand-tone",
      ruleText: "このアプリのブランド文体はカジュアル",
      topicKey: "tone",
      visibility: "project",
      project: "source-project",
      scope: "backend",
    });
    addRule({
      bundleKey: "source-project-app-response",
      ruleText: "アプリの応答は敬語で答える",
      topicKey: "tone",
      visibility: "project",
      project: "source-project",
      scope: "backend",
    });
    addRule({
      bundleKey: "source-project-api-procedure",
      ruleText: "このAPIは失敗時に待機してから停止する",
      topicKey: "response_policy",
      visibility: "project",
      project: "source-project",
      scope: "backend",
    });
    addRule({
      bundleKey: "source-project-glossary",
      ruleText: "略号 CF は Cloud Function を表す",
      topicKey: "expression_policy",
      visibility: "project",
      project: "source-project",
      scope: "backend",
    });
    addRule({
      bundleKey: "source-project-document-delivery",
      ruleText: "文章は毎回全文を表示する",
      topicKey: "document_delivery",
      visibility: "project",
      project: "source-project",
      scope: "backend",
    });

    const previousMode = process.env.WASURENAGUSA_OWNER_SCOPE_BEHAVIOR;
    try {
      delete process.env.WASURENAGUSA_OWNER_SCOPE_BEHAVIOR;
      const disabled = retrieveCorrectionCandidates(storage, {
        project: "other-project",
        scope: "frontend",
        query: "",
        at: "2026-10-03T00:00:00.000Z",
      });
      expect(disabled.alwaysOn.map((rule) => rule.bundleKey)).not.toContain("cross-project-response-topic");
      expect(disabled.alwaysOn.map((rule) => rule.bundleKey)).not.toContain("cross-project-response-terms");
      expect(disabled.alwaysOn.map((rule) => rule.bundleKey)).not.toContain("cross-project-full-text");
      expect(disabled.alwaysOn.map((rule) => rule.bundleKey)).not.toContain("cross-project-brief-response");
      expect(disabled.alwaysOn.map((rule) => rule.bundleKey)).not.toContain("cross-project-no-repeat");
      expect(disabled.alwaysOn.map((rule) => rule.bundleKey)).not.toContain("cross-project-plain-words");
      expect(disabled.alwaysOn.map((rule) => rule.bundleKey)).not.toContain("cross-project-answer-question");
      const localWithDisabled = retrieveCorrectionCandidates(storage, {
        project: "source-project",
        scope: "backend",
        query: "",
        at: "2026-10-03T00:00:00.000Z",
      });
      expect(localWithDisabled.projectRules.map((rule) => rule.bundleKey)).toContain("cross-project-response-topic");

      process.env.WASURENAGUSA_OWNER_SCOPE_BEHAVIOR = "on";
      const enabled = retrieveCorrectionCandidates(storage, {
        project: "other-project",
        scope: "frontend",
        query: "",
        at: "2026-10-03T00:00:00.000Z",
      });

      expect(enabled.alwaysOn.map((rule) => rule.bundleKey)).toContain("cross-project-response-topic");
      expect(enabled.alwaysOn.map((rule) => rule.bundleKey)).toContain("cross-project-response-terms");
      expect(enabled.alwaysOn.map((rule) => rule.bundleKey)).toContain("cross-project-full-text");
      expect(enabled.alwaysOn.map((rule) => rule.bundleKey)).toContain("cross-project-brief-response");
      expect(enabled.alwaysOn.map((rule) => rule.bundleKey)).toContain("cross-project-no-repeat");
      expect(enabled.alwaysOn.map((rule) => rule.bundleKey)).toContain("cross-project-plain-words");
      expect(enabled.alwaysOn.map((rule) => rule.bundleKey)).toContain("cross-project-answer-question");
      expect(enabled.alwaysOn.find((rule) => rule.bundleKey === "cross-project-response-terms")?.visibility).toBe("owner");
      expect(enabled.alwaysOn.map((rule) => rule.bundleKey)).not.toContain("source-project-storage-rule");
      expect(enabled.alwaysOn.map((rule) => rule.bundleKey)).not.toContain("source-project-document-rule");
      expect(enabled.alwaysOn.map((rule) => rule.bundleKey)).not.toContain("source-project-brand-tone");
      expect(enabled.alwaysOn.map((rule) => rule.bundleKey)).not.toContain("source-project-app-response");
      expect(enabled.alwaysOn.map((rule) => rule.bundleKey)).not.toContain("source-project-api-procedure");
      expect(enabled.alwaysOn.map((rule) => rule.bundleKey)).not.toContain("source-project-glossary");
      expect(enabled.alwaysOn.map((rule) => rule.bundleKey)).not.toContain("source-project-document-delivery");

      let storedVisibility = "";
      storage.runCorrectionTransaction(({ db }) => {
        const row = db.prepare("SELECT visibility FROM owner_correction_bundles WHERE bundle_key = ?")
          .get("cross-project-response-terms") as { visibility: string };
        storedVisibility = row.visibility;
      });
      expect(storedVisibility).toBe("project");
    } finally {
      if (previousMode === undefined) delete process.env.WASURENAGUSA_OWNER_SCOPE_BEHAVIOR;
      else process.env.WASURENAGUSA_OWNER_SCOPE_BEHAVIOR = previousMode;
    }
  });

  it("session1の確定前には隠し、session3では持ち越し束を見せる", () => {
    addRule({
      bundleKey: "future-bundle-confirmation",
      ruleText: "出典確認の合成規則",
      topicKey: "verification",
      visibility: "project",
      confirmedAt: "2026-10-03T03:00:00.500Z",
      versionConfirmedAt: "2026-10-03T03:00:00.500Z",
    });
    addRule({
      bundleKey: "future-version-confirmation",
      ruleText: "出典確認の版限定合成規則",
      topicKey: "verification",
      visibility: "project",
      confirmedAt: "2026-10-01T00:00:00.000Z",
      versionConfirmedAt: "2026-10-03T03:00:00.500Z",
    });

    const replayEvents = [
      { sessionId: "synthetic-session-1", at: "2026-10-03T03:00:00.100Z" },
      { sessionId: "synthetic-session-1", at: "2026-10-03T03:00:00.500Z" },
      { sessionId: "synthetic-session-2", at: "2026-10-03T03:00:00.750Z" },
      { sessionId: "synthetic-session-3", at: "2026-10-03T04:00:00.000Z" },
    ];
    const results = replayEvents.map((event) => retrieveCorrectionCandidates(storage, {
      project: "fixture-project",
      scope: "backend",
      query: "出典確認",
      at: event.at,
    }));

    expect(results[0].projectRules.map((rule) => rule.bundleKey)).not.toContain("future-bundle-confirmation");
    expect(results[0].related.map((rule) => rule.bundleKey)).not.toContain("future-bundle-confirmation");
    expect(results[0].projectRules.map((rule) => rule.bundleKey)).not.toContain("future-version-confirmation");
    expect(results[0].related.map((rule) => rule.bundleKey)).not.toContain("future-version-confirmation");
    for (const result of results.slice(1)) {
      expect(result.projectRules.map((rule) => rule.bundleKey)).toContain("future-bundle-confirmation");
      expect(result.related.map((rule) => rule.bundleKey)).toContain("future-bundle-confirmation");
      expect(result.projectRules.map((rule) => rule.bundleKey)).toContain("future-version-confirmation");
      expect(result.related.map((rule) => rule.bundleKey)).toContain("future-version-confirmation");
    }
  });

  it("関連規則を R 閾値と対象語数で絞り、2件まで選べる候補を返す", () => {
    addRule({ bundleKey: "related-one", ruleText: "出典確認を先に行う合成規則", topicKey: "verification", visibility: "project", intensity: 5 });
    addRule({ bundleKey: "related-two", ruleText: "出典確認の結果を示す合成規則", topicKey: "verification", visibility: "project", intensity: 4 });
    addRule({ bundleKey: "related-three", ruleText: "出典確認の条件を残す合成規則", topicKey: "verification", visibility: "project", intensity: 3 });

    const result = retrieveCorrectionCandidates(storage, {
      project: "fixture-project",
      scope: "backend",
      query: "出典確認",
      at: "2026-10-03T00:00:00.000Z",
    });

    expect(result.related.length).toBeGreaterThan(0);
    expect(result.related.length).toBeLessThanOrEqual(40);
    expect(result.related.every((rule) => rule.relevance >= 0.55)).toBe(true);
    expect(result.related.slice(0, 2).map((rule) => rule.bundleKey)).toEqual(["related-one", "related-two"]);
  });

  it("owner/project別FTS候補を各20件、合計40件に抑える", () => {
    for (let index = 1; index <= 22; index += 1) {
      addRule({
        bundleKey: `project-search-${index}`,
        ruleText: `出典確認の合成規則 ${index}`,
        topicKey: "verification",
        visibility: "project",
      });
      addRule({
        bundleKey: `owner-search-${index}`,
        ruleText: `出典確認の所有者向け合成規則 ${index}`,
        topicKey: "verification",
      });
    }

    const result = retrieveCorrectionCandidates(storage, {
      project: "fixture-project",
      scope: "backend",
      query: "出典確認",
      at: "2026-10-03T00:00:00.000Z",
    });

    expect(result.ftsCandidateCount).toBe(40);
  });

  it("空検索はFTSを呼ばず、関連候補を返さない", () => {
    addRule({ bundleKey: "empty-query-rule", ruleText: "合成規則", topicKey: "verification" });

    const result = retrieveCorrectionCandidates(storage, {
      project: "fixture-project",
      scope: "backend",
      query: "",
      at: "2026-10-03T00:00:00.000Z",
    });

    expect(result.ftsCandidateCount).toBe(0);
    expect(result.related).toEqual([]);
  });

  it("強度off/onを往復しても上下限と補正なしの根拠強度・順位を保つ", () => {
    storage.close();
    const migrationDb = new Database(dbPath);
    migrateV11ToV12(migrationDb);
    migrateV12ToV13(migrationDb);
    migrationDb.close();
    storage = new SQLiteStorage(dbPath);
    storage.initialize();
    addRule({
      bundleKey: "upper-clamped",
      ruleText: "出典確認の上限張り付き合成規則",
      topicKey: "verification",
      visibility: "project",
      intensity: 5,
    });
    addRule({
      bundleKey: "upper-comparator",
      ruleText: "出典確認の上限比較合成規則",
      topicKey: "verification",
      visibility: "project",
      intensity: 4,
    });
    addRule({
      bundleKey: "lower-clamped",
      ruleText: "出典確認の下限張り付き合成規則",
      topicKey: "verification",
      visibility: "project",
      intensity: 1,
    });
    addRule({
      bundleKey: "lower-comparator",
      ruleText: "出典確認の下限比較合成規則",
      topicKey: "verification",
      visibility: "project",
      intensity: 2,
    });
    addRule({
      bundleKey: "unadjusted",
      ruleText: "出典確認の補正なし合成規則",
      topicKey: "verification",
      visibility: "project",
      intensity: 3,
    });
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare(`
        INSERT INTO owner_correction_strength_events (
          bundle_key, at, from_intensity, to_intensity, delta, reason, basis
        ) VALUES (?, ?, ?, ?, ?, 'manual', ?)
      `).run("upper-clamped", "2026-10-02T00:00:00.000Z", 4, 5, 1, '{"mode":"on","signal":"fixture","baseIntensity":5}');
      db.prepare(`
        INSERT INTO owner_correction_strength_events (
          bundle_key, at, from_intensity, to_intensity, delta, reason, basis
        ) VALUES (?, ?, ?, ?, ?, 'manual', ?)
      `).run("lower-clamped", "2026-10-02T00:00:00.000Z", 2, 1, -1, '{"mode":"on","signal":"fixture","baseIntensity":1}');
    });

    const previousMode = process.env.WASURENAGUSA_STRENGTH;
    try {
      process.env.WASURENAGUSA_STRENGTH = "on";
      const enabled = retrieveCorrectionCandidates(storage, {
        project: "fixture-project",
        scope: "backend",
        query: "出典確認",
        at: "2026-10-03T00:00:00.000Z",
      });
      const expectedOrder = ["upper-clamped", "upper-comparator", "unadjusted", "lower-comparator", "lower-clamped"];
      expect(enabled.projectRules.map((rule) => rule.bundleKey)).toEqual(expectedOrder);
      expect(Object.fromEntries(enabled.projectRules.map((rule) => [rule.bundleKey, rule.intensity]))).toEqual({
        "upper-clamped": 5,
        "upper-comparator": 4,
        unadjusted: 3,
        "lower-comparator": 2,
        "lower-clamped": 1,
      });

      process.env.WASURENAGUSA_STRENGTH = "off";
      const disabled = retrieveCorrectionCandidates(storage, {
        project: "fixture-project",
        scope: "backend",
        query: "出典確認",
        at: "2026-10-03T00:00:00.000Z",
      });
      expect(disabled.projectRules.map((rule) => rule.bundleKey)).toEqual(expectedOrder);
      expect(disabled.projectRules.map((rule) => rule.intensity)).toEqual(enabled.projectRules.map((rule) => rule.intensity));

      process.env.WASURENAGUSA_STRENGTH = "on";
      const restored = retrieveCorrectionCandidates(storage, {
        project: "fixture-project",
        scope: "backend",
        query: "出典確認",
        at: "2026-10-03T00:00:00.000Z",
      });
      expect(restored.projectRules.map((rule) => rule.bundleKey)).toEqual(expectedOrder);
      expect(restored.projectRules.map((rule) => rule.intensity)).toEqual(disabled.projectRules.map((rule) => rule.intensity));
    } finally {
      if (previousMode === undefined) delete process.env.WASURENAGUSA_STRENGTH;
      else process.env.WASURENAGUSA_STRENGTH = previousMode;
    }
  });

  it("schema v12ではv13の強度表なしで補正候補を読める", () => {
    storage.close();
    const migrationDb = new Database(dbPath);
    migrateV11ToV12(migrationDb);
    migrationDb.close();
    storage = new SQLiteStorage(dbPath);
    storage.initialize();
    addRule({
      bundleKey: "schema-v12-rule",
      ruleText: "出典確認の合成規則",
      topicKey: "verification",
      visibility: "project",
    });
    addRule({
      bundleKey: "schema-v12-response-behavior",
      ruleText: "質問には簡潔に答える合成規則",
      topicKey: "response_policy",
      visibility: "project",
    });
    const previousMode = process.env.WASURENAGUSA_STRENGTH;
    const previousOwnerScopeBehavior = process.env.WASURENAGUSA_OWNER_SCOPE_BEHAVIOR;
    const previousPrinciplesMode = process.env.WASURENAGUSA_PRINCIPLES;
    try {
      process.env.WASURENAGUSA_STRENGTH = "off";
      process.env.WASURENAGUSA_OWNER_SCOPE_BEHAVIOR = "on";
      process.env.WASURENAGUSA_PRINCIPLES = "on";
      const result = retrieveCorrectionCandidates(storage, {
        project: "fixture-project",
        scope: "backend",
        query: "出典確認",
        at: "2026-10-03T00:00:00.000Z",
      });
      expect(result.projectRules.map((rule) => rule.bundleKey)).toContain("schema-v12-rule");
      const crossProjectResult = retrieveCorrectionCandidates(storage, {
        project: "other-project",
        scope: "frontend",
        query: "",
        at: "2026-10-03T00:00:00.000Z",
      });
      expect(crossProjectResult.alwaysOn.map((rule) => rule.bundleKey)).toContain("schema-v12-response-behavior");
    } finally {
      if (previousMode === undefined) delete process.env.WASURENAGUSA_STRENGTH;
      else process.env.WASURENAGUSA_STRENGTH = previousMode;
      if (previousOwnerScopeBehavior === undefined) delete process.env.WASURENAGUSA_OWNER_SCOPE_BEHAVIOR;
      else process.env.WASURENAGUSA_OWNER_SCOPE_BEHAVIOR = previousOwnerScopeBehavior;
      if (previousPrinciplesMode === undefined) delete process.env.WASURENAGUSA_PRINCIPLES;
      else process.env.WASURENAGUSA_PRINCIPLES = previousPrinciplesMode;
    }
  });
});
