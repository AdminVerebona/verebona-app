/**
 * Carte Trello #812 (lot 116F) — REPRISE APRÈS LA RECETTE KO DU 21/11/2026 : règles pures et garde-fous
 * statiques (aucune base réelle, aucune IA). Le scénario PostgreSQL correspondant est
 * `src/test/e2e/scenarios/l116f-decathlon-recette-ko.e2e.ts`.
 *
 *   L116F-KO-U-RULE     règle resserrée : un DÉBUT égal à la date du document, sans rien d'autre, est une copie
 *                       quelle que soit sa mention ; ce que le fait doit porter « en plus » pour être gardé ;
 *   L116F-KO-U-SUSPECT  filtre d'entrée de la règle de lecture (`isPointDateSuspect`) ;
 *   L116F-KO-U-REPORT   `pointDateReport` : une ligne du stock dont le fait a disparu est classée directement ;
 *   L116F-KO-U-READ     la règle de lecture ne coûte AUCUNE requête quand aucune période n'est suspecte, n'écrit
 *                       jamais, et chaque lecteur des périodes passe par elle ;
 *   L116F-KO-U-OPS      script de reprise, migration 1871, contrôle de cohérence (version inchangée), bloc 59.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const requetes: string[] = [];
vi.mock('@/db', () => ({
  pgClient: {
    unsafe: async (q: string) => { requetes.push(q); return []; },
    begin: async () => { throw new Error('aucune écriture dans ce test'); },
  },
}));

const m = await import('../model');
const pd = await import('../point-date');
const svc = await import('../service');

type Entrees = import('../model').PeriodInputs;
type Fait = Entrees['facts'][number];
type Stocke = import('../model').StoredPeriod;
type PointDate = import('../point-date').DocumentPointDate;
type Bornes = import('@/lib/documents/business-periods').PeriodBounds;

const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const SANS_FACTURATION: Entrees['billing'] = { billedPeriod: null, statedMonth: null, hasBillingBlock: false };
const fait = (factId: number, rawKey: string, normalizedValue: string, excerpt: string | null = null): Fait => ({
  factId, rawKey, normalizedValue, periodStart: null, periodEnd: null, attribute: null, confidence: 'certain', excerpt, page: null,
});
/** Bon de commande Decathlon du 17/11/2026 : date enregistrée, date lue par T1 (« Commande du 17/11/2026 »), date de l'opération. */
const COMMANDE: PointDate[] = [
  { date: '2026-11-17', role: 'DOCUMENT_DATE' },
  { date: '2026-11-17', role: 'T1_DOCUMENT_DATE', excerpt: 'Commande du 17/11/2026' },
  { date: '2026-11-17', role: 'OPERATION_DATE' },
];
const verdict = (bounds: Bornes, excerpt: string | null, relevance?: string | null) =>
  pd.classifyPointDatePeriod({ kind: 'VALIDITY', bounds, excerpt, pointDates: COMMANDE, relevance });

