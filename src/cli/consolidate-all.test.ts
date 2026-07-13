import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import RawDatabase from "better-sqlite3";
import { consolidateProject } from "./consolidate-all.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { config } from "../config.js";
import type { ConsolidatedConfig, ConsolidatedDont } from "../types.js";

const DRY_RUN_REPORT_FILE = "consolidation-dryrun-report.json";

/**
 * SQLiteStorage の破壊メソッド（memories を変更しうる書き込み API の全て）。
 * save=新規/更新, delete=物理削除, softDelete=論理削除, deleteVectors=ベクトル削除,
 * purgeTombstones=tombstone 物理削除, updateIntensity=強度更新（memories.updated_at を動かす）。
 */
const DESTRUCTIVE_METHODS = [
  "save",
  "delete",
  "softDelete",
  "deleteVectors",
  "purgeTombstones",
  "updateIntensity",
] as const;

type DestructiveMethod = (typeof DESTRUCTIVE_METHODS)[number];

interface DestructiveSpy {
  /** メソッド別の呼び出し回数 */
  byMethod: Record<DestructiveMethod, number>;
  /** 全破壊メソッドの呼び出し回数の総和 */
  total(): number;
  /** prototype を元の実装へ戻す（テスト間の汚染防止・必ず finally で呼ぶ） */
  restore(): void;
}

/**
 * SQLiteStorage.prototype の破壊メソッドを実装ごとラップし、呼び出し回数を数える。
 *
 * 実装（prototype）を差し替えるため、破壊呼び出しがどのファイル・どの別名から来ても計上する。
 * これが主軸ガード: g-write-severance の正規表現走査は「.softDelete(」のような字面しか追えず、
 * メソッド別名化（`const del = storage["softDelete"].bind(storage)` → `del(ids)`）を捕捉できない。
 * 実メソッドをスパイすれば、そうしたエイリアシング経由の破壊呼び出しも実行時に必ず捕まえられる。
 * ラップは元実装を必ず呼ぶ（挙動を変えない）ので、回帰テストでは実際に memories が書き換わる。
 */
function installDestructiveSpy(): DestructiveSpy {
  const proto = SQLiteStorage.prototype as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  const byMethod = Object.fromEntries(
    DESTRUCTIVE_METHODS.map((m) => [m, 0]),
  ) as Record<DestructiveMethod, number>;
  const originals = new Map<DestructiveMethod, (...args: unknown[]) => unknown>();
  for (const m of DESTRUCTIVE_METHODS) {
    const orig = proto[m];
    originals.set(m, orig);
    proto[m] = function (this: unknown, ...args: unknown[]) {
      byMethod[m] += 1;
      return orig.apply(this, args);
    };
  }
  return {
    byMethod,
    total: () => Object.values(byMethod).reduce((sum, n) => sum + n, 0),
    restore: () => {
      for (const m of DESTRUCTIVE_METHODS) proto[m] = originals.get(m)!;
    },
  };
}

/**
 * 夜間統合のdry-run化（タスク0.8、design.md Phase 0 ⑤、R-A3・R-A6）。
 *
 * 統合（dont重複排除・config要約）は、書き込み（memoriesへのマージ結果保存・原本の論理削除・
 * 統合キャッシュへの永続化）を停止し、クラスタ数・統合候補件数のレポート出力のみを行う。
 * クラスタリング計算自体（読み取り専用の分析）はPhase 3の追記型統合実装まで維持する。
 *
 * F3夢生成（heart-extension、統合とは別系統の書き込み）はこのdry-run化の対象外のため、
 * 各テストで直近のdreamエントリを事前に用意し、干渉なく検証できるようにする
 * （dream生成は直近24h以内にdreamがあれば無条件でスキップする仕様を利用）。
 *
 * Windows / SQLite-only 環境（dont.md・config.md などの Markdown ファイルが存在しない）でも
 * 同様にdry-runが機能することを確認するため、意図的にMarkdownファイルを作らない。
 */
