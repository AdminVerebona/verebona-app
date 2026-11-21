/**
 * Carte Trello #812 (lot 116F) — PÉRIODES DE VALIDITÉ ARTIFICIELLES : règles pures (aucune base, aucune IA).
 *
 *   L116F-U-REPRO   le défaut reproduit : sans la règle, le fait T1 du bon de commande donne « Début de
 *                   validité : 17/11/2026 » ; avec la règle, plus rien ;
 *   L116F-U-RULE    `classifyPointDatePeriod` : jour unique, rôles des dates, motifs, « à réexaminer » ;
 *   L116F-U-MODEL   `qualifyDocumentPeriods` : critères 1 à 5 de la carte (commande, facture, devis,
 *                   contrat / attestation / garantie / facture périodique, émission = date du document) ;
 *   L116F-U-PLAN    `planRefresh` : correction de l'utilisateur protégée, stock « à réexaminer » conservé,
 *                   copie prouvée retirée, rejeu sans effet (critères 6 et 7) ;
 *   L116F-U-COH     contrôle de cohérence : version, anomalies, interdits ;
 *   L116F-U-UI      fiche Document : aucune action « Corriger », libellés inchangés, aucun texte de
 *                   prompt modifié, aucune règle par fournisseur ni par type (critère 8, statique).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: async () => [], begin: async () => { throw new Error('aucune base dans ce test'); } } }));

const lib = await import('@/lib/documents/business-periods');
const m = await import('../model');
const pd = await import('../point-date');
const svc = await import('../service');

type Entrees = import('../model').PeriodInputs;
type Fait = Entrees['facts'][number];
type Stocke = import('../model').StoredPeriod;
type PointDate = import('../point-date').DocumentPointDate;

const SANS_FACTURATION: Entrees['billing'] = { billedPeriod: null, statedMonth: null, hasBillingBlock: false };
const fait = (factId: number, rawKey: string, normalizedValue: string, excerpt: string | null = null, over: Partial<Fait> = {}): Fait => ({
  factId, rawKey, normalizedValue, periodStart: null, periodEnd: null, attribute: null, confidence: 'certain', excerpt, page: null, ...over,
});
const qualifier = (p: Partial<Entrees>) => m.qualifyDocumentPeriods({ candidates: [], facts: [], billing: SANS_FACTURATION, ...p });
const lignes = (p: Partial<Entrees>) => qualifier(p).desired.map((d) => lib.periodLine(d.kind, d));

/** Bon de commande du 17/11/2026 : date du document enregistrée, lue par T1 (« Commande du 17/11/2026 »), date de l'opération. */
const COMMANDE: PointDate[] = [
  { date: '2026-11-17', role: 'DOCUMENT_DATE' },
  { date: '2026-11-17', role: 'T1_DOCUMENT_DATE', excerpt: 'Commande du 17/11/2026' },
  { date: '2026-11-17', role: 'OPERATION_DATE' },
];
const DEVIS: PointDate[] = [{ date: '2026-11-03', role: 'DOCUMENT_DATE' }, { date: '2026-11-03', role: 'T1_DOCUMENT_DATE', excerpt: 'Devis du 03/11/2026' }];

describe('L116F-U-REPRO — le défaut du bon de commande, reproduit puis corrigé', () => {
  const validite = fait(1, 'period.validity', '2026-11-17/', 'Commande du 17/11/2026');

  it('AVANT (qualification sans la connaissance des dates du document) : « Début de validité : 17/11/2026 »', () => {
    // C'est exactement ce que la fiche affichait : le fait T1 était recopié tel quel.
    expect(lignes({ facts: [validite] })).toEqual(['Début de validité : 17/11/2026']);
  });

  it('APRÈS : la date de la commande n’est pas un début de validité — aucune période, le fait est tracé comme écarté', () => {
    const q = qualifier({ facts: [validite], pointDates: COMMANDE });
    expect(q.desired).toEqual([]);
    expect(q.review).toEqual([]);
    expect(q.refused).toEqual([{
      factId: 1, kind: 'VALIDITY', start: '2026-11-17', end: null, date: '2026-11-17',
      roles: ['DOCUMENT_DATE', 'T1_DOCUMENT_DATE', 'OPERATION_DATE'], reason: 'SAME_MENTION_AS_POINT_DATE',
    }]);
    expect(m.deriveDocumentPeriods({ candidates: [], facts: [validite], billing: SANS_FACTURATION, pointDates: COMMANDE })).toEqual([]);
  });
});

