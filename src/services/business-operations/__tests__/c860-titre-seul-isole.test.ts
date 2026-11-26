/**
 * Carte #860 — « T4 : isoler le mode titleOnly, préserver les cartes À traiter et extraire le titre des SYNC
 * mixtes (#832) ». Règles PURES de la sélection des titres exécutables et contrats statiques des chemins actifs.
 *
 *   C860-U-01  SYNC mixte : le titre indépendant est EXTRAIT (date, liens, catégorie restent en attente) ; la SYNC
 *              entière n'est toujours pas une action « titre seulement »
 *   C860-U-02  SYNC qui requalifie type / nature / clé / appartenance : titre non isolable, motif explicite
 *   C860-U-03  RETITLE : exécutable sur l'élément déjà rattaché ; jamais sur un candidat à rattacher, un élément
 *              retiré ou soumis à une décision de représentation
 *   C860-U-04  protections : événement saisi, titre USER / INCONNU (#859), projection modifiée, statut ouvert,
 *              Opération inactive, titre changé depuis le plan, titres contradictoires — abstention motivée
 *   C860-U-05  plan RÉEL (`planOperationProjection`) : projection intacte d'un achat dont titre et date divergent
 *   C860-U-06  chemins actifs : isolation du mode (cartes, dates, orphelines), écrivain limité au titre, parité
 *              simulation / projection / reprise
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decideProjection, isTitleOnlyAction, planOperationProjection, projectionFunctionalKey, selectTitleOnlyActions,
  type AgendaItemSnapshot, type ItemSync, type OperationSnapshot, type ProjectionAction,
} from '../agenda-projection/model';
import { nonTitleActions } from '../agenda-projection/purchase-title-reprise';

const ROOT = resolve(__dirname, '..', '..', '..', '..');
const lire = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const AUJ = '2026-11-20';
const BIEN = 7;
const FICHIER = 50;
const OP = 10;
const CLE = projectionFunctionalKey(OP, 'ACQUISITION');

function op(over: Partial<OperationSnapshot> = {}): OperationSnapshot {
  return {
    id: OP, accountId: 1, typeCode: 'ACQUISITION', status: 'REALIZED', technicalLabel: 'Achat de carburant', provider: 'TotalEnergies',
    plannedDate: null, realizedDate: AUJ, endDate: null, active: true, assetIds: [BIEN], equipmentIds: [], documentFileIds: [FICHIER],
    contractEffectiveTo: null, claimHistoryEventId: null, disposalKind: 'SALE', assetNames: ['Cupra'],
    documentTitles: ['Ticket de carburant'], ...over,
  };
}
/** Projection INTACTE de l'Opération (élément porteur de l'achat). */
function projection(over: Partial<AgendaItemSnapshot> = {}): AgendaItemSnapshot {
  return {
    id: 100, title: 'Achat', date: AUJ, isAutomatic: true, isAutomaticModified: false, projected: true,
    businessOperationId: OP, linkedOperationActive: true, nature: 'HISTORICAL', businessType: 'purchase', homeCategory: 'information',
    functionalKey: CLE, originRefType: 'business_operation', originRefId: OP, assetIds: [BIEN], equipmentIds: [], fileIds: [],
    carriedFact: 'ACQUISITION', carrierOrigin: 'T4', ...over,
  };
}
/** Événement automatique du justificatif, déjà rattaché à l'Opération. */
const evtDocument = (over: Partial<AgendaItemSnapshot> = {}): AgendaItemSnapshot =>
  projection({ id: 200, projected: false, functionalKey: null, originRefType: 'asset_file', originRefId: FICHIER, fileIds: [FICHIER], ...over });

const sync = (changes: ItemSync, itemId = 100): ProjectionAction => ({ kind: 'SYNC', itemId, changes });
const select = (plan: ProjectionAction[], linked: AgendaItemSnapshot[] = [projection()], o: Partial<OperationSnapshot> = {}) =>
  selectTitleOnlyActions({ op: op(o), plan, linked });

