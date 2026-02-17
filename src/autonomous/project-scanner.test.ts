import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { ProjectScanner } from "./project-scanner.js";
import { TaskMarkdownAdapter } from "./task-markdown.js";

describe("ProjectScanner", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "wasurenagusa-projscan-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("scanProjects", () => {
    it("通常プロジェクトを検出する", async () => {
      await mkdir(join(tempDir, "my-app"));
      await mkdir(join(tempDir, "other-app"));

      const scanner = new ProjectScanner(tempDir);
      const projects = await scanner.scanProjects();

      expect(projects).toHaveLength(2);
      expect(projects[0].name).toBe("my-app");
      expect(projects[0].type).toBe("standalone");
      expect(projects[1].name).toBe("other-app");
      expect(projects[1].type).toBe("standalone");
    });

    it("サブプロジェクト持ち親ディレクトリを展開する", async () => {
      await mkdir(join(tempDir, "parent-labo"));
      await mkdir(join(tempDir, "parent-labo", "sub-a"));
      await mkdir(join(tempDir, "parent-labo", "sub-b"));

      const scanner = new ProjectScanner(tempDir, ["parent-labo"]);
      const projects = await scanner.scanProjects();

      expect(projects).toHaveLength(2);
      expect(projects[0].name).toBe("parent-labo/sub-a");
      expect(projects[0].type).toBe("subproject");
      expect(projects[0].path).toBe(join(tempDir, "parent-labo", "sub-a"));
      expect(projects[1].name).toBe("parent-labo/sub-b");
    });

    it("通常プロジェクトとサブプロジェクトを混在で検出する", async () => {
      await mkdir(join(tempDir, "standalone-app"));
      await mkdir(join(tempDir, "mono-repo"));
      await mkdir(join(tempDir, "mono-repo", "service-a"));
      await mkdir(join(tempDir, "mono-repo", "service-b"));

      const scanner = new ProjectScanner(tempDir, ["mono-repo"]);
      const projects = await scanner.scanProjects();

      const names = projects.map((p) => p.name);
      expect(names).toContain("standalone-app");
      expect(names).toContain("mono-repo/service-a");
      expect(names).toContain("mono-repo/service-b");
      expect(projects).toHaveLength(3);
    });

    it("隠しディレクトリを除外する", async () => {
      await mkdir(join(tempDir, "visible-app"));
      await mkdir(join(tempDir, ".hidden-dir"));

      const scanner = new ProjectScanner(tempDir);
      const projects = await scanner.scanProjects();

      expect(projects).toHaveLength(1);
      expect(projects[0].name).toBe("visible-app");
    });

    it("除外リスト（node_modules等）を除外する", async () => {
      await mkdir(join(tempDir, "real-app"));
      await mkdir(join(tempDir, "node_modules"));
      await mkdir(join(tempDir, "dist"));
      await mkdir(join(tempDir, "logs"));

      const scanner = new ProjectScanner(tempDir);
      const projects = await scanner.scanProjects();

      expect(projects).toHaveLength(1);
      expect(projects[0].name).toBe("real-app");
    });

    it("ファイルを除外する（ディレクトリのみ）", async () => {
      await mkdir(join(tempDir, "real-app"));
      await writeFile(join(tempDir, "readme.txt"), "hello");

      const scanner = new ProjectScanner(tempDir);
      const projects = await scanner.scanProjects();

      expect(projects).toHaveLength(1);
      expect(projects[0].name).toBe("real-app");
    });

    it("ドット含みのファイル/ディレクトリを除外する", async () => {
      await mkdir(join(tempDir, "real-app"));
      await writeFile(join(tempDir, "workspace.code-workspace"), "{}");

      const scanner = new ProjectScanner(tempDir);
      const projects = await scanner.scanProjects();

      expect(projects).toHaveLength(1);
    });

    it("サブプロジェクト親内の除外エントリも除外する", async () => {
      await mkdir(join(tempDir, "parent"));
      await mkdir(join(tempDir, "parent", "real-sub"));
      await mkdir(join(tempDir, "parent", "node_modules"));
      await mkdir(join(tempDir, "parent", "logs"));
      await mkdir(join(tempDir, "parent", ".git"));

      const scanner = new ProjectScanner(tempDir, ["parent"]);
      const projects = await scanner.scanProjects();

      expect(projects).toHaveLength(1);
      expect(projects[0].name).toBe("parent/real-sub");
    });

    it("gitサブモジュール（.gitがファイル）を除外する", async () => {
      await mkdir(join(tempDir, "parent"));
      await mkdir(join(tempDir, "parent", "real-sub"));
      await mkdir(join(tempDir, "parent", "submodule-lib"));
      // サブモジュールは .git がファイル（ディレクトリではない）
      await writeFile(
        join(tempDir, "parent", "submodule-lib", ".git"),
        "gitdir: ../../.git/modules/submodule-lib",
      );

      const scanner = new ProjectScanner(tempDir, ["parent"]);
      const projects = await scanner.scanProjects();

      expect(projects).toHaveLength(1);
      expect(projects[0].name).toBe("parent/real-sub");
    });

    it("通常プロジェクト(.gitがディレクトリ)は除外しない", async () => {
      await mkdir(join(tempDir, "normal-project"));
      await mkdir(join(tempDir, "normal-project", ".git"));

      const scanner = new ProjectScanner(tempDir);
      const projects = await scanner.scanProjects();

      expect(projects).toHaveLength(1);
      expect(projects[0].name).toBe("normal-project");
    });

    it("存在しないディレクトリでは空配列を返す", async () => {
      const scanner = new ProjectScanner("/tmp/nonexistent-dir-12345");
      const projects = await scanner.scanProjects();

      expect(projects).toEqual([]);
    });

    it("空ディレクトリでは空配列を返す", async () => {
      const scanner = new ProjectScanner(tempDir);
      const projects = await scanner.scanProjects();

      expect(projects).toEqual([]);
    });

    it("名前順でソートされる", async () => {
      await mkdir(join(tempDir, "zebra"));
      await mkdir(join(tempDir, "alpha"));
      await mkdir(join(tempDir, "middle"));

      const scanner = new ProjectScanner(tempDir);
      const projects = await scanner.scanProjects();

      expect(projects[0].name).toBe("alpha");
      expect(projects[1].name).toBe("middle");
      expect(projects[2].name).toBe("zebra");
    });

    it("subProjectParents未設定なら全ディレクトリをstandaloneとして扱う", async () => {
      await mkdir(join(tempDir, "app-a"));
      await mkdir(join(tempDir, "app-b"));

      const scanner = new ProjectScanner(tempDir); // subProjectParentsなし
      const projects = await scanner.scanProjects();

      expect(projects).toHaveLength(2);
      expect(projects.every((p) => p.type === "standalone")).toBe(true);
    });
  });

  describe("validateProjectName", () => {
    it("存在するプロジェクト名はtrueを返す", async () => {
      await mkdir(join(tempDir, "my-app"));

      const scanner = new ProjectScanner(tempDir);
      const valid = await scanner.validateProjectName("my-app");

      expect(valid).toBe(true);
    });

    it("存在しないプロジェクト名はfalseを返す", async () => {
      await mkdir(join(tempDir, "my-app"));

      const scanner = new ProjectScanner(tempDir);
      const valid = await scanner.validateProjectName("nonexistent");

      expect(valid).toBe(false);
    });

    it("サブプロジェクト名でもバリデーションできる", async () => {
      await mkdir(join(tempDir, "parent"));
      await mkdir(join(tempDir, "parent", "child"));

      const scanner = new ProjectScanner(tempDir, ["parent"]);
      const valid = await scanner.validateProjectName("parent/child");

      expect(valid).toBe(true);
    });
  });

  describe("resolveProjectPath", () => {
    it("プロジェクト名からパスを解決する", async () => {
      await mkdir(join(tempDir, "my-app"));

      const scanner = new ProjectScanner(tempDir);
      const path = await scanner.resolveProjectPath("my-app");

      expect(path).toBe(join(tempDir, "my-app"));
    });

    it("サブプロジェクトのパスを解決する", async () => {
      await mkdir(join(tempDir, "parent"));
      await mkdir(join(tempDir, "parent", "child"));

      const scanner = new ProjectScanner(tempDir, ["parent"]);
      const path = await scanner.resolveProjectPath("parent/child");

      expect(path).toBe(join(tempDir, "parent", "child"));
    });

    it("存在しないプロジェクトはnullを返す", async () => {
      const scanner = new ProjectScanner(tempDir);
      const path = await scanner.resolveProjectPath("nonexistent");

      expect(path).toBeNull();
    });
  });
});