describe('L116F-U-RULE — une date du document n’est jamais, à elle seule, une borne', () => {
  const verdict = (bounds: import('@/lib/documents/business-periods').PeriodBounds, excerpt: string | null, o: { kind?: import('@/lib/documents/business-periods').BusinessPeriodKind; pointDates?: PointDate[]; relevance?: string | null } = {}) =>
    pd.classifyPointDatePeriod({ kind: o.kind ?? 'VALIDITY', bounds, excerpt, pointDates: o.pointDates ?? COMMANDE, relevance: o.relevance });

  it('jour unique : début seul, fin seule, début = fin ; jamais deux bornes, une durée indéterminée, un mois ou une année', () => {
    expect(pd.singleDayOf({ start: '2026-11-17', end: null })).toBe('2026-11-17');
    expect(pd.singleDayOf({ start: null, end: '2026-11-17' })).toBe('2026-11-17');
    expect(pd.singleDayOf({ start: '2026-11-17', end: '2026-11-17' })).toBe('2026-11-17');
    expect(pd.singleDayOf({ start: '2026-11-17', end: '2026-12-17' })).toBeNull();
    expect(pd.singleDayOf({ start: '2026-11-17', end: null, openEnded: true })).toBeNull();
    expect(pd.singleDayOf({ start: '2026-11', end: null })).toBeNull();
    expect(pd.singleDayOf({ start: '2026', end: '2026' })).toBeNull();
    expect(pd.singleDayOf({ start: null, end: null })).toBeNull();
  });

  it('copie PROUVÉE : aucun extrait, extrait sans la date, extrait réduit à la date, mention même de la date du document', () => {
    expect(verdict({ start: '2026-11-17', end: null }, null)).toMatchObject({ verdict: 'POINT_DATE_COPY', reason: 'NO_OWN_PROOF' });
    expect(verdict({ start: '2026-11-17', end: null }, '   ')).toMatchObject({ verdict: 'POINT_DATE_COPY', reason: 'NO_OWN_PROOF' });
    expect(verdict({ start: '2026-11-17', end: null }, 'Votre commande est validée !')).toMatchObject({ verdict: 'POINT_DATE_COPY', reason: 'PROOF_WITHOUT_DATE' });
    expect(verdict({ start: '2026-11-17', end: null }, 'Mardi 17 novembre 2026')).toMatchObject({ verdict: 'POINT_DATE_COPY', reason: 'PROOF_IS_THE_DATE' });
    expect(verdict({ start: '2026-11-17', end: null }, '17/11/2026')).toMatchObject({ verdict: 'POINT_DATE_COPY', reason: 'PROOF_IS_THE_DATE' });
    expect(verdict({ start: '2026-11-17', end: null }, 'commande du 17 nov. 2026')).toMatchObject({ verdict: 'POINT_DATE_COPY', reason: 'SAME_MENTION_AS_POINT_DATE' });
    expect(verdict({ start: null, end: '2026-11-17' }, 'Commande du 17/11/2026')).toMatchObject({ verdict: 'POINT_DATE_COPY', roles: ['DOCUMENT_DATE', 'T1_DOCUMENT_DATE', 'OPERATION_DATE'] });
    // La mention d'un autre fait de date du même jour (« Date de commande ») est aussi celle d'une date ponctuelle.
    const avecFait: PointDate[] = [...COMMANDE, { date: '2026-11-17', role: 'DATE_FACT', excerpt: 'Date de commande : 17/11/2026 — Réf. 4521' }];
    expect(verdict({ start: '2026-11-17', end: null }, 'Date de commande : 17/11/2026', { pointDates: avecFait })).toMatchObject({ verdict: 'POINT_DATE_COPY', reason: 'SAME_MENTION_AS_POINT_DATE' });
  });

  it('contrat v2 : pertinence non établie par T1 (indéterminée, sans date) → jamais une validité tirée de la date du document', () => {
    expect(verdict({ start: '2026-11-17', end: null }, 'Offre valable à compter du 17/11/2026', { relevance: 'UNDETERMINED' })).toMatchObject({ verdict: 'POINT_DATE_COPY', reason: 'RELEVANCE_NOT_ESTABLISHED' });
    expect(verdict({ start: '2026-11-17', end: null }, 'Offre valable à compter du 17/11/2026', { relevance: 'UNKNOWN' })).toMatchObject({ verdict: 'POINT_DATE_COPY', reason: 'RELEVANCE_NOT_ESTABLISHED' });
    // Règle remplacée (carte #812, recette du 21/11) : même « pertinente et connue » selon T1, un DÉBUT égal à la date
    // du document sans rien d'autre n'établit aucune validité (avant : « à réexaminer »).
    expect(verdict({ start: '2026-11-17', end: null }, 'Offre valable à compter du 17/11/2026', { relevance: 'KNOWN' })).toMatchObject({ verdict: 'POINT_DATE_COPY', reason: 'DOCUMENT_DATE_RESTATED' });
    expect(verdict({ start: null, end: '2026-11-17' }, 'Offre valable jusqu’au 17/11/2026', { relevance: 'KNOWN' })).toMatchObject({ verdict: 'TO_REVIEW' });
  });

  // Règle remplacée (carte #812, recette du 21/11). AVANT : un début seul égal à la date du document, cité dans une
  // « mention propre », était « à réexaminer » (TO_REVIEW) et la ligne du stock restait affichée. Le PO a tranché par
  // sa recette : une mention qui ne fait que redire la date du document ne suffit pas — c'est une copie, avec motif.
  it('début égal à la date du document, mention PROPRE : copie (`DOCUMENT_DATE_RESTATED`) ; seule la FIN SEULE reste « à réexaminer »', () => {
    const roles = ['DOCUMENT_DATE', 'T1_DOCUMENT_DATE', 'OPERATION_DATE'];
    expect(verdict({ start: '2026-11-17', end: null }, 'Offre valable à compter du 17/11/2026')).toEqual({ verdict: 'POINT_DATE_COPY', date: '2026-11-17', roles, reason: 'DOCUMENT_DATE_RESTATED' });
    expect(verdict({ start: '2026-11-17', end: null }, 'Commande du 17/11/2026, offre valable dès ce jour')).toMatchObject({ verdict: 'POINT_DATE_COPY', reason: 'DOCUMENT_DATE_RESTATED' });
    expect(verdict({ start: '2026-11-17', end: '2026-11-17' }, 'Votre commande du 17/11/2026 est validée')).toMatchObject({ verdict: 'POINT_DATE_COPY', reason: 'DOCUMENT_DATE_RESTATED' });
    // Non tranché par le PO, inchangé : une FIN SEULE le jour du document, portée par une mention propre.
    expect(verdict({ start: null, end: '2026-11-17' }, 'Offre valable jusqu’au 17/11/2026')).toEqual({ verdict: 'TO_REVIEW', date: '2026-11-17', roles });
  });

  it('justifiée : autre jour, seconde borne, durée indéterminée, date partielle, aucune date du document connue', () => {
    expect(verdict({ start: '2026-12-01', end: null }, 'Valable à compter du 01/12/2026')).toEqual({ verdict: 'JUSTIFIED' });
    expect(verdict({ start: '2026-11-17', end: '2026-12-17' }, 'Commande du 17/11/2026')).toEqual({ verdict: 'JUSTIFIED' });
    expect(verdict({ start: '2026-11-17', end: null, openEnded: true }, null)).toEqual({ verdict: 'JUSTIFIED' });
    expect(verdict({ start: '2026-11', end: '2026-11' }, null)).toEqual({ verdict: 'JUSTIFIED' });
    expect(verdict({ start: '2026-11-17', end: null }, null, { pointDates: [] })).toEqual({ verdict: 'JUSTIFIED' });
    // Un autre fait de date du même jour ne fait pas, seul, de ce jour une date DU DOCUMENT (« valable jusqu'au… » lu deux fois).
    expect(verdict({ start: null, end: '2036-01-01' }, 'Valable jusqu’au 01/01/2036', { pointDates: [{ date: '2036-01-01', role: 'DATE_FACT', excerpt: 'Valable jusqu’au 01/01/2036' }] })).toEqual({ verdict: 'JUSTIFIED' });
  });

  it('périmètre : la VALIDITÉ seulement — garantie, couverture, effet contractuel, facturation ne sont pas concernés', () => {
    expect(pd.POINT_DATE_GUARDED_KINDS).toEqual(['VALIDITY']);
    for (const kind of ['WARRANTY', 'COVERAGE', 'CONTRACT', 'BILLING', 'SERVICE', 'REALIZATION'] as const) {
      expect(verdict({ start: '2026-11-17', end: null }, null, { kind })).toEqual({ verdict: 'JUSTIFIED' });
    }
  });

  it('lecture d’un extrait : date reconnue dans toutes ses écritures, mots de calendrier jamais comptés comme une preuve', () => {
    for (const t of ['17/11/2026', '17.11.26', 'le 17 novembre 2026', '2026-11-17', 'November 17, 2026', '17112026', '20261117']) {
      expect(pd.excerptCitesDay(t, '2026-11-17'), t).toBe(true);
    }
    for (const t of ['18/11/2026', '17/11/2025', 'commande validée', '', '2026']) expect(pd.excerptCitesDay(t, '2026-11-17'), t).toBe(false);
    expect(pd.excerptWords('Mardi 17 nov. 2026, Date d’émission : 17/11/2026')).toEqual(['date', 'd', 'emission']);
    expect(pd.excerptWords('17 novembre 2026')).toEqual([]);
  });
});

