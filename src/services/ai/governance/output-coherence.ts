/**
 * Validateur de cohérence prompt ↔ schéma ↔ adaptateurs — lot 33D (ticket
 * « réussite malgré les désalignements », §16, §24, §26).
 *
 * Exécuté au démarrage (tâche planifiée interne `ai-output-coherence-check`)
 * et dans les tests. Pour chaque opération master :
 *   · le contrat de sortie existe, est versionné, a une empreinte ;
 *   · le schéma FOURNISSEUR dérivé (structured output) : transmis ou omis
 *     (trop complexe), contraintes non transmissibles (vérifiées par
 *     Verebona) ;
 *   · les EXEMPLES JSON du prompt (texte du dépôt ET texte actif du BO s'il
 *     diffère) passent-ils la résolution des sorties ? Si non : chemins en
 *     cause ; si oui après correction : règles nécessaires ; champs de
 *     l'exemple absents du schéma (perdus au mapping).
 *
 * DIAGNOSTIC SEULEMENT : rien n'est bloqué. Un désalignement détecté dit
 * quelle adaptation est nécessaire ; la résolution des sorties l'absorbe à
 * l'exécution quand c'est possible sans ambiguïté.
 */
import type { ZodType } from 'zod';
import { AI_OPERATIONS, isMasterOperation } from '../registry/operations';
import { masterOutputSchemaFor } from '../gateway/master-output-schemas';
import { contractFor, outputSchemaRef } from '../gateway/output-resolution/contracts';
import { providerJsonSchema } from '../gateway/output-resolution/provider-schema';
import { balancedSlice } from '../gateway/output-resolution/json-repair';
import { resolveOutput } from '../gateway/output-resolution/resolve-output';
import { describe, resolveUnion, type FieldDesc } from '../gateway/output-resolution/schema-introspect';

export type CoherenceSeverity = 'info' | 'warning';

export interface CoherenceFinding {
  code:
    | 'SCHEMA_MISSING' | 'CONTRACT_UNVERSIONED' | 'PROVIDER_SCHEMA_OMITTED' | 'PROVIDER_SCHEMA_REDUCED'
    | 'PROMPT_EXAMPLE_INVALID' | 'PROMPT_EXAMPLE_NORMALIZED' | 'PROMPT_FIELD_NOT_IN_SCHEMA' | 'PROMPT_NO_EXAMPLE';
  severity: CoherenceSeverity;
  source: 'contract' | 'repo' | 'bo';
  message: string;
}

export interface OperationCoherence {
  operationCode: string;
  task: string;
  schema: string | null;
  contract: string | null;
  findings: CoherenceFinding[];
}

/** Section de la branche dans le texte du master (jusqu'à la branche suivante). */
export function branchSection(text: string, task: string, discriminant: 'TASK' | 'MODE'): string | null {
  const re = new RegExp(`BRANCHE\\s+${discriminant}\\s*=\\s*${task}\\b`);
  const m = re.exec(text);
  if (!m) return null;
  const reste = text.slice(m.index + m[0].length);
  const next = /\n\s*BRANCHE\s+(?:TASK|MODE)\s*=/.exec(reste);
  return next ? reste.slice(0, next.index) : reste;
}

/** Objets JSON d'exemple d'un texte (accolade en début de ligne, structure équilibrée et parsable). */
export function jsonExamples(section: string): unknown[] {
  const out: unknown[] = [];
  const re = /(^|\n)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) !== null) {
    const start = section.indexOf('{', m.index);
    const slice = balancedSlice(section, start);
    if (!slice) continue;
    try {
      out.push(JSON.parse(slice));
      re.lastIndex = start + slice.length;
    } catch { /* gabarit non JSON (« {...} ») : ignoré */ }
  }
  return out;
}

/**
 * Notation de gabarit des prompts : `"exact|probable|ambiguous"` liste les
 * valeurs permises, ce n'est pas une valeur. Remplacée par sa première
 * alternative avant contrôle.
 */
export function expandTemplateValues(v: unknown): unknown {
  if (typeof v === 'string' && /^[\w-]+(\|[\w-]+)+$/.test(v)) return v.split('|')[0];
  if (Array.isArray(v)) return v.map(expandTemplateValues);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, expandTemplateValues(x)]));
  return v;
}

/** Clés d'un exemple absentes du schéma (elles seraient ignorées au mapping). */
export function unknownKeys(value: unknown, desc: FieldDesc, path = '$', out: string[] = []): string[] {
  const d = resolveUnion(desc, value);
  if (d.node.kind === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const f = d.node.shape[k];
      if (!f) out.push(`${path}.${k}`);
      else unknownKeys(v, f, `${path}.${k}`, out);
    }
  } else if (d.node.kind === 'array' && Array.isArray(value)) {
    value.forEach((x) => unknownKeys(x, d.node.kind === 'array' ? d.node.element : d, `${path}[*]`, out));
  }
  return [...new Set(out)];
}

