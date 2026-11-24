/**
 * Carte 832 — « Achats : unifier le nommage Opération/Agenda, corriger les
 * titres trompeurs ». Règles PURES des deux écarts nommés par la carte.
 *
 * ── L'ÉCART (§ 3.B) ───────────────────────────────────────────────────────
 * `isUninformativePurchaseTitle` découpait l'intitulé sur « ␣—␣ » SEULEMENT :
 * « Achat — Decathlon » était reconnu comme ne disant pas ce qui a été acheté,
 * mais « Achat Decathlon » — la forme réellement produite, visible sur la
 * capture utilisateur du 22/11/2026 — passait pour un intitulé explicite et
 * n'était donc jamais corrigé. Même histoire pour « Achat Cupra », où Cupra
 * est le bien associé et non l'objet acheté.
 *
 * ── L'ÉCART (§ 3.C) ───────────────────────────────────────────────────────
 * La reprise n'appliquait les renommages QUE pour les opérations dont le plan
 * de projection ne contenait aucune autre action (`otherPendingActions`) : un
 * écart annexe — un événement à créer, une date à poser — suffisait à laisser
 * le titre trompeur en place, alors que le corriger est sûr et indépendant.
 *
 *   C832-U-01  sujet d'un intitulé d'achat, avec ou sans ponctuation
 *   C832-U-02  « Achat <bien> », « Achat <prestataire> », « Achat <justificatif> »
 *              sont insuffisants, tiret ou pas ; un vrai objet ne l'est jamais
 *   C832-U-03  rien n'est renommé sans intitulé d'Opération plus précis :
 *              une vraie acquisition du bien garde son titre
 *   C832-U-04  passage « titre seulement » : une seule règle, et la reprise
 *              n'est plus bloquée par un écart de projection annexe
 *
 * Les règles de nommage elles-mêmes (objet, catégorie, grammaire, protection
 * des titres de l'utilisateur) restent couvertes par
 * `c821-titre-evenements-achat.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decideProjection, isTitleOnlyAction, isUninformativePurchaseTitle, planOperationProjection, precisePurchaseTitle,
  purchaseTitleSubject, type AgendaItemSnapshot, type OperationSnapshot, type ProjectionAction,
} from '../agenda-projection/model';
import { nonTitleActions } from '../agenda-projection/purchase-title-reprise';

const ROOT = resolve(__dirname, '..', '..', '..', '..');
const lire = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const AUJ = '2026-11-20';
const CUPRA = 7;
const VELO = 8;
const FICHIER = 50;

/** Opération d'achat de carburant pour la Cupra (cas réel de la capture). */
function op(over: Partial<OperationSnapshot> = {}): OperationSnapshot {
  return {
    id: 10, accountId: 1, typeCode: 'ACQUISITION', status: 'REALIZED', technicalLabel: 'Achat de carburant', provider: 'TotalEnergies',
    plannedDate: null, realizedDate: AUJ, endDate: null, active: true, assetIds: [CUPRA], equipmentIds: [], documentFileIds: [FICHIER],
    contractEffectiveTo: null, claimHistoryEventId: null, disposalKind: 'SALE', assetNames: ['Cupra'],
    documentTitles: ['Ticket de carburant TotalEnergies — 20 novembre 2026', 'Ticket de carburant'], ...over,
  };
}
/** Opération d'achat d'un accessoire chez Decathlon pour le vélo (deuxième cas de la capture). */
const opVelo = (over: Partial<OperationSnapshot> = {}): OperationSnapshot => op({
  id: 11, provider: 'Decathlon', assetIds: [VELO], assetNames: ['Vélo Jean Fourche'],
  documentTitles: ['Ticket Decathlon'], technicalLabel: 'Achat Polisport groovy coussin gris', ...over,
});

function item(over: Partial<AgendaItemSnapshot> = {}): AgendaItemSnapshot {
  return {
    id: 100, title: 'Achat', date: AUJ, isAutomatic: true, isAutomaticModified: false, projected: false,
    businessOperationId: null, linkedOperationActive: false, nature: 'HISTORICAL', businessType: 'purchase', homeCategory: 'information', functionalKey: null,
    originRefType: 'asset_file', originRefId: FICHIER, assetIds: [CUPRA], equipmentIds: [], fileIds: [FICHIER], ...over,
  };
}
const plan = (o: OperationSnapshot, p: { linked?: AgendaItemSnapshot[]; candidates?: AgendaItemSnapshot[] } = {}) =>
  planOperationProjection({ op: o, decision: decideProjection(o, AUJ), linked: p.linked ?? [], suppressedKeys: new Set<string>(), candidates: p.candidates ?? [] });
