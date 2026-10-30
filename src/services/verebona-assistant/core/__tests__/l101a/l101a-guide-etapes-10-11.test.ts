/**
 * Lot 101A — guide du PO, étapes 10 (T1 `t1-product-identity-v1`) et 11
 * (T2 `t2-property-continuity-v1`) : les blocs sont collés dans les textes
 * LIVRÉS comme le ferait le PO, puis vérifiés contre le code réel :
 * contrôles d'activation du BO, détection des marqueurs, exemples JSON passés
 * dans les schémas et validations serveur réels ; contrats déclarés au
 * registre de conformité (99B) pour l'application automatique en préproduction.
 * Le code est sûr AVANT et APRÈS le collage (garde-fous serveur inchangés).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const { inspectMasterTemplate } = await import('@/services/ai/prompts/prompt-loader');
const { checkMasterPromptContent } = await import('@/services/ai/master-prompts/master-prompt-checks');
const { t1Fact } = await import('@/services/ai/source-analysis/master/t1-contract');
const { guardProductIdentity } = await import('@/services/ai/source-analysis/master/product-identity-guard');
const { promptCarriesProductIdentity, T1_PRODUCT_IDENTITY_CONTRACT } = await import('@/services/ai/source-analysis/master/product-identity-contract');
const { promptCarriesPropertyContinuity, T2_PROPERTY_CONTINUITY_CONTRACT } = await import('../../property-continuity-contract');
const { T2UnderstandOutput } = await import('@/services/ai/assistant/master/t2-contract');
const { toT2Understanding } = await import('@/services/ai/assistant/master/t2-understand');
const { guideBlock } = await import('@/services/ai/prompt-conformity/guide-blocks');
const { MARKER_CONTRACT_DECLARATIONS } = await import('@/services/ai/prompt-conformity/contracts');
const { catalogForT2Read } = await import('@/services/canonical/registry');
import type { ProjectedFact } from '@/services/ai/source-analysis/master/t1-contract';

const RACINE = process.cwd();
const GUIDE = readFileSync(join(RACINE, 'docs', 'exploitation', 'prompts-a-appliquer-par-le-po.md'), 'utf-8');
const T1_LIVRE = readFileSync(join(RACINE, 'src', 'services', 'ai', 'prompts', 'source-analysis', 't1_master_v1.txt'), 'utf-8');
const T2_LIVRE = readFileSync(join(RACINE, 'src', 'services', 'ai', 'prompts', 'assistant', 't2_master_v1.txt'), 'utf-8');
const occurrences = (t: string, m: string) => t.split(m).length - 1;
const coller = (texte: string, b: { anchor: string | null; text: string }) => texte.replace(b.anchor!, `${b.text}\n\n${b.anchor}`);

function jsonsDe(texte: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const lignes = texte.split('\n');
  for (let k = 0; k < lignes.length; k++) {
    if (!lignes[k].startsWith('{')) continue;
    const reste = lignes.slice(k).join('\n');
    let prof = 0; let chaine = false; let echap = false; let fin = -1;
    for (let c = 0; c < reste.length; c++) {
      const ch = reste[c];
      if (chaine) { if (echap) echap = false; else if (ch === '\\') echap = true; else if (ch === '"') chaine = false; continue; }
      if (ch === '"') chaine = true; else if (ch === '{') prof += 1; else if (ch === '}') { prof -= 1; if (prof === 0) { fin = c; break; } }
    }
    const brut = reste.slice(0, fin + 1);
    out.push(JSON.parse(brut));
    k += brut.split('\n').length - 1;
  }
  return out;
}

describe('L101A-U-GUIDE-10 — étape 10 : bloc T1 `t1-product-identity-v1`', () => {
  const b = guideBlock('t1-product-identity-v1')!;
  it('bloc balisé, ligne repère unique dans le texte livré, marqueur détecté après collage seulement ; aucun emplacement ni branche ajoutés', () => {
    expect(b).toMatchObject({ prompt: 't1', action: 'insert-before', anchor: 'Réponds uniquement par le JSON de la branche TASK demandée, sans texte autour.' });
    expect(occurrences(T1_LIVRE, b.anchor!)).toBe(1);
    const apres = coller(T1_LIVRE, b);
    expect(promptCarriesProductIdentity(T1_LIVRE)).toBe(false);
    expect(promptCarriesProductIdentity(apres)).toBe(true);
    expect(b.text).toContain(T1_PRODUCT_IDENTITY_CONTRACT);
    expect(inspectMasterTemplate(b.text).placeholders).toEqual([]);
    expect(inspectMasterTemplate(apres).branches).toEqual(inspectMasterTemplate(T1_LIVRE).branches);
  });
  it('contrôles d’activation du BO : aucun bloquant, aucun avertissement nouveau', () => {
    const apres = coller(T1_LIVRE, b);
    expect(checkMasterPromptContent('T1', apres).blocking).toEqual([]);
    expect(checkMasterPromptContent('T1', apres).warnings.map((w) => w.code)).toEqual(checkMasterPromptContent('T1', T1_LIVRE).warnings.map((w) => w.code));
  });
  it('exemple JSON : schéma réel des faits T1, puis garde-fou serveur — rien requalifié, le produit connexe reste générique', () => {
    const [ex] = jsonsDe(b.text);
    const faits = (ex.facts as unknown[]).map((f) => t1Fact.parse(f));
    expect(faits).toHaveLength(5);
    const projetes: ProjectedFact[] = faits.map((f) => ({
      canonicalKey: f.canonicalKey, rawKey: f.rawKey ?? null, label: f.label ?? null, subject: f.subject ?? null, attribute: f.attribute ?? null,
      rawValue: f.rawValue as string, value: f.normalizedValue as string, valueType: 'string', canonicalUnit: null,
      target: { targetType: f.target.type, targetEntityId: f.target.entityId, targetEntityLabel: null, targetConfidence: f.target.confidence },
      provenance: f.provenance, confidence: f.confidence, evidence: f.evidence, semanticEvent: null, recurrence: null,
      periodStart: null, periodEnd: null, origin: 'MODEL_CANONICAL', ruleCode: null,
    }));
    const g = guardProductIdentity(projetes, { mainProduct: { codes: ['MG23K3515AK', 'MG23K3515AK/EF'], name: null, brand: 'Samsung' } });
    expect(g.facts).toEqual(projetes);
    expect(g.counters).toEqual({ genericLabelsRekeyed: 0, incompatibleValuesRequalified: 0, secondaryProductsDetached: 0, conflictsFlagged: 0 });
    // Les clés de l'exemple sont celles du catalogue des champs transmis à T1.
    const cles = new Set(catalogForT2Read().fields.map((f) => f.key));
    for (const f of faits) if (f.canonicalKey) expect(cles.has(f.canonicalKey), f.canonicalKey).toBe(true);
  });
});

describe('L101A-U-GUIDE-11 — étape 11 : bloc T2 `t2-property-continuity-v1`', () => {
  const b = guideBlock('t2-property-continuity-v1')!;
  it('bloc balisé, ligne repère unique, marqueur détecté après collage seulement ; aucun emplacement ni branche ajoutés', () => {
    expect(b).toMatchObject({ prompt: 't2', action: 'insert-before', anchor: 'SORTIE UNDERSTAND' });
    expect(occurrences(T2_LIVRE, b.anchor!)).toBe(1);
    const apres = coller(T2_LIVRE, b);
    expect(promptCarriesPropertyContinuity(T2_LIVRE)).toBe(false);
    expect(promptCarriesPropertyContinuity(apres)).toBe(true);
    expect(b.text).toContain(T2_PROPERTY_CONTINUITY_CONTRACT);
    expect(inspectMasterTemplate(b.text).placeholders).toEqual([]);
    expect(inspectMasterTemplate(apres).branches).toEqual(inspectMasterTemplate(T2_LIVRE).branches);
    // Le bloc reste dans la branche UNDERSTAND (avant sa sortie).
    expect(apres.indexOf('CONTINUITÉ ET PROPRIÉTÉ EXACTE')).toBeGreaterThan(apres.indexOf('BRANCHE MODE = UNDERSTAND'));
    expect(apres.indexOf('CONTINUITÉ ET PROPRIÉTÉ EXACTE')).toBeLessThan(apres.indexOf('SORTIE UNDERSTAND'));
  });
  it('contrôles d’activation du BO : aucun bloquant, aucun avertissement nouveau', () => {
    const apres = coller(T2_LIVRE, b);
    expect(checkMasterPromptContent('T2', apres).blocking).toEqual([]);
    expect(checkMasterPromptContent('T2', apres).warnings.map((w) => w.code)).toEqual(checkMasterPromptContent('T2', T2_LIVRE).warnings.map((w) => w.code));
  });
  it('exemple JSON : schéma réel UNDERSTAND puis traduction serveur — productSeries, indice equipment conservé', () => {
    const [ex] = jsonsDe(b.text);
    const out = T2UnderstandOutput.parse(ex);
    const u = toT2Understanding(out);
    expect(u.requestedFacts).toEqual(['productSeries']);
    expect(u.plan.entityHints).toEqual([{ type: 'equipment', value: 'micro-onde' }]);
  });
});

describe('L101A-U-GUIDE-REG — contrats déclarés au registre de conformité (99B)', () => {
  it('étapes 10 et 11 déclarées en une ligne chacune, bloc officiel présent, détection = fonction de production', async () => {
    const t1 = MARKER_CONTRACT_DECLARATIONS.find((d) => d.id === 't1-product-identity-v1')!;
    const t2 = MARKER_CONTRACT_DECLARATIONS.find((d) => d.id === 't2-property-continuity-v1')!;
    expect(t1).toMatchObject({ treatment: 'T1', guideStep: 10, lot: '101A', task: 'ANALYZE_DOCUMENT', blockId: 't1-product-identity-v1' });
    expect(t2).toMatchObject({ treatment: 'T2', guideStep: 11, lot: '101A', task: 'UNDERSTAND', blockId: 't2-property-continuity-v1' });
    expect(await t1.detect(coller(T1_LIVRE, guideBlock(t1.blockId)!))).toBe(true);
    expect(await t2.detect(coller(T2_LIVRE, guideBlock(t2.blockId)!))).toBe(true);
    expect(await t1.detect(T1_LIVRE)).toBe(false);
    expect(await t2.detect(T2_LIVRE)).toBe(false);
  });
  it('le guide cite les marqueurs, les étapes et les fichiers du code', () => {
    for (const m of ['| 10 | 101A', '| 11 | 101A', 'guardProductIdentity', 'promptCarriesProductIdentity', 'promptCarriesPropertyContinuity', 'COH-EQUIPMENT-IDENTITY', 'ELLIPTIC_CONTEXT_UNRESOLVED']) {
      expect(GUIDE, m).toContain(m);
    }
  });
});
