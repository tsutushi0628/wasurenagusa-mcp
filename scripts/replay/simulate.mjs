#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runSimulation } from "./lib/simulate-engine.mjs";

export function parseReplayArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--mode") {
      options.mode = args[index + 1];
      index += 1;
    } else if (argument === "--compiled-root") {
      options.compiledRoot = args[index + 1];
      index += 1;
    } else if (argument === "--manifest") {
      options.manifest = args[index + 1];
      index += 1;
    } else if (argument === "--scratch") {
      options.scratchRoot = args[index + 1];
      index += 1;
    } else if (argument === "--split") {
      options.split = args[index + 1];
      index += 1;
    } else if (argument === "--audit") {
      options.auditArgs = args[index + 1];
      index += 1;
    } else {
      throw new Error(`unsupported argument: ${argument}`);
    }
  }
  if (!["cold", "freeze", "acceptance", "hook-timing"].includes(options.mode)) {
    throw new Error("unsupported mode; use cold, freeze, acceptance, or hook-timing");
  }
  for (const key of ["manifest", "compiledRoot", "scratchRoot"]) {
    if (typeof options[key] !== "string" || options[key].length === 0) {
      throw new Error("--" + key.replace(/[A-Z]/gu, (letter) => "-" + letter.toLowerCase()) + " is required");
    }
  }
  if (options.mode === "cold" && !["tune", "evaluation"].includes(options.split)) {
    throw new Error("cold mode requires --split tune|evaluation");
  }
  if (options.mode !== "cold" && options.split !== undefined) {
    throw new Error("--split is only valid in cold mode");
  }
  return options;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
try {
  const result = await runSimulation(parseReplayArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
}
