import { join } from "path";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { config, getMemoryPath } from "../config.js";
import { findExplicitRules, recordExplicitRule, recurExplicitRule } from "../corrections/explicit.js";
import { basename } from "path";

export const correctionRecordTool: Tool = {
  name: "correction_record",
  description: `オーナーの指摘を規則として覚える。指摘を受けた直後に呼ぶ。
rule: 次回の行動を1行（原始人調、240字まで。条件・数値は落とさない）
scene: この規則を思い出すべき作業場面を1行（検索に使う名詞を入れる）
quote: オーナーの原文
project: その案件だけの規則なら案件名。全案件共通なら省略
返事に ID や番号は書かない。`,
  inputSchema: {
    type: "object",
    properties: {
      rule: { type: "string", description: "次回の行動1行" },
      scene: { type: "string", description: "思い出す場面1行" },
      quote: { type: "string", description: "オーナーの原文" },
      project: { type: "string", description: "案件限定のときだけ案件名" },
    },
    required: ["rule", "scene"],
  },
};

export const correctionRecurTool: Tool = {
  name: "correction_recur",
  description: `既にある規則と同じ趣旨の指摘を受けたとき、その規則に原文を足して回数を増やす。
query: 既存の規則文か場面の一部（先に correction_search で探してよい）
quote: 今回のオーナーの原文`,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "既存の規則文か場面の一部" },
      quote: { type: "string", description: "今回の原文" },
    },
    required: ["query", "quote"],
  },
};

export const correctionSearchTool: Tool = {
  name: "correction_search",
  description: "覚えている規則を規則文・場面の一部で探す。同趣旨の指摘が既にあるか確かめるときに使う。返事に ID は書かない。",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "規則文か場面の一部" },
      limit: { type: "number", description: "件数（既定5）" },
    },
    required: ["query"],
  },
};

function openStorage(projectRoot: string): SQLiteStorage {
  const memoryPath = getMemoryPath(projectRoot);
  const storage = new SQLiteStorage(join(memoryPath, config.sqliteFile));
  storage.initialize(memoryPath);
  return storage;
}

function requireString(args: Record<string, unknown>, key: string, optional = false): string {
  const value = args[key];
  if (typeof value === "string" && value.trim()) return value;
  if (optional) return "";
  throw new Error(`${key} は必須`);
}

export async function handleCorrectionRecord(args: Record<string, unknown>, projectRoot: string): Promise<string> {
  const storage = openStorage(projectRoot);
  try {
    const result = recordExplicitRule(storage, {
      rule: requireString(args, "rule"),
      scene: requireString(args, "scene"),
      quote: requireString(args, "quote", true),
      project: requireString(args, "project", true) || null,
    });
    return result.created ? `覚えた: ${result.rule}` : `同じ規則があったので原文を足した: ${result.rule}`;
  } finally {
    storage.close();
  }
}

export async function handleCorrectionRecur(args: Record<string, unknown>, projectRoot: string): Promise<string> {
  const storage = openStorage(projectRoot);
  try {
    const result = recurExplicitRule(storage, {
      query: requireString(args, "query"),
      quote: requireString(args, "quote"),
      project: basename(projectRoot),
    });
    if (!result) return "該当する規則が無い。correction_record で新規に覚える";
    return `回数を足した（${result.occurrence_count}回目）: ${result.rule_text}`;
  } finally {
    storage.close();
  }
}

export async function handleCorrectionSearch(args: Record<string, unknown>, projectRoot: string): Promise<string> {
  const storage = openStorage(projectRoot);
  try {
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(20, Math.floor(args.limit)) : 5;
    const rows = findExplicitRules(storage, requireString(args, "query"), basename(projectRoot), limit);
    if (rows.length === 0) return "該当なし";
    return rows.map((row) => `- ${row.rule_text}（場面: ${row.title}）`).join("\n");
  } finally {
    storage.close();
  }
}
