import { homedir } from "node:os";
import { join } from "node:path";
import { SERVER_NAME } from "../config.js";
import { sha256Hex } from "../utils/hash.js";

export interface CachePaths {
  root: string;
  tmpDir: string;
  account: string;
  tags: string;
  searchDir: string;
  search(queryKey: string): string;
  itemDir(itemId: string): string;
  itemMetadata(itemId: string): string;
  itemMarkdown(itemId: string): string;
  itemMarkdownMeta(itemId: string): string;
  itemAnnotations(itemId: string): string;
}

export function defaultCacheDir(): string {
  return join(homedir(), ".cache", SERVER_NAME);
}

export function createCachePaths(root = defaultCacheDir()): CachePaths {
  const searchDir = join(root, "search");
  const tmpDir = join(root, "tmp");

  return {
    root,
    tmpDir,
    account: join(root, "account.json"),
    tags: join(root, "tags.json"),
    searchDir,
    search: (queryKey) => join(searchDir, `${sha256Hex(queryKey)}.json`),
    itemDir: (itemId) => join(root, "items", itemId),
    itemMetadata: (itemId) => join(root, "items", itemId, "metadata.json"),
    itemMarkdown: (itemId) => join(root, "items", itemId, "markdown.md"),
    itemMarkdownMeta: (itemId) => join(root, "items", itemId, "markdown-meta.json"),
    itemAnnotations: (itemId) => join(root, "items", itemId, "annotations.json")
  };
}