describe('L116F-KO-U-RULE — règle resserrée (recette du 21/11)', () => {
  it('les DEUX variantes d’extrait du cas Decathlon sont des copies : la mention de la date, et une « mention propre »', () => {
    expect(verdict({ start: '2026-11-17', end: null }, 'Commande du 17/11/2026')).toMatchObject({ verdict: 'POINT_DATE_COPY', reason: 'SAME_MENTION_AS_POINT_DATE' });
    expect(verdict({ start: '2026-11-17', end: null }, 'Votre commande du 17/11/2026 est validée !')).toMatchObject({ verdict: 'POINT_DATE_COPY', reason: 'DOCUMENT_DATE_RESTATED' });
  });

  it('comment une « mention propre » est reconnue : elle cite le jour, dit au moins un mot de plus, et n’est pas contenue dans la mention de la date du document', () => {
    // Cite le jour : quantième et année parmi les nombres de l'extrait.
    expect(pd.excerptCitesDay('Votre commande du 17/11/2026 est validée !', '2026-11-17')).toBe(true);
    expect(pd.excerptCitesDay('Votre commande est validée !', '2026-11-17')).toBe(false);
    // Mots « en plus » : ni nombres, ni mots de calendrier.
    expect(pd.excerptWords('Mardi 17 novembre 2026')).toEqual([]);
    expect(pd.excerptWords('Votre commande du 17/11/2026 est validée !')).toEqual(['votre', 'commande', 'du', 'est', 'validee']);
    // « commande du » est contenu dans la mention de la date du document : même mention. « votre commande du … est validée » ne l'est pas.
    expect(verdict({ start: '2026-11-17', end: null }, 'commande du 17 nov. 2026')).toMatchObject({ reason: 'SAME_MENTION_AS_POINT_DATE' });
    // Aucun mot n'est interprété : n'importe quelle phrase qui cite la date était « propre » — c'est ce que la recette refuse.
    expect(verdict({ start: '2026-11-17', end: null }, 'Merci pour votre achat du 17/11/2026')).toMatchObject({ verdict: 'POINT_DATE_COPY', reason: 'DOCUMENT_DATE_RESTATED' });
  });

  it('ce que le fait T1 doit porter EN PLUS de la date du document pour être conservé et affiché', () => {
    // Une fin distincte (y compris la fin que T1 déduit d'une durée : « valable 30 jours »).
    expect(verdict({ start: '2026-11-17', end: '2026-12-17' }, 'Offre valable 30 jours à compter du 17/11/2026')).toEqual({ verdict: 'JUSTIFIED' });
    // Une durée indéterminée DÉCLARÉE par le document (INDEFINITE).
    expect(verdict({ start: '2026-11-17', end: null, openEnded: true }, 'Valable à compter du 17/11/2026, sans limitation de durée')).toEqual({ verdict: 'JUSTIFIED' });
    // Une borne différente de la date du document.
    expect(verdict({ start: '2026-12-01', end: null }, 'Valable à compter du 01/12/2026')).toEqual({ verdict: 'JUSTIFIED' });
    expect(verdict({ start: null, end: '2026-12-17' }, 'Valable jusqu’au 17/12/2026')).toEqual({ verdict: 'JUSTIFIED' });
    // Rien de tout cela : début seul, ou début = fin, le jour du document — jamais conservé, quelle que soit la mention.
    for (const extrait of ['Offre valable à compter du 17/11/2026', 'Valide à compter de ce jour, 17/11/2026', 'Commande du 17/11/2026', null]) {
      expect(verdict({ start: '2026-11-17', end: null }, extrait).verdict).toBe('POINT_DATE_COPY');
      expect(verdict({ start: '2026-11-17', end: '2026-11-17' }, extrait).verdict).toBe('POINT_DATE_COPY');
    }
  });

  it('devis « valable à compter du 17/11 » sans fin : non qualifié ; avec le bloc 59 (validity=unknown, aucun fait) : « non renseignée »', () => {
    const devis: PointDate[] = [{ date: '2026-11-17', role: 'DOCUMENT_DATE' }, { date: '2026-11-17', role: 'T1_DOCUMENT_DATE', excerpt: 'Devis du 17/11/2026' }];
    const sansBloc = m.qualifyDocumentPeriods({ candidates: [], billing: SANS_FACTURATION, pointDates: devis, facts: [fait(1, 'period.validity', '2026-11-17/', 'Devis valable à compter du 17/11/2026')] });
    expect(sansBloc.desired).toEqual([]);
    expect(sansBloc.review).toEqual([]);
    expect(sansBloc.refused).toMatchObject([{ factId: 1, reason: 'DOCUMENT_DATE_RESTATED' }]);
    // Ce que le bloc 59 demande déjà à T1 pour ce cas : aucune borne, pertinence « unknown » → ligne « non renseignée », modifiable.
    const avecBloc = m.qualifyDocumentPeriods({ candidates: [], billing: SANS_FACTURATION, pointDates: devis, facts: [fait(2, 'period.relevance', 'validity=unknown', 'Devis valable à compter du 17/11/2026')] });
    expect(avecBloc.desired.map((d) => [d.kind, d.start, d.end, d.basis])).toEqual([['VALIDITY', null, null, 'T1_RELEVANT_UNKNOWN']]);
  });

  it('inchangé : garantie, couverture, effet contractuel le jour du document ; fin seule à mention propre « à réexaminer »', () => {
    for (const kind of ['WARRANTY', 'COVERAGE', 'CONTRACT', 'BILLING', 'SERVICE', 'REALIZATION'] as const) {
      expect(pd.classifyPointDatePeriod({ kind, bounds: { start: '2026-11-17', end: null }, excerpt: 'À compter du 17/11/2026', pointDates: COMMANDE })).toEqual({ verdict: 'JUSTIFIED' });
    }
    expect(verdict({ start: null, end: '2026-11-17' }, 'Offre valable jusqu’au 17/11/2026')).toMatchObject({ verdict: 'TO_REVIEW' });
    expect(pd.POINT_DATE_GUARDED_KINDS).toEqual(['VALIDITY']);
  });
});

