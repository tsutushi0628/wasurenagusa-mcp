import { describe, expect, it } from "vitest";
import { buildArchivePlistXml } from "./scheduler-setup";

describe("会話記録アーカイブのlaunchd設定", () => {
  it("1日1回、プロジェクト内でarchiveスクリプトを実行する", () => {
    const plist = buildArchivePlistXml(
      "/usr/bin/node",
      "/project/scripts/maintenance/archive-transcripts.mjs",
      "/project/.wasurenagusa/scheduler/logs/archive-transcripts.log",
    );

    expect(plist).toContain("com.wasurenagusa.archive-transcripts");
    expect(plist).toContain("<integer>3</integer>");
    expect(plist).toContain("<key>Minute</key>\n    <integer>0</integer>");
    expect(plist).toContain("/project/scripts/maintenance/archive-transcripts.mjs");
    expect(plist).toContain("<string>--all</string>");
    expect(plist).toContain("<key>WorkingDirectory</key>\n  <string>/project</string>");
  });

  it("installerのcwdではなくarchive scriptのpackage rootをWorkingDirectoryにする", () => {
    const plist = buildArchivePlistXml(
      "/usr/bin/node",
      "/installed/package/scripts/maintenance/archive-transcripts.mjs",
      "/scheduler/archive-transcripts.log",
    );

    expect(plist).toContain("<key>WorkingDirectory</key>\n  <string>/installed/package</string>");
    expect(plist).not.toContain("/installer/cwd");
  });

  it("plistのパスに含むXML予約文字をescapeする", () => {
    const plist = buildArchivePlistXml(
      "/usr/bin/node",
      "/project/a&b/scripts/maintenance/archive-transcripts.mjs",
      "/tmp/archive.log",
    );
    expect(plist).toContain("/project/a&amp;b/scripts/maintenance/archive-transcripts.mjs");
    expect(plist).toContain("<string>/project/a&amp;b</string>");
  });
});
