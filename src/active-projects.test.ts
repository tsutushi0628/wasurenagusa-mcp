import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { ActiveProjectsTracker } from "./active-projects.js";
import type { ActiveProject, ActiveProjectsData } from "./types.js";

describe("ActiveProjectsTracker", () => {
  let schedulerDir: string;

  beforeEach(async () => {
    schedulerDir = await mkdtemp(join(tmpdir(), "wasurenagusa-active-projects-"));
  });

  afterEach(async () => {
    await rm(schedulerDir, { recursive: true, force: true });
  });

  function makeProject(name: string, lastSessionAt: string): ActiveProject {
    return {
      name,
      path: `/Users/test/projects/${name}`,
      lastSessionAt,
      sessionTopic: `${name}の作業`,
    };
  }

  describe("update()", () => {
    it("新しいプロジェクトを追加できる", async () => {
      const tracker = new ActiveProjectsTracker(schedulerDir);
      const project = makeProject("my-app", "2026-03-18T10:00:00+09:00");

      await tracker.update(project);

      const raw = await readFile(join(schedulerDir, "active-projects.json"), "utf-8");
      const data: ActiveProjectsData = JSON.parse(raw);
      expect(data.projects).toHaveLength(1);
      expect(data.projects[0].name).toBe("my-app");
      expect(data.maxActiveProjects).toBe(5);
    });

    it("同名プロジェクトが既存の場合は置換する", async () => {
      const tracker = new ActiveProjectsTracker(schedulerDir);
      const v1 = makeProject("my-app", "2026-03-18T10:00:00+09:00");
      v1.sessionTopic = "初回セッション";
      await tracker.update(v1);

      const v2 = makeProject("my-app", "2026-03-18T12:00:00+09:00");
      v2.sessionTopic = "2回目セッション";
      await tracker.update(v2);

      const projects = await tracker.getActiveProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0].sessionTopic).toBe("2回目セッション");
      expect(projects[0].lastSessionAt).toBe("2026-03-18T12:00:00+09:00");
    });

    it("maxActiveProjects（5件）を超えると古いものが削除される", async () => {
      const tracker = new ActiveProjectsTracker(schedulerDir);

      // 6件追加
      for (let i = 0; i < 6; i++) {
        const hour = String(i + 10).padStart(2, "0");
        await tracker.update(makeProject(`project-${i}`, `2026-03-18T${hour}:00:00+09:00`));
      }

      const projects = await tracker.getActiveProjects();
      expect(projects).toHaveLength(5);
      // 最も古い project-0（10:00）が除外されているはず
      const names = projects.map((p) => p.name);
      expect(names).not.toContain("project-0");
      expect(names).toContain("project-5");
    });

    it("lastSessionAt降順でソートされる", async () => {
      const tracker = new ActiveProjectsTracker(schedulerDir);

      // 意図的に時系列をバラバラに追加
      await tracker.update(makeProject("old", "2026-03-18T08:00:00+09:00"));
      await tracker.update(makeProject("newest", "2026-03-18T18:00:00+09:00"));
      await tracker.update(makeProject("middle", "2026-03-18T12:00:00+09:00"));

      const projects = await tracker.getActiveProjects();
      expect(projects[0].name).toBe("newest");
      expect(projects[1].name).toBe("middle");
      expect(projects[2].name).toBe("old");
    });
  });

  describe("getActiveProjects()", () => {
    it("ファイルが存在しない場合は空配列を返す", async () => {
      const tracker = new ActiveProjectsTracker(schedulerDir);
      const projects = await tracker.getActiveProjects();
      expect(projects).toEqual([]);
    });

    it("既存ファイルを正しく読み込める", async () => {
      const data: ActiveProjectsData = {
        projects: [
          makeProject("app-a", "2026-03-18T15:00:00+09:00"),
          makeProject("app-b", "2026-03-18T14:00:00+09:00"),
        ],
        maxActiveProjects: 5,
        updatedAt: "2026-03-18T15:00:00+09:00",
      };
      await writeFile(join(schedulerDir, "active-projects.json"), JSON.stringify(data), "utf-8");

      const tracker = new ActiveProjectsTracker(schedulerDir);
      const projects = await tracker.getActiveProjects();
      expect(projects).toHaveLength(2);
      expect(projects[0].name).toBe("app-a");
      expect(projects[1].name).toBe("app-b");
    });
  });

  describe("getOtherActiveProjects()", () => {
    it("指定したプロジェクトを除外して返す", async () => {
      const tracker = new ActiveProjectsTracker(schedulerDir);

      await tracker.update(makeProject("current", "2026-03-18T18:00:00+09:00"));
      await tracker.update(makeProject("other-a", "2026-03-18T17:00:00+09:00"));
      await tracker.update(makeProject("other-b", "2026-03-18T16:00:00+09:00"));

      const others = await tracker.getOtherActiveProjects("current");
      expect(others).toHaveLength(2);
      const names = others.map((p) => p.name);
      expect(names).not.toContain("current");
      expect(names).toContain("other-a");
      expect(names).toContain("other-b");
    });
  });
});