describe('L116F-KO-U-SUSPECT — filtre d’entrée de la règle de lecture', () => {
  const p = (over: Partial<Parameters<typeof pd.isPointDateSuspect>[0]> = {}) => pd.isPointDateSuspect({ kind: 'VALIDITY', start: '2026-11-17', end: null, userLocked: false, origin: 'T1', ...over });

  it('suspecte : validité non corrigée, réduite à un seul jour (début seul, fin seule, début = fin)', () => {
    expect(p()).toBe(true);
    expect(p({ start: null, end: '2026-11-17' })).toBe(true);
    expect(p({ end: '2026-11-17' })).toBe(true);
  });

  it('jamais suspecte : correction de l’utilisateur, autre nature, deux bornes, durée indéterminée, mois, année, non datée', () => {
    expect(p({ userLocked: true, origin: 'USER' })).toBe(false);
    expect(p({ origin: 'USER' })).toBe(false);
    expect(p({ kind: 'WARRANTY' })).toBe(false);
    expect(p({ kind: 'COVERAGE' })).toBe(false);
    expect(p({ end: '2026-12-17' })).toBe(false);
    expect(p({ openEnded: true })).toBe(false);
    expect(p({ start: '2026-11' })).toBe(false);
    expect(p({ start: '2026', end: '2026' })).toBe(false);
    expect(p({ start: null })).toBe(false);
  });
});

describe('L116F-KO-U-REPORT — état du stock : une ligne dont le fait T1 a disparu', () => {
  const ligne = (id: number, over: Partial<Stocke> = {}): Stocke => ({
    id, kind: 'VALIDITY', segment: 0, start: '2026-11-17', end: null, principalHint: false, origin: 'T1', basis: 'T1_PERIOD_FACT',
    evidence: { quote: 'Votre commande du 17/11/2026 est validée !', page: null, factIds: [404] }, userLocked: false, ...over,
  });
  const vide = m.qualifyDocumentPeriods({ candidates: [], facts: [], billing: SANS_FACTURATION, pointDates: COMMANDE });

  it('classée directement, par la même règle, sur ses propres bornes et sa propre preuve', () => {
    const stock = [ligne(20)];
    const plan = m.planRefresh(stock, vide.desired, vide.review);
    expect(plan.supersede).toEqual([20]);
    // Sans les dates du document (appel d'avant la reprise) : retrait ordinaire, sans motif.
    expect(svc.pointDateReport(vide, stock, plan).copies).toEqual([]);
    expect(svc.pointDateReport(vide, stock, plan, { pointDates: COMMANDE, facts: [] }).copies).toEqual([
      { periodId: 20, kind: 'VALIDITY', start: '2026-11-17', end: null, date: '2026-11-17', roles: ['DOCUMENT_DATE', 'T1_DOCUMENT_DATE', 'OPERATION_DATE'], reason: 'DOCUMENT_DATE_RESTATED' },
    ]);
  });

  it('jamais : une correction de l’utilisateur, une ligne conservée par le plan, une validité à une autre date, une autre nature', () => {
    const corrigee = ligne(21, { origin: 'USER', basis: 'USER', userLocked: true, lockedBefore: null });
    const autreDate = ligne(22, { start: '2026-12-01', segment: 1 });
    const garantie = ligne(23, { kind: 'WARRANTY' });
    const stock = [corrigee, autreDate, garantie];
    const plan = m.planRefresh(stock, vide.desired, vide.review);
    expect(plan.supersede.sort()).toEqual([22, 23]);
    expect(svc.pointDateReport(vide, stock, plan, { pointDates: COMMANDE, facts: [] }).copies).toEqual([]);
    // Une ligne CONSERVÉE par le plan n'est jamais une copie (aucun aller-retour possible entre lecture et écriture).
    const legitime = fait(5, 'period.validity', '2026-11-17/2026-12-17', 'Valable du 17/11/2026 au 17/12/2026');
    const q = m.qualifyDocumentPeriods({ candidates: [], facts: [legitime], billing: SANS_FACTURATION, pointDates: COMMANDE });
    const garde = [ligne(24, { end: '2026-12-17', evidence: { quote: legitime.excerpt, page: null, factIds: [5] } })];
    const planGarde = m.planRefresh(garde, q.desired, q.review);
    expect(planGarde.keep).toEqual([24]);
    expect(svc.pointDateReport(q, garde, planGarde, { pointDates: COMMANDE, facts: [legitime] }).copies).toEqual([]);
  });
});

