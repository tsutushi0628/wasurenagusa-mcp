import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import RawDatabase from "better-sqlite3";
import { SQLiteStorage } from "../storage/sqlite.js";
import { config } from "../config.js";
import { computeForgettingSweep, applyForgettingSweep } from "./forgetting-sweep.js";

/**
 * 忘却（長期未参照）dry-run の業務要件を、合成一時DBで固定する。
 *
 * 業務要件:
 *  - 窓（windowDays）より新しく参照された（last_read_at が新しい）行は忘却候補に上がらない。
 *  - 窓より古い last_read_at を持つ行は候補に上がる（実測の最終読取時刻に基づく候補）。
 *  - last_read_at が NULL で updated_at が窓より古い行は candidate に上がり neverTracked に数える
 *    （移行直後の代理指標＝欠損として可視化する）。
 *  - state != 'active' の行は候補から除外する。
 *  - 候補の順序は参照時刻昇順 → id 昇順で決定論的。
 */
describe("computeForgettingSweep（忘却 dry-run・読み取り専用）", () => {
  let tmpDir: string;
  let dbPath: string;

  const WINDOW_DAYS = 90;

  /** SQLiteStorage で v8 スキーマの空DBを作って閉じ、以降は生SQLで決定論的に seed する。 */
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-forgetting-sweep-test-"));
    mkdirSync(tmpDir, { recursive: true });
    dbPath = join(tmpDir, "memory.db");
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(tmpDir);
    storage.close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** datetime('now', offset) を解決する（例 '-200 days'）。 */
  function nowOffset(offset: string): string {
    const d = new RawDatabase(dbPath, { readonly: true });
    try {
      return (d.prepare("SELECT datetime('now', ?) AS t").get(offset) as { t: string }).t;
    } finally {
      d.close();
    }
  }

  interface SeedRow {
    id: string;
    category: string;
    updatedAt: string;
    lastReadAt: string | null;
    state?: string;
  }

  function seed(rows: SeedRow[]): void {
    const d = new RawDatabase(dbPath);
    try {
      const insert = d.prepare(
        `INSERT INTO memories (id, timestamp, category, title, content, state, last_read_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const tx = d.transaction(() => {
        for (const r of rows) {
          insert.run(
            r.id,
            "2026-01-01T00:00:00+09:00",
            r.category,
            `title-${r.id}`,
            `content-${r.id}`,
            r.state ?? "active",
            r.lastReadAt,
            r.updatedAt,
          );
        }
      });
      tx();
    } finally {
      d.close();
    }
  }

  it("窓より新しく参照された行は候補に上がらず、窓より古い last_read_at の行は候補に上がる", () => {
    const old = nowOffset("-200 days");
    const recent = nowOffset("-1 days");
    seed([
      // updated_at は古いが last_read_at は最近 → 参照直後なので候補にならない
      { id: "log-read-recent", category: "log", updatedAt: old, lastReadAt: recent },
      // last_read_at が窓より古い → 実測ベースの忘却候補
      { id: "log-read-old", category: "log", updatedAt: recent, lastReadAt: old },
    ]);

    const result = computeForgettingSweep(new RawDatabase(dbPath, { readonly: true }), WINDOW_DAYS);

    expect(result.length).toBe(1);
    const log = result[0];
    expect(log.category).toBe("log");
    expect(log.candidateIds).toEqual(["log-read-old"]);
    expect(log.candidateCount).toBe(1);
    // last_read_at 実測に基づく候補なので neverTracked ではない
    expect(log.neverTrackedCount).toBe(0);
    expect(log.activeCount).toBe(2);
    expect(log.windowDays).toBe(WINDOW_DAYS);
  });

  it("last_read_at が NULL で updated_at が窓より古い行は neverTracked 候補に上がる", () => {
    const old = nowOffset("-200 days");
    const recent = nowOffset("-1 days");
    seed([
      // 未計測（NULL）だが updated_at は最近 → 候補にならない
      { id: "log-never-recent", category: "log", updatedAt: recent, lastReadAt: null },
      // 未計測（NULL）で updated_at が窓より古い → neverTracked 候補
      { id: "log-never-old", category: "log", updatedAt: old, lastReadAt: null },
    ]);

    const result = computeForgettingSweep(new RawDatabase(dbPath, { readonly: true }), WINDOW_DAYS);

    expect(result.length).toBe(1);
    const log = result[0];
    expect(log.candidateIds).toEqual(["log-never-old"]);
    expect(log.candidateCount).toBe(1);
    expect(log.neverTrackedCount).toBe(1);
  });

  it("state != 'active' の行は候補から除外する", () => {
    const old = nowOffset("-200 days");
    seed([
      { id: "log-archived-old", category: "log", updatedAt: old, lastReadAt: null, state: "archived" },
      { id: "log-deleted-old", category: "log", updatedAt: old, lastReadAt: null, state: "deleted" },
    ]);

    const result = computeForgettingSweep(new RawDatabase(dbPath, { readonly: true }), WINDOW_DAYS);
    // active 行が 1 件も無い → 候補カテゴリは発生しない
    expect(result).toEqual([]);
  });

  it("候補は参照時刻昇順 → id 昇順で決定論的に並ぶ", () => {
    const d400 = nowOffset("-400 days");
    const d300 = nowOffset("-300 days");
    const d200 = nowOffset("-200 days");
    seed([
      // 参照時刻（COALESCE(last_read_at, updated_at)）が d300 の行を id 逆順で 2 件投入
      { id: "log-b", category: "log", updatedAt: d200, lastReadAt: d300 },
      { id: "log-a", category: "log", updatedAt: d200, lastReadAt: d300 },
      // 最も古い参照時刻 d400（先頭に来る）
      { id: "log-c", category: "log", updatedAt: d400, lastReadAt: null },
    ]);

    const result = computeForgettingSweep(new RawDatabase(dbPath, { readonly: true }), WINDOW_DAYS);
    expect(result.length).toBe(1);
    // d400(log-c) → d300 同点は id 昇順(log-a, log-b)
    expect(result[0].candidateIds).toEqual(["log-c", "log-a", "log-b"]);
    expect(result[0].neverTrackedCount).toBe(1); // log-c のみ NULL
  });

  it("複数カテゴリのそれぞれで候補を集計し、候補0のカテゴリは配列に含めない", () => {
    const old = nowOffset("-200 days");
    const recent = nowOffset("-1 days");
    seed([
      { id: "log-old", category: "log", updatedAt: old, lastReadAt: null },
      { id: "dec-old", category: "decision", updatedAt: old, lastReadAt: null },
      // config は保護種別なので、参照時刻に関わらず候補にならない
      { id: "cfg-recent", category: "config", updatedAt: recent, lastReadAt: recent },
    ]);

    const result = computeForgettingSweep(new RawDatabase(dbPath, { readonly: true }), WINDOW_DAYS);
    const cats = result.map((c) => c.category).sort();
    expect(cats).toEqual(["decision", "log"]);
    expect(result.find((c) => c.category === "config")).toBeUndefined();
  });

  it("config/dont は非参照（NULL last_read_at・updated_at も窓より古い）でも忘却候補に含めない（保護種別）", () => {
    const veryOld = nowOffset("-999 days");
    seed([
      // 比較用の通常カテゴリ: 非参照かつ窓より古い → 候補に上がる
      { id: "log-old", category: "log", updatedAt: veryOld, lastReadAt: null },
      // 保護種別: 非参照かつ窓より古くても候補にしない（config=設定・dont=失敗の教訓は永続保持）
      { id: "cfg-old", category: "config", updatedAt: veryOld, lastReadAt: null },
      { id: "dont-old", category: "dont", updatedAt: veryOld, lastReadAt: null },
    ]);

    const result = computeForgettingSweep(new RawDatabase(dbPath, { readonly: true }), WINDOW_DAYS);
    const cats = result.map((c) => c.category).sort();
    // log だけが候補。config/dont は保護種別として集計・列挙のどちらにも現れない。
    expect(cats).toEqual(["log"]);
    expect(result.find((c) => c.category === "config")).toBeUndefined();
    expect(result.find((c) => c.category === "dont")).toBeUndefined();
  });

  it("windowDays <= 0 は忘却無効として空配列を返す", () => {
    const old = nowOffset("-999 days");
    seed([{ id: "log-old", category: "log", updatedAt: old, lastReadAt: null }]);
    expect(computeForgettingSweep(new RawDatabase(dbPath, { readonly: true }), 0)).toEqual([]);
    expect(computeForgettingSweep(new RawDatabase(dbPath, { readonly: true }), -5)).toEqual([]);
  });

  it("既定の忘却窓（config.forgettingWindowDays）で動作する", () => {
    // 既定値が正の数であることと、その窓で古い行が候補化されることをスモークする
    expect(config.forgettingWindowDays).toBeGreaterThan(0);
    const veryOld = nowOffset(`-${config.forgettingWindowDays * 3} days`);
    seed([{ id: "log-veryold", category: "log", updatedAt: veryOld, lastReadAt: null }]);
    const result = computeForgettingSweep(
      new RawDatabase(dbPath, { readonly: true }),
      config.forgettingWindowDays,
    );
    expect(result.length).toBe(1);
    expect(result[0].candidateIds).toEqual(["log-veryold"]);
  });
});

/**
 * 忘却の実退避（applyForgettingSweep）と復元（restoreArchived）の業務要件を固定する。
 *
 * 業務要件:
 *  - 窓より古い長期未参照の active 行は state='archived' へ論理退避される（物理削除しない）。
 *  - 保護種別（config/dont）と窓内の行は退避されない。
 *  - windowDays<=0 は忘却無効（1件も退避しない）。
 *  - archived は get_detail で読める（可視性マトリクス）＝失われず参照可能。
 *  - restoreArchived で archived → active に戻せる（可逆退避）。
 */
describe("applyForgettingSweep（忘却の実退避）＋ restoreArchived（復元）", () => {
  let tmpDir: string;
  let dbPath: string;
  const WINDOW_DAYS = 90;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-forgetting-apply-test-"));
    mkdirSync(tmpDir, { recursive: true });
    dbPath = join(tmpDir, "memory.db");
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(tmpDir);
    storage.close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function nowOffset(offset: string): string {
    const d = new RawDatabase(dbPath, { readonly: true });
    try {
      return (d.prepare("SELECT datetime('now', ?) AS t").get(offset) as { t: string }).t;
    } finally {
      d.close();
    }
  }

  function seed(rows: { id: string; category: string; updatedAt: string; lastReadAt: string | null; state?: string }[]): void {
    const d = new RawDatabase(dbPath);
    try {
      const insert = d.prepare(
        `INSERT INTO memories (id, timestamp, category, title, content, state, last_read_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const tx = d.transaction(() => {
        for (const r of rows) {
          insert.run(r.id, "2026-01-01T00:00:00+09:00", r.category, `title-${r.id}`, `content-${r.id}`, r.state ?? "active", r.lastReadAt, r.updatedAt);
        }
      });
      tx();
    } finally {
      d.close();
    }
  }

  /** SQLiteStorage を開いて忘却の実退避を適用し、確実に閉じる。 */
  function applyVia(windowDays: number, nightlyCap?: number) {
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(tmpDir);
    try {
      return nightlyCap === undefined
        ? applyForgettingSweep(storage, windowDays)
        : applyForgettingSweep(storage, windowDays, nightlyCap);
    } finally {
      storage.close();
    }
  }

  function stateOf(id: string): string | undefined {
    const d = new RawDatabase(dbPath, { readonly: true });
    try {
      return (d.prepare("SELECT state FROM memories WHERE id = ?").get(id) as { state: string } | undefined)?.state;
    } finally {
      d.close();
    }
  }

  it("窓より古い長期未参照の active 行を archived へ論理退避する（物理削除はしない）", () => {
    const old = nowOffset("-200 days");
    const recent = nowOffset("-1 days");
    seed([
      { id: "log-old-a", category: "log", updatedAt: old, lastReadAt: null },
      { id: "log-old-b", category: "log", updatedAt: old, lastReadAt: null },
      // 窓内 → 退避されない
      { id: "log-recent", category: "log", updatedAt: recent, lastReadAt: null },
    ]);

    const result = applyVia(WINDOW_DAYS);

    expect(result.archivedCount).toBe(2);
    expect(result.neverTrackedCount).toBe(2);
    expect(result.archivedIds.sort()).toEqual(["log-old-a", "log-old-b"]);
    expect(stateOf("log-old-a")).toBe("archived");
    expect(stateOf("log-old-b")).toBe("archived");
    expect(stateOf("log-recent")).toBe("active");
    // 物理削除されていない（行は残る＝可逆）
    const d = new RawDatabase(dbPath, { readonly: true });
    try {
      expect((d.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }).c).toBe(3);
    } finally {
      d.close();
    }
  });

  it("保護種別（config/dont）は窓より古く非参照でも退避されない", () => {
    const veryOld = nowOffset("-999 days");
    seed([
      { id: "cfg-old", category: "config", updatedAt: veryOld, lastReadAt: null },
      { id: "dont-old", category: "dont", updatedAt: veryOld, lastReadAt: null },
      { id: "log-old", category: "log", updatedAt: veryOld, lastReadAt: null },
    ]);

    expect(applyVia(WINDOW_DAYS).archivedIds).toEqual(["log-old"]);
    expect(stateOf("cfg-old")).toBe("active");
    expect(stateOf("dont-old")).toBe("active");
    expect(stateOf("log-old")).toBe("archived");
  });

  it("windowDays <= 0 は忘却無効として 1 件も退避しない", () => {
    const veryOld = nowOffset("-999 days");
    seed([{ id: "log-old", category: "log", updatedAt: veryOld, lastReadAt: null }]);
    const result = applyVia(0);
    expect(result.archivedCount).toBe(0);
    expect(result.archivedIds).toEqual([]);
    expect(stateOf("log-old")).toBe("active");
  });

  it("退避した記憶は get_detail で読め（可視性）、restoreArchived で active に戻せる（可逆）", () => {
    const old = nowOffset("-200 days");
    seed([{ id: "log-old", category: "log", updatedAt: old, lastReadAt: null }]);

    applyVia(WINDOW_DAYS);
    expect(stateOf("log-old")).toBe("archived");

    const storage = new SQLiteStorage(dbPath);
    storage.initialize(tmpDir);
    try {
      // archived は get_detail で読める（deleted と違い可視）
      const detail = storage.getDetail({ ids: ["log-old"] });
      expect(detail.notFound).toEqual([]);
      expect(detail.entries.map((e) => e.id)).toEqual(["log-old"]);

      // restore で active へ戻る
      const restored = storage.restoreArchived(["log-old"]);
      expect(restored).toBe(1);
    } finally {
      storage.close();
    }
    expect(stateOf("log-old")).toBe("active");
  });

  it("1晩の退避上限（nightlyCap）を超える候補は今晩は退避せず翌晩へ持ち越す（rank3・cap配線）", () => {
    // 窓より古い候補を 5 件投入。cap=2 を効かせると、決定論的順序（参照時刻昇順 → id 昇順）の
    // 先頭 2 件だけ退避され、残り 3 件は active のまま翌晩へ持ち越す。
    const days = [500, 400, 300, 200, 100];
    seed(
      days.map((d, i) => ({
        id: `log-${String(i)}`,
        category: "log",
        updatedAt: nowOffset(`-${String(d)} days`),
        lastReadAt: null,
      })),
    );

    const result = applyVia(WINDOW_DAYS, 2);

    expect(result.nightlyCap).toBe(2);
    expect(result.capped).toBe(true);
    expect(result.archivedCount).toBe(2);
    expect(result.deferredCount).toBe(3);
    // 最も古い参照時刻（-500,-400 days）の 2 件だけ退避される
    expect(result.archivedIds).toEqual(["log-0", "log-1"]);
    expect(stateOf("log-0")).toBe("archived");
    expect(stateOf("log-1")).toBe("archived");
    // 上限超過分は今晩は active のまま
    expect(stateOf("log-2")).toBe("active");
    expect(stateOf("log-3")).toBe("active");
    expect(stateOf("log-4")).toBe("active");
  });

  it("候補が上限以内なら打ち切りは起きず全件退避する（capped=false）", () => {
    const old = nowOffset("-200 days");
    seed([
      { id: "log-a", category: "log", updatedAt: old, lastReadAt: null },
      { id: "log-b", category: "log", updatedAt: old, lastReadAt: null },
    ]);

    const result = applyVia(WINDOW_DAYS, 50);
    expect(result.capped).toBe(false);
    expect(result.deferredCount).toBe(0);
    expect(result.archivedCount).toBe(2);
  });
});
