/**
 * Lot 114 (carte #776 — travaux 2 et 6 ; AC02 volet statique, AC07) —
 * PROJECTION du schéma fournisseur : aucune branche du contrat métier n'est
 * perdue, l'adaptateur est versionné, le contrôle statique couvre tous les
 * contrats. Aucun réseau : ce test ne prouve PAS l'acceptation par le
 * fournisseur (mesure en préproduction, mémoire `ai_schema_compatibility`).
 */
import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AI_OPERATIONS, isMasterOperation } from '../../registry/operations';
import { masterOutputSchemaFor } from '../master-output-schemas';
import { resolveRuntimeContract } from '../output-resolution/runtime-contract';
import {
  providerJsonSchema, schemaBranches, lostBranchesOf, PROVIDER_SCHEMA_ADAPTER_VERSION, PROVIDER_MAX_ITEMS_KEPT,
} from '../output-resolution/provider-schema';
import { splitPipe } from '../output-resolution/field-validation';
import { geminiSchemaAcceptable, geminiSchemaIssues } from '../providers/gemini-schema-contract';
import { staticSchemaMatrix, staticSchemaRowOf, isCurrentCouple } from '../schema-compat/static-matrix';
import { T1AnalyzeDocumentOutput } from '../../source-analysis/master/t1-contract';

const canonicalJson = (schema: z.ZodType) => z.toJSONSchema(splitPipe(schema).main, { io: 'input', unrepresentable: 'any', reused: 'inline' });
const masterOperations = () => Object.entries(AI_OPERATIONS).filter(([, op]) => op.active && isMasterOperation(op) && op.outputSchema && op.outputSchema !== 'none').map(([code]) => code);

describe('L114J-PROJ — aucune branche du contrat n’est perdue (AC07)', () => {
  it('L114J-PROJ-01 — T1 v7 : toutes les familles du contrat sont dans le schéma transmis', () => {
    const row = staticSchemaRowOf('t1_analyze_document')!;
    expect(row).toMatchObject({ contractId: 'T1_ANALYZE_DOCUMENT', contractVersion: 7, omitted: null, lostBranches: [] });
    const { contract } = resolveRuntimeContract({ schemaName: 'T1AnalyzeDocumentOutput', operationCode: 't1_analyze_document', callerSchema: T1AnalyzeDocumentOutput });
    const ps = providerJsonSchema(contract.canonical);
    expect(ps.schema).not.toBeNull();
    const branches = schemaBranches(ps.schema);
    // Familles nommées par la carte (travail 6) et le critère AC07.
    for (const top of ['document', 'entities', 'facts', 'tables', 'transcription', 'visual', 'businessOperationCandidates', 'valueDecisions']) {
      expect(branches, top).toContain(`$.${top}`);
    }
    const attendu = (suffixe: RegExp, libelle: string) => expect(branches.some((b) => suffixe.test(b)), libelle).toBe(true);
    attendu(/\.supplier(\.|$)/, 'fournisseur');
    attendu(/\.supplier\.contacts(\[\]|\.|$)/, 'contacts du fournisseur');
    attendu(/\.billingPeriod(\.|$)/, 'période facturée');
    attendu(/^\$\.facts\[\]\.rawValue$/, 'valeur brute d’un fait');
    attendu(/^\$\.facts\[\]\.normalizedValue/, 'valeur normalisée d’un fait');
    attendu(/^\$\.facts\[\]\.(evidence|proof|sourceRefs|citations)/, 'preuve d’un fait');
    // Égalité stricte des branches : le schéma transmis porte EXACTEMENT les propriétés du contrat canonique.
    expect(branches).toEqual(schemaBranches(canonicalJson(contract.canonical)));
    expect(branches.length).toBeGreaterThan(200);
  });

  it('L114J-PROJ-02 — TOUS les contrats maîtres actifs : zéro branche perdue, schéma transmissible et conforme au contrôle statique', () => {
    const matrice = staticSchemaMatrix();
    expect(matrice.map((r) => r.operationCode).sort()).toEqual(masterOperations().filter((c) => masterOutputSchemaFor(AI_OPERATIONS[c].outputSchema!)).sort());
    expect(matrice.length).toBeGreaterThanOrEqual(15);
    for (const r of matrice) {
      expect(r.lostBranches, r.operationCode).toEqual([]);
      expect(r.omitted, r.operationCode).toBeNull();
      expect(r.providerSchemaHash, r.operationCode).toMatch(/^[0-9a-f]{12}$/);
      expect(r.adapterVersion).toBe(PROVIDER_SCHEMA_ADAPTER_VERSION);
      const caller = masterOutputSchemaFor(AI_OPERATIONS[r.operationCode].outputSchema!)!;
      const { contract } = resolveRuntimeContract({ schemaName: AI_OPERATIONS[r.operationCode].outputSchema!, operationCode: r.operationCode, callerSchema: caller });
      const ps = providerJsonSchema(contract.canonical);
      expect(geminiSchemaAcceptable(geminiSchemaIssues(ps.schema)), r.operationCode).toBe(true);
      // Seules des CONTRAINTES sont retirées (revalidées par Verebona) — jamais `properties`, `items`, `required`, `enum`, `type`.
      for (const k of r.droppedKeywords) expect(['properties', 'items', 'required', 'enum', 'type', 'anyOf']).not.toContain(k);
    }
  });

  it('L114J-PROJ-03 — une projection qui amputerait une branche est DÉTECTÉE (garde `projection_lossy`)', () => {
    const canon = canonicalJson(z.object({
      facts: z.array(z.object({ rawValue: z.string().optional(), normalizedValue: z.string().nullable(), evidence: z.object({ page: z.number().int() }) })),
      billingPeriod: z.object({ start: z.string(), end: z.string() }).nullable(),
    })) as Record<string, unknown>;
    expect(lostBranchesOf(canon, canon)).toEqual([]);
    const ampute = JSON.parse(JSON.stringify(canon)) as { properties: Record<string, { items?: { properties: Record<string, unknown> } }> };
    delete ampute.properties.facts.items!.properties.rawValue;
    delete ampute.properties.billingPeriod;
    expect(lostBranchesOf(canon, ampute)).toEqual(['$.billingPeriod', '$.billingPeriod.end', '$.billingPeriod.start', '$.facts[].rawValue']);
    // Les branches sous une union (`nullable`) et sous une liste sont bien parcourues.
    expect(schemaBranches(canon)).toEqual(['$.billingPeriod', '$.billingPeriod.end', '$.billingPeriod.start', '$.facts', '$.facts[].evidence', '$.facts[].evidence.page', '$.facts[].normalizedValue', '$.facts[].rawValue']);
  });
});

