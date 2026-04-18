import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppSnapshot } from "../../types/app.ts";

export class SnapshotStore {
  private readonly rootDir: string;
  private readonly fileName: string;

  constructor(rootDir: string, fileName: string) {
    this.rootDir = rootDir;
    this.fileName = fileName;
  }

  async load(): Promise<AppSnapshot | null> {
    try {
      const target = path.join(this.rootDir, this.fileName);
      const content = await readFile(target, "utf8");
      return JSON.parse(content) as AppSnapshot;
    } catch {
      return null;
    }
  }

  async save(snapshot: AppSnapshot): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const target = path.join(this.rootDir, this.fileName);
    await writeFile(target, JSON.stringify(snapshot, null, 2), "utf8");
  }
}
