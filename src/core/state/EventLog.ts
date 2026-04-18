import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import type { AppEvent } from "../../types/app.ts";

export class EventLog {
  private readonly rootDir: string;
  private readonly fileName: string;

  constructor(rootDir: string, fileName: string) {
    this.rootDir = rootDir;
    this.fileName = fileName;
  }

  async append(event: AppEvent): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const target = path.join(this.rootDir, this.fileName);
    const line = JSON.stringify({
      recordedAt: new Date().toISOString(),
      event
    });

    await appendFile(target, `${line}\n`, "utf8");
  }
}
