import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { kindForName, convertUpload, type Converted } from "./convert.js";

export interface FolderFile extends Converted {
  path: string;
  bytes: number;
}

export interface FolderScan {
  files: FolderFile[];
  skipped: { path: string; reason: string }[];
}

const IGNORED_DIRECTORIES = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "target",
  ".next", ".nuxt", ".cache", ".turbo", "coverage", "__pycache__", ".venv",
  "venv", ".idea", ".vscode", ".pnpm-store", "vendor", ".DS_Store",
]);

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 4000;

export const scanFolder = async (root: string): Promise<FolderScan> => {
  const files: FolderFile[] = [];
  const skipped: FolderScan["skipped"] = [];
  const queue = [root];
  while (queue.length > 0 && files.length < MAX_FILES) {
    const directory = queue.shift() as string;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (cause) {
      skipped.push({ path: relative(root, directory), reason: String(cause) });
      continue;
    }

    for (const entry of entries) {
      const path = join(directory, entry.name);
      const shown = relative(root, path).split(sep).join("/");
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) {
          queue.push(path);
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const kind = kindForName(entry.name);
      const extensionless = !entry.name.includes(".");
      if (kind === null || (extensionless && !/^(README|LICENSE|Makefile|Dockerfile)/iu.test(entry.name))) {
        skipped.push({ path: shown, reason: "unsupported file type" });
        continue;
      }

      const info = await stat(path);
      if (info.size > MAX_FILE_BYTES) {
        skipped.push({ path: shown, reason: "larger than 1 MB" });
        continue;
      }

      try {
        const converted = await convertUpload(entry.name, await readFile(path));
        if (converted.text.trim() === "") {
          skipped.push({ path: shown, reason: "empty" });
          continue;
        }

        files.push({ ...converted, path: shown, bytes: info.size });
      } catch (cause) {
        skipped.push({ path: shown, reason: cause instanceof Error ? cause.message : String(cause) });
      }

      if (files.length >= MAX_FILES) {
        skipped.push({ path: shown, reason: `stopped after ${MAX_FILES} files` });
        break;
      }
    }
  }

  return { files: files.sort((one, other) => one.path.localeCompare(other.path)), skipped };
};
