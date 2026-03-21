import { ConsolidatedDont, ConsolidatedConfig } from "../types.js";

export function formatConsolidatedDont(consolidated: ConsolidatedDont): string {
  if (consolidated.principles.length === 0) return "";

  // score降順でソート
  const sorted = [...consolidated.principles].sort((a, b) => {
    return b.score - a.score;
  });

  // 上位25%の閾値を算出
  const top25Index = Math.ceil(sorted.length * 0.25);

  const sections = sorted.map((p, i) => {
    const prefix = i < top25Index ? "⚠ " : "";
    const displayRule = p.positiveRule || p.rule;
    return `### ${prefix}${i + 1}. ${p.theme} (${p.sourceCount}件, 最大強度${p.maxIntensity})
${displayRule}
[tags: ${p.tags.join(", ")}]`;
  });

  return sections.join("\n\n") +
    "\n\n> 各原則の詳細は memory_search / memory_get_detail で元エントリを参照可能\n";
}

export function formatConsolidatedConfig(consolidated: ConsolidatedConfig): string {
  if (consolidated.summaries.length === 0) return "";

  const sections = consolidated.summaries.map((s, i) => {
    return `### ${i + 1}. ${s.theme}
${s.summary}`;
  });

  return sections.join("\n\n") +
    "\n\n> 各設定の詳細は memory_search で元エントリを参照可能\n";
}
