/**
 * Lot 114C — carte #769 « [P1][Pré-MEP] TCO — Fiabiliser les confirmations sans date : identité du fait, gestes,
 * compteurs et données obsolètes (#712/#722) ». Tests PURS sur le moteur TCO réel (`computeTco`), l'application
 * des confirmations, le panneau « Renseigner les dates » (données du serveur), la validation d'une décision et le
 * contrôle de cohérence. Persistance, API, concurrence et journal sur PostgreSQL :
 * `src/test/e2e/scenarios/l114c-tco-confirmations-sans-date.e2e.ts`.
 *
 * Aucune date du jour : `TODAY` fixe. Montants illustratifs, jamais des règles.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeTco, type TcoEconomicLine, type TcoInput, type TcoOperation, type TcoResult } from '../model';
import { toTcoDto } from '../dto';
import type { ComponentProvenance } from '../fact-identity';
import {
  applyTcoUndatedConfirmations, parseTcoFactKey, tcoFactKeys, tcoLineKeys, tcoLineUndated, tcoLineVersion,
  type TcoUndatedConfirmation, type TcoUserDecision,
} from '../user-decisions';
import { parseTcoDecisionBody, resolveTcoDecisionLine, TCO_DECISION_STALE_MESSAGE } from '../user-decisions.service';
import { TCO_UNDATED_TEXTS, tcoUndatedExpenses } from '../undated-expenses';
import type { LedgerComponent } from '../../finance/engine';
import type { BusinessOperationTypeCode, FinancialComponentKind } from '../../model';

const BIEN = 769;
const TODAY = '2026-11-13';
let seq = 769_000;

const comp = (kind: FinancialComponentKind, cents: number, o: Partial<LedgerComponent> = {}): LedgerComponent => ({
  id: seq++, operationId: 0, kind, amountMinor: cents, currency: 'EUR', amountEurCents: null, economicDate: null,
  periodStart: null, periodEnd: null, targetAssetId: null, ...o,
});
const op = (id: number, typeCode: BusinessOperationTypeCode, components: LedgerComponent[], o: Partial<TcoOperation> = {}): TcoOperation => ({
  id, typeCode, status: 'REALIZED', realizedDate: null, startDate: null, plannedDate: null,
  assetIds: [BIEN], label: `Dossier ${id}`, components: components.map((c) => ({ ...c, operationId: id })), documents: [], sourceKinds: ['DOCUMENT'], ...o,
});
const pv = (documentFileIds: number[], o: Partial<ComponentProvenance> = {}): ComponentProvenance => ({
  documentFileIds, withdrawnFileIds: [], otherSourceKinds: [], invoiceRefs: [], explained: documentFileIds.length ? true : null, ...o,
});
const conf = (key: string, o: Partial<TcoUndatedConfirmation> = {}): TcoUndatedConfirmation => ({ key, confirmedAt: '2026-11-12T11:00:00.000Z', confirmedByUserId: 7, ...o });
const decision = (key: string, value: TcoUserDecision['decision']): TcoUserDecision => ({ key, decision: value, decidedAt: '2026-11-12T10:00:00.000Z', decidedByUserId: 7 });

const MONTANT = 31_359;
const P1 = { periodStart: '2025-09-24', periodEnd: '2026-09-23' };
const P2 = { periodStart: '2026-09-24', periodEnd: '2027-09-23' };

/**
 * Collision du ticket : UN justificatif (fichier 601) porte DEUX dépenses réelles de même nature, même montant,
 * même devise, sur deux périodes distinctes (deux échéances d'un même contrat), sans date de paiement.
 */
function collision(o: { second?: Partial<LedgerComponent>; fichierSecond?: number } = {}) {
  const a = comp('REALIZED_COST', MONTANT, P1);
  const b = comp('REALIZED_COST', MONTANT, { ...P2, ...o.second });
  const f2 = o.fichierSecond ?? 601;
  const ops = [op(1, 'CONTRACT', [a, b], {
    label: 'Assurance', startDate: '2025-09-24',
    documents: [{ fileId: 601, title: 'Échéancier', role: 'INVOICE', date: null }, ...(f2 !== 601 ? [{ fileId: f2, title: 'Avis', role: 'INVOICE', date: null }] : [])],
  })];
  const input = (x: Partial<TcoInput> = {}): TcoInput => ({
    assetId: BIEN, today: TODAY, operations: ops, assetAcquisitionDate: '2020-01-10', assetSaleDate: null, assetStatus: 'ACTIF',
    valuationHistory: [], desiredSalePriceCents: null, budgets: [], readComplete: true, documents: [], assetPrice: null, assetCategory: 'VEHICULE',
    componentProvenance: new Map<number, ComponentProvenance>([[a.id, pv([601])], [b.id, pv([f2])]]), ...x,
  });
  return { a, b, input };
}
const ligne = (t: TcoResult, c: LedgerComponent): TcoEconomicLine => t.lines.find((l) => l.id === `c:${c.id}`)!;
const BASE = `f:601:REALIZED_COST:${MONTANT}:EUR`;

