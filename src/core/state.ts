import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fromRoot, type Workspace } from "../config/load.ts";

export type StateValue = string | number | boolean;
export type State = Record<string, StateValue>;

/**
 * Durable key/value state, shared across runs. Deliberately flat and JSON: agents read and
 * write it with their normal file tools, and a human can diff it.
 */
export async function readState(ws: Workspace): Promise<State> {
  try {
    const raw = await readFile(fromRoot(ws.root, ws.config.paths.state), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(([, value]) =>
        ["string", "number", "boolean"].includes(typeof value),
      ),
    ) as State;
  } catch {
    return {};
  }
}

export async function writeState(ws: Workspace, state: State): Promise<void> {
  const file = fromRoot(ws.root, ws.config.paths.state);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function setState(ws: Workspace, key: string, value: StateValue): Promise<State> {
  const state = await readState(ws);
  state[key] = value;
  await writeState(ws, state);
  return state;
}

export async function unsetState(ws: Workspace, key: string): Promise<State> {
  const state = await readState(ws);
  delete state[key];
  await writeState(ws, state);
  return state;
}