/** Événement AUTOMATIQUE déjà relié qui porte l'achat (même forme que `c821-titre-evenements-achat`). */
const relie = (o: OperationSnapshot, over: Partial<AgendaItemSnapshot> = {}): AgendaItemSnapshot =>
  item({ businessOperationId: o.id, linkedOperationActive: true, carriedFact: 'ACQUISITION', carrierOrigin: 'SYSTEM', assetIds: o.assetIds, ...over });

describe('C832-U-01 — sujet d’un intitulé d’achat, avec ou sans ponctuation', () => {
  it('le sujet est lu après le nom du type, quelle que soit la ponctuation', () => {
    expect(purchaseTitleSubject('Achat')).toBe('');
    expect(purchaseTitleSubject('Achat — Decathlon')).toBe('decathlon');
    expect(purchaseTitleSubject('Achat Decathlon')).toBe('decathlon');
    expect(purchaseTitleSubject('Achat  Décathlon')).toBe('decathlon');
    expect(purchaseTitleSubject('achat - decathlon')).toBe('decathlon');
    expect(purchaseTitleSubject('Achat de carburant')).toBe('de carburant');
  });

  it('un intitulé qui ne commence pas par le type n’est pas un intitulé d’achat', () => {
    expect(purchaseTitleSubject('Plein du 20 novembre')).toBeNull();
    expect(purchaseTitleSubject('Entretien réalisé')).toBeNull();
    // Frontière de mot : ni un autre mot commençant par « achat », ni le pluriel.
    expect(purchaseTitleSubject('Achatterie du coin')).toBeNull();
    expect(purchaseTitleSubject('Achats groupés')).toBeNull();
  });
});

describe('C832-U-02 — le bien, le prestataire et le justificatif ne nomment jamais l’achat, tiret ou pas', () => {
  it('toutes les variantes automatiques sont insuffisantes, sans dépendre du séparateur', () => {
    const o = op();
    for (const t of ['Achat', 'Achat — Cupra', 'Achat Cupra', 'achat cupra', 'Achat CUPRA', 'Achat  Cupra',
      'Achat — TotalEnergies', 'Achat TotalEnergies', 'Achat — Ticket de carburant', 'Achat Ticket de carburant',
      'Achat — Ticket de carburant TotalEnergies — 20 novembre 2026']) {
      expect(isUninformativePurchaseTitle(t, o), t).toBe(true);
    }
  });

  it('cas Decathlon de la capture : « Achat Decathlon » et « Achat — Decathlon » sont tous deux insuffisants', () => {
    const o = opVelo();
    expect(isUninformativePurchaseTitle('Achat Decathlon', o)).toBe(true);
    expect(isUninformativePurchaseTitle('Achat — Decathlon', o)).toBe(true);
    expect(isUninformativePurchaseTitle('Achat Décathlon', o)).toBe(true);
    // Le bien et le titre du justificatif ne valent pas mieux.
    expect(isUninformativePurchaseTitle('Achat Vélo Jean Fourche', o)).toBe(true);
    expect(isUninformativePurchaseTitle('Achat Ticket Decathlon', o)).toBe(true);
  });

  it('un vrai objet reste explicite', () => {
    const o = opVelo();
    for (const t of ['Achat Polisport groovy coussin gris', 'Achat d’une table de cuisson à induction',
      'Achat de carburant', 'Achat — Pneus hiver', 'Achat de plusieurs articles']) {
      expect(isUninformativePurchaseTitle(t, o), t).toBe(false);
    }
  });
});

