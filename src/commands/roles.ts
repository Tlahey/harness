import { loadWorkspace, requireRole, resolveModel } from "../config/load.ts";
import { buildSystemPrompt } from "../opencode/generate.ts";
import { c, log } from "../util/log.ts";

export async function listRoles(): Promise<void> {
  const ws = await loadWorkspace();
  if (ws.roles.size === 0) {
    log.warn(`No roles found in ${ws.config.paths.roles}`);
    return;
  }
  const width = Math.max(...[...ws.roles.keys()].map((n) => n.length));
  for (const role of ws.roles.values()) {
    const model = role.disabled ? "disabled" : resolveModel(ws.config, role.model);
    const name = role.disabled ? c.dim(role.name.padEnd(width)) : c.bold(role.name.padEnd(width));
    console.log(`${name}  ${c.magenta(model.padEnd(32))} ${c.dim(role.description)}`);
  }
}

export async function showRole(name: string, opts: { prompt: boolean }): Promise<void> {
  const ws = await loadWorkspace();
  const role = requireRole(ws, name);

  if (opts.prompt) {
    console.log(await buildSystemPrompt(ws, role));
    return;
  }

  console.log(`${c.bold(role.name)} ${c.dim(`(${role.mode})`)}`);
  console.log(`  model        ${resolveModel(ws.config, role.model)}`);
  console.log(`  temperature  ${role.temperature ?? ws.config.defaults.temperature ?? "(provider default)"}`);
  console.log(`  tools        ${JSON.stringify({ ...ws.config.defaults.tools, ...role.tools })}`);
  console.log(`  permission   ${JSON.stringify({ ...ws.config.defaults.permission, ...role.permission })}`);
  console.log(`  outputs      ${role.outputs.join(", ") || "(none declared)"}`);
  console.log(`  description  ${role.description}`);
  console.log(c.dim(`\n  harness roles show ${role.name} --prompt   # the full system prompt`));
}
