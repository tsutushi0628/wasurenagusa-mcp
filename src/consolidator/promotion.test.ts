import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SQLiteStorage } from "../storage/sqlite.js";
import { validateDraft, draftPrinciple } from "./promotion.js";

// タスク3.11: 昇格の人間ゲート。
// 「必須フィールド欠落は起草段階で拒否」「approved_at NULLは注入対象外」「valid_until到来でexpired」
// 「自動昇格の経路が存在しない（承認は明示approveのみ）」。

let seq = 0;
const idFactory = () => `pr-${++seq}`;

describe("validateDraft（必須フィールド検証）", () => {
  const base = {
    text: "本番push前は必ずレビュー",
    originTier: "owner_confirmed" as const,
    evidenceIds: ["m1"],
    validUntil: "2027-01-01T00:00:00.000Z",
  };

  it("必須が揃えば妥当（エラー0件）", () => {
    expect(validateDraft(base)).toHaveLength(0);
  });

  it("出所ティア欠落を拒否する", () => {
    const { originTier, ...rest } = base;
    void originTier;
    expect(validateDraft(rest).some((e) => e.field === "originTier")).toBe(true);
  });

  it("証拠（evidenceIds）が空だと拒否する", () => {
    expect(validateDraft({ ...base, evidenceIds: [] }).some((e) => e.field === "evidenceIds")).toBe(true);
  });

  it("TTL（validUntil）欠落を拒否する", () => {
    const { validUntil, ...rest } = base;
    void validUntil;
    expect(validateDraft(rest).some((e) => e.field === "validUntil")).toBe(true);
  });
});

describe("昇格フロー（起草→承認→失効）", () => {
  let storage: SQLiteStorage;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-promote-test-"));
    storage = new SQLiteStorage(join(tmpDir, "test.db"));
    storage.initialize();
    seq = 0;
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("必須欠落の候補は起草されない（拒否）", () => {
    const r = draftPrinciple(storage, { text: "x" }, idFactory);
    expect(r.ok).toBe(false);
    expect(storage.listPrinciples()).toHaveLength(0);
  });

  it("起草直後は proposed で、approved_at NULL ゆえ注入対象にならない", () => {
    const r = draftPrinciple(
      storage,
      { text: "原則A", originTier: "agent_observed", evidenceIds: ["m1"], validUntil: "2999-01-01T00:00:00.000Z" },
      idFactory,
    );
    expect(r.ok).toBe(true);
    expect(storage.getInjectablePrinciples()).toHaveLength(0);
  });

  it("承認して初めて注入対象になる（人間ゲート通過）", () => {
    const r = draftPrinciple(
      storage,
      { text: "原則B", originTier: "owner_confirmed", evidenceIds: ["m1"], validUntil: "2999-01-01T00:00:00.000Z" },
      idFactory,
    );
    expect(storage.approvePrinciple(r.id!)).toBe(1);
    const injectable = storage.getInjectablePrinciples();
    expect(injectable.map((p) => p.id)).toContain(r.id);
  });

  it("valid_until 到来で expired になり、注入対象から外れる", () => {
    const r = draftPrinciple(
      storage,
      { text: "原則C", originTier: "owner_confirmed", evidenceIds: ["m1"], validUntil: "2000-01-01T00:00:00.000Z" },
      idFactory,
    );
    storage.approvePrinciple(r.id!);
    // 承認直後でも TTL 既に到来 → getInjectablePrinciples は valid_until>now を要求するので出ない
    expect(storage.getInjectablePrinciples().map((p) => p.id)).not.toContain(r.id);
    // expire バッチで state が expired に落ちる
    expect(storage.expirePrinciples()).toBe(1);
    expect(storage.listPrinciples("expired").map((p) => p.id)).toContain(r.id);
  });

  it("却下された候補は承認できない（自動昇格の経路がない）", () => {
    const r = draftPrinciple(
      storage,
      { text: "原則D", originTier: "agent_observed", evidenceIds: ["m1"], validUntil: "2999-01-01T00:00:00.000Z" },
      idFactory,
    );
    expect(storage.rejectPrinciple(r.id!)).toBe(1);
    expect(storage.approvePrinciple(r.id!)).toBe(0); // rejected は approve 不能
    expect(storage.getInjectablePrinciples()).toHaveLength(0);
  });
});