describe('C860-U-01 — SYNC mixte : le titre indépendant est extrait, le reste reste en attente', () => {
  it('SYNC {titre, date} : titre exécutable (même élément, valeur attendue, représentation lue au plan), date différée', () => {
    const s = select([sync({ title: 'Achat de carburant', date: '2026-11-18' })]);
    expect(s.executable).toEqual([{
      itemId: 100, title: 'Achat de carburant', from: 'Achat', source: 'SYNC',
      expected: { functionalKey: CLE, businessType: 'purchase', nature: 'HISTORICAL' },
    }]);
    expect(s.refused).toEqual([]);
    expect(s.deferred).toEqual([sync({ date: '2026-11-18' })]);
  });

  it('SYNC {titre, liens} et {titre, catégorie} : même extraction, liens et catégorie différés', () => {
    const liens = { assetIds: [BIEN, 9], equipmentIds: [] };
    expect(select([sync({ title: 'Achat de carburant', links: liens })])).toMatchObject({
      executable: [{ itemId: 100, source: 'SYNC' }], deferred: [sync({ links: liens })],
    });
    expect(select([sync({ title: 'Achat de carburant', homeCategory: 'action', date: null })])).toMatchObject({
      executable: [{ itemId: 100, source: 'SYNC' }], deferred: [sync({ homeCategory: 'action', date: null })],
    });
  });

  it('SYNC du seul titre : exécutable, rien de différé ; SYNC sans titre : rien à écrire, entière au plan informatif', () => {
    expect(select([sync({ title: 'Achat de carburant' })])).toMatchObject({ executable: [{ itemId: 100 }], deferred: [] });
    const s = select([sync({ date: '2026-11-18' })]);
    expect(s.executable).toEqual([]);
    expect(s.refused).toEqual([]);
    expect(s.deferred).toEqual([sync({ date: '2026-11-18' })]);
  });

  it('la SYNC mixte, prise en entier, n’est toujours pas une action « titre seulement » et reste une autre action au rapport', () => {
    const mixte = sync({ title: 'Achat de carburant', date: '2026-11-18' });
    expect(isTitleOnlyAction(mixte)).toBe(false);
    expect(nonTitleActions([mixte])).toEqual(['SYNC']);
  });
});

describe('C860-U-02 — SYNC qui requalifie la représentation : titre non isolable', () => {
  it.each([
    [{ businessType: 'maintenance' }, 'TITLE_DEPENDS_ON_TYPE_CORRECTION'],
    [{ nature: 'DEADLINE' as const }, 'TITLE_DEPENDS_ON_NATURE_CORRECTION'],
    [{ functionalKey: 'op:10:AUTRE' }, 'TITLE_DEPENDS_ON_KEY_CHANGE'],
    [{ businessOperationId: OP }, 'TITLE_DEPENDS_ON_ATTACHMENT'],
  ] as Array<[ItemSync, string]>)('SYNC {titre, %o} → %s, aucune écriture, SYNC conservée sans son titre', (autre, motif) => {
    const s = select([sync({ title: 'Achat de carburant', ...autre })]);
    expect(s.executable).toEqual([]);
    expect(s.refused).toEqual([{ itemId: 100, title: 'Achat de carburant', from: 'Achat', source: 'SYNC', reason: motif }]);
    expect(s.deferred).toEqual([sync(autre)]);
  });
});

