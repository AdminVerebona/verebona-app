/**
 * Registre des outils — CDC Assistant §4.3.4.
 *
 * Le registre contrôle au chargement que chaque outil respecte les invariants
 * du port : nom unique, description exploitable par le modèle, et absence de
 * verbe d'écriture dans le nom. Un outil non conforme fait échouer le
 * démarrage plutôt que d'être découvert en production.
 */
import type { AssistantTool, ToolContext, ToolResult } from './tool.port';
import { ALL_READ_TOOLS } from './read-tools';

const registry = new Map<string, AssistantTool<never, unknown>>();

/** Verbes trahissant une mutation — un outil d'assistant n'écrit jamais. */
const WRITE_VERBS = /^(create|update|delete|set|write|save|remove|add|send|post|patch)/i;

export function registerTool(tool: AssistantTool<never, unknown>): void {
  if (registry.has(tool.name)) {
    throw new Error(`[assistant-tools] Outil « ${tool.name} » déjà enregistré.`);
  }
  if (WRITE_VERBS.test(tool.name)) {
    throw new Error(
      `[assistant-tools] « ${tool.name} » suggère une écriture. ` +
      "L'assistant est strictement en lecture seule (CDC §4.3.3).",
    );
  }
  if (!tool.description || tool.description.length < 10) {
    throw new Error(`[assistant-tools] « ${tool.name} » : description insuffisante pour la sélection.`);
  }
  registry.set(tool.name, tool);
}

export function registerReadTools(): void {
  registry.clear();
  for (const tool of ALL_READ_TOOLS) {
    registerTool(tool as unknown as AssistantTool<never, unknown>);
  }
}

export function getTool(name: string): AssistantTool<never, unknown> | null {
  return registry.get(name) ?? null;
}

export function listTools(): AssistantTool<never, unknown>[] {
  return [...registry.values()];
}

/** Catalogue transmis au modèle pour la sélection — noms et descriptions seuls. */
export function describeToolsForModel(): string {
  return listTools()
    .map((t) => {
      const params = Object.entries(t.parameters)
        .map(([k, v]) => `${k} (${v})`).join(', ');
      return `- ${t.name} : ${t.description}${params ? ` | paramètres : ${params}` : ''}`;
    })
    .join('\n');
}

/** Exécute un outil sélectionné. Un nom inconnu n'est jamais deviné. */
export async function executeTool(
  name: string,
  params: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult<unknown>> {
  const tool = getTool(name);
  if (!tool) {
    throw new Error(`[assistant-tools] Outil inconnu « ${name} » — sélection refusée.`);
  }
  return tool.execute(params as never, ctx);
}
