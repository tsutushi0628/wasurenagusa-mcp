import Database from "better-sqlite3";
import { createHash } from "crypto";

/**
 * 「読取りで変わってはいけない状態」の定義（R-B2 AC3）を1箇所に持つ共有正本。
 * G2ゲート（scripts/gates/g2-search.ts）の read-no-side-effect 検査と、単体テスト
 * （src/tools/search-read-no-side-effect.test.ts）が同じSQLを別々に持つと、片方だけ
 * 列を追加した際にもう片方が黙って追随しない事故が起きるため、両方がここをimportする
 * （cr-verify-16）。
 *
 * memories.intensity/timestamp と vector_metadata.access_count を id 昇順でスナップ
 * ショットしハッシュ化する。読み経路の前後比較にのみ使う。
 */
export function mutableStateHash(dbPath: string): { memories: string; vectorMeta: string } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const mem = db.prepare("SELECT id, intensity, timestamp FROM memories ORDER BY id").all();
    let vmeta = "[]";
    const hasVm = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vector_metadata'").get();
    if (hasVm) {
      vmeta = JSON.stringify(db.prepare("SELECT id, access_count FROM vector_metadata ORDER BY id").all());
    }
    return {
      memories: createHash("sha256").update(JSON.stringify(mem)).digest("hex"),
      vectorMeta: createHash("sha256").update(vmeta).digest("hex"),
    };
  } finally {
    db.close();
  }
}
