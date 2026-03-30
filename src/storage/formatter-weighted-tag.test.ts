import { describe, it, expect } from "vitest";
import { formatEntry } from "./formatter.js";
import { MemoryEntry } from "../types.js";

describe("formatter.ts weighted tag support", () => {
  it("outputs weighted tags preserving tag:weight format", () => {
    const entry: MemoryEntry = {
      id: "test-001",
      timestamp: "2024-01-01T00:00:00+09:00",
      category: "config",
      title: "テスト",
      content: "テスト内容",
      tags: ["Gemini:0.3", "rate-limit:0.9"],
    };
    const result = formatEntry(entry);
    expect(result).toContain("- **tags**: Gemini:0.3, rate-limit:0.9");
  });

  it("outputs mixed legacy and weighted tags", () => {
    const entry: MemoryEntry = {
      id: "test-002",
      timestamp: "2024-01-01T00:00:00+09:00",
      category: "config",
      title: "テスト",
      content: "テスト内容",
      tags: ["Gemini", "rate-limit:0.9", "API"],
    };
    const result = formatEntry(entry);
    expect(result).toContain("- **tags**: Gemini, rate-limit:0.9, API");
  });

  it("round-trips weighted tags through format -> parse", () => {
    const entry: MemoryEntry = {
      id: "test-003",
      timestamp: "2024-01-01T00:00:00+09:00",
      category: "config",
      title: "テスト",
      content: "テスト内容",
      tags: ["Gemini:0.3", "rate-limit:0.9", "1000RPM:1"],
    };
    const formatted = formatEntry(entry);
    // Parse the tags line from formatted output
    const tagsMatch = formatted.match(/- \*\*tags\*\*: (.+)/);
    expect(tagsMatch).not.toBeNull();
    const parsedTags = tagsMatch![1].split(",").map(t => t.trim()).filter(Boolean);
    expect(parsedTags).toEqual(["Gemini:0.3", "rate-limit:0.9", "1000RPM:1"]);
  });
});
