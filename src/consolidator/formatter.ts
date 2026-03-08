import { ConsolidatedDont, ConsolidatedConfig } from "../types.js";

export function formatConsolidatedDont(consolidated: ConsolidatedDont): string {
  if (consolidated.principles.length === 0) return "";

  const sections = consolidated.principles.map((p, i) => {
    return `### ${i + 1}. ${p.theme} (${p.sourceCount}件の教訓)
${p.rule}
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
