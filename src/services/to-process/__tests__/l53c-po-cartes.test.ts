/**
 * Lot 53 (retour PO D14, Q17) — règles pures des cartes « À traiter » de
 * décision. Les parcours en base sont couverts par
 * `src/test/e2e/scenarios/l53c-po-sinistres-agenda.e2e.ts`.
 *
 * Lot 83D (CDC v5 §15, §18.4 ; arbitrages V-Q1, V-Q2) : PO-D10 (brouillon du
 * formulaire Sinistre) et PO-D11 (carte « garder / dissocier » une
 * intervention enfant) n'ont plus d'objet — formulaire et intervention enfant
 * retirés. Remplacés par PO-D10/D11-83D, qui prouvent leur ABSENCE.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const {
  OPERATION_ASSET_EXCLUSION_RULE, OPERATION_CARD_RULES, RETIRED_CLAIM_PARENT_RULES,
  exclusionProposals, exclusionQuestion, isOperationCardRule, parseOperationCardChoice,
} = await import('../operation-cards');
const {
  AGENDA_PROJECTION_MATCH_RULE, agendaProjectionProposals, agendaProjectionQuestion, agendaProjectionRelationKey, parseAgendaProjectionChoice,
} = await import('../agenda-projection-cards');
const { PROCESSING_RULES, RULE_PRODUCERS } = await import('../rules-catalog');
const { selectDisplayedProposals, isDisplayableArbitration } = await import('../action-model');
const { todoTitle } = await import('@/services/home/mascot/todo-items');
const { decideProjection, planOperationProjection, matchExistingItem } = await import('@/services/business-operations/agenda-projection/model');
const { applyAssetExclusions } = await import('@/services/business-operations/consolidation/asset-exclusions');

const ROOT = resolve(__dirname, '..', '..', '..', '..');
const lire = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

describe('PO-D14 — agenda : doute sur l\'événement à relier → carte « À traiter » avec candidats et provenance', () => {
  const op = {
    id: 10, accountId: 1, typeCode: 'INTERVENTION' as const, status: 'REALIZED' as const, technicalLabel: 'Remplacement chaudière', provider: 'Chauffage Martin',
    plannedDate: null, realizedDate: '2026-03-10', endDate: null, active: true, assetIds: [5], equipmentIds: [], documentFileIds: [77],
    contractEffectiveTo: null, claimHistoryEventId: null, disposalKind: null,
  };
  const item = (over: Record<string, unknown>) => ({
    id: 100, title: 'Événement', date: '2026-03-10', manualStatus: null, isAutomatic: false, isAutomaticModified: false, projected: false,
    businessOperationId: null, linkedOperationActive: false, nature: null, businessType: null, homeCategory: null, functionalKey: null,
    originRefType: null, originRefId: null, assetIds: [5], equipmentIds: [], fileIds: [], ...over,
  });
  const plan = (candidates: ReturnType<typeof item>[], extra: Record<string, unknown> = {}) => planOperationProjection({
    op, decision: decideProjection(op, '2026-10-12'), linked: [], suppressedKeys: new Set(), candidates, statusCardItems: new Set(), ...extra,
  } as never);

  it('PO-D14-01 deux événements aussi plausibles : aucune projection, aucun lien, l\'abstention porte les DEUX candidats et leur motif', () => {
    const r = plan([item({ id: 7, title: 'Entretien' }), item({ id: 8, title: 'Réparation' })]);
    // Lot 87B (test corrigé) : l'abstention est accompagnée de la demande de décision T4 (aucune écriture).
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ kind: 'ABSTAIN', key: 'INTERVENTION' });
    expect(r[1]).toMatchObject({ kind: 'REPRESENTATION_REQUIRED', itemIds: [7, 8] });
    const c = (r[0] as { candidates: Array<{ itemId: number; reason: string }> }).candidates;
    expect(c.map((x) => x.itemId)).toEqual([7, 8]);
    expect(c[0].reason).toMatch(/plusieurs événements équivalents|signaux/);
    expect(r.some((a) => a.kind === 'LINK' || a.kind === 'CREATE' || a.kind === 'MARK_DONE')).toBe(false);
  });

  it('PO-D14-02 candidats probables classés par écart de date (au plus 3) ; un certain unique reste relié sans carte', () => {
    const m = matchExistingItem(op, (decideProjection(op, '2026-10-12') as unknown as { desired: never }).desired, [
      item({ id: 1, title: 'Note', date: '2026-03-25', fileIds: [77], assetIds: [] }),
      item({ id: 2, title: 'Note', date: '2026-03-20', fileIds: [77], assetIds: [] }),
    ] as never);
    expect(m.kind).toBe('probable');
    expect((m as { candidates: Array<{ item: { id: number } }> }).candidates.map((x) => x.item.id)).toEqual([2, 1]);
    // Lot 87B (test corrigé) : « un certain unique reste relié » seulement sur PROVENANCE (document de l'intervention) ;
    // même bien + type compatible + date proche → abstention, carte et décision T4 (jamais un lien d'office).
    expect(plan([item({ id: 3, title: 'Entretien chaudière', businessType: 'maintenance', fileIds: [77] })])[0]).toMatchObject({ kind: 'LINK', itemId: 3 });
    expect(plan([item({ id: 3, title: 'Entretien chaudière', businessType: 'maintenance' })])[0]).toMatchObject({ kind: 'ABSTAIN', itemId: 3 });
  });

  it('PO-D14-03 choix « nouvel événement » : création sans nouveau rapprochement ; une suppression de l\'utilisateur reste respectée', () => {
    const deux = [item({ id: 7, title: 'Entretien' }), item({ id: 8, title: 'Réparation' })];
    expect(plan(deux, { forceCreate: true })[0]).toMatchObject({ kind: 'CREATE' });
    expect(plan(deux, { forceCreate: true, suppressedKeys: new Set(['INTERVENTION']) })[0]).toMatchObject({ kind: 'SUPPRESSED' });
  });

  it('PO-D14-04 carte actionnable : question avec provenance, propositions affichables (2 candidats + nouvel événement), choix restreints aux candidats', () => {
    const cands = [{ itemId: 7, title: 'Entretien', date: '2026-03-10', reason: 'x' }, { itemId: 8, title: 'Réparation', date: '2026-03-11', reason: 'y' }];
    const q = agendaProjectionQuestion({ title: 'Remplacement chaudière', date: '2026-03-10', typeCode: 'INTERVENTION' }, cands, 'Facture Martin');
    expect(q).toContain('« Facture Martin »');
    expect(q).toContain('« Remplacement chaudière » du 10/03/2026');
    expect(q).not.toMatch(/op[ée]ration/i);
    const props = agendaProjectionProposals(cands);
    expect(isDisplayableArbitration(props)).toBe(true);
    expect(selectDisplayedProposals(props).map((p) => p.value)).toEqual(['ITEM:7', 'ITEM:8', 'NEW']);
    const seul = agendaProjectionQuestion({ title: 'Remplacement chaudière', date: '2026-03-10', typeCode: 'INTERVENTION' }, [cands[0]], null);
    expect(seul).toBe('Dans votre agenda, « Entretien » du 10/03/2026 correspond-il à « Remplacement chaudière » du 10/03/2026 ?');
    const ctx = { candidates: cands };
    expect(parseAgendaProjectionChoice('ITEM:7', ctx)).toEqual({ kind: 'ITEM', itemId: 7 });
    expect(parseAgendaProjectionChoice('ITEM:99', ctx)).toBeNull();
    expect(parseAgendaProjectionChoice('NEW', ctx)).toEqual({ kind: 'NEW' });
    expect(parseAgendaProjectionChoice('NONE', ctx)).toEqual({ kind: 'NONE' });
    expect(agendaProjectionRelationKey(10, 'INTERVENTION')).toBe('agendaProjectionMatch:10:INTERVENTION');
  });

  it('PO-D14-05 règle déclarée au catalogue (producteur réel, appelé par la projection), libellé mascotte', () => {
    const r = PROCESSING_RULES.find((x) => x.code === AGENDA_PROJECTION_MATCH_RULE)!;
    expect(r).toMatchObject({ targetType: 'ASSET', relationKey: 'agendaProjectionMatch', producer: 'T4_PROJECTION_MATCH' });
    expect(RULE_PRODUCERS.T4_PROJECTION_MATCH.entries).toEqual(['syncAgendaProjectionCards']);
    expect(lire('src/services/business-operations/agenda-projection/service.ts')).toContain('syncAgendaProjectionCards(accountId, besoins');
    expect(todoTitle(AGENDA_PROJECTION_MATCH_RULE, 'ARBITRATE')).toBe('Événement de l’agenda à rapprocher');
  });
});

describe('PO-D11-83D — plus d’intervention enfant d’un sinistre (CDC v5 §18.4, AC39) : carte « garder / dissocier » retirée', () => {
  it('la règle n’est plus produite ni résolue ; seul le rattrapage de nettoyage la lit pour clore les cartes ouvertes', () => {
    expect(RETIRED_CLAIM_PARENT_RULES).toEqual(['OPERATION-CLAIM-PARENT', 'OPERATION-CLAIM-DETACH']);
    for (const r of RETIRED_CLAIM_PARENT_RULES) {
      expect(isOperationCardRule(r)).toBe(false);
      expect(OPERATION_CARD_RULES).not.toContain(r as never);
      expect(PROCESSING_RULES.some((x) => x.code === r)).toBe(false);
      expect(parseOperationCardChoice(r, 'KEEP', { operationId: 1, claimId: 9 })).toBeNull();
    }
    const src = lire('src/services/business-operations/consolidation/consolidator.ts');
    expect(src).not.toMatch(/setParent|CLAIM_ACTION_INVOICE|business_operation_claim_actions/);
  });
});

describe('PO-Q17 — bien retiré d\'un sinistre : exclusion mémorisée, jamais de réintégration automatique', () => {
  const ex = [{ id: 1, assetId: 2, acknowledgedFileIds: [50] }];

  it('PO-Q17-01 un bien exclu n\'est jamais relié, même cité par un document ; un document non arbitré produit un conflit (carte)', () => {
    const r = applyAssetExclusions([{ assetId: 1 }, { assetId: 2 }], [{ assetId: 2, fileId: 50 }, { assetId: 2, fileId: 60 }, { assetId: 1, fileId: 60 }], ex);
    expect(r.assets).toEqual([{ assetId: 1 }]);
    expect(r.conflicts).toEqual([{ assetId: 2, exclusionId: 1, fileIds: [60] }]);
  });

  it('PO-Q17-02 document déjà arbitré (« il reste hors du sinistre ») : plus de carte pour lui ; sans exclusion : comportement inchangé', () => {
    expect(applyAssetExclusions([{ assetId: 2 }], [{ assetId: 2, fileId: 50 }], ex)).toEqual({ assets: [], conflicts: [] });
    expect(applyAssetExclusions([{ assetId: 2 }], [{ assetId: 2, fileId: 50 }], [])).toEqual({ assets: [{ assetId: 2 }], conflicts: [] });
  });

  it('PO-Q17-03 carte de décision : document à l\'origine, exclusion = valeur actuelle, réintégration = choix explicite', () => {
    expect(OPERATION_CARD_RULES).toContain(OPERATION_ASSET_EXCLUSION_RULE);
    const q = exclusionQuestion('Garage', 'Dégât des eaux du 12/03/2026');
    expect(q).toContain('« Garage »');
    expect(q).toContain('retiré du sinistre');
    const props = exclusionProposals('Garage');
    expect(props.find((p) => p.isCurrentValue)?.value).toBe('KEEP_EXCLUDED');
    expect(parseOperationCardChoice(OPERATION_ASSET_EXCLUSION_RULE, 'REINSTATE', { operationId: 1, assetId: 2, fileIds: [60] })).toEqual({ kind: 'REINSTATE' });
    expect(parseOperationCardChoice(OPERATION_ASSET_EXCLUSION_RULE, 'KEEP_EXCLUDED', { operationId: 1, assetId: 2, fileIds: [60] })).toEqual({ kind: 'KEEP_EXCLUDED' });
    expect(parseOperationCardChoice(OPERATION_ASSET_EXCLUSION_RULE, 'AUTRE', {})).toBeNull();
    expect(todoTitle(OPERATION_ASSET_EXCLUSION_RULE, 'ARBITRATE')).toBe('Bien retiré d’un sinistre à confirmer');
    expect(lire('src/services/to-process/operation-cards.ts')).toContain('documents: n.fileIds.map((f) => ({ fileId: f, title: titres.get(f) ?? \'Document\' }))');
  });
});

describe('PO-D10-83D — plus de formulaire Sinistre (V-Q1) : ni brouillon, ni création depuis l’interface', () => {
  it('aucun composant ni route de saisie d’un sinistre (fiche et préparation du dossier, ordinateur et mobile)', () => {
    const panel = lire('src/components/exports/preparation/ClaimExportPanel.tsx');
    expect(panel).not.toMatch(/apiClient|ClaimEditor|claimId=\{null\}/);
    expect(() => lire('src/components/assets/claims/AssetClaimsSection.tsx')).toThrow();
    expect(() => lire('src/app/api/assets/[id]/claims/route.ts')).toThrow();
  });
});
