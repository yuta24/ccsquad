import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EntryStore } from "../src/entry.js";
import { cmdAdd, cmdList, cmdShow, cmdEdit, cmdDelete, cmdSearch } from "../src/commands/memory.js";

function tempStore(): { store: EntryStore; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ccsquad-cmd-memory-"));
  const store = new EntryStore(dir);
  store.ensureDir();
  return {
    store,
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ─── cmdAdd ──────────────────────────────────────────────────────────────────

describe("cmdAdd", () => {
  it("test_add_entry_with_title_and_body", () => {
    const { store, cleanup } = tempStore();
    try {
      const logs: string[] = [];
      const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.join(" "));
      });
      try {
        cmdAdd(store, "テスト", undefined, "本文テキスト");
        const entry = store.load("テスト");
        expect(entry.title).toBe("テスト");
        expect(entry.body).toBe("本文テキスト");
        expect(entry.frontmatter.type).toBeUndefined();
        expect(logs.some((l) => l.includes("テスト"))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    } finally {
      cleanup();
    }
  });

  it("test_add_entry_with_type", () => {
    const { store, cleanup } = tempStore();
    try {
      const spy = spyOn(console, "log").mockImplementation(() => {});
      try {
        cmdAdd(store, "設計決定", "decision", "決定内容");
        const entry = store.load("decision/設計決定");
        expect(entry.title).toBe("設計決定");
        expect(entry.frontmatter.type).toBe("decision");
        expect(entry.body).toBe("決定内容");
      } finally {
        spy.mockRestore();
      }
    } finally {
      cleanup();
    }
  });

  it("test_add_entry_without_body", () => {
    const { store, cleanup } = tempStore();
    try {
      const spy = spyOn(console, "log").mockImplementation(() => {});
      try {
        cmdAdd(store, "本文なし");
        const entry = store.load("本文なし");
        expect(entry.title).toBe("本文なし");
        expect(entry.body).toBe("");
      } finally {
        spy.mockRestore();
      }
    } finally {
      cleanup();
    }
  });
});

// ─── cmdList ──────────────────────────────────────────────────────────────────

describe("cmdList", () => {
  it("test_list_entries_in_text_format", () => {
    const { store, cleanup } = tempStore();
    try {
      const spy = spyOn(console, "log").mockImplementation(() => {});
      try {
        cmdAdd(store, "エントリ1", undefined, "本文1");
        spy.mockClear();
        cmdList(store, undefined, "text");
        const calls = spy.mock.calls.map((c) => (c as unknown[]).join(" "));
        expect(calls.some((l) => l.includes("エントリ1"))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    } finally {
      cleanup();
    }
  });

  it("test_list_entries_in_json_format", () => {
    const { store, cleanup } = tempStore();
    try {
      const logs: string[] = [];
      const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.join(" "));
      });
      try {
        cmdAdd(store, "JSONエントリ", undefined, "本文");
        logs.length = 0;
        cmdList(store, undefined, "json");
        const output = logs.join("\n");
        const parsed = JSON.parse(output);
        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed.length).toBe(1);
        expect(parsed[0].title).toBe("JSONエントリ");
      } finally {
        spy.mockRestore();
      }
    } finally {
      cleanup();
    }
  });

  it("test_list_with_type_filter", () => {
    const { store, cleanup } = tempStore();
    try {
      const logs: string[] = [];
      const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.join(" "));
      });
      try {
        cmdAdd(store, "ノート1", "note", "本文");
        cmdAdd(store, "決定1", "decision", "本文");
        logs.length = 0;
        cmdList(store, "note", "json");
        const output = logs.join("\n");
        const parsed = JSON.parse(output);
        expect(parsed.length).toBe(1);
        expect(parsed[0].type).toBe("note");
      } finally {
        spy.mockRestore();
      }
    } finally {
      cleanup();
    }
  });

  it("test_list_when_empty", () => {
    const { store, cleanup } = tempStore();
    try {
      const logs: string[] = [];
      const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.join(" "));
      });
      try {
        cmdList(store, undefined, "text");
        expect(logs.some((l) => l.includes("ありません"))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    } finally {
      cleanup();
    }
  });
});

// ─── cmdShow ──────────────────────────────────────────────────────────────────

describe("cmdShow", () => {
  it("test_show_entry_in_text_format", () => {
    const { store, cleanup } = tempStore();
    try {
      const logs: string[] = [];
      const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.join(" "));
      });
      try {
        cmdAdd(store, "表示テスト", undefined, "本文テキスト");
        logs.length = 0;
        cmdShow(store, "表示テスト", "text");
        expect(logs.some((l) => l.includes("表示テスト"))).toBe(true);
        expect(logs.some((l) => l.includes("タイトル"))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    } finally {
      cleanup();
    }
  });

  it("test_show_entry_in_json_format", () => {
    const { store, cleanup } = tempStore();
    try {
      const logs: string[] = [];
      const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.join(" "));
      });
      try {
        cmdAdd(store, "JSON表示", "note", "JSON本文");
        logs.length = 0;
        cmdShow(store, "note/JSON表示", "json");
        const output = logs.join("\n");
        const parsed = JSON.parse(output);
        expect(parsed.title).toBe("JSON表示");
        expect(parsed.type).toBe("note");
        expect(parsed.body).toBe("JSON本文");
        expect(parsed.key).toBe("note/JSON表示");
      } finally {
        spy.mockRestore();
      }
    } finally {
      cleanup();
    }
  });

  it("test_show_nonexistent_entry_throws", () => {
    const { store, cleanup } = tempStore();
    try {
      expect(() => cmdShow(store, "存在しないキー")).toThrow();
    } finally {
      cleanup();
    }
  });
});

