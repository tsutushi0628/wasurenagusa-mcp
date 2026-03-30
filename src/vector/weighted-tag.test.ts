import { describe, it, expect } from "vitest";
import {
  parseWeightedTag,
  formatWeightedTag,
  parseWeightedTags,
  formatWeightedTags,
} from "./weighted-tag.js";

describe("parseWeightedTag", () => {
  it("parses tag:weight format", () => {
    expect(parseWeightedTag("rate-limit:0.9")).toEqual({
      tag: "rate-limit",
      weight: 0.9,
    });
  });

  it("parses tag with integer weight", () => {
    expect(parseWeightedTag("API:1")).toEqual({ tag: "API", weight: 1.0 });
  });

  it("backward compat: tag without weight defaults to 1.0", () => {
    expect(parseWeightedTag("Gemini")).toEqual({ tag: "Gemini", weight: 1.0 });
  });

  it("backward compat: empty weight after colon defaults to 1.0", () => {
    expect(parseWeightedTag("tag:")).toEqual({ tag: "tag", weight: 1.0 });
  });

  it("clamps weight above 1.0 to 1.0", () => {
    expect(parseWeightedTag("test:1.5")).toEqual({ tag: "test", weight: 1.0 });
  });

  it("clamps weight below 0.0 to 0.0", () => {
    expect(parseWeightedTag("test:-0.3")).toEqual({ tag: "test", weight: 0.0 });
  });

  it("handles tag with multiple colons (e.g. URL-like)", () => {
    expect(parseWeightedTag("http://example:0.5")).toEqual({
      tag: "http://example",
      weight: 0.5,
    });
  });

  it("handles non-numeric value after colon as part of tag name", () => {
    expect(parseWeightedTag("scope:backend")).toEqual({
      tag: "scope:backend",
      weight: 1.0,
    });
  });
});

describe("formatWeightedTag", () => {
  it("formats tag:weight", () => {
    expect(formatWeightedTag({ tag: "rate-limit", weight: 0.9 })).toBe(
      "rate-limit:0.9",
    );
  });

  it("formats weight 1.0", () => {
    expect(formatWeightedTag({ tag: "Gemini", weight: 1.0 })).toBe(
      "Gemini:1",
    );
  });

  it("formats weight 0.0", () => {
    expect(formatWeightedTag({ tag: "generic", weight: 0.0 })).toBe(
      "generic:0",
    );
  });
});

describe("parseWeightedTags", () => {
  it("parses array of mixed format tags", () => {
    const result = parseWeightedTags(["Gemini:0.3", "rate-limit:0.9", "API"]);
    expect(result).toEqual([
      { tag: "Gemini", weight: 0.3 },
      { tag: "rate-limit", weight: 0.9 },
      { tag: "API", weight: 1.0 },
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(parseWeightedTags([])).toEqual([]);
  });
});

describe("formatWeightedTags", () => {
  it("formats array of weighted tags", () => {
    const result = formatWeightedTags([
      { tag: "Gemini", weight: 0.3 },
      { tag: "rate-limit", weight: 0.9 },
    ]);
    expect(result).toEqual(["Gemini:0.3", "rate-limit:0.9"]);
  });

  it("returns empty array for empty input", () => {
    expect(formatWeightedTags([])).toEqual([]);
  });
});

describe("round-trip: parse -> format -> parse", () => {
  it("preserves data through round-trip", () => {
    const original = "rate-limit:0.9";
    const parsed = parseWeightedTag(original);
    const formatted = formatWeightedTag(parsed);
    const reparsed = parseWeightedTag(formatted);
    expect(reparsed).toEqual(parsed);
  });

  it("preserves batch round-trip", () => {
    const originals = ["Gemini:0.3", "rate-limit:0.9", "1000RPM:1"];
    const parsed = parseWeightedTags(originals);
    const formatted = formatWeightedTags(parsed);
    const reparsed = parseWeightedTags(formatted);
    expect(reparsed).toEqual(parsed);
  });
});
