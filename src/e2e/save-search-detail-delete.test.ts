import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SQLiteStorage } from "../storage/sqlite.js";

/**
 * E2E統合テスト: save → search → getDetail ��� delete フロー
 *
 * SQLiteStorage単体で、FTS5（trigramキーワード検索）＋ベクトル検索＋
 * getDetail＋deleteの一連操作を検証する。
 *
 * 注意: FTS5 trigramトークナイザは3文字未満の検索語ではヒットしない。
 * テストの検索語は全て3文字以上にすること。
 */

function makeVector(values: Record<number, number>): number[] {
  const vec = new Array(384).fill(0);
  for (const [idx, val] of Object.entries(values)) {
    vec[Number(idx)] = val;
  }
  return vec;
}

describe("E2E: save → search → getDetail → delete", () => {
  let storage: SQLiteStorage;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-e2e-"));
    storage = new SQLiteStorage(join(tmpDir, "test.db"));
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("全フロー: save → FTS5 search → getDetail → delete → 確認", () => {
    // 1. save: 複数エントリを保存
    const s1 = storage.save({
      category: "config",
      title: "Firebaseプロジェクト設定",
      content: "プロジェクトID: my-app-prod、リージョン: asia-northeast1",
      tags: ["firebase", "config"],
      project: "my-app",
      scope: "backend",
    });
    expect(s1.success).toBe(true);

    const s2 = storage.save({
      category: "dont",
      title: "本番DBへの直接クエリ禁止",
      content: "必ずエミュレータまたはステージング環境を使うこと。過去に本番データを破壊した事故あり。",
      tags: ["database", "safety"],
      project: "my-app",
      intensity: 5,
    });
    expect(s2.success).toBe(true);

    const s3 = storage.save({
      category: "decision",
      title: "認証方式はFirebase Authを採用",
      content: "JWT自前実装ではなくFirebase Authを使う。理由: セキュリティ要件を満たしつつ開発コストを��える。",
      tags: ["auth", "firebase"],
      project: "my-app",
    });
    expect(s3.success).toBe(true);

    // 2. search (FTS5): 3文字以上のキーワードで検索
    const searchResult = storage.search({ query: "Firebase" });
    expect(searchResult.results.length).toBe(2); // s1とs3がヒット
    expect(searchResult.results.some(r => r.id === s1.id)).toBe(true);
    expect(searchResult.results.some(r => r.id === s3.id)).toBe(true);

    // 3. getDetail: 検索結果のIDで詳細取得
    const ids = searchResult.results.map(r => r.id);
    const detail = storage.getDetail({ ids });
    expect(detail.entries.length).toBe(2);
    expect(detail.notFound.length).toBe(0);

    // フル内容が返っている
    const configEntry = detail.entries.find(e => e.id === s1.id);
    expect(configEntry).toBeDefined();
    expect(configEntry!.content).toContain("my-app-prod");
    expect(configEntry!.tags).toContain("firebase");

    // 4. delete: 1件削除
    const deleteResult = storage.delete({ ids: [s1.id] });
    expect(deleteResult.deleted).toEqual([s1.id]);
    expect(deleteResult.notFound.length).toBe(0);

    // 5. 削除確認: 再検索で消えている
    const afterDelete = storage.search({ query: "Firebase" });
    expect(afterDelete.results.length).toBe(1);
    expect(afterDelete.results[0].id).toBe(s3.id);

    // getDetailでも消えている
    const detailAfter = storage.getDetail({ ids: [s1.id] });
    expect(detailAfter.notFound).toEqual([s1.id]);
  });

  it("ハイブリッド検索: FTS5 + ベクトル検索の���合", () => {
    // 1. save + upsertVector
    const s1 = storage.save({
      category: "config",
      title: "ポート番号の設定方法",
      content: "開発サーバーはポート3000、APIはポート8080",
      tags: ["port"],
    });
    storage.upsertVector(s1.id, makeVector({ 0: 1.0 }));

    const s2 = storage.save({
      category: "dont",
      title: "console.logを残さないこと",
      content: "デバッグ用のconsole.logはコミット前に必ず削除する",
      tags: ["code-quality"],
    });
    storage.upsertVector(s2.id, makeVector({ 0: 0.9, 1: 0.1 }));

    const s3 = storage.save({
      category: "log",
      title: "APIエンドポイント追加作業",
      content: "/api/users エンドポイントを追加した",
      tags: ["api"],
    });
    storage.upsertVector(s3.id, makeVector({ 1: 1.0 }));

    // 2. searchHybrid: "ポート番号"でFTSヒット + dim0に近いベクトル
    const hybridResult = storage.searchHybrid(
      { query: "ポート番号" },
      makeVector({ 0: 1.0 })
    );

    // FTS: s1がヒット、ベクトル: 全3件（距離999以下）→ UNIONで3件
    expect(hybridResult.results.length).toBe(3);
    expect(hybridResult.results.some(r => r.id === s1.id)).toBe(true);

    // 3. getDetail
    const detail = storage.getDetail({ ids: hybridResult.results.map(r => r.id) });
    expect(detail.entries.length).toBe(3);

    // 4. delete + ベクトルも消える
    storage.delete({ ids: [s1.id] });
    const vectorAfter = storage.searchVectors(makeVector({ 0: 1.0 }), 999, 10);
    expect(vectorAfter.some(r => r.id === s1.id)).toBe(false);
  });

  it("日本語テキストのtrigram FTS5検索（3文字以上）", () => {
    storage.save({
      category: "config",
      title: "データベース接続の設定方法",
      content: "Firestoreのプロジェクトは asia-northeast1 リージョン",
      tags: ["firestore"],
    });

    storage.save({
      category: "dont",
      title: "テスト環境でのデータ削除を禁止する",
      content: "テスト環境のデータは他チームも参照しているため勝手に削除しない",
      tags: ["test"],
    });

    storage.save({
      category: "config",
      title: "環境変数の設定方法について",
      content: ".envファイルにGEMINI_API_KEYを設定する",
      tags: ["env"],
    });

    // trigramトークナイザは3文字以上でヒット
    const r1 = storage.search({ query: "データベース" });
    expect(r1.results.length).toBeGreaterThanOrEqual(1);
    expect(r1.results.some(r => r.title.includes("データベース"))).toBe(true);

    // 「テスト」（3文字）でヒット
    const r2 = storage.search({ query: "テスト" });
    expect(r2.results.length).toBeGreaterThanOrEqual(1);

    // 「環境変数」（4文字）
    const r3 = storage.search({ query: "環境変数" });
    expect(r3.results.length).toBeGreaterThanOrEqual(1);

    // 「Firestore」（英語混在）
    const r4 = storage.search({ query: "Firestore" });
    expect(r4.results.length).toBe(1);
    expect(r4.results[0].title).toContain("データベース");

    // 「設定方法」（4文字）で複数ヒット
    const r5 = storage.search({ query: "設定方法" });
    expect(r5.results.length).toBeGreaterThanOrEqual(2);
  });

  it("projectフィルタ付きの全フロー", () => {
    storage.save({
      category: "config",
      title: "プロジェクトA用の設定内容",
      content: "内容A詳細",
      project: "proj-a",
    });
    storage.save({
      category: "config",
      title: "プロジェクトB用の設定内容",
      content: "内容B���細",
      project: "proj-b",
    });
    storage.save({
      category: "config",
      title: "共通のプロジェクト設定内容",
      content: "全プロジェクト共通",
    });

    // 「プロジェクト」(5文字) + proj-aフィルタ
    const result = storage.search({ query: "プロジェクト", project: "proj-a" });
    expect(result.results.length).toBe(2); // proj-a + project未指定
    expect(result.results.some(r => r.title.includes("プロジェクトA"))).toBe(true);
    expect(result.results.some(r => r.title.includes("共通"))).toBe(true);
    expect(result.results.some(r => r.title.includes("プロジェクトB"))).toBe(false);
  });

  it("scopeフィ��タ付きの���フロー", () => {
    storage.save({
      category: "config",
      title: "フロントエンド開発の設定情報",
      content: "React 19を使用する",
      scope: "frontend",
    });
    storage.save({
      category: "config",
      title: "バックエンド開発の設定情報",
      content: "Cloud Functions使用する",
      scope: "backend",
    });
    storage.save({
      category: "config",
      title: "汎用的な開発の設定情報",
      content: "全般的な設定のまとめ",
      scope: "general",
    });

    // 「設定情報」(4文字) + frontendフィルタ
    const result = storage.search({ query: "設定情報", scope: "frontend" });
    expect(result.results.some(r => r.title.includes("フロントエンド"))).toBe(true);
    expect(result.results.some(r => r.title.includes("汎用的"))).toBe(true);
    expect(result.results.some(r => r.title.includes("バックエンド"))).toBe(false);
  });

  it("replaceId による更新 → 検索 → 詳細取得", () => {
    const original = storage.save({
      category: "config",
      title: "APIエンドポイントの設定",
      content: "https://api.example.com/version1",
    });

    // replaceIdで更新
    const updated = storage.save({
      category: "config",
      title: "APIエン���ポイントの設定",
      content: "https://api.example.com/version2",
      replaceId: original.id,
    });
    expect(updated.id).toBe(original.id);

    // 検索: 更新後の内容が取得できる
    const detail = storage.getDetail({ ids: [original.id] });
    expect(detail.entries.length).toBe(1);
    expect(detail.entries[0].content).toBe("https://api.example.com/version2");

    // FTS5でも更新後の内容で検索できる（3文字以上のキーワード）
    const searchV2 = storage.search({ query: "version2" });
    expect(searchV2.results.some(r => r.id === original.id)).toBe(true);

    // 旧内容では検索されない
    const searchV1 = storage.search({ query: "version1" });
    expect(searchV1.results.some(r => r.id === original.id)).toBe(false);
  });

  it("updateIntensity → getContext での反映", () => {
    const saved = storage.save({
      category: "dont",
      title: "直接pushしない",
      content: "mainブランチに直接pushしないこと",
      intensity: 3,
    });

    storage.updateIntensity(saved.id, 8);

    const detail = storage.getDetail({ ids: [saved.id] });
    expect(detail.entries[0].intensity).toBe(8);

    const context = storage.getContext();
    expect(context.dont).toContain("直接pushしない");
  });

  it("大量エントリでの検索パフォーマンス（100件）", () => {
    for (let i = 0; i < 100; i++) {
      storage.save({
        category: i % 5 === 0 ? "config" : i % 5 === 1 ? "dont" : i % 5 === 2 ? "decision" : i % 5 === 3 ? "log" : "snippet",
        title: `テストエントリ番号${i}: キーワード番号${i % 10}`,
        content: `テスト内容の詳細 ${i}。カテゴリごとにデータを分散配置している。`,
        tags: [`tag${i % 5}`],
        project: `proj-${i % 3}`,
      });
    }

    // 3文字以上のキーワード検索
    const result = storage.search({ query: "キーワード番号5", limit: 10 });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results.length).toBeLessThanOrEqual(10);

    // カテゴリフィルタ
    const configOnly = storage.search({ query: "テストエントリ", category: "config", limit: 50 });
    expect(configOnly.results.every(r => r.category === "config")).toBe(true);

    // 空クエリで全件取得
    const all = storage.search({ query: "", limit: 200 });
    expect(all.totalCount).toBe(100);
  });
});

