import { mkdir, readFile, writeFile, readdir, unlink } from "fs/promises";
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
import { buildSearchHint } from "./search-hint.js";

export class MarkdownStorage {
  private memoryPath: string;

  constructor(projectRoot: string) {
    this.memoryPath = getMemoryPath(projectRoot);
  }

  private generateId(): string {
    const timestamp = Date.now().toString(36);
    // randomBytes(2)（16bit）だと同一ミリ秒内のバースト書き込みで誕生日問題により
    // ID衝突が発生し得た。operation-logger.tsのID生成と同じrandomBytes(4)（32bit）に揃える。
    const random = randomBytes(4).toString("hex");
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

    await this.rotateOldLogs();
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
      if (params.intensity !== undefined) { entry.intensity = params.intensity; }

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

      // ログ以外のカテゴリでエントリ上限チェック → 超過分を自動アーカイブ
      if (params.category !== "log") {
        const archivedCount = await this.archiveExcessEntries(params.category);
        if (archivedCount > 0) {
          return { success: true, id, path: filePath, message: `Saved to ${params.category} (id: ${id}). ${archivedCount}件の古いエントリをアーカイブしました` };
        }
      }

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
      project: entry.project, scope: entry.scope, intensity: entry.intensity,
    }));

    return {
      results: indexEntries,
      totalCount: filtered.length,
      hint: buildSearchHint(indexEntries.length),
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

    // configエントリ: projectフィルタ後に重複排除してタイトル+内容を返却
    const configEntries = await this.readCategory("config");
    const filteredConfig = currentProject
      ? configEntries.filter(e => !e.project || e.project === currentProject)
      : configEntries;
    const dedupedConfig = this.deduplicateConfigEntries(filteredConfig);
    const configFormatted = dedupedConfig
      .map(e => `### ${e.title}\n${e.content}`)
      .join("\n\n");

    // dontエントリ: projectフィルタ後に全件の内容を返却
    const dontEntries = await this.readCategory("dont");
    const filteredDont = currentProject
      ? dontEntries.filter(e => !e.project || e.project === currentProject)
      : dontEntries;
    const dontFormatted = filteredDont.map(e => formatEntry(e)).join("");

    return {
      config: configFormatted || "（設定情報なし）",
      dont: dontFormatted || "（ルールなし）",
    };
  }

  async readConfigEntries(currentProject?: string): Promise<MemoryEntry[]> {
    await this.initialize();
    const configEntries = await this.readCategory("config");
    return currentProject
      ? configEntries.filter(e => !e.project || e.project === currentProject)
      : configEntries;
  }

  async readDontEntries(currentProject?: string): Promise<MemoryEntry[]> {
    await this.initialize();
    const dontEntries = await this.readCategory("dont");

    // dont-archive.md（過去にローテーションされたエントリ）も統合対象に含める。
    // 高強度の古エントリがアーカイブに sleep していると consolidator が見落とすため。
    const archivePath = join(this.memoryPath, "dont-archive.md");
    let archiveEntries: MemoryEntry[] = [];
    if (existsSync(archivePath)) {
      try {
        const archiveContent = await readFile(archivePath, "utf-8");
        archiveEntries = parseMarkdown(archiveContent, "dont");
      } catch {
        archiveEntries = [];
      }
    }

    // ID 重複排除（active と archive 両方に同じ ID があった場合は active を優先）
    const seenIds = new Set<string>(dontEntries.map(e => e.id));
    const merged = [...dontEntries];
    for (const e of archiveEntries) {
      if (!seenIds.has(e.id)) {
        seenIds.add(e.id);
        merged.push(e);
      }
    }

    return currentProject
      ? merged.filter(e => !e.project || e.project === currentProject)
      : merged;
  }

  async updateIntensity(id: string, intensity: number): Promise<{ success: boolean; id: string; category: MemoryCategory }> {
    await this.initialize();

    const categories: MemoryCategory[] = ["config", "dont", "decision", "log", "snippet"];

    for (const category of categories) {
      const entries = await this.readCategory(category);
      const targetIndex = entries.findIndex(e => e.id === id);
      if (targetIndex === -1) { continue; }

      // intensityを更新
      entries[targetIndex].intensity = intensity;

      // ファイルを再構築
      if (category === "log") {
        const date = entries[targetIndex].timestamp.split("T")[0];
        const filePath = join(this.memoryPath, "logs", `${date}.md`);
        const header = `# Log: ${date}\n\n---\n\n`;
        // 同じ日付のエントリだけで再構築
        const sameDateEntries = entries.filter(e => e.timestamp.split("T")[0] === date);
        const body = sameDateEntries.map(e => formatEntry(e)).join("");
        await writeFile(filePath, header + body, "utf-8");
      } else {
        const filePath = join(this.memoryPath, config.categoryFiles[category]);
        const header = getFileHeader(config.categoryFiles[category]);
        const body = entries.map(e => formatEntry(e)).join("");
        await writeFile(filePath, header + body, "utf-8");
      }

      return { success: true, id, category };
    }

    throw new Error(`Entry not found: ${id}`);
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
      const seenIds = new Set<string>();
      for (const file of files) {
        if (file.endsWith(".md")) {
          const content = await readFile(join(logsPath, file), "utf-8");
          for (const entry of parseMarkdown(content, category)) {
            if (!seenIds.has(entry.id)) {
              seenIds.add(entry.id);
              entries.push(entry);
            }
          }
        }
      }
      return entries;
    }
    const filePath = join(this.memoryPath, config.categoryFiles[category]);
    if (!existsSync(filePath)) { return []; }
    const content = await readFile(filePath, "utf-8");
    const entries = parseMarkdown(content, category);
    // 同一ファイル内の重複も排除
    const seenIds = new Set<string>();
    return entries.filter(e => {
      if (seenIds.has(e.id)) { return false; }
      seenIds.add(e.id);
      return true;
    });
  }

  private async rotateOldLogs(): Promise<void> {
    const logsPath = join(this.memoryPath, "logs");
    if (!existsSync(logsPath)) { return; }

    const retentionDays = config.logRetentionDays;
    if (retentionDays <= 0) { return; }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const cutoffStr = cutoff.toISOString().split("T")[0];

    const files = await readdir(logsPath);
    for (const file of files) {
      if (!file.endsWith(".md")) { continue; }
      const dateStr = file.replace(".md", "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) { continue; }
      if (dateStr < cutoffStr) {
        await unlink(join(logsPath, file));
      }
    }
  }

  private async archiveExcessEntries(category: MemoryCategory): Promise<number> {
    const maxEntries = config.maxEntriesPerCategory;
    if (maxEntries <= 0) { return 0; }

    const entries = await this.readCategory(category);
    if (entries.length <= maxEntries) { return 0; }

    // ファイル内の出現順（＝挿入順）を保持。末尾がmost recent
    // 古い方（先頭）をアーカイブし、新しい方（末尾）を残す
    const archiveCount = entries.length - maxEntries;
    const archive = entries.slice(0, archiveCount);
    const keep = entries.slice(archiveCount);

    // メインファイルを新しいエントリだけで再構築
    const mainFile = join(this.memoryPath, config.categoryFiles[category]);
    const header = getFileHeader(config.categoryFiles[category]);
    const mainBody = keep.map(e => formatEntry(e)).join("");
    await writeFile(mainFile, header + mainBody, "utf-8");

    // アーカイブファイルに追記
    const archiveFile = join(this.memoryPath, `${config.categoryFiles[category].replace(".md", "")}-archive.md`);
    let archiveContent = "";
    if (existsSync(archiveFile)) {
      archiveContent = await readFile(archiveFile, "utf-8");
    } else {
      archiveContent = `# ${category} Archive\n\n自動アーカイブされたエントリ。検索対象外。\n\n---\n\n`;
    }
    const archiveBody = archive.map(e => formatEntry(e)).join("");
    await writeFile(archiveFile, archiveContent + archiveBody, "utf-8");

    return archive.length;
  }

  private validateDateFormat(date: string): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`Invalid date format in timestamp: ${date}`);
    }
  }

  private getFilePath(category: MemoryCategory, timestamp: string): string {
    if (category === "log") {
      const date = timestamp.split("T")[0];
      this.validateDateFormat(date);
      return join(this.memoryPath, "logs", `${date}.md`);
    }
    return join(this.memoryPath, config.categoryFiles[category]);
  }

  /**
   * configエントリの注入時重複排除。
   * タイトルのトークン重複率が50%以上の場合、古い方を除外して新しい方を残す。
   */
  deduplicateConfigEntries(entries: MemoryEntry[]): MemoryEntry[] {
    if (entries.length <= 1) return entries;

    // 新しい順にソート（最新を優先して残す）
    // 同一タイムスタンプ時は挿入順の後（index大）を優先
    const indexed = entries.map((e, i) => ({ entry: e, index: i }));
    indexed.sort((a, b) => {
      const timeDiff = new Date(b.entry.timestamp).getTime() - new Date(a.entry.timestamp).getTime();
      return timeDiff !== 0 ? timeDiff : b.index - a.index;
    });
    const sorted = indexed.map(item => item.entry);

    const kept: MemoryEntry[] = [];

    for (const entry of sorted) {
      const entryTokens = this.extractTitleTokens(entry.title);
      const entryFacts = this.extractContentFacts(entry.content);

      const isDuplicate = kept.some(k => {
        // チェック1: タイトルトークン重複（2つ以上かつ50%以上）
        const keptTokens = this.extractTitleTokens(k.title);
        const titleOverlap = entryTokens.filter(t => keptTokens.includes(t));
        if (entryTokens.length > 0
          && titleOverlap.length >= 2
          && titleOverlap.length >= entryTokens.length * 0.5) {
          return true;
        }

        // チェック2: コンテンツ事実（ポート番号・パス等）の包含チェック
        // このエントリの事実が既に残されたエントリにほぼ含まれていれば冗長
        if (entryFacts.length >= 2) {
          const covered = entryFacts.filter(f => k.content.includes(f));
          if (covered.length >= entryFacts.length * 0.7) {
            return true;
          }
        }

        return false;
      });

      if (!isDuplicate) {
        kept.push(entry);
      }
    }

    return kept;
  }

  /**
   * コンテンツから検証可能な「事実」を抽出する。
   * ポート番号（4-5桁）、ファイルパス（2セグメント以上）を対象とする。
   */
  private extractContentFacts(content: string): string[] {
    const facts: string[] = [];
    // ポート番号（4-5桁の数字、前後が単語境界）
    const ports = content.match(/\b\d{4,5}\b/g);
    if (ports) facts.push(...ports);
    // ファイルパス（2セグメント以上）
    const paths = content.match(/(?:\/[\w.-]+){2,}/g);
    if (paths) facts.push(...paths);
    return facts;
  }

  /**
   * タイトルから検索用トークンを抽出。
   * 漢字は2文字ずつのbigramに分割し、カタカナ・英数字はそのまま抽出する。
   * 「技術設定」→ ["技術", "設定"] のように分割することで、
   * 「設定」単体との一致検出を可能にする。
   */
  private extractTitleTokens(title: string): string[] {
    const tokens: string[] = [];
    // 漢字の連続を2文字bigramに分割
    const kanjiSequences = title.match(/[\u4E00-\u9FFF]{2,}/g);
    if (kanjiSequences) {
      for (const seq of kanjiSequences) {
        for (let i = 0; i + 1 < seq.length; i += 2) {
          tokens.push(seq.substring(i, i + 2));
        }
      }
    }
    // カタカナの連続（2文字以上）
    const kata = title.match(/[\u30A0-\u30FF]{2,}/g);
    if (kata) tokens.push(...kata);
    // 英数字の連続（2文字以上、ハイフン含む）
    const en = title.match(/[a-zA-Z0-9][-a-zA-Z0-9]{1,}/g);
    if (en) tokens.push(...en.map(t => t.toLowerCase()));
    return tokens;
  }
}
