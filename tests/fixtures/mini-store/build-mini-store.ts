/**
 * tests/fixtures/mini-store/build-mini-store.ts
 *
 * 機構検証専用の合成日本語ミニストア生成ヘルパー（タスク0.11、design.md「合成日本語ミニfixture」）。
 *
 * 用途: ゲートスクリプト（G0〜）のロジック検証、PT-01/02/03/05（プロパティテスト）、
 * スキーマ移行がクリーンクローンとCIで実行できることの確認。
 *
 * 禁止: recall・トークナイザ実効・自己検索性（PT-04）等の「検索や統合の品質」を主張する
 * 検証には使わない（品質測定はローカル実データ層 ${WASURENAGUSA_EVAL_DIR} 配下に限定する）。
 *
 * 内容は完全な合成データであり、実在の人物・組織・秘密値を含まない。
 * プロジェクト名も実在プロジェクトと無関係な架空名のみを使う。
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { SQLiteStorage } from "../../../src/storage/sqlite.js";
import { generateJstTimestamp } from "../../../src/utils/operation-logger.js";
import type { MemoryCategory } from "../../../src/types.js";
import type { ConsolidatedDont, ConsolidatedPrinciple } from "../../../src/types.js";

/** 合成データで使う架空のプロジェクト名（実在プロジェクトと衝突しない名称） */
export const FIXTURE_PROJECTS = ["sample-webapp", "demo-api-service", "training-notes"] as const;

interface SeedTemplate {
  category: MemoryCategory;
  title: string;
  content: string;
  tags: string[];
  intensity?: number;
}

/** 合成テンプレート（完全架空・機密ゼロ。一般的な開発プロセスの言い回しのみ） */
const SEED_TEMPLATES: SeedTemplate[] = [
  {
    category: "config",
    title: "サンプルAPIのベースURL",
    content: "サンプル環境のAPIベースURLはポート4100固定で運用する。",
    tags: ["config", "api"],
  },
  {
    category: "config",
    title: "テスト用DBの接続方式",
    content: "テスト用データベースはインメモリSQLiteを使い、テストごとに使い捨てにする。",
    tags: ["config", "db"],
  },
  {
    category: "dont",
    title: "ログ未確認のまま完了報告しない",
    content: "処理結果のログを確認せずに完了したと報告し、後から失敗が発覚した。次回は必ずログ本文を確認してから報告する。",
    tags: ["dont", "process"],
    intensity: 6,
  },
  {
    category: "dont",
    title: "同一エンドポイントの多重リトライ禁止",
    content: "同じAPIエンドポイントを短時間に繰り返し呼び出し、レート制限に抵触した。失敗時は原因を確認してから1回だけ再試行する。",
    tags: ["dont", "api"],
    intensity: 5,
  },
  {
    category: "decision",
    title: "サンプルアプリの命名規則",
    content: "サンプルアプリ内のモジュール名はkebab-case、関数名はcamelCaseで統一する。",
    tags: ["decision", "naming"],
  },
  {
    category: "decision",
    title: "テストランナーの選定",
    content: "サンプルプロジェクトのテストランナーはvitestに統一し、jestは新規導入しない。",
    tags: ["decision", "testing"],
  },
  {
    category: "log",
    title: "サンプル機能Aの実装完了",
    content: "サンプル機能Aの入力検証処理を実装し、境界値テストを追加して完了した。",
    tags: ["log", "feature"],
  },
  {
    category: "log",
    title: "サンプルバグBの修正",
    content: "サンプル一覧画面で発生していた並び順の不整合を修正し、回帰テストを追加した。",
    tags: ["log", "bugfix"],
  },
  {
    category: "snippet",
    title: "サンプル一覧取得クエリ",
    content: "サンプル一覧取得: SELECT * FROM sample_items WHERE status = 'active' ORDER BY created_at DESC LIMIT 20;",
    tags: ["snippet", "query"],
  },
  {
    category: "snippet",
    title: "サンプルAPIの疎通確認コマンド",
    content: "疎通確認: curl -sS http://localhost:4100/health を実行し200が返ることを確認する。",
    tags: ["snippet", "api"],
  },
];

// JSTタイムスタンプは src/utils/operation-logger.ts の generateJstTimestamp を再利用する。

/** 384次元の決定論的な擬似ベクトルを生成する（実embeddingの代替。値そのものに意味はない） */
function deterministicVector(seed: number, dim = 384): number[] {
  const v: number[] = [];
  let x = seed + 1;
  for (let i = 0; i < dim; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    v.push((x % 2000) / 1000 - 1); // -1.0 ～ 1.0 のレンジ
  }
  return v;
}

