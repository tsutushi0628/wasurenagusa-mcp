import { readdir, stat } from "fs/promises";
import { join } from "path";
import type { ProjectEntry } from "../types.js";

/** ディレクトリスキャン時に除外するエントリ */
const EXCLUDED_ENTRIES = new Set([
  "node_modules",
  ".git",
  ".DS_Store",
  "logs",
  "docs",
  "scripts",
  "public",
  "dist",
  "build",
  ".cache",
  "prompts",
  "e2e",
]);

/**
 * ~/projects/ 配下のプロジェクトを自動検出する
 */
export class ProjectScanner {
  constructor(
    private projectsBaseDir: string,
    private subProjectParents: string[] = [],
  ) {}

  /**
   * プロジェクト一覧をスキャンして返す
   */
  async scanProjects(): Promise<ProjectEntry[]> {
    const entries: ProjectEntry[] = [];

    let topDirs: string[];
    try {
      topDirs = await this.listDirectories(this.projectsBaseDir);
    } catch {
      return [];
    }

    for (const dirName of topDirs) {
      if (this.subProjectParents.includes(dirName)) {
        // サブプロジェクト持ち親: 子ディレクトリを個別プロジェクトとして列挙
        const parentPath = join(this.projectsBaseDir, dirName);
        const subDirs = await this.listDirectories(parentPath);
        for (const subDir of subDirs) {
          entries.push({
            name: `${dirName}/${subDir}`,
            path: join(parentPath, subDir),
            type: "subproject",
          });
        }
      } else {
        // 通常プロジェクト
        entries.push({
          name: dirName,
          path: join(this.projectsBaseDir, dirName),
          type: "standalone",
        });
      }
    }

    // 名前順でソート
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  /**
   * プロジェクト名が有効かどうかチェックする
   */
  async validateProjectName(name: string): Promise<boolean> {
    const projects = await this.scanProjects();
    return projects.some((p) => p.name === name);
  }

  /**
   * プロジェクト名から絶対パスを解決する
   */
  async resolveProjectPath(name: string): Promise<string | null> {
    const projects = await this.scanProjects();
    const found = projects.find((p) => p.name === name);
    if (found) {
      return found.path;
    }
    return null;
  }

  /**
   * ディレクトリ内のサブディレクトリ名一覧を返す（除外リスト適用済み）
   */
  private async listDirectories(parentDir: string): Promise<string[]> {
    const result: string[] = [];

    let entries: string[];
    try {
      entries = await readdir(parentDir);
    } catch {
      return [];
    }

    for (const entry of entries) {
      // 隠しファイル・除外エントリをスキップ
      if (entry.startsWith(".") || EXCLUDED_ENTRIES.has(entry)) {
        continue;
      }

      try {
        const entryPath = join(parentDir, entry);
        const entryStat = await stat(entryPath);
        if (entryStat.isDirectory()) {
          // gitサブモジュールを除外（.gitがファイルならサブモジュール）
          const gitPath = join(entryPath, ".git");
          try {
            const gitStat = await stat(gitPath);
            if (gitStat.isFile()) {
              continue;
            }
          } catch {
            // .gitが存在しない場合はサブモジュールではない
          }
          result.push(entry);
        }
      } catch {
        // stat失敗は無視
      }
    }

    return result;
  }
}