describe('L114C-TCO-U-A — écart A : une confirmation « sans date » porte sur UN fait économique', () => {
  it('L114C-TCO-U-A01 — collision : même justificatif, même nature, même montant, périodes distinctes → deux faits retenus, deux clés de fait', () => {
    const { a, b, input } = collision();
    const t = computeTco(input());
    // Le moteur compte les deux échéances (deux lignes réelles du justificatif) : total = 2 × montant.
    expect(t.summary.cumulativeCostCents).toBe(2 * MONTANT);
    for (const c of [a, b]) expect(tcoLineUndated(ligne(t, c))).toBe(true);
    // Cause racine : la clé stable est COMMUNE aux deux dépenses…
    expect(tcoLineKeys(ligne(t, a)).primary).toBe(BASE);
    expect(tcoLineKeys(ligne(t, b)).primary).toBe(BASE);
    // … la clé de fait les distingue par leur période qualifiée (identité durable).
    expect(ligne(t, a).factKey).toBe(`${BASE}#p:2025-09-24~2026-09-23`);
    expect(ligne(t, b).factKey).toBe(`${BASE}#p:2026-09-24~2027-09-23`);
    expect(parseTcoFactKey(ligne(t, a).factKey!)).toEqual({ base: BASE, period: '2025-09-24~2026-09-23', lineId: null });
  });

  it('L114C-TCO-U-A02 — confirmer l’une : l’autre reste sans date et à confirmer ; total et ventilation inchangés ; annuler : seule cette confirmation tombe', () => {
    const { a, b, input } = collision();
    const t0 = computeTco(input());
    const t = computeTco(input({ undatedConfirmations: [conf(ligne(t0, a).factKey!)] }));
    expect(ligne(t, a).undatedConfirmation?.key).toBe(ligne(t0, a).factKey);
    expect(ligne(t, b).undatedConfirmation).toBeUndefined();
    expect(t.undatedConfirmations).toMatchObject({ applied: 1, orphans: [] });
    expect(t.undatedConfirmations?.ambiguous).toBeUndefined();
    expect(t.summary.cumulativeCostCents).toBe(t0.summary.cumulativeCostCents);
    expect(t.annual).toEqual(t0.annual);
    const u = tcoUndatedExpenses(t);
    expect(u).toMatchObject({ count: 2, pendingCount: 1, confirmedCount: 1, costsCents: 2 * MONTANT });
    // Les deux confirmées, puis l'une annulée (sa ligne de table disparaît) : l'autre reste confirmée.
    const deux = computeTco(input({ undatedConfirmations: [conf(ligne(t0, a).factKey!), conf(ligne(t0, b).factKey!)] }));
    expect([ligne(deux, a), ligne(deux, b)].every((l) => !!l.undatedConfirmation)).toBe(true);
    const annulee = computeTco(input({ undatedConfirmations: [conf(ligne(t0, b).factKey!)] }));
    expect(ligne(annulee, a).undatedConfirmation).toBeUndefined();
    expect(ligne(annulee, b).undatedConfirmation?.key).toBe(ligne(t0, b).factKey);
  });

  it('L114C-TCO-U-A03 — ancienne clé commune (avant la carte) : jamais étendue aux deux dépenses ; isolée « à arbitrer » ; reprise idempotente', () => {
    const { a, b, input } = collision();
    const ancienne = [conf(BASE)];
    const t = computeTco(input({ undatedConfirmations: ancienne }));
    // Règle remplacée (carte #769) : avant, la confirmation était appliquée aux DEUX lignes de la clé.
    expect(ligne(t, a).undatedConfirmation).toBeUndefined();
    expect(ligne(t, b).undatedConfirmation).toBeUndefined();
    expect(t.undatedConfirmations).toMatchObject({ applied: 0, orphans: [] });
    expect(t.undatedConfirmations?.ambiguous).toEqual([{ confirmation: ancienne[0], lineIds: [`c:${a.id}`, `c:${b.id}`] }]);
    // Les deux dépenses redeviennent « à confirmer » (arbitrage ciblé), le total ne bouge pas.
    expect(tcoUndatedExpenses(t)).toMatchObject({ count: 2, pendingCount: 2, confirmedCount: 0 });
    expect(t.summary.cumulativeCostCents).toBe(2 * MONTANT);
    // Idempotent : même entrée, même résultat (aucune écriture, aucune dérive).
    expect(computeTco(input({ undatedConfirmations: ancienne })).undatedConfirmations).toEqual(t.undatedConfirmations);
  });

  it('L114C-TCO-U-A04 — ancienne clé commune dont la ligne d’origine existe encore : confirmée pour elle SEULE (même enregistrement), jamais pour l’autre', () => {
    const { a, b, input } = collision();
    const t = computeTco(input({ undatedConfirmations: [conf(BASE, { lineId: `c:${a.id}` })] }));
    expect(ligne(t, a).undatedConfirmation?.key).toBe(BASE);
    expect(ligne(t, b).undatedConfirmation).toBeUndefined();
    expect(t.undatedConfirmations?.ambiguous).toBeUndefined();
    // Ligne d'origine remplacée (identifiant inconnu) : de nouveau ambiguë, jamais attribuée au hasard.
    const perdu = computeTco(input({ undatedConfirmations: [conf(BASE, { lineId: 'c:1' })] }));
    expect(perdu.undatedConfirmations?.ambiguous).toHaveLength(1);
    expect([ligne(perdu, a), ligne(perdu, b)].some((l) => !!l.undatedConfirmation)).toBe(false);
  });

  it('L114C-TCO-U-A05 — décision financière et journal intacts : INCLUDE / EXCLUDE de la même clé ne sont ni supprimés ni étendus par la reprise', () => {
    const { a, b, input } = collision();
    const t = computeTco(input({ undatedConfirmations: [conf(BASE)], userDecisions: [decision('f:999:REALIZED_COST:1:EUR', 'EXCLUDE')] }));
    expect(t.userDecisions.orphans.map((d) => d.key)).toEqual(['f:999:REALIZED_COST:1:EUR']);
    expect([ligne(t, a), ligne(t, b)].every((l) => l.status === 'RETAINED_CONSOLIDATED')).toBe(true);
  });

  it('L114C-TCO-U-A06 — deux justificatifs distincts, même montant : clés distinctes, aucun acquittement croisé', () => {
    const { a, b, input } = collision({ fichierSecond: 602 });
    const t0 = computeTco(input());
    expect(ligne(t0, a).factKey).toBe(BASE);
    expect(ligne(t0, b).factKey).toBe(`f:602:REALIZED_COST:${MONTANT}:EUR`);
    const t = computeTco(input({ undatedConfirmations: [conf(BASE)] }));
    expect(ligne(t, a).undatedConfirmation?.key).toBe(BASE);
    expect(ligne(t, b).undatedConfirmation).toBeUndefined();
  });

  it('L114C-TCO-U-A07 — deux représentations PROUVÉES du même fait (justificatif repris par T3) : une seule confirmation, reliée par la clé secondaire', () => {
    // Composante citant deux justificatifs (601 affiché, 603 en clé secondaire) : la confirmation prise sur 603 la suit.
    const c = comp('REALIZED_COST', 12_000);
    const t = computeTco({
      assetId: BIEN, today: TODAY, assetAcquisitionDate: '2020-01-10', assetSaleDate: null, assetStatus: 'ACTIF', valuationHistory: [], desiredSalePriceCents: null,
      budgets: [], readComplete: true, documents: [], assetPrice: null,
      operations: [op(9, 'INTERVENTION', [c], { documents: [{ fileId: 601, title: 'Facture', role: 'INVOICE', date: null }, { fileId: 603, title: 'Copie', role: 'OTHER', date: null }] })],
      componentProvenance: new Map([[c.id, pv([601, 603])]]), undatedConfirmations: [conf('f:603:REALIZED_COST:12000:EUR')],
    });
    expect(tcoLineKeys(ligne(t, c))).toMatchObject({ primary: 'f:601:REALIZED_COST:12000:EUR', secondary: ['f:603:REALIZED_COST:12000:EUR'] });
    expect(ligne(t, c).undatedConfirmation?.key).toBe('f:603:REALIZED_COST:12000:EUR');
    expect(t.undatedConfirmations).toMatchObject({ applied: 1, orphans: [] });
  });

  it('L114C-TCO-U-A08 — la confirmation suit SON fait quand la clé redevient simple, et ne passe jamais à la dépense d’une autre période', () => {
    const { a, b, input } = collision();
    const t0 = computeTco(input());
    const lignes = (dateB: string | null, dateA: string | null = null) => t0.lines.map((l) => ({
      ...l, undatedConfirmation: undefined,
      ...(l.id === `c:${b.id}` && dateB ? { date: dateB, undated: undefined, economicDate: undefined } : {}),
      ...(l.id === `c:${a.id}` && dateA ? { date: dateA, undated: undefined, economicDate: undefined } : {}),
    })) as TcoEconomicLine[];
    // Confirmation de la période 1 ; la dépense de la période 2 reçoit ensuite une date fiable : la 1 reste confirmée.
    const l1 = lignes('2026-10-01');
    const r1 = applyTcoUndatedConfirmations(l1, [conf(`${BASE}#p:2025-09-24~2026-09-23`)]);
    expect(r1).toMatchObject({ applied: 1, orphans: [], ambiguous: [] });
    expect(l1.find((l) => l.id === `c:${a.id}`)!.undatedConfirmation).toBeDefined();
    // Inversement : la dépense confirmée (période 1) est datée ; sa confirmation ne glisse JAMAIS sur la période 2.
    const l2 = lignes(null, '2025-10-01');
    const r2 = applyTcoUndatedConfirmations(l2, [conf(`${BASE}#p:2025-09-24~2026-09-23`)]);
    expect(r2).toMatchObject({ applied: 0, orphans: [], ambiguous: [] });
    expect(l2.find((l) => l.id === `c:${b.id}`)!.undatedConfirmation).toBeUndefined();
  });

  it('L114C-TCO-U-A09 — aucune propriété durable ne distingue les deux dépenses (même période) : clé par ligne ; ligne remplacée → ambiguë, jamais étendue', () => {
    const { a, b, input } = collision({ second: P1 });
    const t0 = computeTco(input());
    expect(t0.summary.cumulativeCostCents).toBe(2 * MONTANT);
    expect(ligne(t0, a).factKey).toBe(`${BASE}#l:c:${a.id}`);
    expect(ligne(t0, b).factKey).toBe(`${BASE}#l:c:${b.id}`);
    const t = computeTco(input({ undatedConfirmations: [conf(ligne(t0, a).factKey!)] }));
    expect(ligne(t, a).undatedConfirmation).toBeDefined();
    expect(ligne(t, b).undatedConfirmation).toBeUndefined();
    const remplacee = computeTco(input({ undatedConfirmations: [conf(`${BASE}#l:c:1`)] }));
    expect(remplacee.undatedConfirmations?.ambiguous).toHaveLength(1);
    expect([ligne(remplacee, a), ligne(remplacee, b)].some((l) => !!l.undatedConfirmation)).toBe(false);
  });

  it('L114C-TCO-U-A10 — clés de fait : inchangées hors collision ; une ligne non retenue garde la clé stable (jamais un discriminant)', () => {
    const lignes = [
      { id: 'c:1', source: 'OPERATION', kind: 'REALIZED_COST', amountMinor: 100, currency: 'EUR', fileId: 5, sourceFileIds: [5], operationId: 1, status: 'RETAINED_CONSOLIDATED' },
      { id: 'doc:5', source: 'DOCUMENT', kind: 'REALIZED_COST', amountMinor: 100, currency: 'EUR', fileId: 5, operationId: 1, status: 'CONSOLIDATED_ELSEWHERE' },
      { id: 'c:2', source: 'OPERATION', kind: 'REALIZED_COST', amountMinor: 200, currency: 'EUR', fileId: 6, sourceFileIds: [6], operationId: 1, status: 'RETAINED_CONSOLIDATED' },
    ] as unknown as Parameters<typeof tcoFactKeys>[0];
    expect([...tcoFactKeys(lignes)]).toEqual([['c:1', 'f:5:REALIZED_COST:100:EUR'], ['doc:5', 'f:5:REALIZED_COST:100:EUR'], ['c:2', 'f:6:REALIZED_COST:200:EUR']]);
  });

  it('L114C-TCO-U-A11 — seule l’alerte de date est acquittée : la confirmation ne touche ni le statut, ni le montant, ni un doute « même montant »', () => {
    const { a, input } = collision();
    const t0 = computeTco(input());
    const lignes = t0.lines.map((l) => ({ ...l, undatedConfirmation: undefined, ...(l.id === `c:${a.id}` ? { uncertain: true } : {}) })) as TcoEconomicLine[];
    applyTcoUndatedConfirmations(lignes, [conf(ligne(t0, a).factKey!)]);
    const l = lignes.find((x) => x.id === `c:${a.id}`)!;
    expect(l).toMatchObject({ uncertain: true, status: 'RETAINED_CONSOLIDATED', includedCents: MONTANT, date: null });
    expect(l.undatedConfirmation).toBeDefined();
  });
});