export interface BuildMiniStoreOptions {
  /** 生成する合成エントリ総数（既定30）。G0ロジック検証（1,000件以上の前提アサート）で
   *  PASS経路を確認する場合は1000以上を指定する。 */
  count?: number;
  /** 論理削除（tombstone）状態にするエントリ数（既定2、蘇生検出テスト用） */
  softDeleteCount?: number;
  /** 論理削除エントリのうち、ベクトル行を意図的に残す（＝蘇生状態を模す）件数（既定1） */
  resurrectionCount?: number;
  /** consolidated-dont.json へガードパターン付き原則を1件書き込むか（既定false） */
  seedGuardPattern?: boolean;
}

export interface BuildMiniStoreResult {
  memoryPath: string;
  dbPath: string;
  savedCount: number;
  softDeletedIds: string[];
  resurrectedVectorIds: string[];
  guardPatternFile?: string;
}

/**
 * memoryPath（.wasurenagusa相当のディレクトリ）配下に、合成日本語データで
 * 満たされたSQLiteストアを新規構築する。実装コードの save/softDelete/upsertVector を
 * そのまま使うため、本番と同じスキーマ・トリガー経由でデータが作られる。
 */
export function buildMiniStore(
  memoryPath: string,
  options: BuildMiniStoreOptions = {},
): BuildMiniStoreResult {
  const count = options.count ?? 30;
  const softDeleteCount = options.softDeleteCount ?? 2;
  const resurrectionCount = options.resurrectionCount ?? 1;

  mkdirSync(memoryPath, { recursive: true });
  const dbPath = join(memoryPath, "memory.db");
  const storage = new SQLiteStorage(dbPath);
  storage.initialize(memoryPath);

  const savedIds: string[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const template = SEED_TEMPLATES[i % SEED_TEMPLATES.length];
      const project = FIXTURE_PROJECTS[i % FIXTURE_PROJECTS.length];
      const variantSuffix = Math.floor(i / SEED_TEMPLATES.length);
      const result = storage.save({
        category: template.category,
        title: variantSuffix === 0 ? template.title : `${template.title}（バリエーション${variantSuffix}）`,
        content: variantSuffix === 0 ? template.content : `${template.content}（合成バリエーション${variantSuffix}）`,
        tags: template.tags,
        project,
        intensity: template.intensity,
      });
      savedIds.push(result.id);
      // 生存エントリにはベクトルを付与する（backfill対象から外すため）
      storage.upsertVector(result.id, deterministicVector(i));
    }

    // 論理削除（tombstone）状態を作る
    const toSoftDelete = savedIds.slice(0, softDeleteCount);
    const softDeletedIds: string[] = [];
    if (toSoftDelete.length > 0) {
      const { softDeleted } = storage.softDelete(toSoftDelete);
      softDeletedIds.push(...softDeleted);
    }

    // 蘇生状態（delete済みなのにベクトル行が残っている）を意図的に一部だけ再現する。
    // softDeleteはベクトル自体を消さない設計のため、何もしなければ全件が蘇生状態のままになる。
    // ここでは resurrectionCount 件だけ蘇生状態を残し、残りは明示的にベクトルを削除して
    // 「正しく清算された」健全な論理削除も両方fixtureに含める。
    const resurrectedVectorIds = softDeletedIds.slice(0, resurrectionCount);
    const cleanedIds = softDeletedIds.slice(resurrectionCount);
    if (cleanedIds.length > 0) {
      storage.deleteVectors(cleanedIds);
    }

    let guardPatternFile: string | undefined;
    if (options.seedGuardPattern) {
      const principle: ConsolidatedPrinciple = {
        theme: "合成テスト用ガード原則",
        rule: "❌ 合成禁止語FIXTURE_GUARD_TRIGGER を使う 💡 テスト検出用 ✅ 別の表現にする",
        positiveRule: "合成テスト用の表現は使わない",
        tags: ["fixture", "guard-test"],
        sourceCount: 2,
        sourceIds: [savedIds[0], savedIds[1] ?? savedIds[0]],
        score: 10,
        maxIntensity: 5,
        guardPattern: "FIXTURE_GUARD_TRIGGER",
        guardMessage: "合成テスト用の検出語です（G0のguard_block_count計測を実exerciseするためのfixture専用パターン）。",
      };
      const consolidated: ConsolidatedDont = {
        principles: [principle],
        consolidatedAt: generateJstTimestamp(),
        sourceEntryCount: 2,
        version: 1,
      };
      guardPatternFile = join(memoryPath, "consolidated-dont.json");
      writeFileSync(guardPatternFile, JSON.stringify(consolidated, null, 2), "utf-8");
    }

    return {
      memoryPath,
      dbPath,
      savedCount: savedIds.length,
      softDeletedIds,
      resurrectedVectorIds,
      guardPatternFile,
    };
  } finally {
    storage.close();
  }
}