describe('C860-U-03 — RETITLE : seulement sur l’événement déjà rattaché, jamais sur une représentation à décider', () => {
  const retitle = (itemId = 200): ProjectionAction => ({ kind: 'RETITLE', itemId, title: 'Achat de carburant', from: 'Achat' });

  it('événement du justificatif déjà rattaché : exécutable (source RETITLE), CARRY et DATE n’y font pas obstacle', () => {
    const s = select([retitle(), { kind: 'CARRY', itemId: 200, fact: 'ACQUISITION' }, { kind: 'DATE', itemId: 200, date: AUJ }], [evtDocument()]);
    expect(s.executable).toEqual([{ itemId: 200, title: 'Achat de carburant', from: 'Achat', source: 'RETITLE' }]);
    expect(s.deferred.map((a) => a.kind)).toEqual(['CARRY', 'DATE']);
  });

  it('candidat que le plan prévoit de rattacher (LINK) : jamais renommé', () => {
    // Candidat non encore rattaché (pool de rapprochement) : absent des éléments liés.
    expect(select([{ kind: 'LINK', itemId: 200, reason: 'r' }, retitle()], []).refused)
      .toEqual([expect.objectContaining({ itemId: 200, reason: 'ITEM_NOT_LINKED_TO_OPERATION' })]);
    // Membre déjà lié que le LINK ferait porter l'achat : le titre dépend de ce rattachement.
    expect(select([{ kind: 'LINK', itemId: 200, reason: 'r' }, retitle()], [evtDocument({ carriedFact: null })]).refused)
      .toEqual([expect.objectContaining({ itemId: 200, reason: 'TITLE_DEPENDS_ON_ATTACHMENT' })]);
  });

  it('élément retiré / détaché par le plan, ou soumis à une décision de représentation : abstention motivée', () => {
    expect(select([{ kind: 'REMOVE', itemId: 200, reason: 'r' }, retitle()], [evtDocument()]).refused[0].reason).toBe('TITLE_DEPENDS_ON_REMOVAL');
    expect(select([{ kind: 'DETACH', itemId: 200, reason: 'r' }, retitle()], [evtDocument()]).refused[0].reason).toBe('TITLE_DEPENDS_ON_REMOVAL');
    expect(select([retitle(), { kind: 'REPRESENTATION_REQUIRED', itemIds: [200, 300], reason: 'EQUIVALENTS_BESIDE_SLOT' }], [evtDocument()]).refused[0].reason)
      .toBe('TITLE_DEPENDS_ON_REPRESENTATION');
    expect(select([sync({ title: 'Achat de carburant' }), {
      kind: 'ABSTAIN', reason: 'PROBABLE_EQUIVALENT', itemId: 100, key: 'ACQUISITION', candidates: [{ itemId: 100, title: 'Achat', date: AUJ, reason: 'r' }],
    }]).refused[0].reason).toBe('TITLE_DEPENDS_ON_REPRESENTATION');
  });

  it('une représentation à décider qui ne concerne PAS l’élément n’empêche pas son titre indépendant', () => {
    const s = select([sync({ title: 'Achat de carburant' }), { kind: 'REPRESENTATION_REQUIRED', itemIds: [300, 301], reason: 'r' }]);
    expect(s.executable).toHaveLength(1);
    expect(s.deferred).toEqual([{ kind: 'REPRESENTATION_REQUIRED', itemIds: [300, 301], reason: 'r' }]);
  });
});