describe('L116F-U-MODEL — critères 1 à 5 de la carte', () => {
  it('critère 1 — bon de commande : aucune validité, quelle que soit la forme de la sortie T1 ; contrat v2 : aucune ligne « non renseignée »', () => {
    for (const extrait of ['Commande du 17/11/2026', 'Votre commande est validée !', '17/11/2026', null]) {
      expect(lignes({ facts: [fait(1, 'period.validity', '2026-11-17/', extrait)], pointDates: COMMANDE }), String(extrait)).toEqual([]);
      expect(lignes({ facts: [fait(1, 'period.validity', '2026-11-17/2026-11-17', extrait)], pointDates: COMMANDE }), String(extrait)).toEqual([]);
    }
    // Valeur lue dans `periodStart` (sans `normalizedValue`) : même règle.
    expect(lignes({ facts: [fait(1, 'period.validity', '', 'Commande du 17/11/2026', { normalizedValue: null, periodStart: '2026-11-17' })], pointDates: COMMANDE })).toEqual([]);
    // T1 annonce « validity=known » : sa pertinence ne reposait que sur la date de la commande — ni borne, ni « non renseignée ».
    const v2 = qualifier({
      facts: [fait(1, 'period.validity', '2026-11-17/', 'Commande du 17/11/2026', { attribute: 'principal' }), fait(2, 'period.relevance', 'validity=known;billing=not_relevant')],
      pointDates: COMMANDE,
    });
    expect(v2.desired).toEqual([]);
    expect(v2.refused).toHaveLength(1);
  });

  it('critère 2 — facture d’achat ponctuel : aucune période fictive ; garantie et période facturée établies séparément conservées', () => {
    const facture: PointDate[] = [{ date: '2026-11-14', role: 'DOCUMENT_DATE' }, { date: '2026-11-14', role: 'OPERATION_DATE' }];
    expect(lignes({ facts: [fait(1, 'period.validity', '2026-11-14/', 'Facture du 14/11/2026')], pointDates: facture })).toEqual([]);
    expect(lignes({
      facts: [
        fait(1, 'period.validity', '2026-11-14/', null),
        fait(2, 'period.warranty', '2026-11-14/2028-11-14', 'Garantie 2 ans'),
        fait(3, 'period.warranty', '2026-11-14/', 'Garantie à compter du 14/11/2026'),
        fait(4, 'period.billing', '2026-11-01/2026-11-30', 'Période facturée'),
      ],
      pointDates: facture,
    })).toEqual(['Période de garantie : du 14/11/2026 au 14/11/2028', 'Début de garantie : 14/11/2026', 'Période facturée : du 01/11/2026 au 30/11/2026']);
  });

  it('critère 3 — devis : validité explicite conservée (deux bornes, fin seule, durée indéterminée) ; sans validité, rien d’inventé', () => {
    expect(lignes({ facts: [fait(1, 'period.validity', '2026-11-03/2026-12-03', 'Valable 30 jours')], pointDates: DEVIS })).toEqual(['Période de validité : du 03/11/2026 au 03/12/2026']);
    expect(lignes({ facts: [fait(1, 'period.validity', '/2026-12-03', 'Valable jusqu’au 03/12/2026')], pointDates: DEVIS })).toEqual(['Fin de validité : 03/12/2026']);
    expect(lignes({ facts: [fait(1, 'period.validity', '2026-11-03/INDEFINITE', 'Sans limitation de durée')], pointDates: DEVIS })).toEqual(['Début de validité : 03/11/2026 (durée indéterminée)']);
    expect(lignes({ facts: [fait(1, 'period.relevance', 'validity=unknown')], pointDates: DEVIS })).toEqual(['Période de validité : non renseignée']);
    expect(lignes({ facts: [], pointDates: DEVIS })).toEqual([]);
    expect(lignes({ facts: [fait(1, 'period.validity', '2026-11-03/', 'Devis du 03/11/2026')], pointDates: DEVIS })).toEqual([]);
    // Une même validité citée deux fois, dont une mention justifiée par ses deux bornes : conservée.
    expect(lignes({ facts: [fait(1, 'period.validity', '2026-11-03/', 'Devis du 03/11/2026'), fait(2, 'period.validity', '2026-11-03/2026-12-03', 'Valable 30 jours')], pointDates: DEVIS }))
      .toEqual(['Période de validité : du 03/11/2026 au 03/12/2026']);
  });

  it('critère 4 — contrat, attestation, garantie, facture périodique : début seul, fin seule, dates partielles, plusieurs périodes, durée indéterminée', () => {
    const jour: PointDate[] = [{ date: '2026-01-01', role: 'DOCUMENT_DATE' }, { date: '2026-01-01', role: 'T1_DOCUMENT_DATE', excerpt: 'Le 01/01/2026' }];
    expect(lignes({ facts: [fait(1, 'period.contract', '2026-01-01/INDEFINITE', 'Durée indéterminée')], pointDates: jour })).toEqual(['Date d’effet du contrat : 01/01/2026 (durée indéterminée)']);
    expect(lignes({ facts: [fait(1, 'period.contract', '2026-01-01/', null)], pointDates: jour })).toEqual(['Date d’effet du contrat : 01/01/2026']);
    expect(lignes({ facts: [fait(1, 'period.coverage', '2026-01-01/', null)], pointDates: jour })).toEqual(['Début de couverture : 01/01/2026']);
    expect(lignes({ facts: [fait(1, 'period.warranty', '/2028', null)], pointDates: jour })).toEqual(['Fin de garantie : 2028']);
    expect(lignes({ facts: [fait(1, 'period.billing', '2026-01', null), fait(2, 'period.billing', '2026-02', null)], pointDates: jour }))
      .toEqual(['Période facturée : janvier 2026', 'Période facturée : février 2026']);
    // Validité : plusieurs périodes ; celle qui n'est que la date du document est seule écartée, les autres gardent leur rang.
    const q = qualifier({
      facts: [
        fait(1, 'period.validity', '2026-01-01/', 'Le 01/01/2026'),
        fait(2, 'period.validity', '2026-01-01/2026-12-31', 'Valable du 01/01/2026 au 31/12/2026'),
        fait(3, 'period.validity', '2027-03-01/', 'Puis à compter du 01/03/2027'),
        fait(4, 'period.validity', '2026-01', 'Janvier 2026'),
      ],
      pointDates: jour,
    });
    expect(q.desired.map((d) => [d.segment, lib.periodLine(d.kind, d)])).toEqual([
      [0, 'Période de validité : janvier 2026'], [1, 'Période de validité : du 01/01/2026 au 31/12/2026'], [2, 'Début de validité : 01/03/2027'],
    ]);
    expect(q.refused.map((r) => r.factId)).toEqual([1]);
  });

  it('critère 5 — date d’émission = date du document : jamais convertie en validité ; les faits ponctuels ne sont ni lus ni modifiés ici', () => {
    const emission: PointDate[] = [
      { date: '2026-11-14', role: 'DOCUMENT_DATE' }, { date: '2026-11-14', role: 'T1_DOCUMENT_DATE', excerpt: 'Facture du 14/11/2026' },
      { date: '2026-11-14', role: 'DATE_FACT', excerpt: 'Date d’émission : 14/11/2026' },
    ];
    for (const extrait of ['Date d’émission : 14/11/2026', 'Facture du 14/11/2026', 'Émission']) {
      expect(qualifier({ facts: [fait(1, 'period.validity', '2026-11-14/', extrait)], pointDates: emission }).refused, extrait).toHaveLength(1);
    }
    // La qualification ne rend QUE des périodes : aucune date ponctuelle n'y entre ni n'en sort.
    expect(qualifier({ facts: [fait(9, 'invoice.issueDate', '2026-11-14', 'Date d’émission : 14/11/2026')], pointDates: emission })).toEqual({ desired: [], review: [], refused: [], toReview: [] });
  });

  it('sans dates ponctuelles connues, la qualification est exactement celle d’avant la carte (aucune régression silencieuse)', () => {
    const facts = [fait(1, 'period.billing', '2026-01-15/'), fait(2, 'period.validity', '/2026-06-30'), fait(3, 'period.warranty', '2026-03')];
    expect(qualifier({ facts }).desired).toEqual(qualifier({ facts, pointDates: [] }).desired);
    expect(qualifier({ facts }).desired).toEqual(m.deriveDocumentPeriods({ candidates: [], facts, billing: SANS_FACTURATION }));
    expect(qualifier({ facts, pointDates: COMMANDE }).desired).toEqual(qualifier({ facts }).desired);
  });
});

