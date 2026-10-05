/**
 * T1 — Pièces et Équipements selon les capacités du compte (T1-CAP-01..10).
 *
 * Résolution centrale (offre → capacités), contexte transmis (ENTITY_CONTEXT,
 * FIELD_CATALOG, ACCOUNT_CAPABILITIES), garde-fou de sortie (requalification
 * générique sans perte ni rabattement sur le bien), gardes T3 / T4.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: { unsafe: vi.fn() } }));

const { capabilitiesForPlan, isTargetForbidden } = await import('@/services/account-capabilities.service');
const { buildAnalyzeDocumentVariables, catalogForCapabilities, contextFilterStats, describeEntities } = await import('../prompt-context');
const { enforceT1Capabilities } = await import('../capability-guard');
const { T1AnalyzeDocumentOutput } = await import('../t1-contract');
const { projectDocumentFacts } = await import('../../projection/document-projection');
const { catalogForPrompts, listFields } = await import('@/services/canonical/registry');
const { buildAgendaCandidatesT4 } = await import('../../steps/build-agenda-candidates.step');
const { renderMasterPrompt } = await import('@/services/ai/prompts/prompt-loader');

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const STANDARD = capabilitiesForPlan('standard');
const PREMIUM = capabilitiesForPlan('premium');
const DUO = capabilitiesForPlan('premium_duo');

const ctx = {
  accountId: 1, userId: 1, existingTitles: [], linkedAssetId: 30,
  assets: [{ id: 30, name: 'Maison', category: 'IMMOBILIER', subtype: 'maison' }],
  rooms: [{ id: 301, name: 'Chambre', assetId: 30 }],
  equipments: [{ id: 501, name: 'Chaudière Viessmann', type: 'chaudiere', assetId: 30 }],
};
const input = { sourceType: 'file' as const, sourceIds: [1], accountId: 1, userId: 1, mimeTypes: ['application/pdf'], displayNames: ['facture.pdf'] };
const variables = (caps: typeof STANDARD) => buildAnalyzeDocumentVariables({ input, groupIndices: [0], ctx, v2Families: [], capabilities: caps });

/** Facture : « Chaudière Viessmann — N° de série ABC123 », le modèle cible l'équipement. */
const sortie = (type: 'EQUIPMENT' | 'ROOM' = 'EQUIPMENT', entityId: number | null = 501) => T1AnalyzeDocumentOutput.parse({
  task: 'ANALYZE_DOCUMENT',
  entities: {
    assets: [{ entityId: 30, score: 0.9, confidence: 'certain' }],
    rooms: type === 'ROOM' ? [{ entityId: 301, rawLabel: 'Chambre', score: 0.9, confidence: 'certain' }] : [],
    equipments: type === 'EQUIPMENT' ? [{ entityId: 501, rawLabel: 'Chaudière Viessmann', score: 0.9, confidence: 'certain' }] : [],
  },
  facts: [{
    canonicalKey: type === 'EQUIPMENT' ? 'serialNumber' : 'roomArea',
    rawValue: type === 'EQUIPMENT' ? 'ABC123' : '12,5 m²',
    normalizedValue: type === 'EQUIPMENT' ? 'ABC123' : 12.5,
    valueType: type === 'EQUIPMENT' ? 'string' : 'number',
    target: { type, entityId, rawLabel: type === 'EQUIPMENT' ? 'Chaudière Viessmann' : 'Chambre', confidence: 'certain', evidenceSignals: ['désignation'] },
    provenance: 'TEXT_EXTRACTION', confidence: 'certain',
    evidence: { excerpt: type === 'EQUIPMENT' ? 'Chaudière Viessmann — N° de série ABC123' : 'Chambre : 12,5 m²', page: 1 },
    semanticEvent: null,
  }],
});
const projeter = (out: ReturnType<typeof sortie>) => projectDocumentFacts(out, {
  knownAssetId: 30, documentAssetId: 30, assetFamilies: new Map([[30, 'IMMOBILIER' as never]]),
  verifiedIds: { ASSET: new Set([30]), EQUIPMENT: new Set([501]), ROOM: new Set([301]), SUPPLIER: new Set() },
});

