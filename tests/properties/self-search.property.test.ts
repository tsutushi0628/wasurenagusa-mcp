/**
 * tests/properties/self-search.property.test.ts
 *
 * タスク2.8（検証役）: PT-04 自己検索性プロパティテスト。
 * 業務不変条件 R-B3「保存した記憶はその内容自身で必ず見つかる」を、実スナップショットの
 * 全生存エントリ（state='active'）に対して検査する。
 *
 * 合格基準（PdM裁定2026-07-11・ユニーク本文単位への精密化）:
 *   本文（trim後）が完全一致する重複群を1単位とし、「群内の少なくとも1件が自身の本文を
 *   クエリにした検索結果の上位10件に入る」ことを群単位で判定する。群内のどの1件もtop-10に
 *   入らない群（＝本当に見つからない教訓）は FAIL。
 *   理由: R-B3の業務意図は「保存した教訓が自分の内容で見つかる」であり、同一本文の物理コピー
 *   全数（実測最大130件）を10枠のtop-10に並べるのは数学的に不可能。物理コピーの重複は保存側の
 *   産物で、業務上の関心（教訓が見つかるか）とは別。これは実装都合の緩和ではなく業務意図の
 *   操作化であり、空群FAIL維持により「見つからない教訓は必ず落ちる」構造を保存する。
 *
 * 隠蔽防止（精密化が精度低下を覆い隠さないための二重ガード）:
 *   (1) 空群FAIL: 群内のどの1件もtop-10に無ければ群FAIL（業務上重大な回帰の検知器）。
 *   (2) 厳密（エントリ単位）達成率も併記出力する。群単位はユニーク本文でしか厳密判定と
 *       乖離しない（重複群のみ緩和面）。厳密率を出すことで緩和が効いた差分を監査可能にする。
 *   群サイズ1（ユニーク本文）では群単位＝厳密判定なので、単体本文の劣化は従来どおり捕捉される。
 *
 * 検査対象は本番検索実装（src/storage/sqlite.ts の searchHybrid）。tasks.md 2.8 前提注記の
 * とおり並走用の別実装は存在しない。MCPハンドラ層（src/tools/search.ts handleMemorySearch）を
 * 経由しないのは、同層にタスク2.7で廃止予定の書き込み副作用（アクセス計数・critical昇格保存）が
 * 現存しており評価対象コーパスを変異させるため。順位決定は searchHybrid 内で完結するので、
 * searchHybrid 直接検査が本番順位の検査になる。
 *
 * 実行方法（フルコーパス実行はオプトイン。実行例）:
 *   RUN_PT04=1 PT04_STORE=<スナップショット作業コピーのストアパス> \
 *     npx vitest run tests/properties/self-search.property.test.ts
 *
 * - RUN_PT04=1 が無い場合は skip される（vitest サマリに skipped として可視化される。
 *   沈黙成功ではない）。フルコーパス実行は数分〜十数分かかり、テスト基盤標準（testTimeout
 *   10秒）の通常スイートに常駐させない設計判断。ゲートレベルの強制はG2が担う。
 * - PT04_STORE には凍結スナップショットの「検証済みバイト同一コピー」を指定すること。
 *   原本を直接指定しない（本番検索実装は段発火カウンタをストア配下 logs/ へ追記するため、
 *   凍結ディレクトリが汚れる）。コピーの memory.db sha256 が凍結 manifest 記載値と一致する
 *   ことを実行者が事前確認する。
 * - PT04_FAILURES_OUT（任意）: FAIL群の詳細（群ハッシュ短縮値・群サイズ・返却件数のみ。
 *   本文なし）を JSONL で書き出すパス。標準出力には件数のみを出す（tasks.md 2.8「失敗の
 *   出力は件数と分類のみ」・「本文を出力しない」）。
 *
 * 除外規則（design.md G2 self-search 検査項目の定義どおり）:
 * - 本文（trim後）3文字未満のエントリは FTS 最短長制約（trigram）により対象外とし、
 *   除外件数を出力する。
 *
 * 検証役専用資産。実装者は編集しない（tasks.md 2.8・R-M3 の役割制約）。
 */
import { describe, it, expect } from "vitest";
import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import Database from "better-sqlite3";
import { SQLiteStorage } from "../../src/storage/sqlite.js";
import { LocalEmbedding } from "../../src/vector/local-embedding.js";
import { config, getModelsDir } from "../../src/config.js";

const RUN_PT04 = process.env.RUN_PT04 === "1";
const STORE_PATH = process.env.PT04_STORE;
const FAILURES_OUT = process.env.PT04_FAILURES_OUT;