describe('L116F-U-PLAN — critères 6 et 7 : correction de l’utilisateur, stock, rejeu', () => {
  const validite = fait(1, 'period.validity', '2026-11-17/', 'Commande du 17/11/2026');
  const propre = fait(2, 'period.validity', '2026-11-17/', 'Offre valable à compter du 17/11/2026');
  /** Période telle que la qualification d'avant la carte l'enregistrait pour ce fait. */
  const enregistree = (id: number, f: Fait, over: Partial<Stocke> = {}): Stocke => ({
    id, kind: 'VALIDITY', segment: 0, start: '2026-11-17', end: null, principalHint: false, origin: 'T1', basis: 'T1_PERIOD_FACT',
    evidence: { quote: f.excerpt, page: null, factIds: [f.factId] }, userLocked: false, ...over,
  });

  it('l’empreinte du stock est bien celle qu’écrivait la qualification d’avant (le test du stock est fidèle)', () => {
    const [avant] = m.deriveDocumentPeriods({ candidates: [], facts: [validite], billing: SANS_FACTURATION });
    expect(m.periodSignature(enregistree(10, validite))).toBe(m.periodSignature(avant));
  });

  it('copie prouvée : retirée du stock (jamais supprimée) ; rejouée : plus rien', () => {
    const q = qualifier({ facts: [validite], pointDates: COMMANDE });
    const stock = [enregistree(10, validite)];
    const plan = m.planRefresh(stock, q.desired, q.review);
    expect(plan).toEqual({ keep: [], supersede: [10], insert: [] });
    expect(svc.pointDateReport(q, stock, plan)).toEqual({
      copies: [{ periodId: 10, kind: 'VALIDITY', start: '2026-11-17', end: null, date: '2026-11-17', roles: ['DOCUMENT_DATE', 'T1_DOCUMENT_DATE', 'OPERATION_DATE'], reason: 'SAME_MENTION_AS_POINT_DATE' }],
      toReview: [], refusedFacts: 1,
    });
    // Après réparation, le stock actif est vide : second passage sans effet.
    const rejeu = m.planRefresh([], q.desired, q.review);
    expect(rejeu).toEqual({ keep: [], supersede: [], insert: [] });
    expect(svc.pointDateReport(q, [], rejeu)).toEqual({ copies: [], toReview: [], refusedFacts: 1 });
  });

  // Règle remplacée (carte #812, recette du 21/11). AVANT : le début seul à « mention propre » du stock était
  // CONSERVÉ « à réexaminer » (keep + review) et restait affiché. APRÈS : il est retiré du stock avec son motif.
  it('début seul à mention propre (ancien cas « à réexaminer ») : jamais créé, RETIRÉ du stock avec motif', () => {
    const q = qualifier({ facts: [propre], pointDates: COMMANDE });
    expect(q.desired).toEqual([]);
    expect(q.review).toEqual([]);
    expect(q.refused).toMatchObject([{ factId: 2, kind: 'VALIDITY', date: '2026-11-17', reason: 'DOCUMENT_DATE_RESTATED' }]);
    // Nouveau document : rien n'est créé.
    expect(m.planRefresh([], q.desired, q.review)).toEqual({ keep: [], supersede: [], insert: [] });
    // Stock : retiré, motif tracé.
    const stock = [enregistree(11, propre)];
    const plan = m.planRefresh(stock, q.desired, q.review);
    expect(plan).toEqual({ keep: [], supersede: [11], insert: [] });
    expect(svc.pointDateReport(q, stock, plan)).toMatchObject({ copies: [{ periodId: 11, date: '2026-11-17', reason: 'DOCUMENT_DATE_RESTATED' }], toReview: [] });
    // Après une nouvelle analyse (autre fait, même contenu) : toujours retirée, jamais recréée.
    const q2 = qualifier({ facts: [{ ...propre, factId: 99 }], pointDates: COMMANDE });
    expect(m.planRefresh(stock, q2.desired, q2.review)).toEqual({ keep: [], supersede: [11], insert: [] });
  });

  it('fin seule le jour du document, mention propre (non tranché par le PO) : jamais créée, CONSERVÉE « à réexaminer » si elle est enregistrée', () => {
    const fin = fait(7, 'period.validity', '/2026-11-17', 'Offre valable jusqu’au 17/11/2026');
    const q = qualifier({ facts: [fin], pointDates: COMMANDE });
    expect(q.desired).toEqual([]);
    expect(q.review).toHaveLength(1);
    expect(m.planRefresh([], q.desired, q.review)).toEqual({ keep: [], supersede: [], insert: [] });
    const stock = [enregistree(15, fin, { start: null, end: '2026-11-17' })];
    const plan = m.planRefresh(stock, q.desired, q.review);
    expect(plan).toEqual({ keep: [15], supersede: [], insert: [], review: [15] });
    expect(svc.pointDateReport(q, stock, plan)).toMatchObject({ copies: [], toReview: [{ periodId: 15, date: '2026-11-17' }] });
  });

  it('critère 6 — correction de l’utilisateur : jamais retirée ni réécrite, les autres périodes suivent leur règle', () => {
    const corrigee = enregistree(12, validite, { origin: 'USER', basis: 'USER', userLocked: true, lockedBefore: { start: '2026-11-17', end: null } });
    const garantie: Stocke = { id: 13, kind: 'WARRANTY', segment: 0, start: '2026-11-17', end: '2028-11-17', principalHint: false, origin: 'T1', basis: 'T1_PERIOD_FACT', evidence: { quote: 'Garantie 2 ans', page: null, factIds: [3] }, userLocked: false };
    const facts = [validite, fait(3, 'period.warranty', '2026-11-17/2028-11-17', 'Garantie 2 ans')];
    const q = qualifier({ facts, pointDates: COMMANDE });
    const plan = m.planRefresh([corrigee, garantie], q.desired, q.review);
    expect(plan).toEqual({ keep: [13], supersede: [], insert: [] });
    // Le rapport ne compte pas une période de l'utilisateur parmi les copies.
    expect(svc.pointDateReport(q, [corrigee, garantie], plan).copies).toEqual([]);
    // Même avec un fait « à réexaminer » : la décision de l'utilisateur n'est ni doublée ni remplacée.
    const q2 = qualifier({ facts: [propre], pointDates: COMMANDE });
    expect(m.planRefresh([corrigee], q2.desired, q2.review)).toEqual({ keep: [], supersede: [], insert: [] });
  });

  it('validité légitime du stock (fin écrite) : jamais touchée', () => {
    const legitime = fait(5, 'period.validity', '2026-11-17/2026-12-17', 'Valable du 17/11/2026 au 17/12/2026');
    const q = qualifier({ facts: [legitime], pointDates: COMMANDE });
    const stock = [enregistree(14, legitime, { end: '2026-12-17' })];
    expect(m.planRefresh(stock, q.desired, q.review)).toEqual({ keep: [14], supersede: [], insert: [] });
    expect(q.refused).toEqual([]);
  });

  it('création par l’utilisateur (E12) : une validité écartée ne rend pas la nature « pertinente » ; indéterminée sous v2, elle reste ouverte à l’utilisateur', () => {
    expect(svc.creationAllowed('VALIDITY', { candidates: [], facts: [validite], billing: SANS_FACTURATION, pointDates: COMMANDE })).toBe(false);
    expect(svc.creationAllowed('VALIDITY', { candidates: [], facts: [validite, fait(2, 'period.relevance', 'validity=undetermined')], billing: SANS_FACTURATION, pointDates: COMMANDE })).toBe(true);
  });
});