describe('résolution centrale des capacités', () => {
  it('matrice V1 : Standard non, Premium et Premium Duo oui', () => {
    expect(STANDARD).toEqual({ rooms: false, equipments: false });
    expect(PREMIUM).toEqual({ rooms: true, equipments: true });
    expect(DUO).toEqual({ rooms: true, equipments: true });
  });

  it('PREMIUM_PRO jamais autorisé implicitement ; valeur inconnue : rien', () => {
    expect(capabilitiesForPlan('premium_pro')).toEqual({ rooms: false, equipments: false });
    expect(capabilitiesForPlan('PREMIUM')).toEqual({ rooms: false, equipments: false });
    expect(capabilitiesForPlan(undefined)).toEqual({ rooms: false, equipments: false });
    // Les droits effectifs ne connaissent pas premium_pro (retombe en standard).
    expect(read('src/services/entitlements.service.ts')).toContain("(['standard', 'premium', 'premium_duo'] as const).find((p) => p === row.planCode)\n    ?? 'standard'");
  });

  it('la matrice n’est écrite qu’à un endroit ; plan_limits.features_json n’est pas lu', () => {
    expect(read('src/services/ai/source-analysis/master/prompt-context.ts')).not.toMatch(/PREMIUM|premium/);
    // Aucune lecture (le commentaire d'en-tête la mentionne pour l'exclure).
    const code = read('src/services/account-capabilities.service.ts').replace(/\/\*[^]*?\*\//g, '');
    expect(code).not.toMatch(/features_json|planLimits|plan_limits/);
  });
});

describe('contexte transmis à T1', () => {
  it('T1-CAP-01 — Standard : ENTITY_CONTEXT sans pièces ni équipements existants', () => {
    const v = JSON.parse(variables(STANDARD).ENTITY_CONTEXT);
    expect(v.rooms).toEqual([]);
    expect(v.equipments).toEqual([]);
    expect(v.assets).toHaveLength(1);
    expect(contextFilterStats(ctx, STANDARD)).toEqual({ roomsFilteredFromContext: 1, equipmentsFilteredFromContext: 1 });
  });

  it.each([['T1-CAP-02 — Premium', PREMIUM], ['T1-CAP-03 — Premium Duo', DUO]])('%s : pièces et équipements transmis', (_l, caps) => {
    const v = JSON.parse(describeEntities(ctx, caps));
    expect(v.rooms).toEqual([{ id: 301, name: 'Chambre', assetId: 30 }]);
    expect(v.equipments).toEqual([{ id: 501, name: 'Chaudière Viessmann', type: 'chaudiere', assetId: 30 }]);
  });

  it('ACCOUNT_CAPABILITIES : les capacités, jamais le nom de l’offre', () => {
    expect(JSON.parse(variables(STANDARD).ACCOUNT_CAPABILITIES)).toEqual({ rooms: false, equipments: false });
    expect(JSON.parse(variables(PREMIUM).ACCOUNT_CAPABILITIES)).toEqual({ rooms: true, equipments: true });
    expect(Object.values(variables(PREMIUM)).join(' ')).not.toMatch(/PREMIUM|STANDARD|"plan"/);
  });

  it('T1-CAP-04 — Standard : serialNumber [ASSET, EQUIPMENT] → [ASSET]', () => {
    const fields = JSON.parse(variables(STANDARD).FIELD_CATALOG).fields as Array<{ key: string; targets: string[] }>;
    expect(fields.find((f) => f.key === 'warrantyEndDate')?.targets).toEqual(['ASSET']);
    expect(fields.every((f) => !f.targets.includes('EQUIPMENT') && !f.targets.includes('ROOM'))).toBe(true);
    const premium = JSON.parse(variables(PREMIUM).FIELD_CATALOG).fields as Array<{ key: string; targets: string[] }>;
    expect(premium.find((f) => f.key === 'warrantyEndDate')?.targets).toEqual(['ASSET', 'EQUIPMENT']);
  });

  it('T1-CAP-05 — champ uniquement équipement / pièce : absent du catalogue Standard', () => {
    const synth = { version: 'v', family: null, events: [{ businessType: 'x', label: 'x', natures: [], fieldKeys: ['equipOnly', 'both'] }], documents: [],
      fields: [
        { key: 'equipOnly', label: 'E', valueType: 'string', assistantWritable: false, targets: ['EQUIPMENT'] },
        { key: 'both', label: 'B', valueType: 'string', assistantWritable: false, targets: ['ASSET', 'EQUIPMENT'] },
      ] } as never;
    const r = catalogForCapabilities(synth, STANDARD);
    expect(r.catalog.fields.map((f) => [f.key, f.targets])).toEqual([['both', ['ASSET']]]);
    expect(r.catalog.events[0].fieldKeys).toEqual(['both']);
    expect(r.fieldsFiltered).toBe(1);
    // Registre réel : la surface de pièce (ROOM seulement) n'est pas transmise.
    expect(catalogForCapabilities(catalogForPrompts({ family: 'IMMOBILIER' }), STANDARD).catalog.fields.some((f) => f.key === 'roomArea')).toBe(false);
  });

  it('le registre canonique global n’est jamais modifié', () => {
    catalogForCapabilities(catalogForPrompts(), STANDARD);
    expect(listFields(undefined, { targetType: 'ROOM' }).some((f) => f.key === 'roomArea')).toBe(true);
    expect(listFields(undefined, { targetType: 'EQUIPMENT' }).some((f) => f.key === 'serialNumber')).toBe(true);
  });
});

describe('garde-fou de sortie (serveur)', () => {
  it('T1-CAP-06 — Standard, cible EQUIPMENT : aucune projection équipement, fait requalifié générique', () => {
    const { output, counters } = enforceT1Capabilities(sortie('EQUIPMENT'), STANDARD);
    expect(counters).toEqual({ forbiddenTargetsReturned: 1, forbiddenTargetsRequalified: 1, forbiddenEntitiesDropped: 1 });
    expect(output.entities.equipments).toEqual([]);
    const facts = projeter(output).facts;
    expect(facts.some((f) => f.target.targetType === 'EQUIPMENT')).toBe(false);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ canonicalKey: null, origin: 'GENERIC', target: { targetType: 'GENERIC', targetEntityId: null, targetEntityLabel: 'Chaudière Viessmann' } });
  });

  it('T1-CAP-07 — Standard, cible ROOM : même règle', () => {
    const { output } = enforceT1Capabilities(sortie('ROOM', 301), STANDARD);
    expect(output.entities.rooms).toEqual([]);
    const facts = projeter(output).facts;
    expect(facts.some((f) => f.target.targetType === 'ROOM')).toBe(false);
    expect(facts[0]).toMatchObject({ value: 12.5, target: { targetType: 'GENERIC', targetEntityLabel: 'Chambre' } });
  });

  it('T1-CAP-08 — « Chaudière — N° de série ABC123 » : jamais ASSET.serialNumber, fait générique conservé intégralement', () => {
    const { output } = enforceT1Capabilities(sortie('EQUIPMENT'), STANDARD);
    const facts = projeter(output).facts;
    expect(facts.some((f) => f.canonicalKey === 'serialNumber' || (f.target.targetType === 'ASSET' && f.value === 'ABC123'))).toBe(false);
    expect(facts[0]).toMatchObject({
      subject: 'Chaudière Viessmann', attribute: 'serialNumber', value: 'ABC123', rawValue: 'ABC123',
      provenance: 'TEXT_EXTRACTION', confidence: 'certain',
      evidence: { excerpt: 'Chaudière Viessmann — N° de série ABC123', page: 1 },
    });
    expect(facts[0].rawKey).toBeTruthy();
  });

  it.each([['T1-CAP-09 — Premium', PREMIUM], ['T1-CAP-10 — Premium Duo', DUO]])('%s : ciblage EQUIPMENT autorisé', (_l, caps) => {
    const { output, counters } = enforceT1Capabilities(sortie('EQUIPMENT'), caps);
    expect(counters.forbiddenTargetsReturned).toBe(0);
    expect(output.entities.equipments).toHaveLength(1);
    expect(projeter(output).facts[0]).toMatchObject({ canonicalKey: 'serialNumber', target: { targetType: 'EQUIPMENT', targetEntityId: 501 } });
  });
});

