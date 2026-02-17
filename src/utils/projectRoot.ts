import { existsSync } from "fs";
import { dirname, join, resolve } from "path";

/**
 * .git ディレクトリを上位に向かって探索し、プロジェクトルートを特定する。
 * 見つからない場合はstartDir（指定時）またはprocess.cwd()にフォールバック。
 */
export function findProjectRoot(startDir?: string): string {
  const resolvedStart = startDir ? resolve(startDir) : process.cwd();
  let currentDir = resolvedStart;
  const root = resolve("/");

  while (currentDir !== root) {
    const gitPath = join(currentDir, ".git");
    if (existsSync(gitPath)) {
      return currentDir;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  // .gitが見つからない場合はstartDirにフォールバック（CWDに依存しない）
  return resolvedStart;
}