describe('L116F-U-COH — détection récurrente et reprise du stock', () => {
  it('COH-DOC-BUSINESS-PERIODS : version 2, anomalies nommées, aucune IA, aucun retrait d’un cas indéterminé', async () => {
    const { documentBusinessPeriodsCheck: c } = await import('@/services/coherence/registry/checks/document-business-periods');
    expect(c.version).toBe(2);
    expect(c.anomalies).toEqual(expect.arrayContaining(['BUSINESS_PERIODS_POINT_DATE_COPY', 'BUSINESS_PERIODS_POINT_DATE_TO_REVIEW']));
    expect(c.triggers).toEqual(expect.arrayContaining(['SOURCE_ANALYZED', 'DOCUMENT_UPDATED']));
    expect(c.forbiddenRepairs.join(' ')).toMatch(/appeler l’IA/);
    expect(c.forbiddenRepairs.join(' ')).toMatch(/à réexaminer/);
    expect(c.forbiddenRepairs.join(' ')).toMatch(/supprimer une période/);
    expect(svc.POINT_DATE_SUPERSEDED_REASON).toBe('POINT_DATE_COPY');
  });

  it('migration 1870 : additive, idempotente, aucune ligne modifiée', () => {
    const sql = readFileSync(join(process.cwd(), 'src/db/migrations/1870_l116f_periodes_motif_retrait.sql'), 'utf8');
    const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS superseded_reason TEXT/);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS superseded_correlation_id TEXT/);
    expect(code).toMatch(/CREATE INDEX IF NOT EXISTS/);
    expect(code).not.toMatch(/\b(DROP|DELETE|UPDATE|TRUNCATE)\b/);
    expect(code.split('\n').filter((l) => l.includes('ADD COLUMN')).join('\n')).not.toMatch(/NOT NULL|DEFAULT/);
  });
});