describe('C860-U-04 — protections : abstention motivée, sans assouplir #859', () => {
  const titre = [sync({ title: 'Achat de carburant', date: '2026-11-18' })];
  it.each([
    ['événement saisi', { isAutomatic: false }, 'MANUAL_ITEM'],
    ['titre USER (#859)', { titleAuthority: { authority: 'USER', reason: 'USER_TITLE_RECORDED', evidence: 'title_provenance' } }, 'TITLE_NOT_SYSTEM'],
    ['titre INCONNU (#859)', { isAutomaticModified: true }, 'TITLE_NOT_SYSTEM'],
    ['projection modifiée, titre SYSTEM', { isAutomaticModified: true, titleAuthority: { authority: 'SYSTEM', reason: 'SYSTEM_TITLE_RECORDED', evidence: 'title_provenance' } }, 'PROJECTION_MODIFIED'],
    ['statut ouvert (« à qualifier », prévision)', { pendingHold: true }, 'ITEM_PENDING_STATUS'],
    ['élément d’une autre Opération', { businessOperationId: 99 }, 'ITEM_NOT_LINKED_TO_OPERATION'],
  ] as Array<[string, Partial<AgendaItemSnapshot>, string]>)('%s → %s', (_cas, over, motif) => {
    const s = selectTitleOnlyActions({ op: op(), plan: titre, linked: [projection(over)] });
    expect(s.executable).toEqual([]);
    expect(s.refused.map((r) => r.reason)).toEqual([motif]);
  });

  it('RETITLE dont la valeur attendue n’est plus le titre lu : TITLE_CHANGED_SINCE_PLAN', () => {
    const s = select([{ kind: 'RETITLE', itemId: 200, title: 'Achat de carburant', from: 'Achat' }], [evtDocument({ title: 'Mon plein' })]);
    expect(s.refused).toEqual([expect.objectContaining({ itemId: 200, from: 'Achat', reason: 'TITLE_CHANGED_SINCE_PLAN' })]);
  });

  it('autorité INCONNUE rendue avec son motif #859 ; Opération inactive ; titres contradictoires pour un même élément', () => {
    expect(select(titre, [projection({ isAutomaticModified: true })]).refused[0].authority).toMatchObject({ authority: 'UNKNOWN', reason: 'MODIFIED_WITHOUT_TITLE_TRACE' });
    expect(select(titre, [projection()], { active: false }).refused[0].reason).toBe('OPERATION_INACTIVE');
    const s = select([sync({ title: 'A' }), { kind: 'RETITLE', itemId: 100, title: 'B', from: 'Achat' }]);
    expect(s.executable).toEqual([]);
    expect(s.refused.map((r) => r.reason)).toEqual(['CONFLICTING_TITLES']);
  });
});

describe('C860-U-05 — plan RÉEL : projection intacte d’un achat dont le titre et la date divergent', () => {
  it('le plan normal rend une SYNC mixte ; la sélection en extrait le titre, la date reste en attente', () => {
    const o = op();
    const linked = [projection({ title: 'Achat', date: '2026-11-18' })];
    const plan = planOperationProjection({ op: o, decision: decideProjection(o, AUJ), linked, suppressedKeys: new Set(), candidates: [] });
    const s = plan.find((a) => a.kind === 'SYNC') as Extract<ProjectionAction, { kind: 'SYNC' }>;
    expect(s.changes).toMatchObject({ title: 'Achat de carburant', date: AUJ });
    const sel = selectTitleOnlyActions({ op: o, plan, linked });
    expect(sel.executable).toEqual([expect.objectContaining({ itemId: 100, title: 'Achat de carburant', from: 'Achat', source: 'SYNC' })]);
    expect(sel.deferred).toContainEqual({ kind: 'SYNC', itemId: 100, changes: { date: AUJ } });
  });

  it('plan d’une Opération sans titre à corriger : aucune sélection (rien à écrire)', () => {
    const o = op();
    const linked = [projection({ title: 'Achat de carburant', date: '2026-11-18' })];
    const plan = planOperationProjection({ op: o, decision: decideProjection(o, AUJ), linked, suppressedKeys: new Set(), candidates: [] });
    const sel = selectTitleOnlyActions({ op: o, plan, linked });
    expect(sel.executable).toEqual([]);
    expect(sel.refused).toEqual([]);
  });
});

