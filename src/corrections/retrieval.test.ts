import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeCorrectionSchema } from "../storage/correction-schema.js";
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
        status === "confirmed" ? at : null,
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
        status === "confirmed" ? at : null,
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
});