describe('L116F-U-UI — fiche Document et garde-fous', () => {
  const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

  it('carte #782 respectée : aucune action « Corriger » sur une période, lignes du tiroir en lecture, libellés inchangés', () => {
    const composant = lire('src/components/documents/BusinessPeriods.tsx');
    const sansCommentaires = composant.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(sansCommentaires).not.toMatch(/Corriger/);
    expect(lib.PERIOD_EDIT_ACTION).toBe('Modifier');
    expect(lib.BUSINESS_PERIOD_LABELS.VALIDITY).toEqual({ period: 'Période de validité', start: 'Début de validité', end: 'Fin de validité' });
    // Le tiroir n'affiche que ce que le serveur rend : aucune ligne quand aucune période n'est qualifiée.
    expect(composant).toMatch(/!view\.principal && !view\.coverageHistories\.length\)\) return null/);
  });

  it('aucune règle par fournisseur, par type de document ni par titre ; aucun mot interprété dans un extrait', () => {
    const regle = lire('src/services/documents/business-periods/point-date.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(regle).not.toMatch(/decathlon|conforama|fournisseur|supplier|provider/i);
    expect(regle).not.toMatch(/document_type|typeHint|sourceRoleHint|ORDER|QUOTE|INVOICE|retained_title|title/);
    expect(regle).not.toMatch(/valable|valid until|commande|devis|facture|offre/i);
  });

  it('bloc PO 59 présent, facultatif, et aucun texte de prompt du code ne porte la règle', () => {
    const guide = lire('docs/exploitation/prompts-a-appliquer-par-le-po.md');
    expect(guide).toMatch(/Étape 59/);
    expect(guide).toMatch(/FACULTATIVE/);
    const section = guide.slice(guide.indexOf('Étape 59'));
    expect(section).toMatch(/#812/);
    expect(section).toMatch(/fonctionne à l’identique sans ce bloc|fonctionne à l'identique sans ce bloc/);
  });
});
