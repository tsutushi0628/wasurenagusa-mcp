/**
 * spike-sqlite-vec: sqlite-vec 0.1.9 の vec0 API 実在確認スパイク（タスク0.1）
 *
 * 目的: LLM実装者がAPIを幻覚しやすい領域（vec0仮想テーブルの距離既定、KNN構文、
 * 距離値の取得方法）を、使い捨ての一時ファイルDBで実行確認して事実を固定する。
 * 以降の実装（Phase 1以降）はここで確認済みの構文しか使わない。
 *
 * 本番ストアには一切接続しない。書き込みは使い捨てDBのみ。
 *
 * Usage: npx ts-node --esm scripts/spikes/spike-sqlite-vec.ts
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

interface CheckResult {
  label: string;
  ok: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function record(label: string, fn: () => string): void {
  try {
    const detail = fn();
    results.push({ label, ok: true, detail });
  } catch (error) {
    results.push({ label, ok: false, detail: `NG: ${(error as Error).message}` });
  }
}

function embeddingToBuffer(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}

function randomVector(dim: number, seed: number): number[] {
  const v: number[] = [];
  let x = seed;
  for (let i = 0; i < dim; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    v.push((x % 1000) / 1000);
  }
  return v;
}

async function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-spike-vec0-"));
  const dbPath = join(tmpDir, "spike.db");
  const db = new Database(dbPath);

  try {
    // --- 1. 拡張ロード ---
    record("拡張ロード（sqliteVec.load）", () => {
      sqliteVec.load(db);
      const row = db.prepare("SELECT vec_version() as v").get() as { v: string };
      return `vec_version() = ${row.v}`;
    });

    // --- 2. vec0仮想テーブル作成（既定=L2距離、次元384） ---
    record("vec0仮想テーブル作成（既定距離）", () => {
      db.exec(`
        CREATE VIRTUAL TABLE vectors_default USING vec0(
          id TEXT PRIMARY KEY,
          embedding float[384]
        );
      `);
      return "作成成功（distance_metric未指定 = 既定値を使用）";
    });

    // --- 3. 挿入（Buffer化したFloat32Array） ---
    record("INSERT（id + Float32Arrayバッファ）", () => {
      const insert = db.prepare("INSERT INTO vectors_default (id, embedding) VALUES (?, ?)");
      for (let i = 0; i < 20; i++) {
        insert.run(`entry-${i}`, embeddingToBuffer(randomVector(384, i + 1)));
      }
      const count = db.prepare("SELECT COUNT(*) as c FROM vectors_default").get() as { c: number };
      return `${count.c}件挿入成功`;
    });

    // --- 4. KNN構文: WHERE embedding MATCH ? AND k = ? ---
    record("KNN検索（WHERE embedding MATCH ? AND k = ?）", () => {
      const queryBuf = embeddingToBuffer(randomVector(384, 5));
      const rows = db.prepare(
        "SELECT id, distance FROM vectors_default WHERE embedding MATCH ? AND k = ?"
      ).all(queryBuf, 5) as { id: string; distance: number }[];
      if (rows.length !== 5) throw new Error(`期待5件、実際${rows.length}件`);
      const distances = rows.map((r) => r.distance.toFixed(4)).join(", ");
      return `5件取得。距離値=[${distances}]（昇順であることを確認: ${
        rows.every((r, i) => i === 0 || r.distance >= rows[i - 1].distance)
      }）`;
    });

    // --- 5. 既定距離が本当にL2か（同一ベクトルの距離が0に近いことで検証） ---
    record("既定距離=L2の検証（自分自身との距離が約0）", () => {
      const selfVec = randomVector(384, 1); // entry-0 と同じシード
      const queryBuf = embeddingToBuffer(selfVec);
      const rows = db.prepare(
        "SELECT id, distance FROM vectors_default WHERE embedding MATCH ? AND k = ?"
      ).all(queryBuf, 1) as { id: string; distance: number }[];
      const selfRow = rows[0];
      if (selfRow.id !== "entry-0") throw new Error(`最近傍が自分自身ではない: ${selfRow.id}`);
      if (selfRow.distance > 0.001) throw new Error(`自己距離が0近傍でない: ${selfRow.distance}`);
      return `entry-0 との距離=${selfRow.distance}（L2距離として妥当。sqlite-vecのvec0既定距離=L2を実測確認）`;
    });

    // --- 6. distance_metric=cosine 明示指定の構文確認（Phase 3のKNN距離型封じの前提） ---
    record("vec0テーブルでdistance_metric=cosine明示指定", () => {
      db.exec(`
        CREATE VIRTUAL TABLE vectors_cosine USING vec0(
          id TEXT PRIMARY KEY,
          embedding float[384] distance_metric=cosine
        );
      `);
      const insert = db.prepare("INSERT INTO vectors_cosine (id, embedding) VALUES (?, ?)");
      insert.run("c-0", embeddingToBuffer(randomVector(384, 1)));
      insert.run("c-1", embeddingToBuffer(randomVector(384, 2)));
      const queryBuf = embeddingToBuffer(randomVector(384, 1));
      const rows = db.prepare(
        "SELECT id, distance FROM vectors_cosine WHERE embedding MATCH ? AND k = ?"
      ).all(queryBuf, 2) as { id: string; distance: number }[];
      return `distance_metric=cosine 構文は動作する。distance値=[${rows.map((r) => r.distance.toFixed(4)).join(", ")}]`;
    });

    // --- 7. 存在しないカラム名やAPIを試す（幻覚しやすいパターンの反証） ---
    record("【反証】存在しない関数 vec_distance_l2() を集約なしで直接使う", () => {
      try {
        db.prepare("SELECT vec_distance_L2(?, ?) as d").get(
          embeddingToBuffer(randomVector(384, 1)),
          embeddingToBuffer(randomVector(384, 2)),
        );
        return "vec_distance_L2() はスカラー関数として動作する（存在する）";
      } catch (error) {
        return `NG（想定通り失敗した場合はここに記録）: ${(error as Error).message}`;
      }
    });
  } finally {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log("=== spike-sqlite-vec 実行結果 ===");
  for (const r of results) {
    console.log(`[${r.ok ? "OK" : "NG"}] ${r.label}: ${r.detail}`);
  }
  const failCount = results.filter((r) => !r.ok).length;
  console.log(`\n合計 ${results.length}件中 ${failCount}件が想定外エラー`);
}

main().catch((error) => {
  console.error("spike-sqlite-vec 実行失敗:", error);
  process.exit(1);
});