describe("consolidate-all: 夜間統合のdry-run化（書き込み停止・レポート出力）", () => {
  let tmpDir: string;
  let projectRoot: string;
  let memoryPath: string;
  let dbPath: string;

  // 2 つのほぼ同一ベクトル（L2 距離 < 0.25 で同一クラスタに入る。SIM_DISTANCE_THRESHOLD 参照）
  function nearbyVector(seed: number): number[] {
    const v = new Array(config.localEmbeddingDimensions).fill(0);
    v[0] = 1;
    v[1] = seed * 0.001;
    return v;
  }

  function seedRecentDreamToSkipF3(storage: SQLiteStorage): void {
    storage.save({
      category: "dream",
      title: "既存の夢（F3干渉防止用ダミー）",
      content: "dry-run検証をF3夢生成の挙動から独立させるための事前シード",
      tags: ["dream"],
      project: "myproject",
    });
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-consolidate-all-test-"));
    projectRoot = join(tmpDir, "myproject");
    memoryPath = join(projectRoot, ".wasurenagusa");
    dbPath = join(memoryPath, config.sqliteFile);
    mkdirSync(memoryPath, { recursive: true });
    // dont.md / config.md は意図的に作らない（SQLite-only を再現）
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("dont重複候補があっても、memoriesと統合キャッシュへの書き込みは発生せず、レポートに検出件数が記録される", async () => {
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);
    seedRecentDreamToSkipF3(storage);
    const a = storage.save({
      category: "dont",
      title: "タグ直書き禁止A",
      content: "タグをコードに直書きしてはいけない",
      project: "myproject",
      intensity: 4,
    });
    const b = storage.save({
      category: "dont",
      title: "タグ直書き禁止B",
      content: "タグはハードコードせず定数化する",
      project: "myproject",
      intensity: 5,
    });
    // 重複クラスタを形成するための近接ベクトル
    storage.upsertVector(a.id, nearbyVector(1));
    storage.upsertVector(b.id, nearbyVector(2));
    storage.close();

    // dry-run中はdont/config統合のLLM呼び出しが一切発生しないため、generateTextFnの注入は不要
    await consolidateProject(projectRoot);

    const check = new SQLiteStorage(dbPath);
    check.initialize(memoryPath);
    const consolidated = check.readConsolidated("dont") as ConsolidatedDont | null;
    const aliveDont = check.readAliveDontEntries("myproject");
    check.close();

    // 統合キャッシュ（SQLite・ファイル双方）への書き込みが発生していない
    expect(consolidated).toBeNull();
    expect(existsSync(join(memoryPath, config.consolidatedDontFile))).toBe(false);
    // memoriesへの書き込み（マージ結果の新規保存・原本の論理削除）が発生していない
    expect(aliveDont.find((e) => e.id === a.id)).toBeDefined();
    expect(aliveDont.find((e) => e.id === b.id)).toBeDefined();
    expect(aliveDont.length).toBe(2);

    // レポートファイルが生成され、クラスタ数・重複候補件数が記録されている
    const reportPath = join(memoryPath, DRY_RUN_REPORT_FILE);
    expect(existsSync(reportPath)).toBe(true);
    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    expect(report.dont.stale).toBe(true);
    expect(report.dont.aliveEntryCount).toBe(2);
    expect(report.dont.dupClusterCount).toBeGreaterThan(0);

    // 可観測性カウンタ（タスク0.9、R-M1）: 統合候補件数が記録される
    const counterFiles = readFileSync(
      join(memoryPath, "logs", `counters-${new Date(new Date().getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)}.jsonl`),
      "utf-8",
    ).trim().split("\n").map((l) => JSON.parse(l));
    const consolidationEntry = counterFiles.find((e) => e.metric === "consolidation_count");
    expect(consolidationEntry).toBeDefined();
    expect(consolidationEntry.value).toBe(report.dont.dupClusterCount + report.config.entryCount);
  });

  it("config候補があっても、統合キャッシュへの書き込みは発生せず、レポートに候補件数が記録される", async () => {
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);
    seedRecentDreamToSkipF3(storage);
    storage.save({
      category: "config",
      title: "本番API URL",
      content: "本番APIは https://api.example.com",
      project: "myproject",
    });
    storage.close();

    await consolidateProject(projectRoot);

    const check = new SQLiteStorage(dbPath);
    check.initialize(memoryPath);
    const consolidated = check.readConsolidated("config") as ConsolidatedConfig | null;
    check.close();

    expect(consolidated).toBeNull();
    expect(existsSync(join(memoryPath, config.consolidatedConfigFile))).toBe(false);

    const reportPath = join(memoryPath, DRY_RUN_REPORT_FILE);
    expect(existsSync(reportPath)).toBe(true);
    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    expect(report.config.stale).toBe(true);
    expect(report.config.entryCount).toBe(1);
  });

  it("統合候補が0件のときも、レポートは生成され件数0が記録される（沈黙成功を出さない）", async () => {
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);
    seedRecentDreamToSkipF3(storage);
    storage.close();

    await consolidateProject(projectRoot);

    const reportPath = join(memoryPath, DRY_RUN_REPORT_FILE);
    expect(existsSync(reportPath)).toBe(true);
    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    expect(report.dont.aliveEntryCount).toBe(0);
    expect(report.dont.dupClusterCount).toBe(0);
    expect(report.config.entryCount).toBe(0);
  });

  // --- 抑制装置（カテゴリ別上限）の dry-run を「振る舞いレベル」で固定する追加検証 ---
  //
  // g-write-severance（静的ゲート）は「書込パターンがコードに現れない」ことを守るが、
  // 実際に consolidateProject を temp DB 上で走らせ、memories/vector_metadata が 1 行も
  // 変化しないことを before/after スナップショット比較で固定する（名前非依存の無書込ガード）。
  // 同時に、cap-sweep のレポート追記が degenerate な空ではなく実候補を計上していること
  // （判定が本当に働いていること）も e2e で固定する。
  // 忘却（長期未参照の退避）は本増分では未搭載のため、その検証は含めない。

  /**
   * memories 全行（全カラム）と vector_metadata 全行のスナップショット文字列。
   *
   * memories は SELECT *（全列）を id 昇順で取得する。一部列（id/state/content 等）だけを見ると、
   * 生 SQL の 'UPDATE memories SET intensity=0' のように「スナップショット外の狭い列だけを書き換え、
   * かつ updated_at を動かさない」改ざんが、破壊メソッドスパイ（生 SQL は prototype 未経由で total=0）
   * と狭い列スナップショットの両方を素通りする。全列を比較対象に含めることで、経路・命名・別名化に
   * 依らず どのカラムの改ざんも前後不一致で検知する（値が完全同一へ戻る無害な no-op 書き込みのみ
   * 検知外＝データ喪失は無いので許容）。
   */
  function snapshotMemAndVectors(): string {
    const d = new RawDatabase(dbPath, { readonly: true });
    try {
      const mem = d.prepare("SELECT * FROM memories ORDER BY id").all();
      const vm = d
        .prepare("SELECT id, access_count, last_accessed_at FROM vector_metadata ORDER BY id")
        .all();
      return JSON.stringify({ memCount: mem.length, mem, vmCount: vm.length, vm });
    } finally {
      d.close();
    }
  }

  /** 現在時刻基準の相対オフセット（例 '-300 days'）を datetime literal へ解決する。 */
  function nowOffset(offset: string): string {
    const d = new RawDatabase(dbPath, { readonly: true });
    try {
      return (d.prepare("SELECT datetime('now', ?) AS t").get(offset) as { t: string }).t;
    } finally {
      d.close();
    }
  }

  /** memories 行を生投入（id/updated_at を決定論的に固定するため save() ではなく生 SQL を使う）。 */
  function seedRawRows(
    rows: { id: string; category: string; updatedAt: string; state?: string }[],
  ): void {
    const d = new RawDatabase(dbPath);
    try {
      const insert = d.prepare(
        `INSERT INTO memories (id, timestamp, category, title, content, state, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const tx = d.transaction(() => {
        for (const r of rows) {
          insert.run(
            r.id,
            "2026-01-01T00:00:00+09:00",
            r.category,
            `title-${r.id}`,
            `content-${r.id}`, // 行ごとに異なる本文
            r.state ?? "active",
            r.updatedAt,
          );
        }
      });
      tx();
    } finally {
      d.close();
    }
  }

  it("上限超過・dont重複が同居しても consolidateProject は memories/vector を1行も書き換えない（振る舞いレベルの無書込ガード）", async () => {
    const cap = config.maxEntriesPerCategory;

    // dont 重複クラスタ（近接ベクトル）と F3 スキップ用 dream を storage 経由で用意
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);
    seedRecentDreamToSkipF3(storage);
    const a = storage.save({
      category: "dont",
      title: "タグ直書き禁止A",
      content: "タグをコードに直書きしてはいけない（原本）",
      project: "myproject",
      intensity: 4,
    });
    const b = storage.save({
      category: "dont",
      title: "タグ直書き禁止B",
      content: "タグはハードコードせず定数化する（原本）",
      project: "myproject",
      intensity: 5,
    });
    storage.upsertVector(a.id, nearbyVector(1));
    storage.upsertVector(b.id, nearbyVector(2));
    storage.close();

    // 上限超過カテゴリ（log = cap+2）を生投入（capSweep が実候補を出す状況）
    const recent = nowOffset("-1 days");
    const logRows = Array.from({ length: cap + 2 }, (_, i) => ({
      id: `log-${String(i).padStart(4, "0")}`,
      category: "log",
      updatedAt: recent,
    }));
    seedRawRows([...logRows]);

    const before = snapshotMemAndVectors();
    await consolidateProject(projectRoot);
    const after = snapshotMemAndVectors();

    // 【本命】判定は働くが memories/vector_metadata は 1 バイトも変わらない（無書込ガード）
    expect(after).toBe(before);

    // 業務的にも: dont 原本は論理削除されず生存し、archived は 1 件も生まれていない
    const check = new SQLiteStorage(dbPath);
    check.initialize(memoryPath);
    const aliveDont = check.readAliveDontEntries("myproject");
    expect(aliveDont.find((e) => e.id === a.id)).toBeDefined();
    expect(aliveDont.find((e) => e.id === b.id)).toBeDefined();
    const archivedCount = (
      new RawDatabase(dbPath, { readonly: true })
        .prepare("SELECT COUNT(*) AS c FROM memories WHERE state = 'archived'")
        .get() as { c: number }
    ).c;
    expect(archivedCount).toBe(0);
    check.close();

    // レポートは「もし退避したら」の実候補を検出している（degenerate な空ではない）
    const report = JSON.parse(readFileSync(join(memoryPath, DRY_RUN_REPORT_FILE), "utf-8"));
    expect(report.dont.dupClusterCount).toBeGreaterThan(0);
    expect(report.capSweep.totalArchiveCandidateCount).toBe(2); // log は cap+2 の超過 2 件
    // 忘却（staleSweep）は本増分では未搭載のため、レポートに staleSweep セクションは存在しない
    expect(report.staleSweep).toBeUndefined();
  });

  it("複数カテゴリが上限超過のとき、capSweep 候補が各カテゴリ分計上され totalArchiveCandidateCount が per-category 候補数の総和になる", async () => {
    const cap = config.maxEntriesPerCategory;

    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);
    seedRecentDreamToSkipF3(storage);
    storage.close();

    const recent = nowOffset("-1 days");
    const logRows = Array.from({ length: cap + 2 }, (_, i) => ({
      id: `log-${String(i).padStart(4, "0")}`,
      category: "log",
      updatedAt: recent,
    }));
    const decRows = Array.from({ length: cap + 5 }, (_, i) => ({
      id: `dec-${String(i).padStart(4, "0")}`,
      category: "decision",
      updatedAt: recent,
    }));
    seedRawRows([...logRows, ...decRows]);

    const before = snapshotMemAndVectors();
    await consolidateProject(projectRoot);
    const after = snapshotMemAndVectors();
    expect(after).toBe(before); // dry-run: ここでも無書込

    const report = JSON.parse(readFileSync(join(memoryPath, DRY_RUN_REPORT_FILE), "utf-8"));
    expect(report.capSweep.cap).toBe(cap);

    // 両カテゴリとも超過 → categories に両方が載る（カテゴリ順は GROUP BY 依存のため map で参照）
    const byCat: Record<string, { archiveCandidateCount: number; activeCount: number }> =
      Object.fromEntries(
        report.capSweep.categories.map((c: { category: string; archiveCandidateCount: number; activeCount: number }) => [c.category, c]),
      );
    expect(byCat.log.archiveCandidateCount).toBe(2);
    expect(byCat.decision.archiveCandidateCount).toBe(5);

    // 総和が per-category 候補数の合計に一致する（レポート追記の集計ロジックを e2e で固定）
    const sum = report.capSweep.categories.reduce(
      (s: number, c: { archiveCandidateCount: number }) => s + c.archiveCandidateCount,
      0,
    );
    expect(report.capSweep.totalArchiveCandidateCount).toBe(sum);
    expect(sum).toBe(7); // (cap+2 − cap) + (cap+5 − cap) = 2 + 5
  });

  it("dry-run 実行中に SQLiteStorage の破壊メソッド（save/delete/softDelete/deleteVectors/purgeTombstones/updateIntensity）が一度も呼ばれない（実メソッドをスパイする主軸ガード）", async () => {
    const cap = config.maxEntriesPerCategory;

    // 複数カテゴリの memories と vector_metadata を seed（capSweep が実候補を出す状況）。
    // 埋め込みを持つ dont と、埋め込みを持たない config/log を混在させ、破壊経路の広い面を通す。
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);
    seedRecentDreamToSkipF3(storage);
    const a = storage.save({
      category: "dont",
      title: "破壊呼び出し検査用A",
      content: "原本A（dry-run 中に論理削除されてはならない）",
      project: "myproject",
      intensity: 4,
    });
    const b = storage.save({
      category: "dont",
      title: "破壊呼び出し検査用B",
      content: "原本B（dry-run 中に論理削除されてはならない）",
      project: "myproject",
      intensity: 5,
    });
    storage.upsertVector(a.id, nearbyVector(1));
    storage.upsertVector(b.id, nearbyVector(2));
    storage.save({
      category: "config",
      title: "本番API URL",
      content: "本番APIは https://api.example.com",
      project: "myproject",
    });
    storage.close();

    // 上限超過カテゴリ（log = cap+2）を生投入（capSweep が実候補 2 件を出す）
    const recent = nowOffset("-1 days");
    const logRows = Array.from({ length: cap + 2 }, (_, i) => ({
      id: `log-${String(i).padStart(4, "0")}`,
      category: "log",
      updatedAt: recent,
    }));
    seedRawRows([...logRows]);

    // dry-run 本経路（consolidateProject。内部の storage.initialize も含む全区間）をスパイで囲む
    const before = snapshotMemAndVectors();
    const spy = installDestructiveSpy();
    try {
      await consolidateProject(projectRoot);
    } finally {
      spy.restore();
    }
    const after = snapshotMemAndVectors();

    // 【本命】dry-run 中は破壊メソッドが 1 度も呼ばれない（別名化・別ファイル経由でも実メソッドに掛かる）
    expect(spy.total()).toBe(0);
    expect(spy.byMethod).toEqual({
      save: 0,
      delete: 0,
      softDelete: 0,
      deleteVectors: 0,
      purgeTombstones: 0,
      updateIntensity: 0,
    });
    // スナップショットも不変（「破壊呼び出しゼロ」と「無書込」を二重に固定する）
    expect(after).toBe(before);

    // 判定は degenerate な空ではなく実候補を計上している（＝「何もしていないから 0」ではないことの担保）
    const report = JSON.parse(readFileSync(join(memoryPath, DRY_RUN_REPORT_FILE), "utf-8"));
    expect(report.capSweep.totalArchiveCandidateCount).toBe(2);
    expect(report.dont.dupClusterCount).toBeGreaterThan(0);
  });

  it("回帰: 破壊挙動を (a)consolidator別名ヘルパー (b)storage配下の呼び出し側 (c)メソッド別名化 のどの形態で注入しても、スパイと無書込スナップショットが必ず検知する", () => {
    // consolidateProject 本体は改変しない（本文を汚さない）。ここでは「本体の呼び出し経路に破壊
    // ヘルパーが注入されたら検知が落ちるか」を、実 SQLiteStorage（seed 済み temp DB）へ各形態を
    // 実行して固定する。スパイは prototype の実メソッドに掛かるため、呼び出しがどのファイル・
    // どの別名から来ても捕捉する。※(a)(b)の「ファイル位置による静的検知」は g-write-severance の
    // Check D 側テストで固定する（本テストは実行時の振る舞い検知＝別名化 (c) を含む三形態を担う）。

    // 各形態が論理削除する alive な dont 原本を 3 件用意（形態ごとに別 id を対象にして相互干渉を防ぐ）。
    const setup = new SQLiteStorage(dbPath);
    setup.initialize(memoryPath);
    seedRecentDreamToSkipF3(setup);
    const targets = ["a", "b", "c"].map(
      (label) =>
        setup.save({
          category: "dont",
          title: `原本-${label}`,
          content: `原本本文-${label}（この形態で論理削除される）`,
          project: "myproject",
          intensity: 3,
        }).id,
    );
    setup.close();

    // (a) consolidator/ 配下の別名ヘルパーに相当する関数（別名経由の破壊呼び出し）。
    const aliasHelperFromConsolidator = (s: SQLiteStorage, id: string): void => {
      s.softDelete([id]);
    };
    // (b) storage/ 配下の新規呼び出し側ファイルに相当する関数（runtime では位置は無関係だが形態として明示）。
    const callerLocatedUnderStorage = (s: SQLiteStorage, id: string): void => {
      s.softDelete([id]);
    };
    // (c) メソッド別名化: prototype メソッドを別名へ束ねてから呼ぶ（正規表現ゲートが最も追えない形態）。
    const viaMethodAlias = (s: SQLiteStorage, id: string): void => {
      const del = (s as unknown as Record<string, (ids: string[]) => unknown>)["softDelete"].bind(s);
      del([id]);
    };

    const forms: { name: string; run: (s: SQLiteStorage, id: string) => void }[] = [
      { name: "(a) consolidator別名ヘルパー", run: aliasHelperFromConsolidator },
      { name: "(b) storage配下の呼び出し側", run: callerLocatedUnderStorage },
      { name: "(c) メソッド別名化", run: viaMethodAlias },
    ];

    forms.forEach((form, i) => {
      const before = snapshotMemAndVectors();
      const s = new SQLiteStorage(dbPath);
      s.initialize(memoryPath);
      // スパイは initialize 後に掛け、この形態の破壊呼び出しだけを数える
      const spy = installDestructiveSpy();
      try {
        form.run(s, targets[i]);
      } finally {
        spy.restore();
        s.close();
      }
      const after = snapshotMemAndVectors();

      // スパイ: 実メソッドへの破壊呼び出しを必ず捕捉する（別名化・別ファイルでも）
      expect(spy.total(), `${form.name}: スパイが破壊呼び出しを捕捉する`).toBeGreaterThan(0);
      expect(spy.byMethod.softDelete, `${form.name}: softDelete が 1 度呼ばれた`).toBe(1);
      // 無書込スナップショット: memories が実際に変化し、before/after 比較が必ず破れる
      expect(after, `${form.name}: memories が変化しスナップショット比較が破れる`).not.toBe(before);
    });
  });
});

/**
 * main()のAPIキー無し早期exitガード撤去（push前レビュー指摘）。
 * 統合はdry-run化済み（LLM呼び出し無し）のため、APIキーが1つも無い実行環境でも
 * dry-runレポートとconsolidation_countカウンタが記録されることをCLI実機（spawn）で確認する。
 * ビルド済みでないとスキップされる（pre-tool-use-guard.test.tsのCLI実機テストと同型）。
 */
describe("consolidate-all main() CLI（実機）: APIキー無しでもdry-run処理が実行される", () => {
  let tmpHome: string;
  let projectRoot: string;
  let memoryPath: string;
  const cliPath = resolve(__dirname, "../../dist/cli/consolidate-all.js");

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "wasurenagusa-consolidate-main-test-"));
    projectRoot = join(tmpHome, "myproject");
    memoryPath = join(projectRoot, ".wasurenagusa");
    mkdirSync(memoryPath, { recursive: true });

    // F3夢生成をスキップさせ、LLM/ネットワーク呼び出しを一切発生させない
    // （直近24h以内にdreamがあれば無条件スキップする仕様を利用。他テストと同じ手法）
    const storage = new SQLiteStorage(join(memoryPath, config.sqliteFile));
    storage.initialize(memoryPath);
    storage.save({
      category: "dream",
      title: "既存の夢（F3干渉防止用ダミー）",
      content: "main() CLI実機テストをF3夢生成の挙動から独立させるための事前シード",
      tags: ["dream"],
      project: "myproject",
    });
    storage.close();

    const schedulerDir = join(tmpHome, ".wasurenagusa", "scheduler");
    mkdirSync(schedulerDir, { recursive: true });
    writeFileSync(
      join(schedulerDir, "active-projects.json"),
      JSON.stringify({
        projects: [{
          name: "myproject",
          path: projectRoot,
          lastSessionAt: new Date().toISOString(),
          sessionTopic: "test",
        }],
        maxActiveProjects: 5,
        updatedAt: new Date().toISOString(),
      }),
    );
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("APIキーが1つも無くても、対象プロジェクトのdry-runレポートとconsolidation_countカウンタが記録される", () => {
    if (!existsSync(cliPath)) {
      // ビルド前: スキップ
      return;
    }

    // HOMEをtmpHomeへ差し替え、実HOME配下のスケジューラ/秘密には一切触れない
    const proc = spawnSync("node", [cliPath], {
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpHome,
        GEMINI_API_KEY: "",
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
      },
    });

    expect(proc.status).toBe(0);
    expect(existsSync(join(memoryPath, DRY_RUN_REPORT_FILE))).toBe(true);

    const logsDir = join(memoryPath, "logs");
    expect(existsSync(logsDir)).toBe(true);
    const counterFiles = readdirSync(logsDir).filter((f) => f.startsWith("counters-"));
    expect(counterFiles.length).toBe(1);
    const entries = readFileSync(join(logsDir, counterFiles[0]), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(entries.some((e) => e.metric === "consolidation_count")).toBe(true);
  });
});