/** design.md G2: FTS trigram の最短長制約。3文字未満の本文は自己検索の対象外（除外件数を出力）。 */
const MIN_QUERY_LENGTH = 3;
/** PT-04 の合格判定枠。「上位10件に入る」（tasks.md 2.8）。 */
const TOP_K = 10;
/** 埋め込みのバッチサイズ（測定内容に影響しない実行効率パラメータ）。 */
const EMBED_BATCH_SIZE = 32;
/** フルコーパス（約9,600件）で十数分を見込む。10秒標準の対象外とする明示的な上書き。 */
const FULL_RUN_TIMEOUT_MS = 120 * 60 * 1000;
/** 空・極小ストアに対する自明PASSを防ぐ下限（design.md G2 前提アサートと同じ趣旨）。 */
const MIN_CORPUS_SIZE = 1000;
/** PdM裁定で救済確認を明示要求された単独失敗エントリ（Batch3 decay修正の対象）。 */
const RESCUE_ENTRY_ID = "mlugm7ua-b14b";
/** 救済エントリの単独順位確認用の広めのlimit。 */
const RESCUE_PROBE_LIMIT = 100;

interface AliveRow {
  id: string;
  content: string;
}
interface BodyGroup {
  hash: string;
  body: string;
  memberIds: string[];
}
interface FailedGroupRecord {
  hash: string;
  groupSize: number;
  resultCount: number;
}

function hashBody(trimmed: string): string {
  return createHash("sha256").update(trimmed).digest("hex").slice(0, 16);
}

