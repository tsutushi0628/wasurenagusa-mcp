import { execFile } from "child_process";
import { readFile, writeFile, access, readdir, mkdir } from "fs/promises";
import { join, basename } from "path";
import { ChangeLogEntry, SpecPaths } from "../types.js";

export class ChangeLogger {
  private changeLogPath: string;

  constructor(schedulerDir: string) {
    this.changeLogPath = join(schedulerDir, "change-log.json");
  }

  /**
   * git diffで変更ファイルを検出し、change-log.jsonに追記
   * 変更なしならnullを返す
   */
  async recordChanges(projectPath: string): Promise<ChangeLogEntry | null> {
    // .gitディレクトリの存在確認
    const hasGit = await this.exists(join(projectPath, ".git"));
    if (!hasGit) {
      return null;
    }

    // 変更ファイルを取得
    let changedFiles: string[];
    try {
      const diffOutput = await this.execGit(["diff", "HEAD", "--name-only"], projectPath);
      changedFiles = this.parseFileList(diffOutput);
    } catch {
      // git diff失敗時はgit status --porcelainにフォールバック
      const statusOutput = await this.execGit(["status", "--porcelain"], projectPath);
      changedFiles = this.parsePorcelainOutput(statusOutput);
    }

    // 変更なし
    if (changedFiles.length === 0) {
      return null;
    }

    // SpecPathsを検出
    const specPaths = await this.detectSpecPaths(projectPath);

    const entry: ChangeLogEntry = {
      timestamp: new Date().toLocaleString("ja-JP", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).replace(/(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})/, "$1-$2-$3T$4:$5:$6+09:00"),
      project: basename(projectPath),
      projectPath,
      changedFiles,
      specPaths,
    };

    // 既存エントリを読み込み、追記
    const entries = await this.getEntries();
    entries.push(entry);
    await this.writeEntries(entries);

    return entry;
  }

  /**
   * 全変更ログエントリを取得
   */
  async getEntries(): Promise<ChangeLogEntry[]> {
    try {
      const content = await readFile(this.changeLogPath, "utf-8");
      return JSON.parse(content) as ChangeLogEntry[];
    } catch {
      return [];
    }
  }

  /**
   * 指定タイムスタンプのエントリを消費済みにする（配列から除去）
   */
  async consumeEntry(timestamp: string): Promise<void> {
    const entries = await this.getEntries();
    const filtered = entries.filter((e) => e.timestamp !== timestamp);
    await this.writeEntries(filtered);
  }

  /**
   * git コマンド実行（テストでモック可能）
   */
  private execGit(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile("git", args, { cwd }, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      });
    });
  }

  /**
   * git diff --name-only の出力をパース
   */
  private parseFileList(output: string): string[] {
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  /**
   * git status --porcelain の出力をパース（先頭3文字を除去）
   */
  private parsePorcelainOutput(output: string): string[] {
    return output
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter((line) => line.length > 0);
  }

  /**
   * SpecPaths検出
   */
  private async detectSpecPaths(projectPath: string): Promise<SpecPaths> {
    const steeringDir = join(projectPath, ".spec-workflow", "steering");
    const specsDir = join(projectPath, ".spec-workflow", "specs");

    const hasSteering = await this.exists(steeringDir);
    const steering = hasSteering ? steeringDir : "";

    let specs: string[] = [];
    const hasSpecs = await this.exists(specsDir);
    if (hasSpecs) {
      const entries = await readdir(specsDir, { withFileTypes: true });
      specs = entries
        .filter((e) => e.isDirectory())
        .map((e) => join(specsDir, e.name));
    }

    return { steering, specs };
  }

  /**
   * パスの存在確認
   */
  private async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * エントリをファイルに書き込み
   */
  private async writeEntries(entries: ChangeLogEntry[]): Promise<void> {
    await writeFile(this.changeLogPath, JSON.stringify(entries, null, 2));
  }
}
