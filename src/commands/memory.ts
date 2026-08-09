import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { loadWorkspace } from "../config/load.ts";
import { addMemory, indexPath, listMemories, rebuildIndex } from "../core/memory.ts";
import { c, fail, log } from "../util/log.ts";

export async function listMemoryCommand(): Promise<void> {
  const ws = await loadWorkspace();
  const memories = await listMemories(ws);
  if (memories.length === 0) {
    log.warn(`Memory is empty (${ws.config.paths.memory})`);
    return;
  }

  const width = Math.max(...memories.map((memory) => memory.name.length));
  for (const memory of memories) {
    console.log(`${c.bold(memory.name.padEnd(width))}  ${c.magenta(memory.type.padEnd(12))} ${c.dim(memory.description)}`);
  }
  if (memories.length > ws.config.memory.maxEntries) {
    log.warn(
      `${memories.length} entries for a maximum of ${ws.config.memory.maxEntries}: ` +
        "merge or delete some. A memory nobody reads is not a memory.",
    );
  }
}

export async function showMemoryCommand(name: string): Promise<void> {
  const ws = await loadWorkspace();
  const memory = (await listMemories(ws)).find((entry) => entry.name === name);
  if (!memory) fail(`Unknown memory entry "${name}".`);
  console.log(await readFile(memory.file, "utf8"));
}

export async function addMemoryCommand(args: {
  name: string;
  description: string;
  type: string;
  body: string;
}): Promise<void> {
  const ws = await loadWorkspace();
  if (!args.body.trim()) fail("Empty body. Pipe it on stdin: `harness memory add <name> -d '...' < note.md`");

  const file = await addMemory(ws, {
    name: args.name,
    description: args.description,
    type: args.type,
    body: args.body,
  });
  log.ok(`added ${relative(ws.root, file)}`);
  log.detail(`index rebuilt: ${relative(ws.root, indexPath(ws))}`);
}

export async function syncMemoryCommand(): Promise<void> {
  const ws = await loadWorkspace();
  await rebuildIndex(ws);
  const memories = await listMemories(ws);
  log.ok(`index rebuilt (${memories.length} entries): ${relative(ws.root, indexPath(ws))}`);
}
