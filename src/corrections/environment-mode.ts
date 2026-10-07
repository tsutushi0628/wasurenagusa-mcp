export type CorrectionPrinciplesMode = "off" | "shadow" | "on";
export type CorrectionGraduationMode = "off" | "on";
export type CorrectionStrengthMode = "off" | "shadow" | "on";
export type CorrectionLoopMode = "off" | "on";
export type CorrectionInjectMode = "off" | "on";
export type CorrectionComplianceMode = "off" | "on";
export type CorrectionReinjectionMode = "off" | "on";
export type CorrectionCandidateInjectionMode = "off" | "on";
export type OwnerScopeBehaviorMode = "off" | "on";

export interface CorrectionFeatureModes {
  correctionLoop: CorrectionLoopMode;
  correctionInject: CorrectionInjectMode;
  compliance: CorrectionComplianceMode;
  principles: CorrectionPrinciplesMode;
  graduation: CorrectionGraduationMode;
  strength: CorrectionStrengthMode;
  reinjection: CorrectionReinjectionMode;
  candidateInjection: CorrectionCandidateInjectionMode;
  ownerScopeBehavior: OwnerScopeBehaviorMode;
}

const reportedInvalidModes = new Set<string>();

export function readEnvironmentMode<T extends string>(input: {
  name: string;
  value: string | undefined;
  acceptedValues: readonly T[];
  defaultValue: T;
  invalidValue: T;
  lowercase?: boolean;
}): T {
  if (input.value === undefined || input.value.trim() === "") return input.defaultValue;
  const trimmedValue = input.value.trim();
  const mode = input.lowercase ? trimmedValue.toLowerCase() : trimmedValue;
  if (input.acceptedValues.includes(mode as T)) return mode as T;

  const warningKey = `${input.name}\u0000${input.value}`;
  if (!reportedInvalidModes.has(warningKey)) {
    reportedInvalidModes.add(warningKey);
    console.error(`[correction-config] ${input.name}=${JSON.stringify(input.value)} is invalid; using ${input.invalidValue}`);
  }
  return input.invalidValue;
}

export function getCorrectionLoopMode(env: NodeJS.ProcessEnv = process.env): CorrectionLoopMode {
  return readEnvironmentMode({
    name: "WASURENAGUSA_CORRECTION_LOOP",
    value: env.WASURENAGUSA_CORRECTION_LOOP,
    acceptedValues: ["off", "on"],
    defaultValue: "off",
    invalidValue: "off",
    lowercase: true,
  });
}

export function getCorrectionInjectMode(env: NodeJS.ProcessEnv = process.env): CorrectionInjectMode {
  return readEnvironmentMode({
    name: "WASURENAGUSA_CORRECTION_INJECT",
    value: env.WASURENAGUSA_CORRECTION_INJECT,
    acceptedValues: ["off", "on"],
    defaultValue: "on",
    invalidValue: "off",
    lowercase: true,
  });
}

export function getCorrectionComplianceMode(env: NodeJS.ProcessEnv = process.env): CorrectionComplianceMode {
  return readEnvironmentMode({
    name: "WASURENAGUSA_CORRECTION_COMPLIANCE",
    value: env.WASURENAGUSA_CORRECTION_COMPLIANCE,
    acceptedValues: ["off", "on"],
    defaultValue: "on",
    invalidValue: "off",
    lowercase: true,
  });
}

export function readCorrectionFeatureModes(env: NodeJS.ProcessEnv = process.env): CorrectionFeatureModes {
  return {
    correctionLoop: getCorrectionLoopMode(env),
    correctionInject: getCorrectionInjectMode(env),
    compliance: getCorrectionComplianceMode(env),
    principles: readEnvironmentMode({
      name: "WASURENAGUSA_PRINCIPLES",
      value: env.WASURENAGUSA_PRINCIPLES,
      acceptedValues: ["off", "shadow", "on"],
      defaultValue: "shadow",
      invalidValue: "off",
      lowercase: true,
    }),
    graduation: readEnvironmentMode({
      name: "WASURENAGUSA_GRADUATION",
      value: env.WASURENAGUSA_GRADUATION,
      acceptedValues: ["off", "on"],
      defaultValue: "off",
      invalidValue: "off",
      lowercase: true,
    }),
    strength: readEnvironmentMode({
      name: "WASURENAGUSA_STRENGTH",
      value: env.WASURENAGUSA_STRENGTH,
      acceptedValues: ["off", "shadow", "on"],
      defaultValue: "off",
      invalidValue: "off",
    }),
    reinjection: readEnvironmentMode({
      name: "WASURENAGUSA_CORRECTION_REINJECT",
      value: env.WASURENAGUSA_CORRECTION_REINJECT,
      acceptedValues: ["off", "on"],
      defaultValue: "on",
      invalidValue: "off",
      lowercase: true,
    }),
    candidateInjection: readEnvironmentMode({
      name: "WASURENAGUSA_CANDIDATE_INJECT",
      value: env.WASURENAGUSA_CANDIDATE_INJECT,
      acceptedValues: ["off", "on"],
      defaultValue: "off",
      invalidValue: "off",
      lowercase: true,
    }),
    ownerScopeBehavior: readEnvironmentMode({
      name: "WASURENAGUSA_OWNER_SCOPE_BEHAVIOR",
      value: env.WASURENAGUSA_OWNER_SCOPE_BEHAVIOR,
      acceptedValues: ["off", "on"],
      defaultValue: "off",
      invalidValue: "off",
    }),
  };
}
