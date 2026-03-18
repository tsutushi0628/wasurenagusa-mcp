/**
 * ActiveProjectsTracker
 * 最近セッションを行ったプロジェクト上位N件を追跡する。
 * ファイルパス: ~/.wasurenagusa/scheduler/active-projects.json
 */

import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import type { ActiveProject, ActiveProjectsData } from "./types.js";

const DEFAULT_MAX_ACTIVE_PROJECTS = 5;
const FILE_NAME = "active-projects.json";

function nowJST(): string {
  return new Date().toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" }).replace(" ", "T") + "+09:00";
}

export class ActiveProjectsTracker {
  private filePath: string;

  constructor(schedulerDir: string) {
    this.filePath = join(schedulerDir, FILE_NAME);
  }

  async update(project: ActiveProject): Promise<void> {
    let data = await this.readData();

    // 既存エントリを除外（同名プロジェクトは置換するため）
    const filtered = data.projects.filter((p) => p.name !== project.name);

    // 新しいエントリを追加
    filtered.push(project);

    // lastSessionAt降順でソート
    filtered.sort((a, b) => {
      if (a.lastSessionAt > b.lastSessionAt) return -1;
      if (a.lastSessionAt < b.lastSessionAt) return 1;
      return 0;
    });

    // 上位N件のみ保持
    data.projects = filtered.slice(0, data.maxActiveProjects);
    data.updatedAt = nowJST();

    await writeFile(this.filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  async getActiveProjects(): Promise<ActiveProject[]> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const data: ActiveProjectsData = JSON.parse(raw);
      return data.projects;
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  async getOtherActiveProjects(currentProject: string): Promise<ActiveProject[]> {
    const projects = await this.getActiveProjects();
    return projects.filter((p) => p.name !== currentProject);
  }

  private async readData(): Promise<ActiveProjectsData> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      return JSON.parse(raw) as ActiveProjectsData;
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          projects: [],
          maxActiveProjects: DEFAULT_MAX_ACTIVE_PROJECTS,
          updatedAt: nowJST(),
        };
      }
      throw err;
    }
  }
}
