import { describe, expect, it } from "vitest";

import {
  CORRECTION_METRIC_STAGE_NAMES,
  summarizeCorrectionMetricLines,
} from "./aggregate-correction-metrics.mjs";

describe("maintenance/aggregate-correction-metrics", () => {
  it("段別に最近順位のp50・p95・最大値を計算し、旧形式と省略行を除く", () => {
    const lines = Array.from({ length: 20 }, (_, index) => {
      const value = index + 1;
      return JSON.stringify({
        k: "sample",
        st: [value, value * 2, value * 3, value * 4, value * 5, value * 6, value * 7],
      });
    });
    lines.push(JSON.stringify({ k: "sample", ms: 4, tok: 0, miss: 0 }));
    lines.push(JSON.stringify({ k: "omitted", total_count: 1001, omitted_count: 1 }));

    const summary = summarizeCorrectionMetricLines(lines.join("\n"));

    expect(CORRECTION_METRIC_STAGE_NAMES).toEqual([
      "stdin",
      "position",
      "detect",
      "store",
      "retrieve",
      "render",
      "write",
    ]);
    expect(summary).toEqual({
      samples: 20,
      legacySamples: 1,
      stages: {
        stdin: { p50: 10, p95: 19, max: 20 },
        position: { p50: 20, p95: 38, max: 40 },
        detect: { p50: 30, p95: 57, max: 60 },
        store: { p50: 40, p95: 76, max: 80 },
        retrieve: { p50: 50, p95: 95, max: 100 },
        render: { p50: 60, p95: 114, max: 120 },
        write: { p50: 70, p95: 133, max: 140 },
      },
    });
  });

  it("段別配列の長さと値が不正なら失敗する", () => {
    expect(() => summarizeCorrectionMetricLines(JSON.stringify({ k: "sample", st: [1, 2] }))).toThrow();
    expect(() => summarizeCorrectionMetricLines(JSON.stringify({ k: "sample", st: [0, 0, 0, 0, 0, 0, -1] }))).toThrow();
  });
});
