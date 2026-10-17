import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface FastPreferences {
  load(): Promise<boolean>;
  save(fast: boolean): Promise<void>;
}

/** Only our own, bounded {fast:boolean} file is read; malformed files are never repaired. */
export function fileFastPreferences(resolvePath: () => string): FastPreferences {
  let path: string | undefined;
  const location = () => path ??= resolvePath();
  async function read(): Promise<{ text?: string; fast: boolean }> {
    try {
      const before = await lstat(location());
      if (!before.isFile() || before.isSymbolicLink() || before.size > 1024) throw new Error("Invalid preferences");
      const handle = await open(location(), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error("Preferences changed");
        const buffer = Buffer.alloc(1025);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 1024) throw new Error("Invalid preferences");
        const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
        const value: unknown = JSON.parse(text);
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 ||
            !("fast" in value) || typeof value.fast !== "boolean") throw new Error("Invalid preferences");
        return { text, fast: value.fast };
      } finally { await handle.close(); }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { fast: false };
      throw new Error("Fast preferences unavailable");
    }
  }
  return {
    async load() { return (await read()).fast; },
    async save(fast) {
      let temporary: string | undefined;
      try {
        const before = await read();
        await mkdir(dirname(location()), { recursive: true });
        temporary = join(dirname(location()), `.pi-toolkit-${randomUUID()}.tmp`);
        await writeFile(temporary, `${JSON.stringify({ fast })}\n`, { flag: "wx", mode: 0o600 });
        const latest = await read();
        if (latest.text !== before.text) throw new Error("Preferences changed");
        // Exclusive publication for first creation; atomic replacement for a validated file.
        if (before.text === undefined) await link(temporary, location());
        else await rename(temporary, location());
      } catch {
        throw new Error("Fast preferences could not be saved");
      } finally {
        if (temporary) await unlink(temporary).catch(() => {});
      }
    },
  };
}
