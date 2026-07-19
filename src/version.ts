import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_PKG_PATH = resolve(__dirname, "../package.json");
const UNKNOWN_VERSION = "0.0.0-unknown";

/**
 * サーバの自己申告版数を package.json（単一真実源）から読む。
 * ハードコード版数の再発防止のため、版数の真実源は package.json に一本化する。
 * 読めない/壊れている/version 欠損でも startup を止めないよう、
 * 実在しないプレースホルダ版数へ fail-safe する（本物の版数として通用させない）。
 */
export function readServerVersion(pkgPath: string = DEFAULT_PKG_PATH): string {
  try {
    const raw = readFileSync(pkgPath, "utf-8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" && version.length > 0
      ? version
      : UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}

export const SERVER_VERSION = readServerVersion();