describe('L114J-PROJ — adaptateur versionné (AC06 : invalidation après changement d’adaptateur)', () => {
  it('L114J-PROJ-04 — l’empreinte de la projection d’un schéma de RÉFÉRENCE est figée pour la version courante', () => {
    // Schéma qui exerce chaque règle de réduction : littéral, grande et petite borne de liste, motif, longueur,
    // défaut, format conservé et retiré, nullable, bornes numériques.
    const reference = z.object({
      task: z.literal('REFERENCE'),
      kind: z.enum(['a', 'b']),
      items: z.array(z.object({ id: z.string().regex(/^[a-z]+$/).min(1).max(40), n: z.number().int().min(0).max(100) })).max(300),
      few: z.array(z.string()).max(5),
      date: z.iso.date().nullable(),
      mail: z.email().optional(),
      note: z.string().max(2000).default(''),
    });
    const ps = providerJsonSchema(reference);
    expect(ps.omitted).toBeNull();
    const empreinte = createHash('sha256').update(JSON.stringify(ps.schema)).digest('hex').slice(0, 16);
    // Si ce test échoue : la projection a changé. INCRÉMENTER `PROVIDER_SCHEMA_ADAPTER_VERSION` (les
    // qualifications et refus mémorisés pour l'ancienne projection cessent de s'appliquer), puis mettre à jour
    // les deux valeurs ci-dessous ENSEMBLE.
    expect({ version: PROVIDER_SCHEMA_ADAPTER_VERSION, empreinte }).toEqual({ version: 'ps-2026-11-a', empreinte: 'dcabac46d4a139fb' });
    const txt = JSON.stringify(ps.schema);
    expect(txt).not.toContain('"pattern"');
    expect(txt).not.toContain('"maxLength"');
    expect(txt).not.toContain('"default"');
    expect(txt).toContain(`"maxItems":5`);
    expect(txt).not.toContain('"maxItems":300');
    expect(PROVIDER_MAX_ITEMS_KEPT).toBe(20);
    expect([...ps.dropped].sort()).toEqual(expect.arrayContaining(['maxItems', 'maxLength', 'pattern']));
  });

  it('L114J-PROJ-05 — `isCurrentCouple` : un couple mémorisé pour un autre contrat, schéma ou adaptateur est HISTORIQUE', () => {
    const cur = staticSchemaRowOf('t1_analyze_document')!;
    const couple = { operationCode: cur.operationCode, contractId: cur.contractId, contractVersion: cur.contractVersion, schemaHash: cur.schemaHash, providerSchemaHash: cur.providerSchemaHash, adapterVersion: cur.adapterVersion };
    expect(isCurrentCouple(couple)).toBe(true);
    expect(isCurrentCouple({ ...couple, providerSchemaHash: '000000000000' })).toBe(false);
    expect(isCurrentCouple({ ...couple, schemaHash: '000000000000' })).toBe(false);
    expect(isCurrentCouple({ ...couple, contractVersion: cur.contractVersion - 1 })).toBe(false);
    expect(isCurrentCouple({ ...couple, adapterVersion: 'ps-ancien' })).toBe(false);
    expect(isCurrentCouple({ ...couple, operationCode: 'operation_retiree' })).toBe(false);
    expect(staticSchemaRowOf('operation_retiree')).toBeNull();
  });
});