describe('C832-U-03 — rien n’est renommé sans intitulé d’Opération plus précis', () => {
  it('cas Decathlon : l’événement « Achat Decathlon » reçoit l’objet désigné par l’Opération, sur le même identifiant', () => {
    const o = opVelo();
    const evt = relie(o, { id: 101, title: 'Achat Decathlon' });
    expect(plan(o, { linked: [evt] }).filter((a) => a.kind === 'RETITLE')).toEqual([
      { kind: 'RETITLE', itemId: 101, title: 'Achat Polisport groovy coussin gris', from: 'Achat Decathlon' },
    ]);
  });

  it('VRAIE acquisition du véhicule : « Achat Cupra » est conservé, faute de mieux — aucun renommage', () => {
    // L'Opération elle-même ne dit rien de plus que le nom du bien : aucun nom précis à écrire.
    const o = op({ technicalLabel: 'Achat Cupra' });
    expect(precisePurchaseTitle(o)).toBeNull();
    const evt = relie(o, { id: 102, title: 'Achat Cupra' });
    expect(plan(o, { linked: [evt] }).filter((a) => a.kind === 'RETITLE')).toEqual([]);
  });

  it('aucune désignation fiable : l’événement « Achat Decathlon » n’est pas renommé en « Achat »', () => {
    const o = opVelo({ technicalLabel: 'Achat Decathlon' });
    expect(precisePurchaseTitle(o)).toBeNull();
    const evt = relie(o, { id: 103, title: 'Achat Decathlon' });
    expect(plan(o, { linked: [evt] }).filter((a) => a.kind === 'RETITLE')).toEqual([]);
  });

  it('un titre modifié par l’utilisateur n’est jamais touché, même insuffisant', () => {
    const o = opVelo();
    const evt = relie(o, { id: 104, title: 'Achat Decathlon', isAutomaticModified: true });
    expect(plan(o, { linked: [evt] }).filter((a) => a.kind === 'RETITLE')).toEqual([]);
  });
});

describe('C832-U-04 — passage « titre seulement » : une seule règle, et plus de blocage de la reprise', () => {
  const titre = (over: Partial<Extract<ProjectionAction, { kind: 'SYNC' }>['changes']>): ProjectionAction =>
    ({ kind: 'SYNC', itemId: 1, changes: over as Extract<ProjectionAction, { kind: 'SYNC' }>['changes'] });

  it('seules un renommage et une synchronisation du seul titre ne changent qu’un intitulé', () => {
    expect(isTitleOnlyAction({ kind: 'RETITLE', itemId: 1, title: 'Achat de carburant', from: 'Achat' })).toBe(true);
    expect(isTitleOnlyAction(titre({ title: 'Achat de carburant' }))).toBe(true);
    expect(isTitleOnlyAction(titre({ title: 'Achat de carburant', date: AUJ }))).toBe(false);
    expect(isTitleOnlyAction(titre({ date: AUJ }))).toBe(false);
    expect(isTitleOnlyAction({ kind: 'CREATE', desired: {} as never, functionalKey: 'k' })).toBe(false);
    expect(isTitleOnlyAction({ kind: 'REMOVE', itemId: 1, reason: 'r' })).toBe(false);
    expect(isTitleOnlyAction({ kind: 'LINK', itemId: 1, reason: 'r' })).toBe(false);
  });

  it('le rapport de reprise s’appuie sur la MÊME règle (parité du classement des autres actions)', () => {
    expect(nonTitleActions([{ kind: 'RETITLE', itemId: 1, title: 'x', from: 'y' }, titre({ title: 'x' })])).toEqual([]);
    expect(nonTitleActions([titre({ title: 'x', date: AUJ })])).toEqual(['SYNC']);
    expect(nonTitleActions([{ kind: 'REMOVE', itemId: 1, reason: 'r' }, { kind: 'LINK', itemId: 2, reason: 'r' }])).toEqual(['LINK', 'REMOVE']);
    // Inchangé : ce qui n'écrit rien n'est pas « une autre action ».
    expect(nonTitleActions([{ kind: 'SUPPRESSED', key: 'k' }, { kind: 'ABSTAIN', reason: 'r' }])).toEqual([]);
  });

  it('la projection expose le passage « titre seulement », et la reprise l’emploie sans écarter les opérations à écart annexe', () => {
    const service = lire('src/services/business-operations/agenda-projection/service.ts');
    expect(service).toMatch(/titleOnly\?: boolean/);
    expect(service).toMatch(/if \(opts\.titleOnly && !isTitleOnlyAction\(action\)\) continue;/);
    // Un passage « titre seulement » ne propage pas les documents vers l'élément porteur.
    expect(service).toMatch(/!opts\.dryRun && !opts\.titleOnly && representee/);
    const reprise = lire('src/services/business-operations/agenda-projection/purchase-title-reprise.ts');
    expect(reprise).toMatch(/titleOnly: true/);
    // L'ancienne garde bloquante a disparu.
    expect(reprise).not.toMatch(/!x\.otherPendingActions\.length/);
    // Mais l'information reste au rapport.
    expect(reprise).toMatch(/otherPendingActions:/);
  });
});
