import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";

interface ThemeRegistryData {
  themes: string[];
  updatedAt: string;
}

function nowJST(): string {
  return new Date().toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" }).replace(" ", "T") + "+09:00";
}

export class ThemeRegistry {
  private filePath: string;

  constructor(memoryPath: string) {
    this.filePath = join(memoryPath, "themes.json");
  }

  async getThemes(): Promise<string[]> {
    const data = await this.load();
    return data.themes;
  }

  async addThemes(themes: string[]): Promise<void> {
    const data = await this.load();
    const existing = new Set(data.themes);
    for (const theme of themes) {
      existing.add(theme);
    }
    data.themes = [...existing];
    data.updatedAt = nowJST();
    await this.save(data);
  }

  async isNewTheme(theme: string): Promise<boolean> {
    const data = await this.load();
    return !data.themes.includes(theme);
  }

  private async load(): Promise<ThemeRegistryData> {
    try {
      const content = await readFile(this.filePath, "utf-8");
      return JSON.parse(content);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { themes: [], updatedAt: nowJST() };
      }
      throw error;
    }
  }

  private async save(data: ThemeRegistryData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(data, null, 2), "utf-8");
  }
}
