import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  rmdirSync,
  existsSync,
  statSync,
} from "fs";
import { join, dirname } from "path";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { CcsquadError } from "../error.js";
import { parse as parseFrontmatter, write as writeFrontmatter } from "./frontmatter.js";
import type { MemoryEntry, MemoryFrontmatter } from "../domain/types.js";

export function entryKey(entry: MemoryEntry): string {
  if (entry.frontmatter.type) {
    return `${entry.frontmatter.type}/${entry.title}`;
  }
  return entry.title;
}

function validateName(name: string): void {
  if (name.length === 0) {
    throw new CcsquadError("memory", "名前が空です");
  }
  const forbidden = ["/", "\0", "\\"];
  for (const ch of forbidden) {
    if (name.includes(ch)) {
      throw new CcsquadError("memory", `名前に禁止文字 '${ch}' が含まれています: ${name}`);
    }
  }
}

function serializeFrontmatter(fm: MemoryFrontmatter): string {
  const obj: Record<string, string> = {};
  if (fm.type !== undefined) {
    obj["type"] = fm.type;
  }
  obj["created_at"] = fm.created_at;
  obj["updated_at"] = fm.updated_at;
  return yamlStringify(obj).trimEnd();
}

export class EntryStore {
  constructor(private baseDir: string) {}

  ensureDir(): void {
    mkdirSync(this.baseDir, { recursive: true });
  }

  private filePath(title: string, entryType: string | undefined): string {
    if (entryType !== undefined) {
      return join(this.baseDir, entryType, `${title}.md`);
    }
    return join(this.baseDir, `${title}.md`);
  }

  private filePathFromKey(key: string): string {
    return join(this.baseDir, `${key}.md`);
  }

  private parseKey(key: string): { entryType: string | undefined; title: string } {
    const lastSlash = key.lastIndexOf("/");
    if (lastSlash !== -1) {
      return {
        entryType: key.slice(0, lastSlash),
        title: key.slice(lastSlash + 1),
      };
    }
    return { entryType: undefined, title: key };
  }

  save(entry: MemoryEntry): void {
    validateName(entry.title);
    if (entry.frontmatter.type !== undefined) {
      validateName(entry.frontmatter.type);
    }

    const path = this.filePath(entry.title, entry.frontmatter.type);

    if (existsSync(path)) {
      throw new CcsquadError("memory", `エントリ '${entryKey(entry)}' は既に存在します`);
    }

    const parent = dirname(path);
    mkdirSync(parent, { recursive: true });

    const yaml = serializeFrontmatter(entry.frontmatter);
    const content = writeFrontmatter(yaml, entry.body);
    writeFileSync(path, content, "utf8");
  }

  overwrite(entry: MemoryEntry): void {
    validateName(entry.title);
    if (entry.frontmatter.type !== undefined) {
      validateName(entry.frontmatter.type);
    }

    const path = this.filePath(entry.title, entry.frontmatter.type);

    const parent = dirname(path);
    mkdirSync(parent, { recursive: true });

    const yaml = serializeFrontmatter(entry.frontmatter);
    const content = writeFrontmatter(yaml, entry.body);
    writeFileSync(path, content, "utf8");
  }

  load(key: string): MemoryEntry {
    const path = this.filePathFromKey(key);

    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new CcsquadError("memory", `エントリ '${key}' が見つかりません`);
      }
      throw new CcsquadError("io", String(err.message));
    }

    const { yaml, body } = parseFrontmatter(content);
    const rawParsed = yamlParse(yaml);

    if (!rawParsed || typeof rawParsed !== "object") {
      throw new CcsquadError("serialization", `エントリ '${key}' の frontmatter が不正です: オブジェクトではありません`);
    }

    const parsed = rawParsed as Record<string, unknown>;
    if (typeof parsed["created_at"] !== "string") {
      throw new CcsquadError("serialization", `エントリ '${key}' の frontmatter が不正です: created_at が文字列ではありません`);
    }
    if (typeof parsed["updated_at"] !== "string") {
      throw new CcsquadError("serialization", `エントリ '${key}' の frontmatter が不正です: updated_at が文字列ではありません`);
    }

    const fm: MemoryFrontmatter = {
      type: parsed["type"] as string | undefined,
      created_at: parsed["created_at"] as string,
      updated_at: parsed["updated_at"] as string,
    };

    const { title } = this.parseKey(key);

    return { title, frontmatter: fm, body };
  }

  listAll(): MemoryEntry[] {
    const entries: MemoryEntry[] = [];

    if (!existsSync(this.baseDir)) {
      return entries;
    }

    const items = readdirSync(this.baseDir);
    for (const name of items) {
      const fullPath = join(this.baseDir, name);
      const stat = statSync(fullPath);

      if (stat.isFile() && name.endsWith(".md")) {
        const title = name.slice(0, -3);
        try {
          entries.push(this.load(title));
        } catch {
          // skip unreadable entries
        }
      } else if (stat.isDirectory()) {
        const typeName = name;
        const subItems = readdirSync(fullPath);
        for (const subName of subItems) {
          if (subName.endsWith(".md")) {
            const title = subName.slice(0, -3);
            const key = `${typeName}/${title}`;
            try {
              entries.push(this.load(key));
            } catch {
              // skip unreadable entries
            }
          }
        }
      }
    }

    entries.sort((a, b) => {
      const ta = a.frontmatter.created_at;
      const tb = b.frontmatter.created_at;
      if (tb > ta) return 1;
      if (tb < ta) return -1;
      return 0;
    });

    return entries;
  }

  delete(key: string): void {
    const path = this.filePathFromKey(key);

    try {
      unlinkSync(path);
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new CcsquadError("memory", `エントリ '${key}' が見つかりません`);
      }
      throw new CcsquadError("io", String(err.message));
    }

    const parent = dirname(path);
    if (parent !== this.baseDir) {
      try {
        const remaining = readdirSync(parent);
        if (remaining.length === 0) {
          rmdirSync(parent);
        }
      } catch {
        // ignore cleanup errors
      }
    }
  }

  search(query: string, entryType?: string): MemoryEntry[] {
    const all = this.listAll();
    const queryLower = query.toLowerCase();

    return all.filter((entry) => {
      if (entryType !== undefined) {
        if (entry.frontmatter.type !== entryType) {
          return false;
        }
      }
      return (
        entry.title.toLowerCase().includes(queryLower) ||
        entry.body.toLowerCase().includes(queryLower)
      );
    });
  }
}
