/**
 * Lot 87D — ticket P1 « Documents — Uniformiser les titres des factures
 * périodiques et fiabiliser leur affichage dans toute l'application ».
 * Règles PURES (convention, données de facturation, diagnostic du contrôle).
 * Chaîne complète sur PostgreSQL 16 : `src/test/e2e/scenarios/l87d-titres-documents.e2e.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalTitleKey, composePeriodicTitle, disambiguatorFor, formatTitleMonth, hasLegacyTitleTypography,
  presentBilledPeriod, presentSupplier, principalMonthFromAnalysis, TITLE_SEPARATOR,
} from '@/lib/documents/document-title-convention';
import { documentTitleJsonSql, documentTitleOf, withDocumentTitles } from '@/lib/documents/document-title-source';
import { planBusinessTitle, type BillingBasis } from '@/services/ai/source-analysis/document-title';
import { billingBasisFrom, titleLosesInformation } from '../document-title.service';
import { diagnoseDocumentTitle, type DocumentTitleState } from '@/services/coherence/registry/checks/document-titles';
import { COHERENCE_REGISTRY } from '@/services/coherence/registry';

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const T1_CERTAIN = (mois: string, basis = 'MAJORITY_OF_PERIOD') => ({
  document: { billingPeriod: { start: '2026-02-05', end: '2026-03-04', principalMonth: mois, principalMonthBasis: basis, confidence: 'certain', evidence: { quote: 'Abonnement février 2026', page: 1 } } },
});
const billing = (p: Partial<BillingBasis> = {}): BillingBasis => ({ billedPeriod: null, principalMonth: null, invoiceReferences: [], issueDate: null, ...p });
const homiris = (b: Partial<BillingBasis>, extra: Record<string, unknown> = {}) =>
  planBusinessTitle('Facture Homiris Alarme n° 94741358', { typeCode: 'FACTURE', supplier: 'HOMIRIS', documentDate: '2026-02-06', billing: billing(b), selfId: 1, ...extra });

describe('L87D-U-01 — période facturée présentée EXACTEMENT (règle de présentation, jamais d’interprétation)', () => {
  it('un seul mois civil → « Février 2026 »', () => {
    expect(presentBilledPeriod('2026-02-01', '2026-02-28')).toEqual({ label: 'Février 2026', kind: 'MONTH' });
    expect(presentBilledPeriod('2026-02-05', '2026-02-20')?.label).toBe('Février 2026');
  });
  it('mois civils complets → plage de mois ; pluriannuelle et chevauchement d’année exacts', () => {
    expect(presentBilledPeriod('2026-02-01', '2026-03-31')?.label).toBe('Février à mars 2026');
    expect(presentBilledPeriod('2025-09-01', '2026-08-31')?.label).toBe('Septembre 2025 à août 2026');
    expect(presentBilledPeriod('2024-01-01', '2026-12-31')?.label).toBe('Janvier 2024 à décembre 2026');
  });
  it('période « du 5 au 4 » : AUCUN mois choisi par le code (ni le premier, ni les deux) — période au jour', () => {
    expect(presentBilledPeriod('2026-02-05', '2026-03-04')).toEqual({ label: '5 février au 4 mars 2026', kind: 'EXACT_RANGE' });
    expect(presentBilledPeriod('2025-12-15', '2026-01-14')?.label).toBe('15 décembre 2025 au 14 janvier 2026');
    expect(presentBilledPeriod('2026-03-01', '2026-04-15')?.label).toBe('1er mars au 15 avril 2026');
  });
  it('borne absente, illisible ou inversée → aucune période (jamais inventée)', () => {
    expect(presentBilledPeriod(null, '2026-03-04')).toBeNull();
    expect(presentBilledPeriod('2026-02-30', '2026-03-04')).toBeNull();
    expect(presentBilledPeriod('2026-03-04', '2026-02-05')).toBeNull();
  });
});

describe('L87D-U-02 — mois principal : décision IA seulement (point d’extension, demande 87D-mois-principal-factures)', () => {
  it('lu dans la sortie T1 quand il est « certain », avec sa provenance', () => {
    expect(principalMonthFromAnalysis(T1_CERTAIN('2026-02'))).toEqual({ value: '2026-02', basis: 'MAJORITY_OF_PERIOD', source: 'T1_BILLING_PERIOD', quote: 'Abonnement février 2026' });
  });
  it('absent, moins sûr, conflictuel ou illisible → null (aucun mois déduit)', () => {
    expect(principalMonthFromAnalysis({ document: {} })).toBeNull();
    expect(principalMonthFromAnalysis(null)).toBeNull();
    const probable = T1_CERTAIN('2026-02'); probable.document.billingPeriod.confidence = 'probable';
    expect(principalMonthFromAnalysis(probable)).toBeNull();
    expect(principalMonthFromAnalysis(T1_CERTAIN('2026-13'))).toBeNull();
  });
  it('aucune règle « du 5 au 4 », aucun calcul de majorité dans le code', () => {
    const code = src('src/lib/documents/document-title-convention.ts') + src('src/services/documents/document-title.service.ts') + src('src/services/ai/source-analysis/document-title.ts');
    expect(code).not.toMatch(/getUTCDate\(\)\s*[<>]=?\s*\d|majorit[ée]\s*=|joursParMois|daysIn(Month)?\(/i);
  });
});

describe('L87D-U-03 — convention « Facture {Fournisseur} — {Mois AAAA} »', () => {
  it('CA1 : facture majoritairement de février, mois principal IA = février → « Facture Homiris — Février 2026 »', () => {
    const p = homiris({ billedPeriod: { start: '2026-02-05', end: '2026-03-04', source: 'T1_INSTALLMENT' }, principalMonth: principalMonthFromAnalysis(T1_CERTAIN('2026-02')), invoiceReferences: ['94741358'] });
    expect(p.title).toBe('Facture Homiris — Février 2026');
    expect(p.convention).toBe('PERIODIC');
    expect(p.canonicalKey).toBe(canonicalTitleKey('Facture', 'Homiris', 'Février 2026'));
    expect(p.title).not.toContain('94741358'); // le numéro reste dans les métadonnées (recherche), pas dans le titre principal
  });
  it('sans mois principal : période exacte, jamais trompeuse (« Facture Homiris — 5 février au 4 mars 2026 »)', () => {
    expect(homiris({ billedPeriod: { start: '2026-02-05', end: '2026-03-04', source: 'T1_INSTALLMENT' } }).title).toBe('Facture Homiris — 5 février au 4 mars 2026');
  });
  it('chevauchement d’année et période pluriannuelle', () => {
    expect(homiris({ billedPeriod: { start: '2025-12-15', end: '2026-01-14', source: 'T1_INSTALLMENT' } }).title).toBe('Facture Homiris — 15 décembre 2025 au 14 janvier 2026');
    expect(homiris({ billedPeriod: { start: '2025-09-01', end: '2026-08-31', source: 'T1_INSTALLMENT' } }).title).toBe('Facture Homiris — Septembre 2025 à août 2026');
  });
  it('données absentes (ni période, ni mois principal, ni fournisseur) : pas de convention, aucun mois inventé', () => {
    const sans = homiris({});
    expect(sans.convention).toBeNull();
    expect(sans.title).not.toMatch(/Février 2026/);
    const sansFournisseur = planBusinessTitle('Facture', { typeCode: 'FACTURE', supplier: null, billing: billing({ billedPeriod: { start: '2026-02-01', end: '2026-02-28', source: 'T1_INSTALLMENT' } }) });
    expect(sansFournisseur.convention).toBeNull();
  });
  it('typographie unique : séparateur « — », fournisseur en casse de nom propre, sigles conservés', () => {
    expect(TITLE_SEPARATOR).toBe(' — ');
    expect(presentSupplier('HOMIRIS')).toBe('Homiris');
    expect(presentSupplier('EDF')).toBe('EDF');
    expect(presentSupplier('Orange')).toBe('Orange');
    expect(composePeriodicTitle({ nature: 'Facture', supplier: 'HOMIRIS', period: 'Février 2026' })).toBe('Facture Homiris — Février 2026');
    expect(formatTitleMonth('2026-02')).toBe('Février 2026');
    expect(hasLegacyTitleTypography('Facture Homiris _ Février à mars 2026')).toBe(true);
    expect(hasLegacyTitleTypography('Facture Homiris — Février 2026')).toBe(false);
  });
  it('stable et reproductible : mêmes données → même titre, même empreinte', () => {
    const b = { billedPeriod: { start: '2026-02-01', end: '2026-02-28', source: 'T1_INSTALLMENT' as const } };
    expect(homiris(b).title).toBe(homiris(b).title);
    expect(homiris(b).title).toBe('Facture Homiris — Février 2026');
  });
});

describe('L87D-U-04 — deux factures distinctes du même mois : désambiguïsation DÉTERMINISTE et symétrique', () => {
  const A = { id: 1, invoiceReferences: ['94741358'], issueDate: '2026-02-06' };
  const B = { id: 2, invoiceReferences: ['94741361'], issueDate: '2026-02-20' };
  it('numéro de facture unique dans le groupe ; seul → aucun discriminant', () => {
    expect(disambiguatorFor(A, [B])).toBe('n° 94741358');
    expect(disambiguatorFor(B, [A])).toBe('n° 94741361');
    expect(disambiguatorFor(A, [])).toBeNull();
  });
  it('sans numéro : la date d’émission ; ni l’un ni l’autre : aucun discriminant (jamais « (2) », jamais de fusion)', () => {
    const C = { id: 3, invoiceReferences: [], issueDate: '2026-02-06' };
    const D = { id: 4, invoiceReferences: [], issueDate: '2026-02-21' };
    expect(disambiguatorFor(C, [D])).toBe('émise le 6 février 2026');
    expect(disambiguatorFor({ id: 5, invoiceReferences: [], issueDate: null }, [{ id: 6, invoiceReferences: [], issueDate: null }])).toBeNull();
  });
  it('indépendant de l’ordre de traitement', () => {
    const p1 = homiris({ billedPeriod: { start: '2026-02-01', end: '2026-02-28', source: 'T1_INSTALLMENT' }, invoiceReferences: ['94741358'] }, { selfId: 1, periodicSiblings: [B] });
    const p2 = homiris({ billedPeriod: { start: '2026-02-01', end: '2026-02-28', source: 'T1_INSTALLMENT' }, invoiceReferences: ['94741358'] }, { selfId: 1, periodicSiblings: [B, { id: 9, invoiceReferences: ['X1'], issueDate: null }].reverse().slice(1) });
    expect(p1.title).toBe('Facture Homiris — Février 2026 (n° 94741358)');
    expect(p2.title).toBe(p1.title);
  });
});

describe('L87D-U-05 — données de facturation persistées (connaissance T1), rien de déduit', () => {
  const cand = (p: Record<string, unknown>) => ({ businessReferences: [], financialHints: [], ...p });
  it('période d’ÉCHÉANCE unique, références de facture (recherchables), date d’émission', () => {
    const b = billingBasisFrom({
      candidatePayloads: [cand({
        businessReferences: [{ kind: 'INVOICE', value: '94741358' }, { kind: 'CONTRACT', value: 'C-1' }],
        financialHints: [{ amountScope: 'INSTALLMENT', periodStart: '2026-02-05', periodEnd: '2026-03-04' }],
      })],
      factPeriods: [], analysisResult: null, issueDate: '2026-02-06',
    });
    expect(b).toEqual({ billedPeriod: { start: '2026-02-05', end: '2026-03-04', source: 'T1_INSTALLMENT' }, principalMonth: null, invoiceReferences: ['94741358'], issueDate: '2026-02-06' });
  });
  it('période AMBIGUË (deux échéances différentes) → aucune période retenue (jamais tranchée par le code)', () => {
    const b = billingBasisFrom({
      candidatePayloads: [cand({ financialHints: [
        { amountScope: 'INSTALLMENT', periodStart: '2026-02-05', periodEnd: '2026-03-04' },
        { amountScope: 'INSTALLMENT', periodStart: '2026-03-05', periodEnd: '2026-04-04' },
      ] })],
      factPeriods: [{ s: '2026-02-05', e: '2026-03-04' }], analysisResult: null, issueDate: null,
    });
    expect(b.billedPeriod).toBeNull();
  });
  it('mois principal repris de la sortie T1 (certain seulement)', () => {
    expect(billingBasisFrom({ candidatePayloads: [], factPeriods: [], analysisResult: T1_CERTAIN('2026-02'), issueDate: null }).principalMonth?.value).toBe('2026-02');
  });
});

describe('L87D-U-06 — ancienne typographie : normalisée sans perte d’information', () => {
  it('un candidat qui perdrait le fournisseur ou la cible n’est jamais retenu', () => {
    const plan = planBusinessTitle('Facture fibre', { typeCode: 'FACTURE', supplier: 'Orange', subjects: ['fibre'], documentDate: '2026-09-05' });
    expect(titleLosesInformation('Facture fibre Orange _ Septembre 2026', 'Facture fibre — 5 septembre 2026', plan)).toBe(true);
    expect(titleLosesInformation('Facture fibre Orange _ Septembre 2026', plan.title!, plan)).toBe(false);
  });
});

describe('L87D-U-07 — même titre partout : une seule règle d’affichage, lue en SQL ou par l’ORM', () => {
  it('documentTitleOf : titre métier → titre du lien web → nom original exploitable → nom technique', () => {
    expect(documentTitleOf({ titleRetained: 'Facture Homiris — Février 2026', titleOriginal: 'scan.pdf' })).toBe('Facture Homiris — Février 2026');
    expect(documentTitleOf({ titleRetained: '5be5a3ca-38cf-47fc-942c-3386ea8e846b.pdf', titleWebLink: 'Notice chaudière', titleOriginal: 'x.pdf' })).toBe('Notice chaudière');
  });
  it('exports utilisateur (v12) : même titre que la liste ; seul le repli sur nom de fichier perd son extension', async () => {
    const { documentTitle } = await import('@/services/exports/v12/data/documents');
    expect(documentTitle({ id: 1, retainedTitle: 'Facture Homiris — Février 2026', originalFilename: 'scan.pdf' })).toBe('Facture Homiris — Février 2026');
    expect(documentTitle({ id: 2, retainedTitle: '5be5a3ca-38cf-47fc-942c-3386ea8e846b.pdf', webLinkTitle: 'Notice chaudière', originalFilename: null })).toBe('Notice chaudière');
    expect(documentTitle({ id: 3, retainedTitle: null, originalFilename: 'Bail signé.pdf' })).toBe('Bail signé');
  });
  it('objet JSONB (comparable : DISTINCT / GROUP BY) remplacé par le titre affiché', async () => {
    expect(documentTitleJsonSql('f')).toMatch(/^jsonb_build_object\(/);
    const rows = [{ id: 1, titre: { titleRetained: 'Facture Homiris — Février 2026', titleWebLink: null, titleOriginal: 'a.pdf', titleFilename: null, titleS3Key: null, titlePublicId: null } }];
    expect((await withDocumentTitles(Promise.resolve(rows)))[0].titre).toBe('Facture Homiris — Février 2026');
    expect(() => documentTitleJsonSql('f; DROP')).toThrow();
  });
  it('plus aucune reconstruction locale « coalesce(retained_title, original_filename) » dans les vues utilisateur (exceptions motivées : BO, contexte IA, filtres SQL)', () => {
    const vues = [
      'src/services/search/global-search.service.ts', 'src/services/to-process/operation-cards.ts', 'src/services/to-process/agenda-projection-cards.ts',
      'src/services/home/mascot/t6-interpellation.service.ts', 'src/services/business-operations/read-service.ts', 'src/services/business-operations/tco/service.ts',
      'src/services/suppliers/supplier-detail.service.ts', 'src/services/ai/source-analysis/lot-notification.ts', 'src/services/verebona-assistant/canonical/agenda.ts',
      'src/services/verebona-assistant/canonical/business-sources.ts', 'src/services/ai/knowledge/document-knowledge.service.ts', 'src/services/agenda/AgendaQueryService.ts',
    ];
    for (const v of vues) expect(src(v), v).not.toMatch(/coalesce\((nullif\()?\s*\w*\.?retained_title,\s*(''\),\s*)?\w*\.?original_filename/i);
  });
});

describe('L87D-U-COH — contrôle COH-DOC-TITLES : diagnostic pur', () => {
  const attendu = { title: 'Facture Homiris — Février 2026', convention: 'PERIODIC', key: 'k', fingerprint: 'fp', record: { v: 1, invoiceReferences: ['94741358'] }, principalMonth: '2026-02', invoiceReferences: ['94741358'], typographyReplaceable: true };
  const etat = (p: Partial<DocumentTitleState> = {}): DocumentTitleState => ({
    fileId: 1, title: 'Facture Homiris — Février 2026', titleSource: 'SYSTEM', titleValid: true, ruleVersion: 3, contextFingerprint: 'fp',
    persisted: { basis: { v: 1, invoiceReferences: ['94741358'] }, convention: 'PERIODIC', key: 'k' }, expected: attendu,
    harmonized: false, searchLabel: 'Facture Homiris — Février 2026', sheetLabel: 'Facture Homiris — Février 2026', ...p,
  });
  it('conforme → CONSISTENT (idempotence : un second passage ne répare rien)', () => {
    expect(diagnoseDocumentTitle(etat())).toEqual({ verdict: 'CONSISTENT' });
  });
  it('titre automatique non conforme (stock Homiris) → AUTO_TITLE_NOT_CANONICAL ou TITLE_MONTH_MISMATCH', () => {
    expect(diagnoseDocumentTitle(etat({ title: 'Facture Homiris Alarme n° 94741358 – Mars à avril 2026' }))).toEqual({ verdict: 'REPAIRABLE', anomaly: 'TITLE_MONTH_MISMATCH' });
    expect(diagnoseDocumentTitle(etat({ title: 'Facture Homiris _ Février 2026' }))).toEqual({ verdict: 'REPAIRABLE', anomaly: 'AUTO_TITLE_NOT_CANONICAL' });
  });
  it('titre SYSTÈME technique (« <uuid>.pdf ») alors qu’un titre métier est constructible → AUTO_TITLE_TECHNICAL (rôle de l’ancien balayage horaire)', () => {
    const tech = '5be5a3ca-38cf-47fc-942c-3386ea8e846b.pdf';
    expect(diagnoseDocumentTitle(etat({ title: tech, titleValid: false, expected: { ...attendu, convention: null, key: null, title: 'Certificat d’immatriculation Cupra' } })))
      .toEqual({ verdict: 'REPAIRABLE', anomaly: 'AUTO_TITLE_TECHNICAL' });
    // Aucune donnée pour un meilleur titre : rien à réparer ici (jamais de titre inventé).
    expect(diagnoseDocumentTitle(etat({ title: tech, titleValid: false, expected: null }))).toEqual({ verdict: 'CONSISTENT' });
  });
  it('titre USER : jamais réparé ; seules ses métadonnées le sont', () => {
    expect(diagnoseDocumentTitle(etat({ titleSource: 'USER', title: 'Mon alarme de février' }))).toEqual({ verdict: 'CONSISTENT' });
    expect(diagnoseDocumentTitle(etat({ titleSource: 'USER', title: 'Mon alarme', persisted: { basis: null, convention: null, key: null } })))
      .toEqual({ verdict: 'REPAIRABLE', anomaly: 'SEARCH_REFERENCE_NOT_INDEXED' });
  });
  it('numéro de facture non indexé → SEARCH_REFERENCE_NOT_INDEXED ; métadonnées périmées → TITLE_METADATA_NOT_PROPAGATED', () => {
    expect(diagnoseDocumentTitle(etat({ persisted: { basis: { v: 1, invoiceReferences: [] }, convention: 'PERIODIC', key: 'k' } }))).toMatchObject({ anomaly: 'SEARCH_REFERENCE_NOT_INDEXED' });
    expect(diagnoseDocumentTitle(etat({ persisted: { basis: { v: 1, invoiceReferences: ['94741358'] }, convention: null, key: 'k' } }))).toMatchObject({ anomaly: 'TITLE_METADATA_NOT_PROPAGATED' });
  });
  it('libellé de recherche ≠ fiche → FINDING (défaut de code, jamais « réparé » par une écriture)', () => {
    expect(diagnoseDocumentTitle(etat({ searchLabel: 'autre' }))).toEqual({ verdict: 'FINDING', anomaly: 'SEARCH_LABEL_DIVERGENT' });
  });
  it('registre : ajouté EN FIN (position relative après le contrôle 86F), réparation par le service de nommage seulement', () => {
    const ids = COHERENCE_REGISTRY.map((c) => c.id);
    expect(ids.indexOf('COH-DOC-TITLES')).toBeGreaterThan(ids.indexOf('COH-TCO-ECONOMIC-DATES'));
    const c = COHERENCE_REGISTRY.find((x) => x.id === 'COH-DOC-TITLES')!;
    expect(c.services).toEqual(['documents/document-title.service#ensureBusinessTitle']);
    expect(c.forbiddenRepairs.join(' ')).toMatch(/réécrire un titre utilisateur/);
  });
  it('lot 97A : le contrat T1 de sortie porte le bloc facultatif `billingPeriod` (v7), aucun prompt modifié', () => {
    expect(src('src/services/ai/source-analysis/master/t1-contract.ts')).toMatch(/billingPeriod: t1BillingPeriod\.optional\(\)/);
    expect(src('src/services/ai/prompts/source-analysis/t1_master_v1.txt')).not.toMatch(/billingPeriod|t1-billing-period-v1/);
  });
});
