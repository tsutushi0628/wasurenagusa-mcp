import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import type { HumanActionItem } from "../types.js";

export class ActionList {
  private filePath: string;

  constructor(schedulerDir: string) {
    this.filePath = join(schedulerDir, "action-list.json");
  }

  async add(item: HumanActionItem): Promise<void> {
    const items = await this.loadItems();
    items.push(item);
    await this.saveItems(items);
  }

  async getAll(): Promise<HumanActionItem[]> {
    return await this.loadItems();
  }

  async resolve(taskId: string): Promise<void> {
    const items = await this.loadItems();
    const filtered = items.filter((item) => item.taskId !== taskId);
    await this.saveItems(filtered);
  }

  private async loadItems(): Promise<HumanActionItem[]> {
    try {
      const content = await readFile(this.filePath, "utf-8");
      return JSON.parse(content) as HumanActionItem[];
    } catch {
      return [];
    }
  }

  private async saveItems(items: HumanActionItem[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(items, null, 2));
  }
}
