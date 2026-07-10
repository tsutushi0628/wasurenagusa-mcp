/**
 * tests/properties/state-machine.property.test.ts
 *
 * タスク1.7（検証役）: 記憶の状態機械（design.md「記憶の状態機械」節）の不変条件を
 * fast-check（exact pin, devDependency）でプロパティテスト化する。
 *
 * 対象は design.md のプロパティテストカタログのうち PT-01 と PT-05 のみ
 * （PT-02/PT-03はトークン予算・ガード件数上限で本タスク対象外、PT-04は生成器なしの
 * 実スナップショット単体テストで別タスク対象。design.md 605-619行）。
 *
 * PT-01 = 不変条件I1（deletedはどの読み経路からも返らない）
 * PT-05 = 不変条件I4（state='deleted' と deleted_at IS NOT NULL は常に同値）+
 *         「定義済み遷移のみが起こる」（design.md: deleted→activeは未定義。蘇生はID変更の
 *         再保存でのみ行う）
 *
 * 制約（タスク1.7の_Restrictions_）: 実装コード（src/配下）は一切変更しない。
 *
 * 状態機械の現状（2026-07-10時点、Phase 1）:
 * - active への遷移は save()（新規作成）のみが公開APIとして存在する。
 * - deleted への遷移は softDelete()（active/archivedいずれからも可、実装は
 *   `deleted_at IS NULL`で判定するため両方から到達可能）が公開APIとして存在する。
 * - archived への遷移を行う公開APIはまだ存在しない（Phase 3以降のキュレーション機能。
 *   src/storage/visibility-matrix.test.ts の既存注記と同じ判断で、生のSQLで直接
 *   state列を書き換えて「archived状態のエントリが既に存在する」という前提だけを再現する。
 *   これは「遷移操作」ではなく、読み経路の可視性を検証するためのフィクスチャ設営である）。
 * - deleted→active は上記のとおりどの公開APIにも存在しない。唯一「実質的に危険」なのは
 *   save({ replaceId }) を deleted 状態のIDに対して呼んだ場合で、実装（src/storage/sqlite.ts
 *   の save() 内 replaceId 分岐）は id の存在有無だけを見て内容列をUPDATEし、state/deleted_at
 *   列には触れない。つまり「内容は上書きされるが state='deleted' のままで留まる」という
 *   仕様であり、これが実際に成り立つかどうかを本プロパティテストのPT-05側で検証する
 *   （=deleted→activeという未定義遷移がreplaceIdの再試行によって起こらないことの実証）。
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { SQLiteStorage } from "../../src/storage/sqlite.js";
import type { MemoryCategory } from "../../src/types.js";

// FTS/LIKE経路が確実にヒットするための固定マーカー（3文字以上、trigramで割れない前提のため
// ひらがな/カタカナ/漢字混在は避けて安定した英数字を使う）。
const MARKER = "prop-state-machine-marker";

type PlannedState = "active" | "archived" | "deleted";

interface PlannedEntry {
  category: MemoryCategory;
  suffix: number;
  finalState: PlannedState;
  resurrectionAttempts: number;
}

const entryArb: fc.Arbitrary<PlannedEntry> = fc.record({
  category: fc.constantFrom<MemoryCategory>("log", "dont", "config"),
  suffix: fc.integer({ min: 0, max: 999_999 }),
  finalState: fc.constantFrom<PlannedState>("active", "archived", "deleted"),
  resurrectionAttempts: fc.integer({ min: 0, max: 2 }),
});

const sequenceArb = fc.array(entryArb, { minLength: 1, maxLength: 6 });

/** テスト用フィクスチャ一式。runOne() 呼び出しごとに使い捨てのSQLite DBを作る。 */
function withFreshStorage<T>(fn: (storage: SQLiteStorage, rawDb: Database.Database) => T): T {
  const tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-pt-state-machine-"));
  const dbPath = join(tmpDir, "test.db");
  const storage = new SQLiteStorage(dbPath);
  storage.initialize();
  const rawDb = new Database(dbPath);
  try {
    return fn(storage, rawDb);
  } finally {
    rawDb.close();
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** 生成された計画どおりにエントリを実際に作り、目標状態まで到達させる。id一覧を返す。 */
function realizePlan(
  storage: SQLiteStorage,
  rawDb: Database.Database,
  plan: PlannedEntry[],
): Array<{ id: string; category: MemoryCategory; finalState: PlannedState }> {
  const realized: Array<{ id: string; category: MemoryCategory; finalState: PlannedState }> = [];

  for (const p of plan) {
    const saved = storage.save({
      category: p.category,
      title: `${MARKER}-title-${p.suffix}`,
      content: `${MARKER}-content-${p.suffix}`,
      intensity: 5, // dontカテゴリでlistHighIntensityDontsの対象になれるよう常に設定
      predictedFactors: ["p"],
      actualFactors: ["a"],
      predictionError: 0.9, // categoryを問わずlistHighErrorEntriesの対象になれるよう常に設定
    });

    if (p.finalState === "archived") {
      // archivedへの公開APIはまだ存在しない（Phase 1時点の事実）。フィクスチャ設営として
      // 直接SQLで到達させる（src/storage/visibility-matrix.test.ts と同じ既存convention）。
      rawDb.prepare("UPDATE memories SET state = 'archived' WHERE id = ?").run(saved.id);
    } else if (p.finalState === "deleted") {
      // deletedへは実際の公開API softDelete() を通す（本物の遷移を実行する）。
      storage.softDelete([saved.id]);
    }

    // PT-05: 実際に存在する公開API save({replaceId}) を、目標状態に到達した後で繰り返し呼び、
    // deleted→activeという未定義遷移が「内容上書きの副作用」として起きないことを検証する。
    for (let i = 0; i < p.resurrectionAttempts; i++) {
      storage.save({
        category: p.category,
        replaceId: saved.id,
        title: `${MARKER}-replaced-title-${p.suffix}-${i}`,
        content: `${MARKER}-replaced-content-${p.suffix}-${i}`,
      });

      // I4は「常に同期」が要求なので、置換のたびに毎回確認する（最後の1回だけでなく）。
      const row = rawDb
        .prepare("SELECT state, deleted_at FROM memories WHERE id = ?")
        .get(saved.id) as { state: string; deleted_at: string | null };
      expect(row.state === "deleted").toBe(row.deleted_at !== null); // I4（常時同期）

      if (p.finalState === "deleted") {
        // 定義済み遷移のみが起こる: deleted→activeは未定義であり、replaceIdの再試行では
        // 起こらないことをここで固定する。
        expect(row.state).toBe("deleted");
      }
    }

    realized.push({ id: saved.id, category: p.category, finalState: p.finalState });
  }

  return realized;
}

describe("状態機械プロパティテスト（design.md 不変条件カタログ）", () => {
  it("PT-01（不変条件I1）: deleted状態のエントリはどの読み経路からも返らない", () => {
    fc.assert(
      fc.property(sequenceArb, (plan) => {
        withFreshStorage((storage, rawDb) => {
          const realized = realizePlan(storage, rawDb, plan);
          const deletedIds = new Set(realized.filter((r) => r.finalState === "deleted").map((r) => r.id));
          const nonDeletedIds = realized.filter((r) => r.finalState !== "deleted").map((r) => r.id);

          // 検索（キーワード）
          const searchResult = storage.search({ query: MARKER, limit: 1000 });
          for (const entry of searchResult.results) {
            expect(deletedIds.has(entry.id)).toBe(false);
          }

          // 検索（ハイブリッド。ベクトルは未付与のためFTS経路のみで判定）
          const hybridResult = storage.searchHybrid({ query: MARKER, limit: 1000 }, new Array(384).fill(0));
          for (const entry of hybridResult.results) {
            expect(deletedIds.has(entry.id)).toBe(false);
          }

          // get_detail: active/archivedは返る。deletedはnotFoundに回り、entriesには出ない。
          const allIds = realized.map((r) => r.id);
          const detailResult = storage.getDetail({ ids: allIds });
          for (const entry of detailResult.entries) {
            expect(deletedIds.has(entry.id)).toBe(false);
          }
          for (const id of deletedIds) {
            expect(detailResult.notFound).toContain(id);
          }
          for (const id of nonDeletedIds) {
            expect(detailResult.notFound).not.toContain(id);
          }

          // backfill（埋め込み未付与一覧）
          const missingEmbeddingIds = storage.getEntriesWithoutEmbedding();
          for (const id of deletedIds) {
            expect(missingEmbeddingIds).not.toContain(id);
          }

          // 統合（dont限定の生存エントリ抽出）
          const aliveDonts = storage.readAliveDontEntries();
          for (const entry of aliveDonts) {
            expect(deletedIds.has(entry.id)).toBe(false);
          }

          // 注入: 強度上位dont
          const highIntensity = storage.listHighIntensityDonts(1, 1000);
          for (const entry of highIntensity) {
            expect(deletedIds.has(entry.id)).toBe(false);
          }

          // 注入: 予測ずれ上位
          const highError = storage.listHighErrorEntries(0, 1000);
          for (const entry of highError) {
            expect(deletedIds.has(entry.id)).toBe(false);
          }

          // 注入: config/dont読み出し
          const configEntries = storage.readConfigEntries();
          for (const entry of configEntries) {
            expect(deletedIds.has(entry.id)).toBe(false);
          }
          const dontEntries = storage.readDontEntries();
          for (const entry of dontEntries) {
            expect(deletedIds.has(entry.id)).toBe(false);
          }
        });
      }),
      { numRuns: 50 },
    );
  });

  it("PT-05（不変条件I4 + 定義済み遷移のみ）: state/deleted_atは常時同期し、deleted→activeは起こらない", () => {
    fc.assert(
      fc.property(sequenceArb, (plan) => {
        withFreshStorage((storage, rawDb) => {
          // realizePlan自体がI4の逐次検証（置換のたびに毎回）と、deleted状態が
          // replaceId再試行で覆らないことの検証を内包する。ここでは最終状態についても
          // 全件まとめて再確認する。
          const realized = realizePlan(storage, rawDb, plan);

          for (const r of realized) {
            const row = rawDb
              .prepare("SELECT state, deleted_at FROM memories WHERE id = ?")
              .get(r.id) as { state: string; deleted_at: string | null };

            // I4: state='deleted' ⟺ deleted_at IS NOT NULL（常に同値）
            expect(row.state === "deleted").toBe(row.deleted_at !== null);

            // 定義済み遷移のみ: 到達させた目標状態がそのまま最終状態であること
            // （softDeleteは不可逆、archivedフィクスチャはreplaceIdでは書き換わらない列のため
            // 両方とも目標状態から動かない）。
            expect(row.state).toBe(r.finalState);
          }
        });
      }),
      { numRuns: 50 },
    );
  });
});