describe('gardes T3 / T4', () => {
  it('T4 : sans la capacité, une cible ÉQUIPEMENT n’est jamais un candidat (ni réattribuée au bien)', () => {
    const champ = {
      fieldKey: 'warrantyEndDate', canonicalKey: 'warrantyEndDate', value: '2031-03-01', excerpt: 'Garantie jusqu’au 01/03/2031',
      confidence: 'certain', provenance: 'TEXT_EXTRACTION',
      target: { targetType: 'EQUIPMENT', targetEntityId: 501, targetEntityLabel: 'Chaudière', targetConfidence: 'certain' },
    } as never;
    const base = { sourceFileId: 1, documentAssetId: 30, multiAsset: false };
    expect(buildAgendaCandidatesT4([champ], { ...base, capabilities: PREMIUM }).map((c) => c.target)).toEqual([{ type: 'EQUIPMENT', id: 501 }]);
    expect(buildAgendaCandidatesT4([champ], { ...base, capabilities: STANDARD })).toEqual([]);
  });

  it('T3 : persistProjectedFacts refuse une preuve pièce / équipement hors capacités (relues si non fournies)', () => {
    const src = read('src/services/ai/source-analysis/steps/persist-evidence.step.ts');
    expect(src).toContain("const caps = p.capabilities ?? await getAccountCapabilities(p.input.accountId);");
    expect(src).toContain("skip(eligible[i].fact, 'CAPABILITY_FORBIDDEN');");
    expect(src.indexOf("'CAPABILITY_FORBIDDEN');")).toBeLessThan(src.indexOf('// 2. Revérification en base'));
  });

  it('isTargetForbidden : seulement ROOM / EQUIPMENT sans la capacité', () => {
    expect(['ASSET', 'DOCUMENT', 'SUPPLIER', 'GENERIC'].some((t) => isTargetForbidden(t, STANDARD))).toBe(false);
    expect(isTargetForbidden('ROOM', STANDARD) && isTargetForbidden('EQUIPMENT', STANDARD)).toBe(true);
    expect(isTargetForbidden('ROOM', PREMIUM) || isTargetForbidden('EQUIPMENT', PREMIUM)).toBe(false);
  });
});