function checkText(
  text: string, source: 'repo' | 'bo', op: { operationCode: string; task: string; taskField?: 'task' | 'mode' | 'none' },
  schema: ZodType, schemaName: string,
): CoherenceFinding[] {
  const findings: CoherenceFinding[] = [];
  const disc = op.taskField === 'mode' ? 'MODE' : 'TASK';
  const section = branchSection(text, op.task, disc) ?? text;
  const field = op.taskField === 'none' ? null : (op.taskField ?? 'task');
  const exemples = jsonExamples(section).filter((e) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
    return field ? (e as Record<string, unknown>)[field] === op.task : true;
  });
  if (exemples.length === 0) {
    findings.push({ code: 'PROMPT_NO_EXAMPLE', severity: 'info', source, message: `Aucun exemple JSON complet de la branche ${op.task} (gabarit conceptuel ou absent) : seul le schéma fait foi.` });
    return findings;
  }
  for (const brut of exemples) {
    const ex = expandTemplateValues(brut);
    const r = resolveOutput({
      raw: JSON.stringify(ex), schema, schemaName, operationCode: op.operationCode,
      expectedTask: field ? op.task : undefined, taskField: op.taskField, allowPruning: false,
    });
    if (!r.ok) {
      findings.push({
        code: 'PROMPT_EXAMPLE_INVALID', severity: 'warning', source,
        message: `Exemple du prompt non conforme au schéma ${schemaName} : ${r.issues.slice(0, 4).map((i) => `${i.path} (${i.subtype}${i.expected ? `, attendu ${i.expected}` : ''})`).join(' ; ')}.`,
      });
    } else if (r.repairs.some((x) => x.stage === 'normalization' || x.stage === 'compat_adapter')) {
      findings.push({
        code: 'PROMPT_EXAMPLE_NORMALIZED', severity: 'info', source,
        message: `Exemple du prompt accepté après normalisation (${[...new Set(r.repairs.map((x) => x.rule))].join(', ')}).`,
      });
    }
    const inconnues = unknownKeys(ex, describe(schema));
    if (inconnues.length) {
      findings.push({
        code: 'PROMPT_FIELD_NOT_IN_SCHEMA', severity: 'warning', source,
        message: `Champs demandés par le prompt absents du schéma (ignorés au mapping) : ${inconnues.slice(0, 8).join(', ')}.`,
      });
    }
  }
  return findings;
}

/**
 * Contrôle complet. `activeTexts` : texte actif par opération (BO), s'il
 * diffère du dépôt ; `repoText` : lecture du fichier du dépôt.
 */
export function checkOutputCoherence(p: {
  repoText: (masterPromptCode: string) => string | null;
  activeTexts?: Record<string, string | null>;
}): OperationCoherence[] {
  const out: OperationCoherence[] = [];
  for (const op of Object.values(AI_OPERATIONS)) {
    if (!op.active || !isMasterOperation(op)) continue;
    const findings: CoherenceFinding[] = [];
    const schema = masterOutputSchemaFor(op.outputSchema);
    if (!schema) {
      findings.push({ code: 'SCHEMA_MISSING', severity: 'warning', source: 'contract', message: `Schéma ${op.outputSchema} introuvable.` });
      out.push({ operationCode: op.operationCode, task: op.task, schema: null, contract: null, findings });
      continue;
    }
    const ref = outputSchemaRef(op.outputSchema, schema, op.operationCode);
    if (!contractFor(op.outputSchema)) {
      findings.push({ code: 'CONTRACT_UNVERSIONED', severity: 'info', source: 'contract', message: `Contrat ${op.outputSchema} sans version déclarée (affiché ${ref.version}).` });
    }
    const ps = providerJsonSchema(schema);
    if (ps.omitted) {
      findings.push({ code: 'PROVIDER_SCHEMA_OMITTED', severity: 'info', source: 'contract', message: `Schéma fournisseur non transmis (${ps.omitted}, ${ps.nodes} nœuds) : mode JSON seul, normalisation et validation inchangées.` });
    } else if (ps.dropped.length) {
      findings.push({ code: 'PROVIDER_SCHEMA_REDUCED', severity: 'info', source: 'contract', message: `Schéma fournisseur réduit : contraintes vérifiées par Verebona seulement (${ps.dropped.join(', ')}).` });
    }
    const repo = p.repoText(op.masterPromptCode);
    if (repo) findings.push(...checkText(repo, 'repo', op, schema, op.outputSchema));
    const bo = p.activeTexts?.[op.operationCode];
    if (bo && bo !== repo) findings.push(...checkText(bo, 'bo', op, schema, op.outputSchema));
    out.push({ operationCode: op.operationCode, task: op.task, schema: op.outputSchema, contract: `${ref.version} · ${ref.hash}`, findings });
  }
  return out;
}

/** Passage de démarrage : textes du dépôt et texte actif (BO / configuration) de chaque opération. */
export async function runOutputCoherenceCheck(): Promise<{ operations: number; warnings: number; infos: number; report: OperationCoherence[] }> {
  const { readMasterFileFromRepo } = await import('./master-corpus/cases');
  const { resolveOperationConfig } = await import('../config/config-resolver');
  const activeTexts: Record<string, string | null> = {};
  for (const op of Object.values(AI_OPERATIONS)) {
    if (!op.active || !isMasterOperation(op)) continue;
    try {
      const cfg = await resolveOperationConfig(op.operationCode);
      activeTexts[op.operationCode] = cfg.promptArchitecture === 'master' ? cfg.masterPromptText ?? null : null;
    } catch {
      activeTexts[op.operationCode] = null;
    }
  }
  const report = checkOutputCoherence({
    repoText: (code) => { try { return readMasterFileFromRepo(code); } catch { return null; } },
    activeTexts,
  });
  const all = report.flatMap((r) => r.findings);
  return { operations: report.length, warnings: all.filter((f) => f.severity === 'warning').length, infos: all.filter((f) => f.severity === 'info').length, report };
}
