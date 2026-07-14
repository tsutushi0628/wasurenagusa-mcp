import { describe, it, expect } from "vitest";
import { capClusters, canResumeWrite, DEFAULT_NIGHTLY_CAP } from "./batch-cap.js";

// タスク3.9: 「1晩の統合件数が上限で止まる」「書き込み再開はdry-runレポートの確認記録を前提にする」。

describe("capClusters（1晩の統合件数が上限で止まる）", () => {
  it("上限を超える分は翌晩へ持ち越す（capped=true）", () => {
    const clusters = Array.from({ length: 120 }, (_, i) => i);
    const r = capClusters(clusters, 50);
    expect(r.toProcess).toHaveLength(50);
    expect(r.deferred).toHaveLength(70);
    expect(r.capped).toBe(true);
  });

  it("上限以下なら全処理・持ち越しなし（capped=false）", () => {
    const r = capClusters([1, 2, 3], 50);
    expect(r.toProcess).toHaveLength(3);
    expect(r.deferred).toHaveLength(0);
    expect(r.capped).toBe(false);
  });

  it("既定上限は50", () => {
    const r = capClusters(Array.from({ length: 60 }, (_, i) => i));
    expect(r.toProcess).toHaveLength(DEFAULT_NIGHTLY_CAP);
  });

  it("cap<=0 は今晩処理しない（全持ち越し）", () => {
    const r = capClusters([1, 2, 3], 0);
    expect(r.toProcess).toHaveLength(0);
    expect(r.deferred).toHaveLength(3);
  });
});

describe("canResumeWrite（書き込み再開はdry-run確認記録を前提）", () => {
  const reportId = "report-abc";
  const good = { reportId, confirmedAt: "2026-07-14T00:00:00.000Z", confirmedBy: "owner" };

  it("確認記録が無ければ再開しない（既定dry-run継続）", () => {
    expect(canResumeWrite(reportId, null).allowed).toBe(false);
  });

  it("直近レポートを人間確認済みなら再開許可", () => {
    expect(canResumeWrite(reportId, good).allowed).toBe(true);
  });

  it("確認記録が別レポート由来なら拒否（再確認が必要）", () => {
    expect(canResumeWrite(reportId, { ...good, reportId: "old" }).allowed).toBe(false);
  });

  it("確認者が空なら拒否", () => {
    expect(canResumeWrite(reportId, { ...good, confirmedBy: "" }).allowed).toBe(false);
  });
});
