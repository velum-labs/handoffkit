import { mkdir, open, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

export async function atomicWriteFile(path: string, data: string | Uint8Array): Promise<void> {
  const directory = dirname(path);
  await ensurePrivateDir(directory);
  const tempPath = join(directory, `.${randomUUID()}.tmp`);
  let fileHandle: Awaited<ReturnType<typeof open>> | null = null;

  try {
    fileHandle = await open(tempPath, "w", 0o600);
    await fileHandle.writeFile(data);
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = null;
    await rename(tempPath, path);
    await fsyncDirectory(directory);
  } finally {
    if (fileHandle) {
      await fileHandle.close().catch(() => {});
    }
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  let dirHandle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    dirHandle = await open(directory, "r");
    await dirHandle.sync();
  } catch {
    // Some platforms/filesystems do not allow fsync on directories.
  } finally {
    if (dirHandle) {
      await dirHandle.close().catch(() => {});
    }
  }
}
