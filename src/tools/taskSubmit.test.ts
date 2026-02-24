import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

// SCHEDULER_DIRをモックで置換
let testSchedulerDir: string;
vi.mock("os", async () => {
  const actual = await vi.importActual("os");
  return {
    ...actual,
    homedir: () => testSchedulerDir,
  };
});

describe("handleTaskSubmit", () => {
  beforeEach(async () => {
    testSchedulerDir = await mkdtemp(join(tmpdir(), "wasurenagusa-tool-submit-"));
  });

  afterEach(async () => {
    await rm(testSchedulerDir, { recursive: true, force: true });
  });

  it("必須パラメータ欠落でエラーを返す", async () => {
    const { handleTaskSubmit } = await import("./taskSubmit.js");
    const result = await handleTaskSubmit({ why: "test", what: "test" });
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeDefined();
  });

  it("プロジェクトメタ未登録でエラーを返す", async () => {
    const { handleTaskSubmit } = await import("./taskSubmit.js");
    const result = await handleTaskSubmit({
      why: "テスト",
      what: "テストタスク",
      done: "テスト通過",
      project: "nonexistent-project",
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("メタ情報が見つかりません");
  });

  it("テンプレート文面がそのまま投入された場合にエラーを返す", async () => {
    const { handleTaskSubmit } = await import("./taskSubmit.js");
    const result = await handleTaskSubmit({
      why: "なぜやるか（背景・目的）",
      what: "何をやるか",
      done: "完了条件",
      project: "test-project",
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("テンプレート文面のまま");
  });

  it("テンプレートパターン「ここに」を含む場合にエラーを返す", async () => {
    const { handleTaskSubmit } = await import("./taskSubmit.js");
    const result = await handleTaskSubmit({
      why: "ここに背景を書く",
      what: "実装する",
      done: "テスト通過",
      project: "test-project",
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("テンプレート文面のまま");
  });

  it("具体的な内容が記入されていればテンプレートバリデーションを通過する", async () => {
    const { handleTaskSubmit } = await import("./taskSubmit.js");
    const result = await handleTaskSubmit({
      why: "ユーザー体験の改善のため",
      what: "ダッシュボードにグラフを追加",
      done: "vitest全パス",
      project: "nonexistent-project",
    });
    const parsed = JSON.parse(result);
    // テンプレバリデーションは通過し、プロジェクトメタ未登録エラーになる
    expect(parsed.error).toContain("メタ情報が見つかりません");
  });
});
