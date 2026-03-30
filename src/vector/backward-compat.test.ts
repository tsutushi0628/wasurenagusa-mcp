import { describe, it, expect } from "vitest";
import { parseWeightedTags } from "./weighted-tag.js";
import { SearchScorer } from "./search-scorer.js";
import { parseMarkdown } from "../storage/parser.js";
import { formatEntry } from "../storage/formatter.js";

describe("backward compatibility", () => {
  it("legacy tags (no weight) parse as weight 1.0", () => {
    const tags = parseWeightedTags(["Gemini", "API", "設定"]);
    expect(tags).toEqual([
      { tag: "Gemini", weight: 1.0 },
      { tag: "API", weight: 1.0 },
      { tag: "設定", weight: 1.0 },
    ]);
  });

  it("SearchScorer works with weight 1.0 legacy tags", () => {
    const score = SearchScorer.score({
      vectorSimilarity: 0.9,
      matchedTagWeights: [1.0, 1.0],
      daysSinceLastAccess: 0,
      accessCount: 0,
    });
    // 0.9 * (1.0 + 2.0) * 1.0 * 1.0 = 2.7
    expect(score).toBeCloseTo(2.7, 5);
  });

  it("legacy markdown round-trips correctly", () => {
    const md = `## レガシーエントリ

- **id**: legacy-001
- **timestamp**: 2024-01-01T00:00:00+09:00
- **category**: config
- **tags**: Gemini, API, 設定
- **content**: レガシーコンテンツ

---

`;
    const entries = parseMarkdown(md, "config");
    expect(entries).toHaveLength(1);
    expect(entries[0].tags).toEqual(["Gemini", "API", "設定"]);

    // Format back and re-parse
    const formatted = formatEntry(entries[0]);
    expect(formatted).toContain("- **tags**: Gemini, API, 設定");
  });

  it("mixed legacy and weighted tags work together in scoring", () => {
    const legacyScore = SearchScorer.score({
      vectorSimilarity: 0.8,
      matchedTagWeights: [1.0], // legacy tag, weight=1.0
      daysSinceLastAccess: 0,
      accessCount: 0,
    });

    const weightedScore = SearchScorer.score({
      vectorSimilarity: 0.8,
      matchedTagWeights: [0.9], // weighted tag
      daysSinceLastAccess: 0,
      accessCount: 0,
    });

    // Legacy tag (weight 1.0) should score slightly higher than weighted (0.9)
    expect(legacyScore).toBeGreaterThan(weightedScore);
  });

  it("parsing weighted tags preserves through parse->format->parse", () => {
    const md = `## 新形式エントリ

- **id**: new-001
- **timestamp**: 2024-06-01T00:00:00+09:00
- **category**: config
- **tags**: Gemini:0.3, rate-limit:0.9, API制限:0.8
- **content**: 新形式コンテンツ

---

`;
    const entries = parseMarkdown(md, "config");
    const formatted = formatEntry(entries[0]);
    const reparsed = parseMarkdown(formatted, "config");
    expect(reparsed[0].tags).toEqual(entries[0].tags);
  });
});
