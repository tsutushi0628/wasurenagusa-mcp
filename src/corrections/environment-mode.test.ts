import { afterEach, describe, expect, it, vi } from "vitest";
import { isCorrectionComplianceEnabled } from "./compliance.js";
import { readCorrectionFeatureModes } from "./environment-mode.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("correction environment modes", () => {
  it("invalid loop, inject, and compliance values fail closed and name each variable on stderr", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const modes = readCorrectionFeatureModes({
      WASURENAGUSA_CORRECTION_LOOP: "invalid-loop-mode",
      WASURENAGUSA_CORRECTION_INJECT: "invalid-inject-mode",
      WASURENAGUSA_CORRECTION_COMPLIANCE: "invalid-compliance-mode",
    });

    expect(modes.correctionLoop).toBe("off");
    expect(modes.correctionInject).toBe("off");
    expect(modes.compliance).toBe("off");
    const warnings = errorSpy.mock.calls.map(([message]) => String(message));
    expect(warnings).toHaveLength(3);
    expect(warnings.some((warning) => warning.includes("WASURENAGUSA_CORRECTION_LOOP"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("WASURENAGUSA_CORRECTION_INJECT"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("WASURENAGUSA_CORRECTION_COMPLIANCE"))).toBe(true);
    expect(warnings.every((warning) => !warning.includes("\n"))).toBe(true);
  });

  it("compliance判定も共通mode readerを使い、不正値をstderrへ出す", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(isCorrectionComplianceEnabled({ WASURENAGUSA_CORRECTION_COMPLIANCE: "invalid-compliance-reader" })).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("WASURENAGUSA_CORRECTION_COMPLIANCE"));
  });
});