describe.skipIf(!RUN_PT04)("PT-04 自己検索性（全生存エントリ・実スナップショット・ユニーク本文単位）", () => {
  it(
    "全ユニーク本文群は、群内の少なくとも1件が自身の本文で上位10件に入る（達成率100%）",
    async () => {
      if (!STORE_PATH) {
        throw new Error("PT04_STORE が未設定です。スナップショット作業コピーのストアパスを指定してください");
      }
      const dbPath = join(STORE_PATH, config.sqliteFile);
      if (!existsSync(dbPath)) {
        throw new Error(`ストアが存在しません: ${dbPath}`);
      }

      // 生存エントリの列挙は読み取り専用接続の生SQLで行う（検索APIの検査対象と
      // フィクスチャ取得を分離し、列挙側の副作用をゼロに固定する）。順序はID昇順で決定的。
      const enumDb = new Database(dbPath, { readonly: true });
      const aliveRows = enumDb
        .prepare("SELECT id, content FROM memories WHERE state = 'active' ORDER BY id")
        .all() as AliveRow[];
      enumDb.close();

      const aliveCount = aliveRows.length;
      // 空・極小ストアでの自明PASS（沈黙成功）を防ぐ。誤ったストアパス指定もここで検出する。
      expect(aliveCount, "生存エントリ数が下限未満。ストアパス誤指定の疑い").toBeGreaterThanOrEqual(
        MIN_CORPUS_SIZE,
      );

      const excluded = aliveRows.filter((r) => r.content.trim().length < MIN_QUERY_LENGTH);
      const targets = aliveRows.filter((r) => r.content.trim().length >= MIN_QUERY_LENGTH);

      // 本文（trim後）完全一致で群化する。群のクエリは本文そのもの（群内で同一）なので、
      // 検索は群ごとに1回で足りる（メンバー全員のクエリが同一結果になる）。
      const groupMap = new Map<string, BodyGroup>();
      for (const r of targets) {
        const trimmed = r.content.trim();
        const h = hashBody(trimmed);
        const g = groupMap.get(h);
        if (g) g.memberIds.push(r.id);
        else groupMap.set(h, { hash: h, body: trimmed, memberIds: [r.id] });
      }
      const groups = [...groupMap.values()];

      const storage = new SQLiteStorage(dbPath);
      storage.initialize(STORE_PATH);

      const failedGroups: FailedGroupRecord[] = [];
      let strictPassedEntries = 0; // 自身IDがtop-10に入ったエントリ数（厳密・エントリ単位）
      let testedEntries = 0; // 検査対象エントリ総数（=Σ群サイズ）
      let groupsTested = 0;
      let rescueRank = -1; // 救済エントリの単独順位（RESCUE_PROBE_LIMIT内）。-1=圏外

      try {
        const localEmbedding = new LocalEmbedding(getModelsDir(STORE_PATH));
        await localEmbedding.initialize();
        if (!localEmbedding.isAvailable()) {
          // ベースライン・G2と同じ定義（ハイブリッド経路）で測る。FTS単独への無言の
          // すり替えは測定条件の変更になるため fail-loud で停止する。
          throw new Error("LocalEmbeddingが利用できません。FTS5フォールバックでの測定は行いません");
        }

        for (let batchStart = 0; batchStart < groups.length; batchStart += EMBED_BATCH_SIZE) {
          const batch = groups.slice(batchStart, batchStart + EMBED_BATCH_SIZE);
          const embeddings = await localEmbedding.embedBatch(
            batch.map((g) => g.body),
            "query",
          );

          for (let i = 0; i < batch.length; i++) {
            const g = batch[i];
            const result = storage.searchHybrid({ query: g.body, category: "all", limit: TOP_K }, embeddings[i]);
            const topIds = new Set(result.results.map((r) => r.id));
            const memberSet = new Set(g.memberIds);
            let inTop = 0;
            for (const id of memberSet) if (topIds.has(id)) inTop += 1;

            groupsTested += 1;
            testedEntries += g.memberIds.length;
            strictPassedEntries += inTop; // 厳密: この群のメンバーのうちtop-10に入った実数

            // 群単位: メンバーが1件もtop-10に無い群のみFAIL（空群FAIL＝隠蔽防止の中核）。
            if (inTop === 0) {
              failedGroups.push({ hash: g.hash, groupSize: g.memberIds.length, resultCount: result.results.length });
            }
          }

          if ((batchStart / EMBED_BATCH_SIZE) % 30 === 0) {
            console.error(
              `[PT-04] progress: groups=${groupsTested}/${groups.length} failedGroups=${failedGroups.length}`,
            );
          }
        }

        // 救済エントリ（decay修正対象）の単独順位を個別確認する（PdM明示要求）。
        // ユニーク本文なので群単位でも厳密でも同じ1件だが、順位そのものを広めのlimitで実測する。
        const rescueRow = targets.find((r) => r.id === RESCUE_ENTRY_ID);
        if (rescueRow) {
          const [rescueEmb] = await localEmbedding.embedBatch([rescueRow.content], "query");
          const rescueRes = storage.searchHybrid(
            { query: rescueRow.content, category: "all", limit: RESCUE_PROBE_LIMIT },
            rescueEmb,
          );
          rescueRank = rescueRes.results.findIndex((r) => r.id === RESCUE_ENTRY_ID);
        }
      } finally {
        storage.close();
      }

      // FAIL群詳細（群ハッシュ短縮・群サイズ・返却件数のみ・本文なし）はファイルへ退避する。
      if (FAILURES_OUT && failedGroups.length > 0) {
        writeFileSync(FAILURES_OUT, failedGroups.map((f) => JSON.stringify(f)).join("\n") + "\n");
      }

      const uniqueBodies = groups.length;
      const dupGroups = groups.filter((g) => g.memberIds.length >= 2).length;
      const groupAchievement = groupsTested > 0 ? (groupsTested - failedGroups.length) / groupsTested : 0;
      const strictAchievement = testedEntries > 0 ? strictPassedEntries / testedEntries : 0;

      // サマリは件数のみ（tasks.md 2.8 の出力契約）。厳密率と群単位率を両方出す（隠蔽防止）。
      console.log(
        JSON.stringify({
          check: "PT-04 self-search (unique-body-group)",
          measured: {
            alive: aliveCount,
            excludedShortBody: excluded.length,
            testedEntries,
            uniqueBodies,
            dupGroups,
            groupsPassed: groupsTested - failedGroups.length,
            failedGroups: failedGroups.length,
            groupAchievementRate: Number(groupAchievement.toFixed(4)),
            strictPassedEntries,
            strictAchievementRate: Number(strictAchievement.toFixed(4)),
            rescueEntryId: RESCUE_ENTRY_ID,
            rescueRank: rescueRank === -1 ? `>${RESCUE_PROBE_LIMIT}` : rescueRank + 1,
          },
          threshold: { groupAchievementRateMust: 1.0, topK: TOP_K },
        }),
      );

      // 全件処理の完全性: 除外＋検査エントリ＝生存全件（無言のスキップを許さない）。
      expect(excluded.length + testedEntries, "除外+検査の合計が生存全件と一致しない").toBe(aliveCount);
      // 救済エントリはtop-10に入ること（PdM明示要求の個別確認）。
      expect(rescueRank, `救済エントリ ${RESCUE_ENTRY_ID} がtop-10圏外`).toBeGreaterThanOrEqual(0);
      expect(rescueRank, `救済エントリ ${RESCUE_ENTRY_ID} の順位が10位超`).toBeLessThan(TOP_K);
      // 業務不変条件そのもの: どの1件もtop-10に入らない群=0（達成率100%）。
      expect(failedGroups.length, `自己検索性のFAIL群 ${failedGroups.length}件（群内の全メンバーがtop-10外）`).toBe(0);
    },
    FULL_RUN_TIMEOUT_MS,
  );
});
