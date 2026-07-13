import { describe, it, expect, beforeEach, afterEach } from "vitest";
import RawDatabase from "better-sqlite3";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { SQLiteStorage } from "../storage/sqlite.js";
import { computeCapSweep } from "./cap-sweep.js";

/**
 * cap-sweep の純関数（dry-run 判定）テスト。
 *
 * 検証する業務要件:
 * - computeCapSweep: カテゴリ別上限を超えた active 行のうち keep 順（access_count 降順 →
 *   updated_at 降順 → id 昇順）で cap 件目以降を「退避候補」として決定論的に返す。上限以下の
 *   カテゴリは載せない。archived/deleted 行は母数にも候補にも入れない。
 * - 読み取り専用（SELECT のみ）で、判定前後で 1 行も変化させない（dry-run の本質）。
 *
 * 忘却（長期未参照の退避）判定は本増分では未実装のため、その検証は含めない。
 *
 * セットアップ方針: 本番と同じ v7 スキーマを SQLiteStorage.initialize() で生成し（スキーマ定義の
 * ドリフトを避ける）、close 後に生 better-sqlite3 コネクションで memories / vector_metadata を
 * 明示値で直接投入する。save() 経由では id・updated_at・access_count を決定論的に固定できないため、
 * keep 順の検証には生投入が必要。
 */

/**
 * 判定前後で DB が 1 バイトも変わらないことを示すための状態スナップショット。
 * 上限判定が触れうる列（本文・content_hash・state・deleted_at・updated_at と
 * vector_metadata の access_count・last_accessed_at）を漏れなく取り込み、「読み取り専用」で
 * あることを狭い列だけで見逃さないようにする。
 */
function snapshot(db: RawDatabase.Database): string {
  const mem = db
    .prepare(
      "SELECT id, state, category, title, content, content_hash, deleted_at, updated_at FROM memories ORDER BY id",
    )
    .all();
  const vm = db
    .prepare("SELECT id, access_count, last_accessed_at FROM vector_metadata ORDER BY id")
    .all();
  return JSON.stringify({ mem, vm });
}