describe("E2E: 2文字キーワード LIKEフォールバック", () => {
  let storage: SQLiteStorage;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-e2e-like-"));
    storage = new SQLiteStorage(join(tmpDir, "test.db"));
    storage.initialize();

    // テストデータ: 2文字キーワードを含むエントリ
    storage.save({
      category: "config",
      title: "環境変数の設定",
      content: "本番環境と開発環境の切り替え方法",
      tags: ["env", "設定"],
      project: "my-app",
    });

    storage.save({
      category: "config",
      title: "DB接続の設定方法",
      content: "PostgreSQLのDB接続文字列を.envに記載する",
      tags: ["DB", "postgres"],
      project: "my-app",
    });

    storage.save({
      category: "decision",
      title: "認証方式の決定事項",
      content: "Firebase Authを採用。JWTは自前実装しない",
      tags: ["auth", "認証"],
      project: "my-app",
    });

    storage.save({
      category: "dont",
      title: "本番に直接pushしない",
      content: "mainブランチへの直push禁止。PRを経由すること",
      tags: ["git", "安全"],
      scope: "backend",
    });
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("search: 2文字日本語「設定」でLIKEフォールバック", () => {
    const result = storage.search({ query: "設定" });
    expect(result.results.length).toBeGreaterThanOrEqual(2);
    expect(result.results.some(r => r.title.includes("環境変数"))).toBe(true);
    expect(result.results.some(r => r.title.includes("DB接続"))).toBe(true);
  });

  it("search: 2文字日本語「環境」でLIKEフォールバック", () => {
    const result = storage.search({ query: "環境" });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results.some(r => r.title.includes("環境変数"))).toBe(true);
  });

  it("search: 2文字英語「DB」でLIKEフォールバック", () => {
    const result = storage.search({ query: "DB" });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results.some(r => r.title.includes("DB接続"))).toBe(true);
  });

  it("search: 2文字「認証」でLIKEフォールバック", () => {
    const result = storage.search({ query: "認証" });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results.some(r => r.title.includes("認証方式"))).toBe(true);
  });

  it("search: 1文字「本」でもLIKEフォールバック", () => {
    const result = storage.search({ query: "本" });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });

  it("search: 2文字 + categoryフィルタ", () => {
    const result = storage.search({ query: "設定", category: "config" });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results.every(r => r.category === "config")).toBe(true);
  });

  it("search: 2文字 + projectフィルタ", () => {
    const result = storage.search({ query: "安全", project: "my-app" });
    // "安全"タグを持つエントリはproject未指定(=null)なのでヒットする
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });

  it("search: 2文字 + scopeフィルタ", () => {
    const result = storage.search({ query: "PR", scope: "backend" });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results.some(r => r.title.includes("push"))).toBe(true);
  });

  it("search: totalCountが正しい", () => {
    const result = storage.search({ query: "設定" });
    expect(result.totalCount).toBe(result.results.length);
  });

  it("searchHybrid: 2文字「設定」でLIKEフォールバック + ベクトル検索", () => {
    // ベクトルを追加
    const allEntries = storage.search({ query: "" });
    for (const entry of allEntries.results) {
      const vec = new Array(384).fill(0);
      vec[0] = Math.random();
      storage.upsertVector(entry.id, vec);
    }

    const queryVec = new Array(384).fill(0);
    queryVec[0] = 1.0;

    const result = storage.searchHybrid({ query: "設定" }, queryVec);
    // LIKE: "設定"を含むエントリ + ベクトル: 全件 → UNIONで4件
    expect(result.results.length).toBe(4);
  });

  it("searchHybrid: 2文字「DB」でLIKEフォールバック + ベクトル検索", () => {
    // ベクトルを1件だけ追加
    const dbEntry = storage.search({ query: "DB" });
    expect(dbEntry.results.length).toBeGreaterThanOrEqual(1);
    const vec = new Array(384).fill(0);
    vec[0] = 1.0;
    storage.upsertVector(dbEntry.results[0].id, vec);

    const queryVec = new Array(384).fill(0);
    queryVec[0] = 1.0;

    const result = storage.searchHybrid({ query: "DB" }, queryVec);
    // LIKE: DB含む1件, ベクトル: 1件(同じID) → UNION = 1件
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results.some(r => r.title.includes("DB接続"))).toBe(true);
  });

  it("3文字以上は従来通りFTS5を使用", () => {
    // "設定方法"(4文字)はFTS5でヒットする
    const result = storage.search({ query: "設定方法" });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results.some(r => r.title.includes("DB接続"))).toBe(true);
  });
});
