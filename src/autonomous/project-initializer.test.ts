import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { ProjectInitializer } from "./project-initializer.js";
import type { ProjectMeta } from "../types.js";

const mockGenerateText = vi.fn();
vi.mock("../llm/provider.js", () => ({
  createGenerateTextFn: vi.fn(() => mockGenerateText),
}));

vi.mock("../analyzer/prompt-loader.js", () => ({
  loadPrompt: vi.fn().mockResolvedValue("PROJECT: {project_name}\nINFO: {initial_info}"),
}));

describe("ProjectInitializer", () => {
  let schedulerDir: string;

  beforeEach(async () => {
    schedulerDir = await mkdtemp(join(tmpdir(), "wasurenagusa-projinit-"));
  });

  afterEach(async () => {
    await rm(schedulerDir, { recursive: true, force: true });
  });

  describe("generateQuestions()", () => {
    it("LLMで質問リストを生成する", async () => {
      mockGenerateText.mockResolvedValue(
        JSON.stringify({
          questions: [
            {
              key: "phase",
              question: "プロジェクトのフェーズは？",
              options: ["startup", "growth", "mature"],
            },
          ],
        }),
      );

      const initializer = new ProjectInitializer(schedulerDir);
      const result = await initializer.generateQuestions("test-project", "テスト情報");

      expect(result.questions).toBeDefined();
      expect(result.questions.length).toBe(1);
      expect(result.questions[0].key).toBe("phase");
    });

    it("不正なJSONでエラーを投げる", async () => {
      mockGenerateText.mockResolvedValue("これはJSONではない");

      const initializer = new ProjectInitializer(schedulerDir);
      await expect(
        initializer.generateQuestions("test-project"),
      ).rejects.toThrow("Failed to parse");
    });
  });

  describe("saveProjectMeta()", () => {
    it("回答からProjectMetaを保存する", async () => {
      const initializer = new ProjectInitializer(schedulerDir);
      const meta = await initializer.saveProjectMeta(
        "test-project",
        "/tmp/test-project",
        {
          phase: "growth",
          qualityPolicy: "quality_first",
          testExpectation: "comprehensive",
        },
      );

      expect(meta.project).toBe("test-project");
      expect(meta.projectPath).toBe("/tmp/test-project");
      expect(meta.phase).toBe("growth");
      expect(meta.qualityPolicy).toBe("quality_first");
      expect(meta.createdAt).toBeDefined();
    });

    it("未指定のフィールドはデフォルト値が使われる", async () => {
      const initializer = new ProjectInitializer(schedulerDir);
      const meta = await initializer.saveProjectMeta(
        "test-project",
        "/tmp/test-project",
        {},
      );

      expect(meta.phase).toBe("startup");
      expect(meta.qualityPolicy).toBe("balanced");
      expect(meta.aiAutonomy).toBe("moderate");
    });
  });

  describe("loadProjectMeta()", () => {
    it("保存したmetaを読み込める", async () => {
      const initializer = new ProjectInitializer(schedulerDir);
      await initializer.saveProjectMeta("test-project", "/tmp/test-project", {
        phase: "mature",
      });

      const loaded = await initializer.loadProjectMeta("test-project");
      expect(loaded).not.toBeNull();
      expect(loaded!.phase).toBe("mature");
    });

    it("存在しないプロジェクトにはnullを返す", async () => {
      const initializer = new ProjectInitializer(schedulerDir);
      const loaded = await initializer.loadProjectMeta("nonexistent");
      expect(loaded).toBeNull();
    });
  });

  describe("loadProjectMetaOrDefault()", () => {
    it("meta.jsonが存在しない場合、デフォルト値を返す", async () => {
      const initializer = new ProjectInitializer(schedulerDir);
      const meta = await initializer.loadProjectMetaOrDefault("new-project", "/tmp/new");

      expect(meta.project).toBe("new-project");
      expect(meta.projectPath).toBe("/tmp/new");
      expect(meta.phase).toBe("startup");
    });

    it("meta.jsonが存在する場合、保存値を返す", async () => {
      const initializer = new ProjectInitializer(schedulerDir);
      await initializer.saveProjectMeta("existing", "/tmp/existing", { phase: "growth" });

      const meta = await initializer.loadProjectMetaOrDefault("existing", "/tmp/fallback");
      expect(meta.phase).toBe("growth");
      expect(meta.projectPath).toBe("/tmp/existing"); // 保存時のpathが使われる
    });
  });

  describe("updateProjectMeta()", () => {
    it("既存のmetaを部分更新する", async () => {
      const initializer = new ProjectInitializer(schedulerDir);
      await initializer.saveProjectMeta("test-project", "/tmp/test", { phase: "startup" });

      const updated = await initializer.updateProjectMeta("test-project", {
        phase: "growth",
        qualityPolicy: "quality_first",
      });

      expect(updated.phase).toBe("growth");
      expect(updated.qualityPolicy).toBe("quality_first");
      expect(updated.project).toBe("test-project"); // 変更不可
      expect(updated.updatedAt).not.toBe(updated.createdAt);
    });

    it("存在しないプロジェクトでエラーを投げる", async () => {
      const initializer = new ProjectInitializer(schedulerDir);
      await expect(
        initializer.updateProjectMeta("nonexistent", { phase: "growth" }),
      ).rejects.toThrow("Project meta not found");
    });
  });
});