describe("TaskMarkdownAdapter.updateProjectList", () => {
  let tempDir: string;
  let filePath: string;
  let adapter: TaskMarkdownAdapter;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "wasurenagusa-projlist-"));
    filePath = join(tempDir, "tasks.md");
    adapter = new TaskMarkdownAdapter(filePath);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("マーカー間のプロジェクトリストを更新する", async () => {
    await writeFile(
      filePath,
      `# Tasks

<!-- PROJECT_LIST_START (自動更新: 手動編集禁止) -->
<!-- 古いリスト -->
<!-- PROJECT_LIST_END -->

## タスク
- project: my-app
- why: 理由
- what: 作業
- done: 条件
`,
    );

    const projects = [
      { name: "app-a", path: "/tmp/app-a", type: "standalone" as const },
      { name: "parent/sub", path: "/tmp/parent/sub", type: "subproject" as const },
    ];

    const result = await adapter.updateProjectList(projects);
    expect(result).toBe(true);

    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("app-a");
    expect(content).toContain("parent/sub");
    expect(content).toContain("自動更新");
    expect(content).not.toContain("古いリスト");
    // タスク部分は保持される
    expect(content).toContain("## タスク");
    expect(content).toContain("- project: my-app");
  });

  it("マーカーがなければfalseを返す", async () => {
    await writeFile(filePath, `# Tasks\n\n## タスク\n- project: my-app\n`);

    const result = await adapter.updateProjectList([]);
    expect(result).toBe(false);
  });

  it("ファイルが存在しなければfalseを返す", async () => {
    const result = await adapter.updateProjectList([]);
    expect(result).toBe(false);
  });

  it("空のプロジェクトリストでも更新される", async () => {
    await writeFile(
      filePath,
      `<!-- PROJECT_LIST_START -->
<!-- old -->
<!-- PROJECT_LIST_END -->`,
    );

    const result = await adapter.updateProjectList([]);
    expect(result).toBe(true);

    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("PROJECT_LIST_START");
    expect(content).toContain("PROJECT_LIST_END");
    expect(content).not.toContain("old");
  });

  it("既存タスクに影響を与えない", async () => {
    await writeFile(
      filePath,
      `# Tasks

<!-- PROJECT_LIST_START -->
<!-- old list -->
<!-- PROJECT_LIST_END -->

## 重要タスク
- project: critical-app
- why: セキュリティ
- what: 脆弱性修正
- done: テスト通過
- status: in-progress

## 次タスク
- project: other-app
- why: 改善
- what: リファクタ
- done: ビルド通過
`,
    );

    const projects = [
      { name: "new-app", path: "/tmp/new-app", type: "standalone" as const },
    ];

    await adapter.updateProjectList(projects);

    const content = await readFile(filePath, "utf-8");
    // タスク内容が完全に保持されている
    expect(content).toContain("## 重要タスク");
    expect(content).toContain("- project: critical-app");
    expect(content).toContain("- status: in-progress");
    expect(content).toContain("## 次タスク");
    expect(content).toContain("- what: リファクタ");

    // パーサーでも正常に読み取れる
    const tasks = adapter.parse(content);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].what).toBe("脆弱性修正");
    expect(tasks[1].what).toBe("リファクタ");
  });
});