describe('L114C-TCO-U-BC — écarts B et C : trois issues depuis la même dépense, trois quantités distinctes', () => {
  /** Trois dépenses sans date sur trois justificatifs (montants illustratifs). */
  function trois() {
    const cs = [comp('REALIZED_COST', 202_300), comp('REALIZED_COST', 21_476, P1), comp('REALIZED_COST', 31_359, P2)];
    const ops = [op(2, 'CONTRACT', cs, { label: 'Contrat', startDate: '2025-09-24', documents: cs.map((_, i) => ({ fileId: 701 + i, title: `Pièce ${i + 1}`, role: 'INVOICE', date: null })) })];
    const input = (x: Partial<TcoInput> = {}): TcoInput => ({
      assetId: BIEN, today: TODAY, operations: ops, assetAcquisitionDate: '2020-01-10', assetSaleDate: null, assetStatus: 'ACTIF', valuationHistory: [],
      desiredSalePriceCents: null, budgets: [], readComplete: true, documents: [], assetPrice: null, assetCategory: 'VEHICULE',
      componentProvenance: new Map(cs.map((c, i) => [c.id, pv([701 + i])])), ...x,
    });
    return { cs, input };
  }

  it('L114C-TCO-U-C01 — 3 sans date : 3 en attente → 2 et 1 confirmée → 0 et 3 confirmées ; le nombre de dépenses sans date reste 3 ; annulation : seul « en attente » remonte', () => {
    const { cs, input } = trois();
    const t0 = computeTco(input());
    const cles = cs.map((c) => ligne(t0, c).factKey!);
    const etat = (n: number) => { const u = toTcoDto(computeTco(input({ undatedConfirmations: cles.slice(0, n).map((k) => conf(k)) }))).undatedExpenses; return [u.count, u.pendingCount, u.confirmedCount, u.costsCents]; };
    const total = 202_300 + 21_476 + 31_359;
    expect(etat(0)).toEqual([3, 3, 0, total]);
    expect(etat(1)).toEqual([3, 2, 1, total]);
    expect(etat(3)).toEqual([3, 0, 3, total]);
    expect(etat(2)).toEqual([3, 1, 2, total]); // une confirmation annulée
  });

  it('L114C-TCO-U-C02 — date fiable établie : le nombre de dépenses sans date diminue ; dépense retirée : elle sort des trois quantités', () => {
    const { cs, input } = trois();
    const t0 = computeTco(input());
    const datee = t0.lines.map((l) => (l.id === `c:${cs[0].id}` ? { ...l, date: '2024-05-12', annualYear: 2024, undated: undefined } : l)) as TcoEconomicLine[];
    expect(tcoUndatedExpenses({ lines: datee })).toMatchObject({ count: 2, pendingCount: 2, confirmedCount: 0 });
    const retiree = computeTco(input({ userDecisions: [decision(ligne(t0, cs[1]).decisionKey!, 'EXCLUDE')], undatedConfirmations: [conf(ligne(t0, cs[1]).factKey!)] }));
    expect(tcoUndatedExpenses(retiree)).toMatchObject({ count: 2, pendingCount: 2, confirmedCount: 0 });
    // EXCLUDE neutralise le point de date sans effacer la confirmation (conservée hors effet, non orpheline).
    expect(retiree.undatedConfirmations).toMatchObject({ applied: 0, orphans: [] });
    expect(retiree.reliability.warnings).toContain('ECONOMIC_DATE_UNDETERMINED');
  });

  it('L114C-TCO-U-C03 — texte des compteurs : formulation neutre, accord, jamais « anomalie » ni « erreur »', () => {
    expect(TCO_UNDATED_TEXTS.counters(3, 0)).toBe('Conservation sans date : 3 choix à confirmer, 0 déjà confirmé.');
    expect(TCO_UNDATED_TEXTS.counters(1, 2)).toBe('Conservation sans date : 1 choix à confirmer, 2 déjà confirmés.');
    expect(TCO_UNDATED_TEXTS.counters(0, 3)).not.toMatch(/anomalie|erreur|Opération/i);
  });

  it('L114C-TCO-U-B01 — même dépense du panneau : « Conserver dans le TCO sans date » et « Retirer du TCO » (geste distinct, phrase propre) ; clé de fait et version fournies', () => {
    const { cs, input } = trois();
    const u = toTcoDto(computeTco(input())).undatedExpenses;
    for (const i of u.items) {
      expect(i.options.map((o) => o.action)).toEqual(['CONFIRM_UNDATED', 'EXCLUDE']);
      expect(i.options.find((o) => o.action === 'EXCLUDE')).toMatchObject({ label: 'Retirer du TCO', confirm: 'Retirer cette dépense du coût de possession ? Vous pourrez l’ajouter de nouveau.' });
      expect(i.lineVersion).toMatch(/^v1:[0-9a-f]{16}$/);
    }
    expect(u.items.map((i) => i.lineKey)).toEqual(expect.arrayContaining(cs.map((_, n) => expect.stringContaining(`f:${701 + n}:`))));
    // Confirmée : « Annuler mon choix » et « Retirer du TCO » restent accessibles ensemble.
    const t0 = computeTco(input());
    const apres = toTcoDto(computeTco(input({ undatedConfirmations: [conf(ligne(t0, cs[0]).factKey!)] }))).undatedExpenses;
    expect(apres.items.find((i) => i.lineId === `c:${cs[0].id}`)!.options.map((o) => o.action)).toEqual(['REVERT_UNDATED', 'EXCLUDE']);
  });

  it('L114C-TCO-U-B02 — collision : le retrait suit la décision d’inclusion existante (clé stable commune) — la confirmation annonce les dépenses concernées', () => {
    const { input } = collision();
    const u = toTcoDto(computeTco(input())).undatedExpenses;
    for (const i of u.items) expect(i.options.find((o) => o.action === 'EXCLUDE')!.confirm).toBe(TCO_UNDATED_TEXTS.removeShared(2));
    expect(TCO_UNDATED_TEXTS.removeShared(2)).toContain('2 dépenses');
  });
});