// ─── cmdEdit ──────────────────────────────────────────────────────────────────

describe("cmdEdit", () => {
  it("test_edit_title", () => {
    const { store, cleanup } = tempStore();
    try {
      const spy = spyOn(console, "log").mockImplementation(() => {});
      try {
        cmdAdd(store, "旧タイトル", undefined, "本文");
        cmdEdit(store, "旧タイトル", "新タイトル");
        const entry = store.load("新タイトル");
        expect(entry.title).toBe("新タイトル");
        expect(entry.body).toBe("本文");
      } finally {
        spy.mockRestore();
      }
    } finally {
      cleanup();
    }
  });

  it("test_edit_body", () => {
    const { store, cleanup } = tempStore();
    try {
      const spy = spyOn(console, "log").mockImplementation(() => {});
      try {
        cmdAdd(store, "本文編集テスト", undefined, "旧本文");
        cmdEdit(store, "本文編集テスト", undefined, undefined, false, "新本文");
        const entry = store.load("本文編集テスト");
        expect(entry.body).toBe("新本文");
      } finally {
        spy.mockRestore();
      }
    } finally {
      cleanup();
    }
  });

  it("test_edit_type", () => {
    const { store, cleanup } = tempStore();
    try {
      const spy = spyOn(console, "log").mockImplementation(() => {});
      try {
        cmdAdd(store, "タイプ変更テスト", "note", "本文");
        cmdEdit(store, "note/タイプ変更テスト", undefined, "decision");
        const entry = store.load("decision/タイプ変更テスト");
        expect(entry.frontmatter.type).toBe("decision");
      } finally {
        spy.mockRestore();
      }
    } finally {
      cleanup();
    }
  });
});

// ─── cmdDelete ────────────────────────────────────────────────────────────────

describe("cmdDelete", () => {
  it("test_delete_existing_entry", () => {
    const { store, cleanup } = tempStore();
    try {
      const logs: string[] = [];
      const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.join(" "));
      });
      try {
        cmdAdd(store, "削除対象", undefined, "本文");
        logs.length = 0;
        cmdDelete(store, "削除対象");
        expect(logs.some((l) => l.includes("削除しました"))).toBe(true);
        expect(() => store.load("削除対象")).toThrow();
      } finally {
        spy.mockRestore();
      }
    } finally {
      cleanup();
    }
  });

  it("test_delete_nonexistent_entry_throws", () => {
    const { store, cleanup } = tempStore();
    try {
      expect(() => cmdDelete(store, "存在しない")).toThrow();
    } finally {
      cleanup();
    }
  });
});

// ─── cmdSearch ────────────────────────────────────────────────────────────────

describe("cmdSearch", () => {
  it("test_search_finds_matching_entry_by_title", () => {
    const { store, cleanup } = tempStore();
    try {
      const logs: string[] = [];
      const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.join(" "));
      });
      try {
        cmdAdd(store, "認証方式", undefined, "詳細");
        cmdAdd(store, "DB設計", undefined, "テーブル");
        logs.length = 0;
        cmdSearch(store, "認証", undefined, "text");
        expect(logs.some((l) => l.includes("認証方式"))).toBe(true);
        expect(logs.every((l) => !l.includes("DB設計"))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    } finally {
      cleanup();
    }
  });

  it("test_search_finds_matching_entry_by_body", () => {
    const { store, cleanup } = tempStore();
    try {
      const logs: string[] = [];
      const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.join(" "));
      });
      try {
        cmdAdd(store, "設計メモ", undefined, "JWTトークンを使う");
        cmdAdd(store, "別のメモ", undefined, "セッション管理");
        logs.length = 0;
        cmdSearch(store, "JWT", undefined, "text");
        expect(logs.some((l) => l.includes("設計メモ"))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    } finally {
      cleanup();
    }
  });

  it("test_search_with_type_filter", () => {
    const { store, cleanup } = tempStore();
    try {
      const logs: string[] = [];
      const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.join(" "));
      });
      try {
        cmdAdd(store, "認証", "decision", "JWT");
        cmdAdd(store, "認証メモ", "note", "JWT関連");
        logs.length = 0;
        cmdSearch(store, "JWT", "decision", "json");
        const output = logs.join("\n");
        const parsed = JSON.parse(output);
        expect(parsed.length).toBe(1);
        expect(parsed[0].type).toBe("decision");
      } finally {
        spy.mockRestore();
      }
    } finally {
      cleanup();
    }
  });

  it("test_search_with_no_matches_returns_empty", () => {
    const { store, cleanup } = tempStore();
    try {
      const logs: string[] = [];
      const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.join(" "));
      });
      try {
        cmdAdd(store, "認証方式", undefined, "JWT");
        logs.length = 0;
        cmdSearch(store, "GraphQL", undefined, "text");
        expect(logs.some((l) => l.includes("ありません"))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    } finally {
      cleanup();
    }
  });
});