describe("cap-sweep (dry-run 抑制装置判定)", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: RawDatabase.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-cap-sweep-test-"));
    dbPath = join(tmpDir, "memory.db");
    // 本番と同一の v7 スキーマを生成してから閉じ、以降は生コネクションで明示投入する。
    const storage = new SQLiteStorage(dbPath);
    storage.initialize();
    storage.close();
    db = new RawDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * memories 1 行を明示値で投入。accessCount を指定すると vector_metadata も投入する
   * （keep 順の access_count 降順を検証するため）。未指定なら vector_metadata 行を作らない
   * （＝埋め込み未生成の行＝access_count が COALESCE で 0 に正規化される相当）。
   */
  function insertMemory(opts: {
    id: string;
    category: string;
    updatedAt: string; // 'YYYY-MM-DD HH:MM:SS'（datetime() と同フォーマット）
    state?: string;
    accessCount?: number;
  }): void {
    db.prepare(
      `INSERT INTO memories (id, timestamp, category, title, content, state, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.id,
      "2026-01-01T00:00:00+09:00",
      opts.category,
      `title-${opts.id}`,
      `content-${opts.id}`, // 行ごとに異なる本文（dedup 回避）
      opts.state ?? "active",
      opts.updatedAt,
    );
    if (opts.accessCount !== undefined) {
      db.prepare("INSERT INTO vector_metadata (id, access_count) VALUES (?, ?)").run(
        opts.id,
        opts.accessCount,
      );
    }
  }

  describe("computeCapSweep", () => {
    it("(a) 全カテゴリが上限以下なら退避候補ゼロ（結果配列が空）", () => {
      insertMemory({ id: "m1", category: "log", updatedAt: "2026-01-01 00:00:00" });
      insertMemory({ id: "m2", category: "log", updatedAt: "2026-01-02 00:00:00" });
      insertMemory({ id: "m3", category: "decision", updatedAt: "2026-01-03 00:00:00" });

      const result = computeCapSweep(db, 100);
      expect(result).toEqual([]);
    });

    it("(b) 上限境界: ちょうど cap のカテゴリは載らず、cap+1 のカテゴリは超過1件を返す", () => {
      // log: ちょうど cap(3) → 載らない
      insertMemory({ id: "l1", category: "log", updatedAt: "2026-01-01 00:00:00" });
      insertMemory({ id: "l2", category: "log", updatedAt: "2026-01-02 00:00:00" });
      insertMemory({ id: "l3", category: "log", updatedAt: "2026-01-03 00:00:00" });
      // decision: cap+1(4) → 超過1件
      insertMemory({ id: "d1", category: "decision", updatedAt: "2026-01-01 00:00:00" });
      insertMemory({ id: "d2", category: "decision", updatedAt: "2026-01-02 00:00:00" });
      insertMemory({ id: "d3", category: "decision", updatedAt: "2026-01-03 00:00:00" });
      insertMemory({ id: "d4", category: "decision", updatedAt: "2026-01-04 00:00:00" });

      const result = computeCapSweep(db, 3);

      // 超過したカテゴリ（decision）だけが載る
      expect(result).toHaveLength(1);
      const decision = result[0];
      expect(decision.category).toBe("decision");
      expect(decision.activeCount).toBe(4);
      expect(decision.cap).toBe(3);
      expect(decision.archiveCandidateCount).toBe(1);
      expect(decision.candidateIds).toHaveLength(1);
    });

    it("(c) keep 順が access_count 降順 → updated_at 降順 → id 昇順で確定し、候補は正しい末尾", () => {
      // access_count でまず並ぶ: m1(10) が最上位、m5(vector_metadata無し=0)が最下位。
      insertMemory({ id: "m1", category: "log", updatedAt: "2026-01-01 00:00:00", accessCount: 10 });
      // 以下は access_count=5 の 3 行。updated_at 降順で m2/m3(6月) が m4(3月) より上。
      // m2 と m3 は access も updated も同値 → id 昇順のタイブレークで m2 が m3 より上。
      insertMemory({ id: "m2", category: "log", updatedAt: "2026-06-01 00:00:00", accessCount: 5 });
      insertMemory({ id: "m3", category: "log", updatedAt: "2026-06-01 00:00:00", accessCount: 5 });
      insertMemory({ id: "m4", category: "log", updatedAt: "2026-03-01 00:00:00", accessCount: 5 });
      // vector_metadata 無し → COALESCE で access_count=0（最下位）
      insertMemory({ id: "m5", category: "log", updatedAt: "2026-12-01 00:00:00" });

      const result = computeCapSweep(db, 2);

      expect(result).toHaveLength(1);
      const log = result[0];
      expect(log.category).toBe("log");
      expect(log.activeCount).toBe(5);
      expect(log.archiveCandidateCount).toBe(3);
      // keep 順 = [m1, m2, m3, m4, m5]。cap=2 で keep=[m1,m2]、候補は末尾 3 件を順序どおり。
      expect(log.candidateIds).toEqual(["m3", "m4", "m5"]);
    });

    it("(c2) updated_at 降順の層が keep 順を決める（access_count 同点かつ id 順が updated_at と逆でも updated_at が支配）", () => {
      // 変異検出用: access_count を全行同値にし、id 昇順と updated_at 降順が「逆向き」になるよう
      // 配置する。こうすると ORDER BY から updated_at 降順を外した瞬間、id 昇順が代役になって
      // keep 順が反転し、候補が入れ替わる（＝この層が load-bearing であることを固定する）。
      // 先頭を必ず keep させるための最高 access 行。
      insertMemory({ id: "top", category: "log", updatedAt: "2026-01-01 00:00:00", accessCount: 99 });
      // access は同値(5)。updated_at は z_newer(6月) > a_older(1月)。id 昇順は "a_older" < "z_newer"。
      // ⇒ updated_at 降順なら z_newer が先、id 昇順なら a_older が先（両者が逆向き）。
      insertMemory({ id: "a_older", category: "log", updatedAt: "2026-01-01 00:00:00", accessCount: 5 });
      insertMemory({ id: "z_newer", category: "log", updatedAt: "2026-06-01 00:00:00", accessCount: 5 });

      const result = computeCapSweep(db, 2);

      expect(result).toHaveLength(1);
      // 正: keep 順 = [top(99), z_newer(6月,5), a_older(1月,5)]。cap=2 ⇒ keep=[top, z_newer]、
      // 候補は最下位の a_older 1 件。
      // 誤（updated_at 降順を外した場合）: keep 順 = [top, a_older(id昇順), z_newer] となり候補が
      // z_newer に化けるため、この等値アサートが必ず落ちる。
      expect(result[0].candidateIds).toEqual(["a_older"]);
    });

    it("archived / deleted 行は母数にも候補にも入らない（active のみ対象）", () => {
      insertMemory({ id: "a1", category: "log", updatedAt: "2026-01-01 00:00:00", accessCount: 1 });
      insertMemory({ id: "a2", category: "log", updatedAt: "2026-01-02 00:00:00", accessCount: 1 });
      insertMemory({ id: "a3", category: "log", updatedAt: "2026-01-03 00:00:00", accessCount: 1 });
      // 非 active（母数から除外されるべき）
      insertMemory({ id: "x1", category: "log", updatedAt: "2026-01-04 00:00:00", state: "archived" });
      insertMemory({ id: "x2", category: "log", updatedAt: "2026-01-05 00:00:00", state: "deleted" });

      const result = computeCapSweep(db, 2);

      expect(result).toHaveLength(1);
      expect(result[0].activeCount).toBe(3); // active 3 件のみ（archived/deleted は数えない）
      expect(result[0].archiveCandidateCount).toBe(1);
      // 候補に非 active id が混ざらない
      expect(result[0].candidateIds).not.toContain("x1");
      expect(result[0].candidateIds).not.toContain("x2");
    });

    it("cap <= 0（上限無効）は空配列を返す（退避しない約束）", () => {
      insertMemory({ id: "m1", category: "log", updatedAt: "2026-01-01 00:00:00" });
      insertMemory({ id: "m2", category: "log", updatedAt: "2026-01-02 00:00:00" });

      expect(computeCapSweep(db, 0)).toEqual([]);
      expect(computeCapSweep(db, -1)).toEqual([]);
    });

    it("(d) 判定の前後で DB が 1 行も変化しない（dry-run = 純読み取り）", () => {
      insertMemory({ id: "m1", category: "log", updatedAt: "2026-01-01 00:00:00", accessCount: 3 });
      insertMemory({ id: "m2", category: "log", updatedAt: "2026-01-02 00:00:00", accessCount: 2 });
      insertMemory({ id: "m3", category: "log", updatedAt: "2026-01-03 00:00:00", accessCount: 1 });
      insertMemory({ id: "m4", category: "log", updatedAt: "2026-01-04 00:00:00" });

      const before = snapshot(db);
      const result = computeCapSweep(db, 2);
      const after = snapshot(db);

      // 退避候補は算出されるが（=判定は働いている）、DB の状態は不変。
      expect(result[0].archiveCandidateCount).toBe(2);
      expect(after).toBe(before);
      // 実退避が走っていないこと（archived が 1 件も生まれていない）を明示確認。
      const archivedCount = (
        db.prepare("SELECT COUNT(*) AS c FROM memories WHERE state = 'archived'").get() as {
          c: number;
        }
      ).c;
      expect(archivedCount).toBe(0);
    });
  });

  // 忘却（長期未参照の退避）判定は本増分では未実装のため、テストも設けない。
  // 忘却は信頼できる最終参照（アクセス時刻）配線を敷く次増分で実装する。
});