describe('compatibilité d’un texte de version antérieur', () => {
  const ancien = 'TASK = {{TASK}}\nValeurs autorisées : ANALYZE_DOCUMENT\n{{SOURCES}}\nBRANCHE TASK = ANALYZE_DOCUMENT\n';
  it('ACCOUNT_CAPABILITIES sans emplacement : ignorée, jamais concaténée ; toute autre variable reste refusée', () => {
    const out = renderMasterPrompt(ancien, { masterPromptCode: 't1_master_v1', task: 'ANALYZE_DOCUMENT', allowedTasks: ['ANALYZE_DOCUMENT'],
      variables: { SOURCES: '[]', ACCOUNT_CAPABILITIES: '{"rooms":false}' } });
    expect(out).not.toContain('rooms');
    expect(() => renderMasterPrompt(ancien, { masterPromptCode: 't1_master_v1', task: 'ANALYZE_DOCUMENT', allowedTasks: ['ANALYZE_DOCUMENT'],
      variables: { SOURCES: '[]', AUTRE: 'x' } })).toThrow(/sans emplacement/);
  });

  it('contrôle BO : texte master T1 sans {{ACCOUNT_CAPABILITIES}} → avertissement NON bloquant ; autre emplacement manquant → bloquant', async () => {
    const { masterConfigIssues, checkMasterProposal } = await import('@/services/ai/config/prompt-architecture');
    const { emptyTreatmentConfig } = await import('@/services/ai/config/config-types');
    const depot = read('src/services/ai/prompts/source-analysis/t1_master_v1.txt');
    const sansCaps = depot.replaceAll('{{ACCOUNT_CAPABILITIES}}', '');
    expect(checkMasterProposal('T1', depot)).toEqual([]);
    expect(checkMasterProposal('T1', sansCaps)).toEqual([]);
    const issues = masterConfigIssues({ ...emptyTreatmentConfig('T1'), primaryModel: 'm', masterPrompt: sansCaps });
    const avert = issues.filter((i) => i.field === 'masterPrompt');
    expect(avert).toHaveLength(1);
    expect(avert[0].blocking).toBe(false);
    expect(avert[0].message).toContain('{{ACCOUNT_CAPABILITIES}}');
    // Un emplacement obligatoire supprimé reste bloquant.
    const sansSources = depot.replaceAll('{{SOURCES}}', '');
    expect(masterConfigIssues({ ...emptyTreatmentConfig('T1'), primaryModel: 'm', masterPrompt: sansSources })
      .some((i) => i.blocking && /SOURCES/.test(i.message))).toBe(true);
    // Texte du dépôt : aucun avertissement.
    expect(masterConfigIssues({ ...emptyTreatmentConfig('T1'), primaryModel: 'm', masterPrompt: depot })
      .filter((i) => i.field === 'masterPrompt')).toEqual([]);
  });

  it('le texte du dépôt porte l’emplacement et la règle', () => {
    const t = read('src/services/ai/prompts/source-analysis/t1_master_v1.txt');
    expect(t).toContain('{{ACCOUNT_CAPABILITIES}}');
    expect(t).toMatch(/ROOM n’est utilisable que si ACCOUNT_CAPABILITIES\.rooms vaut true/);
  });
});
