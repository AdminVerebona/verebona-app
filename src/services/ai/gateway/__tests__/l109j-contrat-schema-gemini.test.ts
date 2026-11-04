/**
 * Lot 109J — TEST DE CONTRAT du schéma structuré RÉELLEMENT envoyé à Gemini
 * (incident T3:6033, appel 7345 : `t3_document_naming@v1` refusé en HTTP 400
 * INVALID_ARGUMENT, cause non citée par Google).
 *
 * Le schéma vérifié est celui de la requête : contrat runtime résolu comme
 * par la passerelle → schéma fournisseur réduit → `generationConfig`
 * construit par l'adaptateur (`responseJsonSchema`). Aucun réseau.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AI_OPERATIONS, isMasterOperation } from '../../registry/operations';
import { masterOutputSchemaFor } from '../master-output-schemas';
import { resolveRuntimeContract } from '../output-resolution/runtime-contract';
import { providerJsonSchema, PROVIDER_MAX_ITEMS_KEPT } from '../output-resolution/provider-schema';
import { buildGenerationConfig } from '../providers/gemini-generation-config';
import { geminiSchemaAcceptable, geminiSchemaIssues, GEMINI_SCHEMA_LIMITS } from '../providers/gemini-schema-contract';
import { T3DocumentNamingOutput } from '../../reconciliation/master/t3-contract';

/** Schéma transmis pour une opération, exactement comme la passerelle le construit. */
function sentSchema(operationCode: string): Record<string, unknown> | null {
  const op = AI_OPERATIONS[operationCode];
  const caller = masterOutputSchemaFor(op.outputSchema!);
  if (!caller) return null;
  const { contract } = resolveRuntimeContract({ schemaName: op.outputSchema!, operationCode, callerSchema: caller });
  const ps = providerJsonSchema(contract.canonical);
  if (!ps.schema) return null;
  const cfg = buildGenerationConfig({ model: 'gemini-3.5-flash', maxOutputTokens: 8192, responseSchema: ps.schema });
  return cfg.responseJsonSchema as Record<string, unknown>;
}

describe('L109J-GEM — contrat du schéma structuré Gemini', () => {
  it('L109J-GEM-01 — REPRODUCTION : le schéma de t3_document_naming@v1 AVANT correction dépassait la contrainte d’états (listes imbriquées bornées)', () => {
    // Schéma tel que dérivé avant le lot 109J (toutes les bornes `maxItems` conservées).
    const brut = z.toJSONSchema(T3DocumentNamingOutput, { io: 'input', unrepresentable: 'any', reused: 'inline' }) as Record<string, unknown>;
    const issues = geminiSchemaIssues(brut);
    const imbriquees = issues.filter((i) => i.code === 'NESTED_ARRAY_BOUNDS');
    // families (≤ 100) × document_ids (≤ 200) = 20 000 états de longueur de liste.
    expect(imbriquees.map((i) => i.path)).toContain('$.properties.families.items.properties.document_ids');
    expect(geminiSchemaAcceptable(issues)).toBe(false);
  });

  it('L109J-GEM-02 — schéma ENVOYÉ pour DOCUMENT_NAMING : conforme (aucun écart bloquant), structured output conservé', () => {
    const s = sentSchema('t3_document_naming');
    expect(s).not.toBeNull();
    const issues = geminiSchemaIssues(s);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    // Les grandes bornes ne partent plus (vérifiées par Verebona à la validation).
    const txt = JSON.stringify(s);
    for (const m of txt.matchAll(/"maxItems":(\d+)/g)) expect(Number(m[1])).toBeLessThanOrEqual(PROVIDER_MAX_ITEMS_KEPT);
    // Sémantique conservée : obligatoires, énumérations, nullables.
    expect(txt).toContain('"document_renames"');
    expect(txt).toContain('"certain","probable","conflictual"');
  });

  it('L109J-GEM-03 — TOUTES les opérations master : le schéma envoyé respecte le contrat (aucun mot-clé hors sous-ensemble, enum de chaînes, profondeur, taille)', () => {
    const ecarts: string[] = [];
    for (const [code, op] of Object.entries(AI_OPERATIONS)) {
      if (!op.active || !isMasterOperation(op) || !op.outputSchema) continue;
      const s = sentSchema(code);
      if (!s) continue;
      for (const i of geminiSchemaIssues(s)) if (i.severity === 'error' || i.code === 'UNSUPPORTED_KEYWORD') ecarts.push(`${code} ${i.code} ${i.path} ${i.detail}`);
    }
    expect(ecarts).toEqual([]);
  });

  it('L109J-GEM-04 — validateur : enum null / booléen, type inconnu, profondeur, taille → écarts bloquants ; mot-clé inconnu → avertissement', () => {
    expect(geminiSchemaIssues({ type: 'string', enum: ['a', null] }).map((i) => i.code)).toContain('INVALID_ENUM');
    expect(geminiSchemaIssues({ type: 'string', enum: [] }).map((i) => i.code)).toContain('INVALID_ENUM');
    expect(geminiSchemaIssues({ type: 'date' }).map((i) => i.code)).toContain('INVALID_TYPE');
    const warn = geminiSchemaIssues({ type: 'object', properties: { a: { type: 'string', pattern: 'x' } }, additionalProperties: false });
    expect(warn).toEqual([expect.objectContaining({ code: 'UNSUPPORTED_KEYWORD', severity: 'warning', detail: 'pattern' })]);
    let profond: Record<string, unknown> = { type: 'string' };
    for (let k = 0; k <= GEMINI_SCHEMA_LIMITS.maxDepth + 1; k++) profond = { type: 'object', properties: { x: profond } };
    expect(geminiSchemaAcceptable(geminiSchemaIssues(profond))).toBe(false);
    const gros = { type: 'object', properties: Object.fromEntries(Array.from({ length: 2000 }, (_x, i) => [`propriete_longue_${i}`, { type: 'string', description: 'x'.repeat(10) }])) };
    expect(geminiSchemaIssues(gros).map((i) => i.code)).toContain('TOO_LARGE');
  });

  it('L109J-GEM-05 — schéma non conforme : NON envoyé (motif provider_contract, écarts tracés) — jamais un 400 payé puis masqué', () => {
    const lourd = z.object({ a: z.array(z.object({ b: z.array(z.object({ c: z.array(z.string()).max(15) })).max(15) })).max(15) });
    const ps = providerJsonSchema(lourd);
    expect(ps.schema).toBeNull();
    expect(ps.omitted).toBe('provider_contract');
    expect(ps.issues?.some((x) => x.startsWith('NESTED_ARRAY_BOUNDS@'))).toBe(true);
  });
});
