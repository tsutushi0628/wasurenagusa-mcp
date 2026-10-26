#!/usr/bin/env node
/**
 * wasurenagusa-rules: 明示規則の CLI。
 *   inject-sub --project P --query "依頼文"   サブ・Codex 招聘向けの規則文（ID なし）
 *   import-rulings <rulings.json> [--apply]    旧指摘リストの取り込み（既定 dry-run）
 *   record --rule R --scene S [--quote Q] [--project P]
 *   list [--project P]
 */
import { readFileSync } from "fs";
import { basename, join } from "path";
import { SQLiteStorage } from "../storage/sqlite.js";
import { config, getMemoryPath } from "../config.js";
import { countExplicitRules, recordExplicitRule, renderRulesForSubagent, findExplicitRules } from "../corrections/explicit.js";
import { findProjectRoot } from "../utils/projectRoot.js";
import { isDirectRun } from "../utils/cli-entry.js";

function parseArgs(argv: string[]): { command: string; positional: string[]; flags: Record<string, string | true> } {
  const [command = "", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument.startsWith("--")) {
      const key = argument.slice(2);
      const next = rest[index + 1];
      if (next !== undefined && !next.startsWith("--")) { flags[key] = next; index += 1; } else flags[key] = true;
    } else positional.push(argument);
  }
  return { command, positional, flags };
}

function flag(flags: Record<string, string | true>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

function openStorage(): { storage: SQLiteStorage; project: string } {
  const projectRoot = findProjectRoot(process.cwd());
  const memoryPath = getMemoryPath(projectRoot);
  const storage = SQLiteStorage.openExistingForHook(join(memoryPath, config.sqliteFile), { mode: "auto" });
  return { storage, project: basename(projectRoot) };
}

interface LegacyRuling {
  id: string; rule: string; scene?: string | null; quotes: Array<{ date: string; text: string }>;
  scope: string; project: string | null; status: string; recur: number; last_seen: string;
}

export function importRulings(storage: SQLiteStorage, json: { rulings: LegacyRuling[] }, apply: boolean): string {
  const before = storage.runCorrectionTransaction(({ db }) => countExplicitRules(db));
  let rules = 0; let quotes = 0; let created = 0; let skipped = 0;
  const problems: string[] = [];
  for (const ruling of json.rulings) {
    if (!ruling.rule?.trim()) { skipped += 1; continue; }
    rules += 1;
    const scene = (ruling.scene && ruling.scene.trim()) || ruling.rule;
    const quoteList = ruling.quotes.length > 0 ? ruling.quotes : [{ date: ruling.last_seen, text: "" }];
    quotes += ruling.quotes.length;
    if (!apply) continue;
    try {
      quoteList.forEach((quote, index) => {
        const result = recordExplicitRule(storage, {
          rule: ruling.rule, scene, quote: quote.text, project: ruling.project,
          at: `${quote.date}T00:00:00.000Z`, quoteDate: quote.date, sourceKind: "legacy_import",
          occurrenceBonus: index === quoteList.length - 1 ? Math.max(0, ruling.recur) : 0,
        });
        if (index === 0 && result.created) created += 1;
      });
    } catch (error) {
      problems.push(`${ruling.rule.slice(0, 40)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const after = storage.runCorrectionTransaction(({ db }) => countExplicitRules(db));
  const lines = [
    `${apply ? "apply" : "dry-run"}: 規則 ${rules} 件、引用 ${quotes} 件、規則文なしで飛ばした ${skipped} 件`,
    `束 ${before.bundles} → ${after.bundles}（新規 ${created}）、根拠 ${before.evidence} → ${after.evidence}`,
  ];
  if (problems.length > 0) lines.push(`失敗 ${problems.length} 件`, ...problems);
  return lines.join("\n");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { command, positional, flags } = parseArgs(argv);
  if (command === "inject-sub") {
    const { storage, project } = openStorage();
    try {
      const text = renderRulesForSubagent(storage, { project: flag(flags, "project") ?? project, query: flag(flags, "query") ?? "", limit: Number(flag(flags, "limit") ?? 5) });
      if (text) process.stdout.write(`${text}\n`);
      return 0;
    } finally { storage.close(); }
  }
  if (command === "import-rulings") {
    const path = positional[0];
    if (!path) { process.stderr.write("rulings.json のパスが要る\n"); return 2; }
    const json = JSON.parse(readFileSync(path, "utf8")) as { rulings: LegacyRuling[] };
    const { storage } = openStorage();
    try { process.stdout.write(`${importRulings(storage, json, flags.apply === true)}\n`); return 0; } finally { storage.close(); }
  }
  if (command === "record") {
    const { storage } = openStorage();
    try {
      const result = recordExplicitRule(storage, { rule: flag(flags, "rule") ?? "", scene: flag(flags, "scene") ?? "", quote: flag(flags, "quote"), project: flag(flags, "project") ?? null });
      process.stdout.write(`${result.created ? "覚えた" : "原文を足した"}: ${result.rule}\n`);
      return 0;
    } finally { storage.close(); }
  }
  if (command === "list") {
    const { storage, project } = openStorage();
    try {
      const rows = findExplicitRules(storage, flag(flags, "query") ?? "", flag(flags, "project") ?? project, Number(flag(flags, "limit") ?? 20));
      process.stdout.write(rows.map((row) => `- ${row.rule_text}（場面: ${row.title}）`).join("\n") + (rows.length ? "\n" : ""));
      return 0;
    } finally { storage.close(); }
  }
  process.stderr.write("usage: wasurenagusa-rules inject-sub|import-rulings|record|list\n");
  return 2;
}

if (isDirectRun(process.argv[1], import.meta.url)) {
  main().then((code) => process.exit(code)).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); });
}
