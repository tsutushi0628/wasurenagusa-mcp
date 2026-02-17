import { describe, it, expect, vi, beforeEach } from "vitest";
import { PromptBuilder } from "./prompt-builder.js";
import type { SchedulerTask } from "../types.js";

// loadPromptをモック
vi.mock("../analyzer/prompt-loader.js", () => ({
  loadPrompt: vi.fn(),
}));

import { loadPrompt } from "../analyzer/prompt-loader.js";
const mockLoadPrompt = vi.mocked(loadPrompt);

function createTask(overrides?: Partial<SchedulerTask>): SchedulerTask {
  return {
    id: "test-task-id",
    type: "change-based",
    priority: 1,
    project: "my-project",
    projectPath: "/home/user/projects/my-project",
    specPaths: {
      steering: ".spec-workflow/steering",
      specs: [".spec-workflow/specs/feature-a", ".spec-workflow/specs/feature-b"],
    },
    changedFiles: ["src/index.ts", "src/utils.ts"],
    status: "pending",
    createdAt: "2026-02-14T10:00:00+09:00",
    ...overrides,
  };
}

describe("PromptBuilder", () => {
  let builder: PromptBuilder;

  beforeEach(() => {
    vi.clearAllMocks();
    builder = new PromptBuilder();
  });

  describe("buildChangeBasedPrompt", () => {
    it("変更ベースタスクから適切なプロンプト文字列を生成できる", async () => {
      const template = "Project: {project_name}, Path: {project_path}, Files: {changed_files}";
      mockLoadPrompt.mockResolvedValue(template);

      const task = createTask();
      const result = await builder.buildChangeBasedPrompt(task);

      expect(result).toContain("my-project");
      expect(result).toContain("/home/user/projects/my-project");
      expect(result).toContain("src/index.ts");
      expect(result).toContain("src/utils.ts");
      expect(mockLoadPrompt).toHaveBeenCalledWith("spec-update.txt");
    });

    it("テンプレート内の変数が正しく置換される", async () => {
      const template = [
        "プロジェクト: {project_name}",
        "パス: {project_path}",
        "変更ファイル:",
        "{changed_files}",
        "Steering: {steering_path}",
        "Specs: {specs_paths}",
      ].join("\n");
      mockLoadPrompt.mockResolvedValue(template);

      const task = createTask();
      const result = await builder.buildChangeBasedPrompt(task);

      expect(result).toContain("プロジェクト: my-project");
      expect(result).toContain("パス: /home/user/projects/my-project");
      expect(result).toContain("- src/index.ts");
      expect(result).toContain("- src/utils.ts");
      expect(result).toContain("Steering: .spec-workflow/steering");
      expect(result).toContain(
        "Specs: .spec-workflow/specs/feature-a, .spec-workflow/specs/feature-b"
      );
    });
  });

  describe("buildRotationPrompt", () => {
    it("ローテーションタスクから適切なプロンプト文字列を生成できる", async () => {
      const template = [
        "プロジェクト: {project_name}",
        "パス: {project_path}",
        "Steering: {steering_path}",
        "Specs: {specs_paths}",
      ].join("\n");
      mockLoadPrompt.mockResolvedValue(template);

      const task = createTask({ type: "rotation", changedFiles: undefined });
      const result = await builder.buildRotationPrompt(task);

      expect(result).toContain("プロジェクト: my-project");
      expect(result).toContain("パス: /home/user/projects/my-project");
      expect(result).toContain("Steering: .spec-workflow/steering");
      expect(result).toContain(
        "Specs: .spec-workflow/specs/feature-a, .spec-workflow/specs/feature-b"
      );
      expect(mockLoadPrompt).toHaveBeenCalledWith("spec-rotation.txt");
    });
  });

  describe("テンプレートファイルが存在しない場合", () => {
    it("デフォルトのプロンプトを返す", async () => {
      mockLoadPrompt.mockRejectedValue(new Error("ENOENT: no such file"));

      const task = createTask();
      const result = await builder.buildChangeBasedPrompt(task);

      expect(result).toBeTruthy();
      expect(result).toContain("my-project");
      expect(result).toContain("/home/user/projects/my-project");
    });

    it("ローテーションでもデフォルトのプロンプトを返す", async () => {
      mockLoadPrompt.mockRejectedValue(new Error("ENOENT: no such file"));

      const task = createTask({ type: "rotation" });
      const result = await builder.buildRotationPrompt(task);

      expect(result).toBeTruthy();
      expect(result).toContain("my-project");
    });
  });
});
