/**
 * Lot 115 (carte #784, §A — AC02 volet statique, AC07) — CONFORMITÉ DE LA
 * PROJECTION du schéma transmis au fournisseur, prouvée sur la projection
 * ELLE-MÊME.
 *
 * ⚠️ Ce fichier ne prouve PAS que le fournisseur accepte le schéma. La cause
 * des refus HTTP 400 constatés en préproduction n'a jamais pu être établie
 * (aucun accès au fournisseur depuis l'atelier — voir la recette 114J), et
 * AUCUN appel réel n'est fait ici. Ce qui est prouvé :
 *   · le schéma transmis n'emploie que des mots-clés du sous-ensemble
 *     DOCUMENTÉ par le fournisseur (`GEMINI_JSON_SCHEMA_KEYWORDS`) ;
 *   · la forme factorisée (`$defs` / `$ref`) fait baisser CHAQUE dimension que
 *     la documentation citée par la carte désigne comme cause possible d'un
 *     refus « too many states », sans perdre une seule branche du contrat ;
 *   · un plafond d'exploitation, et lui seul, peut faire renoncer à l'envoi ;
 *   · les deux formes sont des COUPLES distincts : aucune qualification n'est
 *     héritée de l'autre.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AI_OPERATIONS, isMasterOperation } from '../../registry/operations';
import { masterOutputSchemaFor } from '../master-output-schemas';
import { resolveRuntimeContract, providerSchemaHash } from '../output-resolution/runtime-contract';
import {
  providerJsonSchema, projectionVariants, providerSchemaPropertyCap, providerSchemaShape, resolveSchemaRefs,
  schemaBranches, lostBranchesOf, SCHEMA_SHAPES,
} from '../output-resolution/provider-schema';
import { splitPipe } from '../output-resolution/field-validation';
import {
  GEMINI_JSON_SCHEMA_KEYWORDS, GEMINI_SCHEMA_LIMITS, geminiSchemaIssues, geminiSchemaMetrics, geminiSchemaAcceptable,
  unsupportedKeywordsIn,
} from '../providers/gemini-schema-contract';
import { T1AnalyzeDocumentOutput } from '../../source-analysis/master/t1-contract';

const canonicalJson = (schema: z.ZodType) => z.toJSONSchema(splitPipe(schema).main, { io: 'input', unrepresentable: 'any', reused: 'inline' }) as Record<string, unknown>;

const contratT1 = () => resolveRuntimeContract({ schemaName: 'T1AnalyzeDocumentOutput', operationCode: 't1_analyze_document', callerSchema: T1AnalyzeDocumentOutput }).contract;

const contratsMaitres = () => Object.entries(AI_OPERATIONS)
  .filter(([, op]) => op.active && isMasterOperation(op) && op.outputSchema && op.outputSchema !== 'none' && masterOutputSchemaFor(op.outputSchema))
  .map(([code, op]) => ({ code, contract: resolveRuntimeContract({ schemaName: op.outputSchema!, operationCode: code, callerSchema: masterOutputSchemaFor(op.outputSchema!)! }).contract }));

describe('L115E-PROJ — le schéma transmis tient dans le sous-ensemble documenté', () => {
  it('L115E-PROJ-01 — aucun mot-clé hors contrat dans AUCUN contrat maître (invariant de la projection)', () => {
    for (const { code, contract } of contratsMaitres()) {
      const ps = providerJsonSchema(contract.canonical, { shape: 'factorise', maxProperties: null });
      expect(ps.omitted, code).toBeNull();
      expect(unsupportedKeywordsIn(ps.schema), code).toEqual([]);
      expect(geminiSchemaAcceptable(geminiSchemaIssues(ps.schema)), code).toBe(true);
      // Les mots-clés réellement présents appartiennent tous au sous-ensemble documenté.
      for (const k of motsClesDe(ps.schema!)) expect(GEMINI_JSON_SCHEMA_KEYWORDS.has(k), `${code} · ${k}`).toBe(true);
    }
  });

  it('L115E-PROJ-02 — `$defs` et `$ref` font partie du sous-ensemble documenté (base de la factorisation)', () => {
    for (const k of ['$defs', '$ref', 'anyOf', 'enum', 'items', 'maxItems', 'properties', 'required', 'type', 'description', 'format', 'minimum', 'maximum', 'propertyOrdering']) {
      expect(GEMINI_JSON_SCHEMA_KEYWORDS.has(k), k).toBe(true);
    }
  });
});

describe('L115E-PROJ — la factorisation réduit les dimensions documentées SANS perte (AC02, AC07)', () => {
  it('L115E-PROJ-03 — T1 v7 : forme factorisée transmise, chaque dimension baisse, zéro branche perdue', () => {
    const contract = contratT1();
    const factorise = providerJsonSchema(contract.canonical, { shape: 'factorise', maxProperties: null });
    const deployee = providerJsonSchema(contract.canonical, { shape: 'inline', maxProperties: null });
    expect(factorise.shape).toBe('factorise');
    expect(deployee.shape).toBe('inline');
    expect(factorise.omitted).toBeNull();
    const f = factorise.metrics!;
    const d = deployee.metrics!;
    // Dimensions citées par la documentation (taille, propriétés, énumérations, unions, profondeur, bornes imbriquées).
    expect(f.serializedChars).toBeLessThan(d.serializedChars);
    expect(f.properties).toBeLessThan(d.properties);
    expect(f.enumValues).toBeLessThan(d.enumValues);
    expect(f.depth).toBeLessThan(d.depth);
    expect(f.nestedArrayBound).toBeLessThanOrEqual(d.nestedArrayBound);
    expect(f.unionBranches).toBeLessThanOrEqual(d.unionBranches);
    // … et le schéma transmis reste sous les plafonds du contrat fournisseur.
    expect(f.serializedChars).toBeLessThan(GEMINI_SCHEMA_LIMITS.maxSerializedChars);
    expect(f.depth).toBeLessThanOrEqual(GEMINI_SCHEMA_LIMITS.maxDepth);
    expect(f.nestedArrayBound).toBeLessThanOrEqual(GEMINI_SCHEMA_LIMITS.maxNestedArrayBound);
    // AUCUNE branche perdue : égalité stricte des branches sur la forme déployée du schéma transmis.
    const canon = schemaBranches(canonicalJson(contract.canonical));
    expect(schemaBranches(resolveSchemaRefs(factorise.schema!))).toEqual(canon);
    expect(schemaBranches(deployee.schema)).toEqual(canon);
    // Les familles nommées par AC07 sont présentes dans la forme transmise.
    const branches = schemaBranches(resolveSchemaRefs(factorise.schema!));
    for (const top of ['document', 'entities', 'facts', 'tables', 'transcription', 'visual', 'businessOperationCandidates', 'valueDecisions']) {
      expect(branches, top).toContain(`$.${top}`);
    }
    expect(branches).toContain('$.facts[].rawValue');
    expect(branches.some((b) => /\.supplier\.contacts(\[\]|\.|$)/.test(b))).toBe(true);
    expect(branches.some((b) => /\.billingPeriod(\.|$)/.test(b))).toBe(true);
  });

  it('L115E-PROJ-04 — TOUS les contrats maîtres : zéro branche perdue dans la forme transmise', () => {
    for (const { code, contract } of contratsMaitres()) {
      const ps = providerJsonSchema(contract.canonical, { shape: 'factorise', maxProperties: null });
      expect(ps.lostBranches ?? [], code).toEqual([]);
      expect(lostBranchesOf(canonicalJson(contract.canonical), resolveSchemaRefs(ps.schema!)), code).toEqual([]);
    }
  });

  it('L115E-PROJ-05 — les deux formes sont des COUPLES distincts : aucune qualification héritée', () => {
    const contract = contratT1();
    const f = providerJsonSchema(contract.canonical, { shape: 'factorise', maxProperties: null });
    const d = providerJsonSchema(contract.canonical, { shape: 'inline', maxProperties: null });
    expect(providerSchemaHash(f.schema)).not.toBe(providerSchemaHash(d.schema));
    expect(JSON.stringify(f.schema)).toContain('"$defs"');
    expect(JSON.stringify(d.schema)).not.toContain('"$defs"');
    expect([...SCHEMA_SHAPES]).toEqual(['factorise', 'inline']);
    // Forme par défaut : factorisée ; `AI_PROVIDER_SCHEMA_SHAPE=inline` rend la forme antérieure sans redéploiement.
    expect(providerSchemaShape({} as unknown as NodeJS.ProcessEnv)).toBe('factorise');
    expect(providerSchemaShape({ AI_PROVIDER_SCHEMA_SHAPE: 'inline' } as unknown as NodeJS.ProcessEnv)).toBe('inline');
    expect(providerSchemaShape({ AI_PROVIDER_SCHEMA_SHAPE: ' INLINE ' } as unknown as NodeJS.ProcessEnv)).toBe('inline');
    expect(providerSchemaShape({ AI_PROVIDER_SCHEMA_SHAPE: 'factorise' } as unknown as NodeJS.ProcessEnv)).toBe('factorise');
  });

  it('L115E-PROJ-06 — une référence non résolue est détectée comme PERTE (la factorisation ne masque rien)', () => {
    const canon = { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'string' } } } } };
    const avecRef = { type: 'object', properties: { a: { $ref: '#/$defs/x' } }, $defs: { x: { type: 'object', properties: { b: { type: 'string' } } } } };
    expect(lostBranchesOf(canon, resolveSchemaRefs(avecRef))).toEqual([]);
    const refCassee = { type: 'object', properties: { a: { $ref: '#/$defs/absent' } }, $defs: {} };
    expect(lostBranchesOf(canon, resolveSchemaRefs(refCassee))).toEqual(['$.a.b']);
  });
});

describe('L115E-PROJ — profil de complexité et plafond d’exploitation (A2)', () => {
  it('L115E-PROJ-07 — le profil est MESURÉ, exactement, sur un schéma connu', () => {
    const m = geminiSchemaMetrics({
      type: 'object',
      properties: {
        lignes: { type: 'array', maxItems: 5, items: { type: 'object', properties: { code: { type: 'string', enum: ['A', 'B', 'C'] }, n: { type: 'number' } }, required: ['code'] } },
        statut: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['lignes'],
    });
    expect(m).toMatchObject({ properties: 4, enumValues: 3, unionBranches: 2, arrays: 1, requiredProperties: 2, nestedArrayBound: 5 });
    expect(m.propertyNameChars).toBe('lignes'.length + 'statut'.length + 'code'.length + 'n'.length);
    expect(geminiSchemaMetrics(null)).toMatchObject({ nodes: 0, properties: 0, serializedChars: 0 });
  });

  it('L115E-PROJ-08 — AUCUN plafond de propriétés par défaut ; posé en exploitation, le schéma n’est plus transmis', () => {
    expect(providerSchemaPropertyCap({} as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(providerSchemaPropertyCap({ AI_PROVIDER_SCHEMA_MAX_PROPERTIES: '0' } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(providerSchemaPropertyCap({ AI_PROVIDER_SCHEMA_MAX_PROPERTIES: 'abc' } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(providerSchemaPropertyCap({ AI_PROVIDER_SCHEMA_MAX_PROPERTIES: ' 120 ' } as unknown as NodeJS.ProcessEnv)).toBe(120);
    const contract = contratT1();
    const sansPlafond = providerJsonSchema(contract.canonical, { shape: 'factorise', maxProperties: null });
    expect(sansPlafond.omitted).toBeNull();
    const avecPlafond = providerJsonSchema(contract.canonical, { shape: 'factorise', maxProperties: 10 });
    // Repli explicite, borné et observable : mode JSON, contrat complet au prompt, motif et écart tracés.
    expect(avecPlafond.schema).toBeNull();
    expect(avecPlafond.omitted).toBe('provider_contract');
    expect(avecPlafond.issues?.some((c) => c.startsWith('PROPERTY_CAP_EXCEEDED'))).toBe(true);
    // Le profil reste mesuré même quand le schéma n'est pas transmis (diagnostic).
    expect(avecPlafond.metrics!.properties).toBeGreaterThan(10);
  });

  it('L115E-PROJ-09 — table de décision des variantes : chiffrée, sans perte, sans appel fournisseur', () => {
    const variantes = projectionVariants(contratT1().canonical);
    expect(variantes.map((v) => v.name)).toEqual(['deployee', 'sans_bornes', 'sans_maxitems', 'sans_textes', 'refs_factorises']);
    for (const v of variantes) {
      expect(v.lostBranches, v.name).toEqual([]);
      expect(v.conform, v.name).toBe(true);
      expect(v.unsupportedKeywords, v.name).toEqual([]);
    }
    const par = (n: string) => variantes.find((v) => v.name === n)!.metrics;
    expect(par('refs_factorises').serializedChars).toBeLessThan(par('deployee').serializedChars);
    expect(par('refs_factorises').properties).toBeLessThan(par('deployee').properties);
    expect(par('sans_maxitems').nestedArrayBound).toBe(1);
    expect(par('sans_bornes').serializedChars).toBeLessThan(par('deployee').serializedChars);
  });
});

/** Mots-clés (et non noms de propriétés) réellement présents dans un schéma. */
function motsClesDe(schema: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!n || typeof n !== 'object') return;
    for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
      out.add(k);
      if (k === 'properties' || k === '$defs') { if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk); continue; }
      walk(v);
    }
  };
  walk(schema);
  return [...out].sort();
}
