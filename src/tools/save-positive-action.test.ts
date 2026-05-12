import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SQLiteStorage } from "../storage/sqlite.js";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, mkdirSync, rmSync } from "fs";

const MEMORY_DIR = ".wasurenagusa";

describe("positiveAction 保存・バリデーション（SQLiteStorage直接テスト）", () => {
  let memoryDir: string;
  let dbPath: string;
  let storage: SQLiteStorage;

  beforeEach(() => {
    memoryDir = mkdtempSync(join(tmpdir(), "wasurenagusa-positive-action-test-"));
    mkdirSync(join(memoryDir, MEMORY_DIR), { recursive: true });
    dbPath = join(memoryDir, MEMORY_DIR, "memory.db");
    storage = new SQLiteStorage(dbPath);
    storage.initialize(join(memoryDir, MEMORY_DIR));
  });

  afterEach(() => {
    storage.close();
    rmSync(memoryDir, { recursive: true, force: true });
  });

  it("category=dont + positiveAction を保存するとgetDetailでpositiveActionが読み出せる", () => {
    const saveResult = storage.save({
      category: "dont",
      title: "データは完全形保存／表示は表示層で制御",
      content: "substring等の切り捨てはしない",
      positiveAction: "データ保存時は完全形を保持し、表示文字数制限はCSS truncationで表示層に委譲する",
    });

    expect(saveResult.success).toBe(true);
    const detail = storage.getDetail({ ids: [saveResult.id] });

    expect(detail.entries.length).toBe(1);
    expect(detail.entries[0].positiveAction).toBe("データ保存時は完全形を保持し、表示文字数制限はCSS truncationで表示層に委譲する");
  });

  it("positiveAction が未設定のエントリは positiveAction が undefined で返る", () => {
    const saveResult = storage.save({
      category: "dont",
      title: "旧エントリ（positiveActionなし）",
      content: "旧スタイルのエントリ",
    });

    expect(saveResult.success).toBe(true);
    const detail = storage.getDetail({ ids: [saveResult.id] });

    expect(detail.entries.length).toBe(1);
    expect(detail.entries[0].positiveAction).toBeUndefined();
  });

  it("replaceId パスで positiveAction が上書き保存される", () => {
    const saveResult = storage.save({
      category: "dont",
      title: "旧タイトル",
      content: "旧内容",
    });
    const id = saveResult.id;

    storage.save({
      category: "dont",
      title: "新タイトル",
      content: "新内容",
      replaceId: id,
      positiveAction: "新しい肯定形アクション",
    });

    const detail = storage.getDetail({ ids: [id] });
    expect(detail.entries.length).toBe(1);
    expect(detail.entries[0].positiveAction).toBe("新しい肯定形アクション");
    expect(detail.entries[0].title).toBe("新タイトル");
  });

  it("listHighIntensityDonts に positiveAction が含まれる", () => {
    storage.save({
      category: "dont",
      title: "高強度dontエントリ",
      content: "内容",
      intensity: 9,
      positiveAction: "高強度dontの肯定形アクション",
    });

    const donts = storage.listHighIntensityDonts(4, 10);
    expect(donts.length).toBe(1);
    expect(donts[0].positiveAction).toBe("高強度dontの肯定形アクション");
  });

  it("category=dont + scenario + whyCore を保存するとgetDetailで読み出せる", () => {
    const saveResult = storage.save({
      category: "dont",
      title: "データは完全形保存／表示は表示層で制御",
      content: "公報原文を切り捨てた",
      scenario: "politician-checker パイプラインで公報原文先頭20字を切り捨てて格納（substring(0,20)）。今回が3度目",
      whyCore: "データ層で切り詰めると後で完全形が必要な時に取り戻せず、再々々発は致命的",
      positiveAction: "データ保存時は完全形を保持し、表示文字数制限はCSS truncationで表示層に委譲する",
    });

    expect(saveResult.success).toBe(true);
    const detail = storage.getDetail({ ids: [saveResult.id] });

    expect(detail.entries.length).toBe(1);
    expect(detail.entries[0].scenario).toBe("politician-checker パイプラインで公報原文先頭20字を切り捨てて格納（substring(0,20)）。今回が3度目");
    expect(detail.entries[0].whyCore).toBe("データ層で切り詰めると後で完全形が必要な時に取り戻せず、再々々発は致命的");
  });

  it("scenario / whyCore が未設定のエントリは undefined で返る", () => {
    const saveResult = storage.save({
      category: "dont",
      title: "旧エントリ（3要素なし）",
      content: "旧スタイルのエントリ",
    });

    expect(saveResult.success).toBe(true);
    const detail = storage.getDetail({ ids: [saveResult.id] });

    expect(detail.entries.length).toBe(1);
    expect(detail.entries[0].scenario).toBeUndefined();
    expect(detail.entries[0].whyCore).toBeUndefined();
  });

  it("listHighIntensityDonts に scenario / whyCore が含まれる", () => {
    storage.save({
      category: "dont",
      title: "高強度dontエントリ（3要素）",
      content: "内容",
      intensity: 9,
      positiveAction: "高強度dontの肯定形アクション",
      scenario: "本番チャンネルに誤投稿した",
      whyCore: "送信パスの実装確認を怠った",
    });

    const donts = storage.listHighIntensityDonts(4, 10);
    expect(donts.length).toBe(1);
    expect(donts[0].scenario).toBe("本番チャンネルに誤投稿した");
    expect(donts[0].whyCore).toBe("送信パスの実装確認を怠った");
  });

  it("replaceId パスで scenario / whyCore が上書き保存される", () => {
    const saveResult = storage.save({
      category: "dont",
      title: "旧タイトル",
      content: "旧内容",
    });
    const id = saveResult.id;

    storage.save({
      category: "dont",
      title: "新タイトル",
      content: "新内容",
      replaceId: id,
      scenario: "新しいシナリオ",
      whyCore: "新しい核心理由",
    });

    const detail = storage.getDetail({ ids: [id] });
    expect(detail.entries.length).toBe(1);
    expect(detail.entries[0].scenario).toBe("新しいシナリオ");
    expect(detail.entries[0].whyCore).toBe("新しい核心理由");
  });
});
