/**
 * LLM出力の業務整合性ガード（memory-redesign Phase 3・タスク3.10／llm-design 4原則の④）。
 *
 * 統合・起草・サルベージ判定の全LLM出力に共通適用する warning 設計のガード。LLMが返した
 * sourceIds/category を「入力との差分判定」で検査し、業務整合性を欠くフィールドは throw せず
 * 破棄して warning を積む（呼び出し側が計数する）。JSONパース失敗はバッチスキップ扱い。
 *
 * 設計方針（llm-design ④）:
 *   - 検査・分岐・集計・破棄はすべてコード側（本ファイル）。LLMにガードを実装させない。
 *   - throw で強制停止しない（warning + 計数 + 当該フィールド破棄）。JSONパース失敗のみ
 *     「そのバッチをスキップ」という上位判断を促す skip フラグで返す。
 *   - 純関数（DB非依存・IO非依存）。計数の副作用は呼び出し側に委ねる（テスト容易性）。
 */
import type { MemoryCategory } from "../types.js";

/** 業務上有効な category の集合（enum の単一真実源）。types.MemoryCategory と一致させる。 */
export const VALID_CATEGORIES: readonly MemoryCategory[] = [
  "config",
  "dont",
  "decision",
  "log",
  "snippet",
  "dream",
  "success",
];

export interface GuardWarning {
  /** 破棄したフィールド名（"sourceIds" | "category"）。*/
  field: string;
  /** 破棄理由（人間可読・数値/識別子のみ、本文は載せない）。*/
  reason: string;
}

/** LLMが返した統合出力の生の形（未検証・部分的に欠損しうる）。*/
export interface RawMergeOutput {
  sourceIds?: unknown;
  category?: unknown;
  [key: string]: unknown;
}

export interface SanitizedMergeOutput {
  /** 入力ID集合の部分集合であることを検証済みの sourceIds（不正時は undefined に破棄）。*/
  sourceIds?: string[];
  /** enum 内であることを検証済みの category（不正時は undefined に破棄）。*/
  category?: MemoryCategory;
  [key: string]: unknown;
}

export interface GuardResult {
  sanitized: SanitizedMergeOutput;
  warnings: GuardWarning[];
}

/**
 * LLM統合出力を入力との差分で検査し、整合しないフィールドを破棄して warning を返す。
 * throw しない。
 *
 * @param raw LLMが返した（パース済みの）出力オブジェクト
 * @param inputIds このバッチでLLMに与えた入力記憶IDの全集合（sourceIds はこの部分集合であるべき）
 */
export function guardMergeOutput(raw: RawMergeOutput, inputIds: string[]): GuardResult {
  const warnings: GuardWarning[] = [];
  const inputSet = new Set(inputIds);
  // 未検証の sourceIds/category は除いた残りだけを土台にし、検証を通ったものだけ後で載せる。
  const { sourceIds: _rawSourceIds, category: _rawCategory, ...rest } = raw;
  void _rawSourceIds;
  void _rawCategory;
  const sanitized: SanitizedMergeOutput = { ...rest };

  // sourceIds: 配列かつ全要素が入力ID集合の部分集合であることを要求。逸脱があれば丸ごと破棄。
  if (raw.sourceIds !== undefined) {
    const ids = raw.sourceIds;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) {
      warnings.push({ field: "sourceIds", reason: "配列(string[])でない" });
      delete sanitized.sourceIds;
    } else {
      const fabricated = (ids as string[]).filter((id) => !inputSet.has(id));
      if (fabricated.length > 0) {
        // 入力に無いID（捏造）が1件でもあれば sourceIds 全体を破棄（沈黙空振りの根治）。
        warnings.push({
          field: "sourceIds",
          reason: `入力ID集合の部分集合でない（捏造${fabricated.length}件/計${ids.length}件）`,
        });
        delete sanitized.sourceIds;
      } else {
        sanitized.sourceIds = ids as string[];
      }
    }
  }

  // category: enum 内であることを要求。逸脱があれば破棄。
  if (raw.category !== undefined) {
    if (
      typeof raw.category === "string" &&
      (VALID_CATEGORIES as readonly string[]).includes(raw.category)
    ) {
      sanitized.category = raw.category as MemoryCategory;
    } else {
      warnings.push({ field: "category", reason: "enum(MemoryCategory)外の値" });
      delete sanitized.category;
    }
  }

  return { sanitized, warnings };
}

export interface ParseResult {
  ok: boolean;
  value?: RawMergeOutput;
  /** JSONパース失敗＝そのバッチをスキップすべき（上位で計数）。*/
  skip: boolean;
}

/**
 * LLM出力のJSON文字列をパースする。失敗は throw せず skip=true で返す（バッチスキップ＋計数）。
 */
export function parseLlmJson(text: string): ParseResult {
  try {
    const value = JSON.parse(text) as RawMergeOutput;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, skip: true };
    }
    return { ok: true, value, skip: false };
  } catch {
    return { ok: false, skip: true };
  }
}