describe('L114C-TCO-U-D — écart D : décision reçue depuis une version économique obsolète', () => {
  const base = { kind: 'REALIZED_COST', amountMinor: 31_359, currency: 'EUR', status: 'RETAINED_CONSOLIDATED', date: null, eurCents: 31_359, undated: true, period: { start: '2025-09-24', end: '2026-09-23' } } as const;
  const v = (o: Record<string, unknown> = {}) => tcoLineVersion({ ...base, ...o } as never);

  it('L114C-TCO-U-D01 — version : change avec le montant, la devise, la nature, la période, la date, le statut ; stable sinon', () => {
    const ref = v();
    expect(ref).toMatch(/^v1:[0-9a-f]{16}$/);
    for (const o of [{ amountMinor: 31_360 }, { currency: 'USD' }, { kind: 'REDUCTION' }, { period: { start: '2026-09-24', end: '2027-09-23' } }, { period: undefined },
      { date: '2026-01-05', undated: undefined }, { status: 'EXCLUDED' }, { eurCents: 30_000 }]) expect(v(o)).not.toBe(ref);
    // Identifiant, libellé, source, justificatif, événement de référence : hors version (re-clé prouvée tolérée).
    expect(v({ id: 'c:1', label: 'A', source: 'OPERATION', fileId: 1, operationId: 2 })).toBe(v({ id: 'doc:9', label: 'B', source: 'DOCUMENT', fileId: 9, operationId: null }));
    expect(v({ status: 'RETAINED_DIRECT' })).toBe(ref);
    expect(v({ currency: ' eur ' })).toBe(ref);
  });

  it('L114C-TCO-U-D02 — version : insensible aux choix de l’utilisateur (requête identique répétée = idempotente)', () => {
    const ref = v();
    expect(v({ undatedConfirmation: { key: 'k', confirmedAt: '2026-11-12T11:00:00.000Z', confirmedByUserId: 7 } })).toBe(ref);
    // Dépense retirée par l'utilisateur : la version reste celle du traitement automatique.
    expect(v({ status: 'EXCLUDED', eurCents: 31_359, userDecision: { key: 'k', decision: 'EXCLUDE', decidedAt: 'x', decidedByUserId: 7, applied: true, automaticStatus: 'RETAINED_CONSOLIDATED', automaticReason: null } })).toBe(ref);
  });

  it('L114C-TCO-U-D03 — moteur : chaque ligne porte sa version ; requalification du montant ou de la période → autre version', () => {
    const { a, b, input } = collision();
    const t = computeTco(input());
    expect(ligne(t, a).version).toBe(tcoLineVersion(ligne(t, a)));
    const autre = collision({ second: { periodStart: '2027-01-01', periodEnd: '2027-12-31' } });
    const t2 = computeTco(autre.input());
    expect(ligne(t2, autre.b).version).not.toBe(ligne(t, b).version); // période requalifiée : autre version
    expect(ligne(t2, autre.a).version).toBe(ligne(t, a).version); // fait inchangé : même version
  });

  const L = (o: Partial<TcoEconomicLine>): TcoEconomicLine => ({
    id: 'c:1', source: 'OPERATION', kind: 'REALIZED_COST', amountMinor: 100, currency: 'EUR', fileId: 5, sourceFileIds: [5], operationId: 1,
    status: 'RETAINED_CONSOLIDATED', factKey: 'f:5:REALIZED_COST:100:EUR', version: 'v1:aaaa', ...o,
  } as TcoEconomicLine);

  it('L114C-TCO-U-D04 — ligne trouvée par son identifiant : acceptée si la clé la désigne encore et si la version est la sienne ; sinon obsolète', () => {
    const lignes = [L({})];
    expect(resolveTcoDecisionLine(lignes, { lineId: 'c:1', lineKey: 'f:5:REALIZED_COST:100:EUR', lineVersion: 'v1:aaaa' })).toMatchObject({ ok: true });
    // Même identifiant technique, fait changé (montant → autre clé ; propriété matérielle → autre version) : refusé.
    expect(resolveTcoDecisionLine(lignes, { lineId: 'c:1', lineKey: 'f:5:REALIZED_COST:90:EUR', lineVersion: null })).toEqual({ ok: false, reason: 'STALE' });
    expect(resolveTcoDecisionLine(lignes, { lineId: 'c:1', lineKey: 'f:5:REALIZED_COST:100:EUR', lineVersion: 'v1:bbbb' })).toEqual({ ok: false, reason: 'STALE' });
    expect(resolveTcoDecisionLine(lignes, { lineId: 'c:1', lineKey: null, lineVersion: 'v1:bbbb' })).toEqual({ ok: false, reason: 'STALE' });
    // Compatibilité : sans clé ni version (gestes d'inclusion antérieurs), l'identifiant reste accepté.
    expect(resolveTcoDecisionLine(lignes, { lineId: 'c:1' })).toMatchObject({ ok: true });
  });

  it('L114C-TCO-U-D05 — identifiant disparu : re-clé PROUVÉE (clé de fait, clé stable ou clé secondaire, une seule ligne, même version) acceptée', () => {
    // Justificatif 5 repris par un événement de référence : nouvelle ligne `c:9`, même clé.
    expect(resolveTcoDecisionLine([L({ id: 'c:9' })], { lineId: 'doc:5', lineKey: 'f:5:REALIZED_COST:100:EUR', lineVersion: 'v1:aaaa' })).toMatchObject({ ok: true, line: { id: 'c:9' } });
    // Clé secondaire (autre justificatif du même fait).
    const reunie = L({ id: 'c:9', sourceFileIds: [5, 6] });
    expect(resolveTcoDecisionLine([reunie], { lineId: 'doc:6', lineKey: 'f:6:REALIZED_COST:100:EUR', lineVersion: 'v1:aaaa' })).toMatchObject({ ok: true, line: { id: 'c:9' } });
    // Même clé, version différente (période ou date changée) : refusé.
    expect(resolveTcoDecisionLine([L({ id: 'c:9' })], { lineId: 'doc:5', lineKey: 'f:5:REALIZED_COST:100:EUR', lineVersion: 'v1:bbbb' })).toEqual({ ok: false, reason: 'STALE' });
  });

  it('L114C-TCO-U-D06 — identifiant disparu et clé ambiguë (scission : deux lignes) ou sans ligne (montant corrigé) : obsolète ; sans clé : introuvable', () => {
    const scission = [L({ id: 'c:8', factKey: 'f:5:REALIZED_COST:100:EUR#l:c:8' }), L({ id: 'c:9', factKey: 'f:5:REALIZED_COST:100:EUR#l:c:9' })];
    expect(resolveTcoDecisionLine(scission, { lineId: 'c:1', lineKey: 'f:5:REALIZED_COST:100:EUR' })).toEqual({ ok: false, reason: 'STALE' });
    // La clé de fait précise désigne toujours une seule dépense.
    expect(resolveTcoDecisionLine(scission, { lineId: 'c:1', lineKey: 'f:5:REALIZED_COST:100:EUR#l:c:9' })).toMatchObject({ ok: true, line: { id: 'c:9' } });
    expect(resolveTcoDecisionLine([L({ id: 'c:9' })], { lineId: 'c:1', lineKey: 'f:5:REALIZED_COST:250:EUR' })).toEqual({ ok: false, reason: 'STALE' });
    expect(resolveTcoDecisionLine([L({ id: 'c:9' })], { lineId: 'c:1' })).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('L114C-TCO-U-D07 — corps de l’API : `lineVersion` acceptée et bornée ; clé de fait (discriminant) acceptée ; message du ticket à l’identique', () => {
    expect(parseTcoDecisionBody({ lineId: 'c:1', action: 'CONFIRM_UNDATED', lineKey: `${BASE}#p:2025-09-24~2026-09-23`, lineVersion: 'v1:0123456789abcdef' }))
      .toMatchObject({ ok: true, value: { lineVersion: 'v1:0123456789abcdef', lineKey: `${BASE}#p:2025-09-24~2026-09-23` } });
    expect(parseTcoDecisionBody({ lineId: 'c:1', action: 'CONFIRM_UNDATED', lineVersion: 12 })).toMatchObject({ ok: false });
    expect(parseTcoDecisionBody({ lineId: 'c:1', action: 'CONFIRM_UNDATED', lineVersion: 'x'.repeat(65) })).toMatchObject({ ok: false });
    expect(parseTcoDecisionBody({ lineId: 'c:1', action: 'EXCLUDE' })).toMatchObject({ ok: true });
    expect(TCO_DECISION_STALE_MESSAGE).toBe('Cette dépense a changé, vérifiez ses nouvelles informations');
  });
});

describe('L114C-TCO-U-COH — contrôle de cohérence et interface', () => {
  it('L114C-TCO-U-COH — COH-TCO-SAME-FACT version 2 : confirmation ambiguë isolée (arbitrage), sans réparation ni écriture', async () => {
    const { getCheck } = await import('@/services/coherence/registry');
    const c = getCheck('COH-TCO-SAME-FACT')!;
    expect(c.version).toBe(2);
    expect(c.anomalies).toContain('UNDATED_CONFIRMATION_AMBIGUOUS');
    expect(c.repair).toBeUndefined();
    expect(c.forbiddenRepairs.join(' ')).toMatch(/étendre une confirmation « sans date »/);
  });

  const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

  it('L114C-TCO-UI-01 — alerte unique et panneau : compteurs affichés, « Retirer du TCO » depuis la dépense, version renvoyée, refus 409 rafraîchi sans succès', () => {
    const section = lire('src/components/assets/TcoSection.tsx');
    const panneau = lire('src/components/assets/TcoUndatedDatesSheet.tsx');
    const gestes = lire('src/components/assets/tco-decision-actions.tsx');
    for (const src of [section, panneau]) {
      expect(src).toContain('TCO_UNDATED_TEXTS.counters(');
      expect(src).toContain('data-tco-undated-pending=');
      expect(src).toContain('aria-live="polite"');
    }
    // Une seule alerte « sans date » (aucune seconde carte ni diagnostic en doublon).
    expect(section.match(/data-tco-undated=\{/g)).toHaveLength(1);
    expect(panneau).toContain('lineVersion={i.lineVersion}');
    expect(gestes).toContain('...(lineVersion ? { lineVersion } : {})');
    expect(section).toContain("err.code === 'DECISION_STALE'");
    // Le succès n'est annoncé qu'après la réponse du serveur (jamais dans le traitement d'un refus).
    const refus = section.slice(section.indexOf('const arbitrate: TcoArbitrate'), section.indexOf('const decideCtx'));
    expect(refus.indexOf('toast.success')).toBeLessThan(refus.indexOf('} catch'));
    expect(refus.slice(refus.indexOf('} catch'))).not.toContain('toast.success');
  });

  it('L114C-TCO-UI-02 — charte Sérénité : aucune couleur brute ajoutée ; jamais « Opération » dans les textes', () => {
    for (const f of ['src/components/assets/TcoUndatedDatesSheet.tsx', 'src/components/assets/tco-decision-actions.tsx']) {
      expect(lire(f)).not.toMatch(/#[0-9a-fA-F]{6}\b|rgb\(|text-(red|green|blue|amber|orange)-\d/);
    }
    const textes = [TCO_UNDATED_TEXTS.counters(2, 1), TCO_UNDATED_TEXTS.pendingBadge, TCO_UNDATED_TEXTS.removeShared(2), TCO_DECISION_STALE_MESSAGE];
    for (const t of textes) expect(t).not.toMatch(/Opération/i);
  });
});