describe('L116F-KO-U-READ — la règle à la lecture', () => {
  it('aucune période suspecte : aucune requête, rien de retiré (coût nul pour tous les autres documents)', async () => {
    const { pgClient } = await import('@/db');
    requetes.length = 0;
    const lignes = [
      { id: 1, fileId: 10, kind: 'WARRANTY' as const, start: '2026-11-17', end: '2028-11-17', userLocked: false, origin: 'T1' },
      { id: 2, fileId: 10, kind: 'VALIDITY' as const, start: '2026-11-03', end: '2026-12-03', userLocked: false, origin: 'T1' },
      { id: 3, fileId: 11, kind: 'VALIDITY' as const, start: '2026-11-17', end: null, userLocked: true, origin: 'USER' },
      { id: 4, fileId: 12, kind: 'COVERAGE' as const, start: '2026-11-17', end: null, userLocked: false, origin: 'T1' },
    ];
    expect([...(await svc.pointDateCopyIds(pgClient as never, 7, lignes))]).toEqual([]);
    expect(await svc.withoutPointDateCopies(pgClient as never, 7, lignes)).toEqual(lignes);
    expect(requetes).toEqual([]);
  });

  it('période suspecte : seulement des lectures (SELECT), jamais une écriture ni une transaction', async () => {
    const { pgClient } = await import('@/db');
    requetes.length = 0;
    await svc.pointDateCopyIds(pgClient as never, 7, [{ id: 1, fileId: 10, kind: 'VALIDITY', start: '2026-11-17', end: null, userLocked: false, origin: 'T1' }]);
    expect(requetes.length).toBeGreaterThan(0);
    for (const q of requetes) {
      expect(q.trim()).toMatch(/^SELECT\b/);
      expect(q).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    }
  });

  it('chaque lecteur des périodes passe par la règle : fiche, listes, surfaces (dépense, Assistant, dossiers), contexte T3, titrage', () => {
    const service = lire('src/services/documents/business-periods/service.ts');
    const lecture = (nom: string) => service.slice(service.indexOf(`export async function ${nom}(`)).split('\nexport ')[0];
    expect(lecture('readDocumentPeriods')).toMatch(/withoutPointDateCopies\(sql, accountId, stored\)/);
    expect(lecture('readPrincipalPeriodLines')).toMatch(/withoutPointDateCopies\(sql, accountId, r\.map\(toStored\)\)/);
    expect(lire('src/services/documents/business-period-surfaces.ts')).toMatch(/pointDateCopyIds\(sql, accountId/);
    const t3 = lire('src/services/business-operations/tco/semantic-qualification/context.ts');
    expect(t3).toMatch(/pointDateCopyIds\(sql, accountId/);
    expect(t3).toMatch(/pointDateRefusedFacts\(sql, accountId, f\)/);
    expect(lire('src/services/documents/document-title.service.ts')).toMatch(/withoutPointDateFactPeriods\(sql, fileId, accountId, lus\)/);
    // Une seule fonction de règle, partagée par l'écriture, l'inspection et la lecture.
    expect(service.match(/await pointDateState\(/g)).toHaveLength(3);
    expect(service.match(/classifyPointDatePeriod\(/g)).toHaveLength(1);
    // La lecture n'appelle aucun modèle et n'ouvre aucune transaction.
    const garde = service.slice(service.indexOf('export async function pointDateCopyIds('), service.indexOf('export async function pointDateRefusedFacts('));
    expect(garde).not.toMatch(/\.begin\(|INSERT|UPDATE|provider|completion/);
  });

  it('aucun cache de cette lecture : la route est « no-cache », le composant lit sans cache client, le service worker ne garde pas les API', () => {
    expect(lire('src/app/api/documents/[id]/periodes/route.ts')).toMatch(/'Cache-Control': 'private, no-cache'/);
    const composant = lire('src/components/documents/BusinessPeriods.tsx');
    expect(composant).toMatch(/apiClient\.get<\{ periods: DocumentPeriodsView \}>\(`\/api\/documents\/\$\{documentId\}\/periodes`\)/);
    expect(composant).not.toMatch(/useCache/);
    const sw = lire('public/sw.js');
    expect(sw).toMatch(/const isApiRoute = url\.pathname\.startsWith\('\/api\/'\);/);
    expect(sw).toMatch(/if \(isHtml \|\| isNextChunk \|\| isApiRoute\) \{\s*\/\/ Network-only/);
  });
});

describe('L116F-KO-U-OPS — reprise de l’exploitant, migration, contrôle de cohérence, guide', () => {
  it('script : compte ou tous les comptes, document facultatif, à blanc par défaut, même service que le contrôle de cohérence', () => {
    const script = lire('scripts/reprise-812-validites-artificielles.ts');
    expect(script).toMatch(/arg\('account'\)/);
    expect(script).toMatch(/process\.argv\.includes\('--all'\)/);
    expect(script).toMatch(/arg\('file'\)/);
    expect(script).toMatch(/const apply = process\.argv\.includes\('--apply'\);/);
    expect(script).toMatch(/process\.exitCode = 2/);
    expect(script.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    const reprise = lire('src/services/documents/business-periods/point-date-reprise.ts');
    const code = reprise.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toMatch(/previewDocumentBusinessPeriods\(accountId, fileId, sql\)/);
    expect(code).toMatch(/refreshDocumentBusinessPeriods\(accountId, fileId, \{ correlationId \}\)/);
    // Aucune règle ni écriture propre : ni classification, ni UPDATE / DELETE dans ce module.
    expect(code).not.toMatch(/classifyPointDatePeriod|\b(INSERT|UPDATE|DELETE)\b/);
    expect(code).toMatch(/const apply = opts\.apply === true;/);
    expect(code).toMatch(/NOT p\.user_locked AND p\.origin <> 'USER'/);
    const controle = lire('src/services/coherence/registry/checks/document-business-periods.ts');
    expect(controle).toMatch(/refreshDocumentBusinessPeriods\(accountId, id, \{ correlationId: ctx\.correlationId \}\)/);
  });

  it('migration 1871 : additive, idempotente, aucune ligne modifiée ; le code tolère son absence', () => {
    const sql = lire('src/db/migrations/1871_l116f_periodes_detail_retrait.sql');
    const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS superseded_detail TEXT/);
    expect(code).not.toMatch(/\b(DROP|DELETE|UPDATE|TRUNCATE|INSERT)\b/);
    expect(code.split('\n').filter((l) => l.includes('ADD COLUMN')).join('\n')).not.toMatch(/NOT NULL|DEFAULT/);
    const service = lire('src/services/documents/business-periods/service.ts');
    const trace = service.slice(service.indexOf('SET superseded_detail = x.reason'));
    expect(trace.slice(0, 600)).toMatch(/code !== '42703'\) throw e/);
  });

  it('contrôle de cohérence : version 2 inchangée (aucune requalification à blanc de plus), anomalies inchangées', async () => {
    const { documentBusinessPeriodsCheck: c } = await import('@/services/coherence/registry/checks/document-business-periods');
    expect(c.version).toBe(2);
    expect(c.anomalies).toEqual(['BUSINESS_PERIODS_MISSING', 'BUSINESS_PERIODS_STALE', 'BUSINESS_PERIODS_POINT_DATE_COPY', 'BUSINESS_PERIODS_POINT_DATE_TO_REVIEW']);
  });

  it('aucun texte de prompt modifié dans le code ; le bloc 59 reste facultatif et son texte à coller est inchangé', () => {
    const guide = lire('docs/exploitation/prompts-a-appliquer-par-le-po.md');
    const section = guide.slice(guide.indexOf('## 19. Étape 59'), guide.indexOf('## 20. Étape 60'));
    expect(section).toMatch(/FACULTATIVE/);
    expect(section).toMatch(/mets validity=unknown dans period\.relevance/);
    expect(section).toMatch(/Complément du 21\/11\/2026/);
    // Un seul bloc de texte à coller dans cette étape (le complément n'ajoute aucun texte de prompt).
    expect(section.match(/```text/g)).toHaveLength(1);
    const regle = lire('src/services/documents/business-periods/point-date.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(regle).not.toMatch(/decathlon|polisport|fournisseur|supplier|provider/i);
    expect(regle).not.toMatch(/valable|commande|devis|facture|offre/i);
  });
});