describe('C860-U-06 — chemins actifs : isolation, écrivain du titre seul, parité', () => {
  const service = lire('src/services/business-operations/agenda-projection/service.ts');
  const consolidation = lire('src/services/business-operations/agenda-projection/consolidation.ts');
  const reprise = lire('src/services/business-operations/agenda-projection/purchase-title-reprise.ts');

  it('mode « titre seulement » : branche dédiée, aucune carte de rapprochement / de date, aucun nettoyage d’orphelines', () => {
    const branche = service.slice(service.indexOf('if (opts.titleOnly) {'), service.indexOf('    for (const action of plan) {\n      if (action.kind === \'LINK\')'));
    expect(branche).toMatch(/selectTitleOnlyActions/);
    expect(branche).toMatch(/applyTitleOnly/);
    expect(branche).toMatch(/continue;/);
    for (const interdit of ['besoins.push', 'applyAction(', 'recomputePrincipal', 'representationRequired']) expect(branche).not.toContain(interdit);
    // Cartes de rapprochement et de date : jamais appelées en mode « titre seulement ».
    expect(service).toMatch(/if \(opts\.dryRun \|\| opts\.titleOnly\) return;\n\s+\{\n\s+const \{ syncAgendaProjectionCards \}/);
    expect(service).toMatch(/if \(!opts\.dryRun && !opts\.titleOnly\) await cleanupOrphans/);
  });

  it('applyTitleOnly : deux écrivains du titre seul, résultat relu, seuls `retitled` et `changes` comptés', () => {
    const f = service.slice(service.indexOf('async function applyTitleOnly('), service.indexOf('Lot 83A (CDC v5 §11.5 – §11.8, AC17, AC19, AC20)'));
    expect(f).toMatch(/retitleAgendaItem\(/);
    expect(f).toMatch(/writeProjectionTitleOnly\(/);
    expect(f).not.toMatch(/writeAgendaItem|removeAgendaItemsTraced|attachProjected|detachItem|syncAgendaProjectionCards|produceAgendaActions/);
    expect(f).toMatch(/SELECT title FROM agenda_items WHERE id = \$\{c\.itemId\} AND account_id = \$\{op\.accountId\}/);
    expect(f.match(/res\.[a-zA-Z]+/g)?.filter((x) => x !== 'res.titleOnly').sort()).toEqual(['res.changes', 'res.retitled', 'res.retitled']);
  });

  it('écrivain dédié : n’écrit QUE le titre et l’horodatage, gardes #859 réutilisées, journal restaurable', () => {
    const f = consolidation.slice(consolidation.indexOf('export async function writeProjectionTitleOnly('), consolidation.indexOf('// ── Restauration'));
    const updates = f.match(/UPDATE agenda_items i SET [^W]+WHERE/g) ?? [];
    expect(updates).toEqual(['UPDATE agenda_items i SET title = $4, updated_at = now() WHERE']);
    expect(f).not.toMatch(/projection_origin\s*=|projection_correlation_id|functional_key\s*=|business_type\s*=|event_nature\s*=/);
    expect(f).toMatch(/declareTitleWritePg\(/);
    expect(f).toMatch(/'RETITLE'/);
    const garde = consolidation.slice(consolidation.indexOf('const PROJECTION_TITLE_ONLY_SQL'), consolidation.indexOf('export async function writeProjectionTitleOnly('));
    expect(garde).toMatch(/\$\{PURCHASE_RETITLE_SQL\}/);
    expect(garde).toMatch(/i\.title = \$5/);
    expect(garde).toMatch(/i\.business_operation_id = \$3/);
    expect(garde).toMatch(/NOT COALESCE\(i\.is_automatic_modified, false\)/);
    // La garde #859 n'est pas assouplie : RETITLE garde PURCHASE_RETITLE_SQL / ABSORBABLE_SQL.
    expect(consolidation).toMatch(/THEN \(\$\{PURCHASE_RETITLE_SQL\}\) ELSE \(\$\{ABSORBABLE_SQL\}\) END/);
  });

  it('reprise : même sélection pour le constat (simulation « titre seulement ») et l’application ; compteurs du résultat réel', () => {
    expect(reprise).toMatch(/dryRun: true, titleOnly: true/);
    expect(reprise).toMatch(/titleOnly: true, \.\.\.jour/);
    expect(reprise).toMatch(/t\.status === 'RENAMED'/);
    // L'ancien aperçu « tout SYNC contenant un titre » a disparu.
    expect(reprise).not.toMatch(/a\.kind === 'SYNC' && a\.changes\.title !== undefined/);
  });
});
