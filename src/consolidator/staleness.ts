import { readFile, writeFile, stat } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { config } from "../config.js";
import { ConsolidatedDont } from "../types.js";
import { parseMarkdown } from "../storage/parser.js";

export async function isConsolidationStale(memoryPath: string): Promise<boolean> {
  const dontPath = join(memoryPath, config.categoryFiles.dont);
  const consolidatedPath = join(memoryPath, config.consolidatedDontFile);

  if (!existsSync(dontPath)) return false;
  if (!existsSync(consolidatedPath)) return true;

  const [dontStat, consolidatedStat] = await Promise.all([
    stat(dontPath),
    stat(consolidatedPath),
  ]);

  if (dontStat.mtimeMs > consolidatedStat.mtimeMs) return true;

  const consolidated = await readConsolidatedDont(memoryPath);
  if (!consolidated) return true;

  const dontContent = await readFile(dontPath, "utf-8");
  const entries = parseMarkdown(dontContent, "dont");

  return entries.length !== consolidated.sourceEntryCount;
}

export async function readConsolidatedDont(memoryPath: string): Promise<ConsolidatedDont | null> {
  const consolidatedPath = join(memoryPath, config.consolidatedDontFile);
  if (!existsSync(consolidatedPath)) return null;

  try {
    const content = await readFile(consolidatedPath, "utf-8");
    return JSON.parse(content) as ConsolidatedDont;
  } catch {
    return null;
  }
}

export async function writeConsolidatedDont(memoryPath: string, data: ConsolidatedDont): Promise<void> {
  const consolidatedPath = join(memoryPath, config.consolidatedDontFile);
  await writeFile(consolidatedPath, JSON.stringify(data, null, 2), "utf-8");
}
