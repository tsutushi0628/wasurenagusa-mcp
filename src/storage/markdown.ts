import { mkdir, readFile, writeFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import {
  MemoryCategory,
  MemoryEntry,
  MemoryIndexEntry,
  SaveParams,
  SaveResult,
  SearchParams,
  SearchResult,
  GetDetailParams,
  GetDetailResult,
  DeleteParams,
  DeleteResult,
  ContextResult
} from "../types.js";
import { config, getMemoryPath } from "../config.js";
import { parseMarkdown } from "./parser.js";
import { formatEntry, getFileHeader } from "./formatter.js";

export class MarkdownStorage {
  private memoryPath: string;

  constructor(projectRoot: string) {
    this.memoryPath = getMemoryPath(projectRoot);
  }

  private generateId(): string {
    const timestamp = Date.now().toString(36);
    const random = randomBytes(2).toString("hex");
    return `${timestamp}-${random}`;
  }

  async initialize(): Promise<void> {
    if (!existsSync(this.memoryPath)) {
      await mkdir(this.memoryPath, { recursive: true });
    }

    const logsPath = join(this.memoryPath, "logs");
    if (!existsSync(logsPath)) {
      await mkdir(logsPath, { recursive: true });
    }

    const files = ["config.md", "dont.md", "decisions.md", "snippets.md"];
    for (const file of files) {
      const filePath = join(this.memoryPath, file);
      if (!existsSync(filePath)) {
        const header = getFileHeader(file);
        await writeFile(filePath, header, "utf-8");
      }
    }
  }

  async save(params: SaveParams): Promise<SaveResult> {
    try {
      await this.initialize();

      const id = this.generateId();
      const now = new Date();
      const jstOffset = 9 * 60 * 60 * 1000;
      const jst = new Date(now.getTime() + jstOffset);
      const timestamp = jst.toISOString().replace("Z", "+09:00");
      const entry: MemoryEntry = {
        id,
        timestamp,
        category: params.category,
        content: params.content,
        title: params.title,
        tags: params.tags || [],
      };
      if (params.project) { entry.project = params.project; }
      if (params.scope) { entry.scope = params.scope; }

      const filePath = this.getFilePath(params.category, timestamp);

      // replaceId指定時: 既存エントリを置換
      if (params.replaceId) {
        const replaced = await this.replaceEntry(params.category, params.replaceId, entry);
        if (replaced) {
          return { success: true, id, path: filePath, message: `Replaced ${params.replaceId} in ${params.category} (new id: ${id})` };
        }
        // 置換対象が見つからなければ新規追加にフォールバック
      }

      const formatted = formatEntry(entry);

      let existingContent = "";
      if (existsSync(filePath)) {
        existingContent = await readFile(filePath, "utf-8");
      } else if (params.category === "log") {
        existingContent = `# Log: ${timestamp.split("T")[0]}\n\n---\n\n`;
      }

      await writeFile(filePath, existingContent + formatted, "utf-8");

      return { success: true, id, path: filePath, message: `Saved to ${params.category} (id: ${id})` };
    } catch (error) {
      return { success: false, id: "", path: "", message: `Failed to save: ${error}` };
    }
  }

  async search(params: SearchParams): Promise<SearchResult> {
    await this.initialize();

    const categories: MemoryCategory[] =
      params.category === "all" || !params.category
        ? ["config", "dont", "decision", "log", "snippet"]
        : [params.category];

    const allEntries: MemoryEntry[] = [];
    for (const category of categories) {
      const entries = await this.readCategory(category);
      allEntries.push(...entries);
    }

    const query = params.query.toLowerCase();
    let filtered = allEntries.filter(entry =>
      entry.title.toLowerCase().includes(query) ||
      entry.content.toLowerCase().includes(query) ||
      entry.tags.some(tag => tag.toLowerCase().includes(query))
    );

    // projectフィルタ: 指定プロジェクト + project未指定エントリ
    if (params.project) {
      filtered = filtered.filter(entry =>
        !entry.project || entry.project === params.project
      );
    }

    // scopeフィルタ: 指定scope + general + scope未指定エントリ
    if (params.scope) {
      filtered = filtered.filter(entry =>
        !entry.scope || entry.scope === "general" || entry.scope === params.scope
      );
    }

    filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const limit = params.limit || config.defaultSearchLimit;
    const limited = filtered.slice(0, limit);

    const indexEntries: MemoryIndexEntry[] = limited.map(entry => ({
      id: entry.id, timestamp: entry.timestamp, category: entry.category, title: entry.title, tags: entry.tags,
      project: entry.project, scope: entry.scope,
    }));

    return {
      results: indexEntries,
      totalCount: filtered.length,
      hint: indexEntries.length > 0
        ? "詳細が必要なエントリのIDを memory_get_detail に渡してください。"
        : "該当するメモリが見つかりませんでした。"
    };
  }

  async getDetail(params: GetDetailParams): Promise<GetDetailResult> {
    await this.initialize();

    const allCategories: MemoryCategory[] = ["config", "dont", "decision", "log", "snippet"];
    const allEntries: MemoryEntry[] = [];
    for (const category of allCategories) {
      const entries = await this.readCategory(category);
      allEntries.push(...entries);
    }

    const entryMap = new Map(allEntries.map(e => [e.id, e]));
    const found: MemoryEntry[] = [];
    const notFound: string[] = [];

    for (const id of params.ids) {
      const entry = entryMap.get(id);
      if (entry) { found.push(entry); } else { notFound.push(id); }
    }

    return { entries: found, notFound };
  }

  async delete(params: DeleteParams): Promise<DeleteResult> {
    await this.initialize();

    const idsToDelete = new Set(params.ids);
    const deleted: string[] = [];
    const categories: MemoryCategory[] = ["config", "dont", "decision", "log", "snippet"];

    for (const category of categories) {
      const entries = await this.readCategory(category);
      const before = entries.length;
      const remaining = entries.filter(e => !idsToDelete.has(e.id));
      const removedCount = before - remaining.length;

      if (removedCount > 0) {
        // 削除されたIDを記録
        for (const entry of entries) {
          if (idsToDelete.has(entry.id)) {
            deleted.push(entry.id);
          }
        }

        // ファイルを再構築
        if (category === "log") {
          // logはファイルごとに再構築
          const byDate = new Map<string, MemoryEntry[]>();
          for (const entry of remaining) {
            const date = entry.timestamp.split("T")[0];
            if (!byDate.has(date)) { byDate.set(date, []); }
            byDate.get(date)!.push(entry);
          }
          // 元のエントリの日付も処理（空になったファイルも再構築）
          for (const entry of entries) {
            if (idsToDelete.has(entry.id)) {
              const date = entry.timestamp.split("T")[0];
              if (!byDate.has(date)) { byDate.set(date, []); }
            }
          }
          for (const [date, dateEntries] of byDate) {
            const filePath = join(this.memoryPath, "logs", `${date}.md`);
            const header = `# Log: ${date}\n\n---\n\n`;
            const body = dateEntries.map(e => formatEntry(e)).join("");
            await writeFile(filePath, header + body, "utf-8");
          }
        } else {
          const filePath = join(this.memoryPath, config.categoryFiles[category]);
          const header = getFileHeader(config.categoryFiles[category]);
          const body = remaining.map(e => formatEntry(e)).join("");
          await writeFile(filePath, header + body, "utf-8");
        }
      }
    }

    const notFound = params.ids.filter(id => !deleted.includes(id));

    return { deleted, notFound };
  }

  async getContext(currentProject?: string): Promise<ContextResult> {
    await this.initialize();

    // configエントリ: projectフィルタ後にタイトル一覧のみ返却
    const configEntries = await this.readCategory("config");
    const filteredConfig = currentProject
      ? configEntries.filter(e => !e.project || e.project === currentProject)
      : configEntries;
    const configTitles = filteredConfig
      .map(e => `- ${e.title} (id: ${e.id})`)
      .join("\n");

    // dontエントリ: projectフィルタ後に全件の内容を返却
    const dontEntries = await this.readCategory("dont");
    const filteredDont = currentProject
      ? dontEntries.filter(e => !e.project || e.project === currentProject)
      : dontEntries;
    const dontFormatted = filteredDont.map(e => formatEntry(e)).join("");

    return {
      config: configTitles || "（設定情報なし）",
      dont: dontFormatted || "（ルールなし）",
    };
  }

  async readDontEntries(currentProject?: string): Promise<MemoryEntry[]> {
    await this.initialize();
    const dontEntries = await this.readCategory("dont");
    return currentProject
      ? dontEntries.filter(e => !e.project || e.project === currentProject)
      : dontEntries;
  }

  private async replaceEntry(category: MemoryCategory, targetId: string, newEntry: MemoryEntry): Promise<boolean> {
    const entries = await this.readCategory(category);
    const targetIndex = entries.findIndex(e => e.id === targetId);
    if (targetIndex === -1) { return false; }

    // 既存エントリを新しいエントリで置換
    entries[targetIndex] = newEntry;

    // ファイルを再構築
    const filePath = category === "log"
      ? join(this.memoryPath, "logs", `${entries[targetIndex].timestamp.split("T")[0]}.md`)
      : join(this.memoryPath, config.categoryFiles[category]);

    const header = getFileHeader(config.categoryFiles[category]);
    const body = entries.map(e => formatEntry(e)).join("");
    await writeFile(filePath, header + body, "utf-8");

    return true;
  }

  private async readFileIfExists(filePath: string): Promise<string> {
    return existsSync(filePath) ? await readFile(filePath, "utf-8") : "";
  }

  private async readCategory(category: MemoryCategory): Promise<MemoryEntry[]> {
    if (category === "log") {
      const logsPath = join(this.memoryPath, "logs");
      if (!existsSync(logsPath)) { return []; }
      const files = await readdir(logsPath);
      const entries: MemoryEntry[] = [];
      for (const file of files) {
        if (file.endsWith(".md")) {
          const content = await readFile(join(logsPath, file), "utf-8");
          entries.push(...parseMarkdown(content, category));
        }
      }
      return entries;
    }
    const filePath = join(this.memoryPath, config.categoryFiles[category]);
    if (!existsSync(filePath)) { return []; }
    const content = await readFile(filePath, "utf-8");
    return parseMarkdown(content, category);
  }

  private getFilePath(category: MemoryCategory, timestamp: string): string {
    if (category === "log") {
      const date = timestamp.split("T")[0];
      return join(this.memoryPath, "logs", `${date}.md`);
    }
    return join(this.memoryPath, config.categoryFiles[category]);
  }
}
