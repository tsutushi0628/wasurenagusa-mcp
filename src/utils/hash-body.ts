import { createHash } from "crypto";

/**
 * 本文（trim後）の先頭16桁sha256ハッシュ。「同一本文＝同一群」の基準として、
 * G2ゲートのself-search検査（scripts/gates/g2-search.ts）とPT-04プロパティテスト
 * （tests/properties/self-search.property.test.ts）が共有する唯一の正本（cr-verify-07）。
 * 片方だけ変更されると「同基準」の前提が黙って崩れるため、両方がここをimportする。
 */
export const hashBody = (trimmed: string): string => createHash("sha256").update(trimmed).digest("hex").slice(0, 16);
