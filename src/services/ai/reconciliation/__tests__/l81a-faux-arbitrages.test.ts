/**
 * Lot 81A — ticket « [P1] T3 / À traiter — Corriger les faux arbitrages entre
 * valeurs identiques » (cas « Maison » : date d'achat 06/05/2021 vs
 * 06/05/2021). Tests PURS du moteur de décision, de l'équivalence métier, du
 * pont « À traiter », du contrôle de création des actions, des libellés et de
 * la confrontation agenda (aucun accès base).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => { throw new Error('aucune requête attendue'); }) }, db: {} }));

const { decide, withoutEquivalentProposals } = await import('../decision/decision-matrix');
const { areBusinessEquivalent, businessKey, realAlternatives } = await import('../decision/equivalence');
const { mapReconciliationDecision, arbitrationProposals } = await import('@/services/to-process/reconciliation-bridge');
const { isDisplayableArbitration, sanitizeArbitrationProposals } = await import('@/services/to-process/action-model');
const { presentCardLabels, businessValueLabel, userProposalLabel } = await import('@/services/to-process/card-labels');
const { crossCheckAcquisitionDate } = await import('../information-check/inventory');
const { suspectArbitration } = await import('@/services/to-process/arbitration-equivalence-reprise');
const { entityConflictProposals } = await import('@/services/to-process/entity-field-cards');
const { normalize } = await import('../decision/normalizers');
import type { CurrentValue, DecisionInput, EvidenceCandidate, ReconciliationDecision } from '../types';
import type { ActionProposal } from '@/services/to-process/action-model';

const D = (s: string) => new Date(`${s}T00:00:00Z`);

let seq = 100;
const preuve = (fieldKey: string, value: unknown, o: Partial<EvidenceCandidate> = {}): EvidenceCandidate => ({
  evidenceId: o.evidenceId ?? ++seq, value, normalized: normalize(fieldKey, value), confidence: 'certain', authorityScore: 60,
  documentType: 'FACTURE', documentDate: D('2024-01-01'), sourceId: o.sourceId ?? seq, excerpt: 'extrait littéral', ...o,
});
const courant = (fieldKey: string, value: unknown, o: Partial<CurrentValue> = {}): CurrentValue => ({
  value, normalized: normalize(fieldKey, value), origin: 'USER', updatedAt: null, ...o,
});
const entree = (fieldKey: string, current: CurrentValue | null, candidates: EvidenceCandidate[]): DecisionInput => ({
  fieldKey, current, candidates, isCritical: false,
});

describe('L81A — équivalence métier (normaliseurs existants, clé canonique)', () => {
  it('L81A-EQ-01 — 06/05/2021 et 2021-05-06 sont équivalents (clé et alias)', () => {
    expect(areBusinessEquivalent('acquisitionDate', '06/05/2021', '2021-05-06')).toBe(true);
    // Alias du registre dont le NOM ne contient pas « date » : avant, comparé comme un texte.
    expect(areBusinessEquivalent('acquisitionDay', '06/05/2021', '2021-05-06')).toBe(true);
    expect(areBusinessEquivalent('acquisitionDate', '06/05/2021', '17/05/2021')).toBe(false);
  });

  it('L81A-EQ-02 — date ISO avec heure ≡ même date métier ; objet Date accepté', () => {
    expect(areBusinessEquivalent('acquisitionDate', '2021-05-06T00:00:00.000Z', '06/05/2021')).toBe(true);
    expect(areBusinessEquivalent('acquisitionDate', '2021-05-06T10:30:00+02:00', '2021-05-06')).toBe(true);
    expect(areBusinessEquivalent('acquisitionDate', D('2021-05-06'), '06/05/2021')).toBe(true);
  });

  it('L81A-EQ-03 — montants équivalents de formats différents', () => {
    expect(areBusinessEquivalent('acquisitionPrice', 150000, '150 000,00 €')).toBe(true);
    expect(areBusinessEquivalent('acquisitionPrice', '150000', '150.000,00')).toBe(true);
    expect(areBusinessEquivalent('acquisitionPrice', 150000, 150001)).toBe(false);
    // Alias en centimes : unité déclarée par le registre.
    expect(businessKey('purchasePriceCents', 15000000)).toBe(businessKey('acquisitionPrice', 150000));
  });

  it('L81A-EQ-04 — textes et références : casse, accents, espaces ; plaques', () => {
    expect(areBusinessEquivalent('insurer', '  MAÏF  Assurances ', 'maif assurances')).toBe(true);
    expect(areBusinessEquivalent('registrationNumber', 'ab 123 cd', 'AB-123-CD')).toBe(true);
    expect(areBusinessEquivalent('contractNumber', 'C-1', 'C-2')).toBe(false);
    // Vide ≠ valeur ; deux vides équivalents.
    expect(areBusinessEquivalent('acquisitionDate', null, '2021-05-06')).toBe(false);
    expect(areBusinessEquivalent('acquisitionDate', '', null)).toBe(true);
  });

  it('L81A-EQ-05 — alternatives réelles : sans valeur équivalente à la valeur en place ni doublon', () => {
    const r = realAlternatives('acquisitionDate', '06/05/2021', ['2021-05-06', '2021-05-17', '17/05/2021', null], (x) => x);
    expect(r).toEqual(['2021-05-17']);
  });
});

describe('L81A — moteur de décision (decision-matrix)', () => {
  it('L81A-DM-01 — valeur actuelle = proposition : aucun faux arbitrage', () => {
    const d = decide(entree('acquisitionDate', courant('acquisitionDate', '2021-05-06'), [preuve('acquisitionDate', '06/05/2021')]));
    expect(d.action).toBe('keep');
    expect(d.reasonCode).toBe('MANUAL_VALUE_CONFIRMED');
  });

  it('L81A-DM-02 — alias sans « date » dans le nom (cause D) : 06/05/2021 vs 2021-05-06 confirmé, pas de conflit', () => {
    const d = decide(entree('acquisitionDay', courant('acquisitionDay', '06/05/2021'), [preuve('acquisitionDay', '2021-05-06')]));
    expect(d.action).toBe('keep');
  });

  it('L81A-DM-03 — deux documents avec la même valeur (formats différents) : pas d’arbitrage', () => {
    const a = preuve('acquisitionDay', '06/05/2021');
    const b = preuve('acquisitionDay', '2021-05-06');
    expect(decide(entree('acquisitionDay', courant('acquisitionDay', '2021-05-06'), [a, b])).action).toBe('keep');
    // Champ vide : complétion (une seule valeur), jamais un arbitrage entre deux formats.
    const vide = decide(entree('acquisitionDay', null, [a, b]));
    expect(vide.action).toBe('apply');
    expect(vide.reasonCode).toBe('EMPTY_FIELD_CONVERGING');
  });

  it('L81A-DM-04 — CAS « MAISON » : fiche = acte A = 06/05/2021, acte B = 17/05/2021 (même autorité) → la VRAIE contradiction (17/05) est proposée', () => {
    const a = preuve('acquisitionDate', '2021-05-06', { evidenceId: 1, documentDate: D('2024-06-01') });
    const b = preuve('acquisitionDate', '2021-05-17', { evidenceId: 2, documentDate: D('2024-01-01') });
    const d = decide(entree('acquisitionDate', courant('acquisitionDate', '2021-05-06'), [a, b]));
    expect(d.action).toBe('create_conflict');
    expect(d.proposedValue).toBe('2021-05-17');
    expect(d.currentValue).toBe('2021-05-06');
    // Les preuves des deux côtés sont conservées.
    expect(d.evidenceIds).toEqual([1, 2]);
    expect(d.alternatives?.map((x) => x.value)).toEqual(['2021-05-17']);
    // Jamais une proposition équivalente à la valeur en place.
    expect(areBusinessEquivalent('acquisitionDate', d.proposedValue, d.currentValue)).toBe(false);
    // Pont : 17/05/2021 proposé, 06/05/2021 en valeur actuelle — rien d'autre.
    const intent = mapReconciliationDecision(d)!;
    expect(intent.kind).toBe('UPSERT');
    expect(intent.proposals!.map((p) => [p.value, !!p.isCurrentValue])).toEqual([['2021-05-17', false], ['2021-05-06', true]]);
  });

  it('L81A-DM-05 — plusieurs contradictions non résolues : toutes présentées, aucune masquée', () => {
    const a = preuve('acquisitionDate', '2021-05-06', { evidenceId: 11 });
    const b = preuve('acquisitionDate', '2021-05-17', { evidenceId: 12 });
    const c = preuve('acquisitionDate', '2021-06-01', { evidenceId: 13 });
    const d = decide(entree('acquisitionDate', courant('acquisitionDate', '2021-05-06'), [a, b, c]));
    expect(d.action).toBe('create_conflict');
    expect(d.alternatives?.map((x) => x.value).sort()).toEqual(['2021-05-17', '2021-06-01']);
    expect([...d.evidenceIds].sort()).toEqual([11, 12, 13]);
    const props = arbitrationProposals(d)!;
    expect(props.filter((p) => !p.isCurrentValue).map((p) => p.value).sort()).toEqual(['2021-05-17', '2021-06-01']);
  });

  it('L81A-DM-06 — champ vide, deux sources divergentes de même autorité : les DEUX valeurs proposées', () => {
    const a = preuve('acquisitionDate', '2021-05-06', { evidenceId: 21, documentDate: D('2024-06-01') });
    const b = preuve('acquisitionDate', '2021-05-17', { evidenceId: 22 });
    const d = decide(entree('acquisitionDate', null, [a, b]));
    expect(d.action).toBe('create_conflict');
    expect(d.proposedValue).toBe('2021-05-06');
    // Signature (mémoire des arbitrages) inchangée pour deux valeurs : même formule qu'avant.
    expect(d.evidenceIds).toEqual([21, 22]);
    expect(arbitrationProposals(d)!.map((p) => p.value)).toEqual(['2021-05-06', '2021-05-17']);
  });

  it('L81A-DM-07 — valeur UTILISATEUR contredite par une preuve différente : arbitrage conservé, aucune écriture', () => {
    const d = decide(entree('acquisitionDate', courant('acquisitionDate', '2021-05-06', { origin: 'USER' }),
      [preuve('acquisitionDate', '2005-02-17', { documentType: 'ACTE_AUTHENTIQUE', authorityScore: 100 })]));
    expect(d.action).toBe('create_conflict');
    expect(d.reasonCode).toBe('MANUAL_VALUE_CONTRADICTED');
    expect(d.proposedValue).toBe('2005-02-17');
  });

  it('L81A-DM-08 — sources d’autorité différente : règles existantes appliquées (décision déterministe)', () => {
    const acte = preuve('acquisitionPrice', 150000, { documentType: 'ACTE_AUTHENTIQUE', authorityScore: 1000 });
    const facture = preuve('acquisitionPrice', 149000, { documentType: 'FACTURE', authorityScore: 850 });
    const auto = courant('acquisitionPrice', 149000, { origin: 'RECONCILIATION', authorityScore: 850 });
    const d = decide(entree('acquisitionPrice', auto, [acte, facture]));
    expect(d.action).toBe('update');
    expect(d.reasonCode).toBe('AUTO_VALUE_BETTER_AUTHORITY');
    // Même cas, la fiche porte la valeur de l'acte : confirmée, pas d'arbitrage.
    const ok = decide(entree('acquisitionPrice', courant('acquisitionPrice', '150 000,00 €', { origin: 'RECONCILIATION', authorityScore: 1000 }), [acte, facture]));
    expect(ok.action).toBe('keep');
  });

  it('L81A-DM-09 — deux montants équivalents de formats différents : aucun faux arbitrage', () => {
    const d = decide(entree('acquisitionPrice', courant('acquisitionPrice', 150000), [preuve('acquisitionPrice', '150 000,00 €')]));
    expect(d.action).toBe('keep');
  });

  it('L81A-DM-10 — garde finale : un conflit dont toutes les propositions égalent la valeur en place devient une abstention (ni carte, ni fermeture)', () => {
    const faux: ReconciliationDecision = {
      fieldKey: 'acquisitionDate', currentValue: '06/05/2021', proposedValue: '2021-05-06', action: 'create_conflict',
      reasonCode: 'CONFIRMED_AGENDA_CONTRADICTION', confidence: 'conflictual', evidenceIds: [], deterministic: true,
    };
    const g = withoutEquivalentProposals(faux);
    expect(g.action).toBe('ignore');
    expect(g.reasonCode).toBe('EQUIVALENT_VALUES');
    expect(mapReconciliationDecision(faux)).toBeNull();
    expect(mapReconciliationDecision(g)).toBeNull();
    // Un vrai conflit traverse la garde intact.
    const vrai = { ...faux, proposedValue: '2021-05-17' };
    expect(withoutEquivalentProposals(vrai)).toBe(vrai);
  });
});

describe('L81A — contrôle de création des actions (action-model / upsertAction)', () => {
  const p = (value: ActionProposal['value'], o: Partial<ActionProposal> = {}): ActionProposal => ({ value, label: String(value), confidence: 0.3, ...o });

  it('L81A-AM-01 — arbitrage dont la seule proposition égale la valeur actuelle : non affichable', () => {
    const props = [p('2021-05-06', { evidenceIds: ['1'] }), p('06/05/2021', { isCurrentValue: true, confidence: 1 })];
    expect(isDisplayableArbitration(props, 'acquisitionDate')).toBe(false);
    expect(sanitizeArbitrationProposals(props, 'acquisitionDate')).toEqual([props[1]]);
  });

  it('L81A-AM-02 — doublons fusionnés (preuves cumulées), vraie alternative conservée', () => {
    const props = [p('2021-05-17', { evidenceIds: ['1'] }), p('17/05/2021', { evidenceIds: ['2'] }), p('2021-05-06', { isCurrentValue: true })];
    const s = sanitizeArbitrationProposals(props, 'acquisitionDate');
    expect(s.map((x) => x.value)).toEqual(['2021-05-17', '2021-05-06']);
    expect(s[0].evidenceIds).toEqual(['1', '2']);
    expect(isDisplayableArbitration(props, 'acquisitionDate')).toBe(true);
  });

  it('L81A-AM-03 — relation (sans clé de donnée) : seules des valeurs identiques sont confondues', () => {
    expect(isDisplayableArbitration([p('ITEM:7'), p('ITEM:8'), p('NEW')])).toBe(true);
    expect(isDisplayableArbitration([p('ITEM:7'), p('ITEM:7', { isCurrentValue: true })])).toBe(false);
  });

  it('L81A-AM-04 — équipement : propositions sans valeur équivalente à la valeur en place', () => {
    const d: ReconciliationDecision = {
      fieldKey: 'acquisitionDate', currentValue: '06/05/2021', proposedValue: '2021-05-06', action: 'create_conflict',
      reasonCode: 'EQUAL_AUTHORITY_DIVERGENCE', confidence: 'conflictual', evidenceIds: [1], deterministic: true,
    };
    expect(entityConflictProposals(d)).toEqual([]);
    expect(entityConflictProposals({ ...d, proposedValue: '2021-05-17' }).map((x) => x.value)).toEqual(['2021-05-17', '06/05/2021']);
  });
});

describe('L81A — affichage (card-labels) : jamais deux valeurs différentes affichées pareil', () => {
  it('L81A-LB-01 — date rendue depuis la VALEUR comparée', () => {
    expect(businessValueLabel('acquisitionDate', '2021-05-06T00:00:00.000Z', '2021-05-06T00:00:00.000Z')).toBe('06/05/2021');
    expect(userProposalLabel('2021-05-06', 'acquisitionDate', '2021-05-17')).toBe('17/05/2021');
    // Libellé rédigé (« Garder … ») : conservé.
    expect(businessValueLabel('acquisitionDate', '2021-05-06', 'Garder 06/05/2021')).toBeNull();
  });

  it('L81A-LB-02 — deux propositions affichées identiques ⇔ valeurs équivalentes', () => {
    const valeurs: unknown[] = ['2021-05-06', '06/05/2021', '2021-05-06T22:00:00Z', '2021-05-05T22:00:00.000Z', '2021-05-17'];
    const vue = (vs: unknown[]) => presentCardLabels({
      targetType: 'ASSET', fieldKey: 'acquisitionDate', relationKey: null, ruleCode: 'DATA-ACQUISITION-DATE', question: 'Quelle est la date d’achat de ce bien ?',
      proposals: vs.map((v) => ({ value: v as string, label: String(v), confidence: 0.3 })), target: { label: 'Maison' },
    });
    for (const a of valeurs) {
      for (const b of valeurs) {
        const [la, lb] = vue([a, b]).proposals.map((x) => x.label);
        expect(la === lb, `${String(a)} / ${String(b)}`).toBe(areBusinessEquivalent('acquisitionDate', a, b));
      }
    }
  });

  it('L81A-LB-03 — montants : rendu depuis la valeur', () => {
    expect(businessValueLabel('acquisitionPrice', 150000, '150000')).toBe(`${new Intl.NumberFormat('fr-FR').format(150000)} €`);
  });
});

describe('L81A — confrontation agenda (lot 76J préservé)', () => {
  it('L81A-AG-01 — fiche au format 06/05/2021 et achat confirmé au 2021-05-06 : COHÉRENT, aucune écriture ni arbitrage', () => {
    const r = crossCheckAcquisitionDate({
      current: courant('acquisitionDate', '06/05/2021'), evidenceSourceIds: [], engineDecision: null, arbitratedSignature: null,
      observations: [{ source: 'AGENDA', id: 5, date: '2021-05-06', automatic: false, confirmed: true, derivedFromField: false, sourceFileIds: [] }],
    });
    expect(r.decision).toBeNull();
    expect(r.records[0].verdict).toBe('CONSISTENT');
  });

  it('L81A-AG-02 — vraie contradiction avec un achat confirmé : arbitrage maintenu', () => {
    const r = crossCheckAcquisitionDate({
      current: courant('acquisitionDate', '06/05/2021'), evidenceSourceIds: [], engineDecision: null, arbitratedSignature: null,
      observations: [{ source: 'AGENDA', id: 5, date: '2021-05-17', automatic: false, confirmed: true, derivedFromField: false, sourceFileIds: [] }],
    });
    expect(r.decision?.action).toBe('create_conflict');
    expect(r.decision?.proposedValue).toBe('2021-05-17');
  });
});

describe('L81A — rattrapage : détection des cartes suspectes (pure)', () => {
  const p = (value: string, cur = false): ActionProposal => ({ value, label: value, confidence: cur ? 1 : 0.3, ...(cur ? { isCurrentValue: true } : {}) });
  it('L81A-RP-01 — carte « 06/05/2021 vs 06/05/2021 » suspecte ; vraie carte saine', () => {
    expect(suspectArbitration('acquisitionDate', [p('2021-05-06'), p('2021-05-06', true)])).toBe('EQUIVALENT_TO_CURRENT');
    expect(suspectArbitration('acquisitionDate', [p('2021-05-06'), p('06/05/2021', true)])).toBe('EQUIVALENT_TO_CURRENT');
    expect(suspectArbitration('acquisitionDate', [p('2021-05-17'), p('17/05/2021'), p('2021-05-06', true)])).toBe('DUPLICATE_PROPOSALS');
    expect(suspectArbitration('acquisitionDate', [p('2021-05-17'), p('2021-05-06', true)])).toBeNull();
  });
});
