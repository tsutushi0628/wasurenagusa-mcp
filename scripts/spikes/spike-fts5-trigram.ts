/**
 * spike-fts5-trigram: FTS5 trigramトークナイザの日本語クエリ挙動 実在確認スパイク（タスク0.2）
 *
 * 目的: trigram索引に対する「フレーズクエリ」と「トークン分割クエリ（AND/OR）」の
 * 挙動差、および2文字以下のクエリ語の扱い（trigramの最短長制約）を、使い捨ての
 * 一時ファイルDBで実行確認する。Phase 1のトークナイザスパイクとPhase 2のクエリ
 * ビルダの前提事実をここで固定する。
 *
 * 本番ストアには一切接続しない。
 *
 * Usage: npx ts-node --esm scripts/spikes/spike-fts5-trigram.ts
 */

import Database from "better-sqlite3";
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

async function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-spike-fts5-"));
  const dbPath = join(tmpDir, "spike.db");
  const db = new Database(dbPath);

  try {
    db.exec(`
      CREATE VIRTUAL TABLE docs USING fts5(
        title,
        content,
        tokenize='trigram'
      );
    `);

    const insert = db.prepare("INSERT INTO docs (rowid, title, content) VALUES (?, ?, ?)");
    insert.run(1, "本番API URLの設定", "本番環境のAPI URLはポート3000で固定する");
    insert.run(2, "Firestoreのインデックス設計", "複合クエリにはFirestoreの複合インデックスが必要");
    insert.run(3, "ガードパターンの自動生成停止", "ガードパターンを自動生成すると自己DoSベクトルになる");
    insert.run(4, "夜間統合のdry-run化", "夜間統合は書き込みを止めてレポートのみ出力する");

    function search(matchExpr: string): { rowid: number }[] {
      return db.prepare(
        "SELECT rowid FROM docs WHERE docs MATCH ? ORDER BY rank"
      ).all(matchExpr) as { rowid: number }[];
    }

    // --- 1. フレーズクエリ（保存済み表現と完全一致しない自然文） ---
    record("フレーズクエリ: 保存表現と完全一致しない自然文 → ヒットしない", () => {
      const rows = search('"ガードパターン 自動生成"');
      return `ヒット件数=${rows.length}（フレーズは連続する部分文字列一致のみ。空白を含む2語連結フレーズは元テキストに連続して現れないためヒットしない想定）`;
    });

    // --- 2. フレーズクエリ（元テキストに実在する連続部分文字列） ---
    record("フレーズクエリ: 実在する連続部分文字列 → ヒットする", () => {
      const rows = search('"ガードパターン"');
      return `ヒット件数=${rows.length}（rowid=${rows.map((r) => r.rowid).join(",")}）。連続部分文字列はフレーズでもヒットする`;
    });

    // --- 3. トークン分割 OR結合 ---
    record("トークン分割OR: 複数語のいずれかで広く拾う", () => {
      const rows = search('"ガードパターン" OR "夜間統合"');
      return `ヒット件数=${rows.length}（rowid=${rows.map((r) => r.rowid).join(",")}）。OR結合は各語ヒットの和集合になる`;
    });

    // --- 4. トークン分割 AND結合 ---
    record("トークン分割AND: 両方の語を含む行のみに絞る", () => {
      const rows = search('"ガードパターン" AND "自動生成"');
      return `ヒット件数=${rows.length}（rowid=${rows.map((r) => r.rowid).join(",")}）。ANDは両語を含む行のみに絞られる（今回は同一行なので一致）`;
    });

    record("トークン分割AND: 異なる行にしか出現しない語の組み合わせ → 0件", () => {
      const rows = search('"ガードパターン" AND "Firestore"');
      return `ヒット件数=${rows.length}（別々の行にしか出現しない語のAND結合は0件になる想定）`;
    });

    // --- 5. 2文字以下のクエリ語（trigramの最短長制約） ---
    record("2文字クエリ「本番」: trigram最短長3文字未満のため原理的にヒットしない", () => {
      try {
        const rows = search('"本番"');
        return `例外は出ず実行できた。ヒット件数=${rows.length}（2文字はtrigram索引の最小単位3文字に満たないため、内部的に0件または全件スキャン相当になる可能性がある。実測値で判断）`;
      } catch (error) {
        return `クエリ自体が失敗した: ${(error as Error).message}`;
      }
    });

    record("3文字クエリ「本番A」相当（3文字の連続部分文字列）: trigram最小単位以上でヒットする", () => {
      const rows = search('"本番環"');
      return `ヒット件数=${rows.length}（3文字の連続部分文字列はtrigramトークナイザの最小単位を満たすためヒットする想定）`;
    });

    // --- 6. 1文字クエリ ---
    record("1文字クエリ「本」: 最短長制約に満たない", () => {
      try {
        const rows = search('"本"');
        return `例外は出ず実行できた。ヒット件数=${rows.length}`;
      } catch (error) {
        return `クエリ自体が失敗した（想定内）: ${(error as Error).message}`;
      }
    });
  } finally {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log("=== spike-fts5-trigram 実行結果 ===");
  for (const r of results) {
    console.log(`[${r.ok ? "OK" : "NG"}] ${r.label}: ${r.detail}`);
  }
  const failCount = results.filter((r) => !r.ok).length;
  console.log(`\n合計 ${results.length}件中 ${failCount}件が想定外エラー`);
}

main().catch((error) => {
  console.error("spike-fts5-trigram 実行失敗:", error);
  process.exit(1);
});
