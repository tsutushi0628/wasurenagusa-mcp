import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { loadPrompt } from "../analyzer/prompt-loader.js";
import { createGeminiModel } from "../analyzer/gemini-client.js";
import type { ProjectMeta, ProjectInitOutput } from "../types.js";

const DEFAULT_PROJECT_META: Omit<ProjectMeta, "project" | "projectPath" | "createdAt" | "updatedAt"> = {
  phase: "startup",
  qualityPolicy: "balanced",
  testExpectation: "standard",
  codeQuality: "balanced",
  debtTolerance: "moderate",
  aiAutonomy: "moderate",
  escalationTriggers: ["cost_impact", "user_facing", "architecture"],
  targetAudience: "b2c_consumer",
  successMetric: "user_engagement",
};

export class ProjectInitializer {
  private projectsDir: string;

  constructor(schedulerDir: string) {
    this.projectsDir = join(schedulerDir, "projects");
  }

  async generateQuestions(projectName: string, initialInfo?: string): Promise<ProjectInitOutput> {
    const template = await loadPrompt("project-initialize.txt");
    const prompt = template
      .replace(/\{project_name\}/g, projectName)
      .replace(/\{initial_info\}/g, initialInfo ?? "なし");

    const model = createGeminiModel();
    const result = await model.generateContent(prompt);
    const text = result.response.text();

    const jsonMatch = text.match(/\{[\s\S]*"questions"[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`Failed to parse project init response as JSON: ${text.slice(0, 200)}`);
    }

    return JSON.parse(jsonMatch[0]) as ProjectInitOutput;
  }

  async saveProjectMeta(
    projectName: string,
    projectPath: string,
    answers: Record<string, string>,
  ): Promise<ProjectMeta> {
    const now = new Date().toISOString();
    const meta: ProjectMeta = {
      project: projectName,
      projectPath,
      phase: (answers.phase as ProjectMeta["phase"]) ?? DEFAULT_PROJECT_META.phase,
      qualityPolicy: (answers.qualityPolicy as ProjectMeta["qualityPolicy"]) ?? DEFAULT_PROJECT_META.qualityPolicy,
      testExpectation: (answers.testExpectation as ProjectMeta["testExpectation"]) ?? DEFAULT_PROJECT_META.testExpectation,
      codeQuality: (answers.codeQuality as ProjectMeta["codeQuality"]) ?? DEFAULT_PROJECT_META.codeQuality,
      debtTolerance: (answers.debtTolerance as ProjectMeta["debtTolerance"]) ?? DEFAULT_PROJECT_META.debtTolerance,
      aiAutonomy: (answers.aiAutonomy as ProjectMeta["aiAutonomy"]) ?? DEFAULT_PROJECT_META.aiAutonomy,
      escalationTriggers: answers.escalationTriggers
        ? answers.escalationTriggers.split(",").map((s) => s.trim())
        : DEFAULT_PROJECT_META.escalationTriggers,
      targetAudience: answers.targetAudience ?? DEFAULT_PROJECT_META.targetAudience,
      successMetric: answers.successMetric ?? DEFAULT_PROJECT_META.successMetric,
      createdAt: now,
      updatedAt: now,
    };

    await this.writeMetaFile(projectName, meta);
    return meta;
  }

  async loadProjectMeta(projectName: string): Promise<ProjectMeta | null> {
    const metaPath = this.getMetaPath(projectName);
    try {
      const content = await readFile(metaPath, "utf-8");
      return JSON.parse(content) as ProjectMeta;
    } catch {
      return null;
    }
  }

  async loadProjectMetaOrDefault(projectName: string, projectPath: string): Promise<ProjectMeta> {
    const existing = await this.loadProjectMeta(projectName);
    if (existing) {
      return existing;
    }
    const now = new Date().toISOString();
    return {
      project: projectName,
      projectPath,
      ...DEFAULT_PROJECT_META,
      createdAt: now,
      updatedAt: now,
    };
  }

  async updateProjectMeta(projectName: string, updates: Partial<ProjectMeta>): Promise<ProjectMeta> {
    const existing = await this.loadProjectMeta(projectName);
    if (!existing) {
      throw new Error(`Project meta not found: ${projectName}`);
    }
    const updated: ProjectMeta = {
      ...existing,
      ...updates,
      project: existing.project,
      projectPath: existing.projectPath,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await this.writeMetaFile(projectName, updated);
    return updated;
  }

  private getMetaPath(projectName: string): string {
    return join(this.projectsDir, projectName, "meta.json");
  }

  private async writeMetaFile(projectName: string, meta: ProjectMeta): Promise<void> {
    const metaPath = this.getMetaPath(projectName);
    await mkdir(dirname(metaPath), { recursive: true });
    await writeFile(metaPath, JSON.stringify(meta, null, 2));
  }
}
