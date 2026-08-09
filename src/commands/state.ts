import { relative } from "node:path";
import { fromRoot, loadWorkspace } from "../config/load.ts";
import { readState, setState, unsetState } from "../core/state.ts";
import { c, log } from "../util/log.ts";

/** `42` and `true` are stored as a number and a boolean, so `{{ state.x }}` reads naturally. */
function coerce(raw: string): string | number | boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  const asNumber = Number(raw);
  return raw.trim() !== "" && Number.isFinite(asNumber) ? asNumber : raw;
}

export async function listStateCommand(): Promise<void> {
  const ws = await loadWorkspace();
  const state = await readState(ws);
  const keys = Object.keys(state).sort();

  if (keys.length === 0) {
    log.warn(`State is empty (${ws.config.paths.state})`);
    return;
  }
  const width = Math.max(...keys.map((key) => key.length));
  for (const key of keys) console.log(`${c.bold(key.padEnd(width))}  ${String(state[key])}`);
  log.detail(`usable in any prompt: {{ state.${keys[0]} }}`);
}

export async function setStateCommand(key: string, value: string): Promise<void> {
  const ws = await loadWorkspace();
  await setState(ws, key, coerce(value));
  log.ok(`${key} = ${value} (${relative(ws.root, fromRoot(ws.root, ws.config.paths.state))})`);
}

export async function unsetStateCommand(key: string): Promise<void> {
  const ws = await loadWorkspace();
  await unsetState(ws, key);
  log.ok(`${key} removed`);
}
