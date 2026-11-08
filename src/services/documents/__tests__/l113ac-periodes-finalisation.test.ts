/**
 * Lot 113AC (Trello #725) — finalisation des périodes métier : fusion D11 → surfaces (T2, dossiers,
 * fiche), listes et recherche, requalification T1 du stock (BO). Tests SANS base (fonctions pures,
 * gardes statiques). Les preuves sur PostgreSQL réel : `l113ac-periodes-finalisation.e2e.ts`.
 *
 *   L113AC-U-01  T2 : couvertures établies inchangées ; CONFLICT « périodes différentes selon les
 *                justificatifs » sans choix ; REPLACED cité comme historique avec la note ; sources réunies
 *   L113AC-U-02  extrait documentaire T2 : marque d'une couverture remplacée / en conflit
 *   L113AC-U-03  `publicCoverage` : `basis` jamais exposé, le reste conservé
 *   L113AC-U-04  suggestions de recherche : période principale d'un document seulement
 *   L113AC-U-05  requalification : disponibilité, classement, estimation, rapport BO
 *   L113AC-U-06  gardes statiques : listes (desktop + mobile), BO (bouton désactivé), aucun « Opération »
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  coverageFactsText, documentPeriodsText, T2_CONFLICT_PREFIX, T2_CONFLICT_UNSETTLED, T2_COVERAGE_PREFIX, T2_HISTORY_PREFIX, T2_NO_EXTENSION,
} from '@/lib/documents/business-period-surfaces';
import { publicCoverage, type CoverageEntry } from '@/services/documents/business-periods/service';
import { toLiveResults } from '@/lib/verebona/live-search';
import {
  availabilityFrom, censusBucket, estimateCost, REQUALIFICATION_BATCH_SIZE, REQUALIFICATION_ORIGIN,
} from '@/services/documents/business-periods/requalification';
import { backfillDefinition, validateBackfillRequest } from '@/services/admin/ops/backfill/definitions';
import { summarizeBackfill } from '@/services/admin/ops/backfill/report-format';

const ROOT = process.cwd();
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const l = (line: string, documentTitle: string, extra: Record<string, unknown> = {}) => ({ line, documentTitle, ...extra });

describe('L113AC-U-01 — T2 : faits de couverture résolus (D11)', () => {
  it('établies seules : texte 113AB à l’identique', () => {
    expect(coverageFactsText([l('Période couverte : du 01/04/2024 au 31/03/2025', 'Attestation 2024')]))
      .toBe(`${T2_COVERAGE_PREFIX} : du 01/04/2024 au 31/03/2025 (justificatif : Attestation 2024) — ${T2_NO_EXTENSION}`);
  });

  it('CONFLICT : « périodes différentes selon les justificatifs », aucune n’est présentée comme établie', () => {
    const t = coverageFactsText([
      l('Période couverte : du 01/04/2025 au 31/03/2026', 'Attestation A', { resolution: { status: 'CONFLICT', note: 'Les justificatifs indiquent des périodes différentes.' } }),
      l('Période couverte : du 01/07/2025 au 30/06/2026', 'Attestation B', { resolution: { status: 'CONFLICT', note: 'Les justificatifs indiquent des périodes différentes.' } }),
    ])!;
    expect(t).toBe(`${T2_CONFLICT_PREFIX} : du 01/04/2025 au 31/03/2026 (justificatif : Attestation A) ; du 01/07/2025 au 30/06/2026 (justificatif : Attestation B) — ${T2_CONFLICT_UNSETTLED} — ${T2_NO_EXTENSION}`);
    expect(t).not.toContain(T2_COVERAGE_PREFIX);
  });

  it('REPLACED : période retenue = document remplaçant ; l’ancienne citée comme historique, avec la raison', () => {
    const t = coverageFactsText([
      l('Période couverte : du 01/04/2024 au 31/03/2025', 'Attestation 2024', { resolution: { status: 'REPLACED', note: 'Actualisée par l’avenant « Avenant 2024 »' } }),
      l('Période couverte : du 01/06/2024 au 31/03/2025', 'Avenant 2024'),
    ])!;
    expect(t.startsWith(`${T2_COVERAGE_PREFIX} : du 01/06/2024 au 31/03/2025 (justificatif : Avenant 2024)`)).toBe(true);
    expect(t).toContain(`${T2_HISTORY_PREFIX} : du 01/04/2024 au 31/03/2025 (justificatif : Attestation 2024) — Actualisée par l’avenant « Avenant 2024 »`);
  });

  it('même fait sur plusieurs justificatifs : sources réunies, correction signalée', () => {
    expect(coverageFactsText([l('Période couverte : du 01/04/2025 au 31/03/2026', 'Attestation', { userCorrected: true, otherSources: [{ documentTitle: 'Attestation (copie)' }] })]))
      .toBe(`${T2_COVERAGE_PREFIX} : du 01/04/2025 au 31/03/2026 (justificatifs : Attestation ; Attestation (copie)), corrigée par l’utilisateur — ${T2_NO_EXTENSION}`);
  });
});

describe('L113AC-U-02 — extrait documentaire T2', () => {
  it('couverture en conflit ou remplacée : jamais dite sans réserve ; sinon inchangé', () => {
    expect(documentPeriodsText({ principal: { line: 'Période couverte : du 01/04/2025 au 31/03/2026', segments: [{ line: 'x', resolution: { status: 'CONFLICT', note: 'n' } }] }, secondary: [] }))
      .toBe('Période couverte : du 01/04/2025 au 31/03/2026 (périodes différentes selon les justificatifs)');
    expect(documentPeriodsText({ principal: { line: 'Période couverte : du 01/04/2024 au 31/03/2025', segments: [{ line: 'x', resolution: { status: 'REPLACED', note: 'Actualisée par l’avenant « A »' } }] }, secondary: [] }))
      .toBe('Période couverte : du 01/04/2024 au 31/03/2025 (période remplacée : Actualisée par l’avenant « A »)');
    expect(documentPeriodsText({ principal: { line: 'Période facturée : du 01/03/2025 au 31/03/2025', segments: [{ line: 'x', userCorrected: true }] }, secondary: [] }))
      .toBe('Période facturée : du 01/03/2025 au 31/03/2025 (corrigée par l’utilisateur)');
  });
});

describe('L113AC-U-03 — `publicCoverage`', () => {
  it('retire `basis` (interne) et conserve statut, note, document remplaçant, question, sources', () => {
    const c: CoverageEntry = {
      id: 1, kind: 'COVERAGE', segment: 0, start: '2024-04-01', end: '2025-03-31', line: 'L', userCorrected: false, fileId: 3, documentTitle: 'T',
      resolution: { status: 'REPLACED', basis: 'AMENDMENT', byFileId: 4, note: 'N' }, otherSources: [{ fileId: 5, documentTitle: 'U' }],
    };
    const p = publicCoverage(c);
    expect(p.resolution).toEqual({ status: 'REPLACED', byFileId: 4, note: 'N' });
    expect(p.otherSources).toEqual([{ fileId: 5, documentTitle: 'U' }]);
    expect(JSON.stringify(p)).not.toContain('AMENDMENT');
    const sans: CoverageEntry = { ...c, resolution: undefined };
    expect(publicCoverage(sans)).toBe(sans);
  });
});

describe('L113AC-U-04 — suggestions de recherche', () => {
  it('document : sous-titre puis période principale ; autre nature : période ignorée', () => {
    const r = toLiveResults('attest', [
      { id: 'doc-1', category: 'Document', label: 'Attestation 2025', sublabel: 'Attestation d’assurance', periodLine: 'Période couverte : du 01/04/2025 au 31/03/2026', href: '/documents?tiroir=document:1' },
      { id: 'doc-2', category: 'Document', label: 'Attestation sans période', href: '/documents?tiroir=document:2' },
      { id: 'asset-3', category: 'Bien', label: 'Attestation (bien)', periodLine: 'ne doit pas apparaître', href: '/assets/3' },
    ]);
    expect(r.find((x) => x.id === 'doc-1')!.sub).toBe('Attestation d’assurance · Période couverte : du 01/04/2025 au 31/03/2026');
    expect(r.find((x) => x.id === 'doc-2')!.sub).toBeNull();
    expect(r.find((x) => x.id === 'asset-3')!.sub).toBeNull();
  });
});

describe('L113AC-U-05 — requalification T1 du stock', () => {
  it('disponible seulement si le contrat est « satisfait » ; sinon raison explicite', () => {
    expect(availabilityFrom('SATISFIED', null)).toMatchObject({ available: true, contractState: 'SATISFIED' });
    const a = availabilityFrom('ABSENT', 'Le contrat t1-business-periods-v2 est absent du prompt T1 actif.');
    expect(a.available).toBe(false);
    expect(a.reason).toContain('« absent »');
    expect(a.reason).toContain('bloc 28');
  });

  it('classement : jamais demandé / demandé en attente / requalifié / demandé sans sortie v2', () => {
    expect(censusBucket({ qualified: false, jobStatus: null })).toBe('toRequalify');
    expect(censusBucket({ qualified: true, jobStatus: null })).toBe('qualifiedOtherwise');
    expect(censusBucket({ qualified: false, jobStatus: 'PENDING' })).toBe('requestedPending');
    expect(censusBucket({ qualified: false, jobStatus: 'RUNNING' })).toBe('requestedPending');
    expect(censusBucket({ qualified: true, jobStatus: 'DONE' })).toBe('requestedQualified');
    expect(censusBucket({ qualified: false, jobStatus: 'DONE' })).toBe('requestedWithoutV2');
    expect(censusBucket({ qualified: false, jobStatus: 'FAILED' })).toBe('requestedWithoutV2');
  });

  it('estimation : moyenne observée × documents ; jamais sur zéro document', () => {
    expect(estimateCost(3_000_000, 100, 40)).toEqual({ averageMicrosPerDocument: 30_000, estimatedMicros: 1_200_000 });
    expect(estimateCost(0, 100, 40)).toEqual({ averageMicrosPerDocument: null, estimatedMicros: null });
    expect(estimateCost(5_000, 0, 40)).toEqual({ averageMicrosPerDocument: null, estimatedMicros: null });
  });

  it('rattrapage BO déclaré : simuler / appliquer, motif obligatoire, filtre compte', () => {
    expect(backfillDefinition('business-periods-v2-requalification')).toMatchObject({ order: 19, actions: ['simulate', 'apply'], accountFilter: true });
    expect(validateBackfillRequest({ script: 'business-periods-v2-requalification', action: 'apply', reason: '' })).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
    expect(validateBackfillRequest({ script: 'business-periods-v2-requalification', action: 'simulate', accountId: 12 })).toMatchObject({ ok: true });
    expect(REQUALIFICATION_BATCH_SIZE).toBe(100);
    expect(REQUALIFICATION_ORIGIN).toBe('business-periods-v2-requalification');
  });

  it('rapport : refus explicite sans le contrat ; avant / après en application', () => {
    const census = { toRequalify: 3, requestedPending: 0, requestedQualified: 0, requestedWithoutV2: 0, qualifiedOtherwise: 1 };
    const base = {
      action: 'apply' as const, availability: availabilityFrom('ABSENT', null), batchSize: 100, before: census,
      estimate: { averageMicrosPerDocument: 20_000, estimatedMicros: 60_000, windowDays: 30, sampleDocuments: 10 }, batch: [1, 2, 3], ineligibleAccounts: [],
    };
    const refus = summarizeBackfill('business-periods-v2-requalification', 'apply', null, { result: { ...base, refused: 'CONTRACT_NOT_ACTIVE', queued: [], notAccepted: [], after: census } });
    expect(refus.headline).toMatch(/^Application refusée : Inactif/);
    const ok = summarizeBackfill('business-periods-v2-requalification', 'apply', null, {
      result: { ...base, availability: availabilityFrom('SATISFIED', null), queued: [1, 2], notAccepted: [3], after: { ...census, toRequalify: 1, requestedPending: 2 } },
    });
    expect(ok.headline).toBe('Application : 2 document(s) mis en file T1 (lot de 100 au plus) ; 1 non accepté(s) par la file.');
    expect(ok.counters).toEqual(expect.arrayContaining([{ label: 'Avant — à requalifier', value: 3 }, { label: 'Après — demandés, analyse en attente', value: 2 }]));
    const sim = summarizeBackfill('business-periods-v2-requalification', 'simulate', null, { result: { ...base, action: 'simulate' } });
    expect(sim.headline).toMatch(/^Simulation : 3 document\(s\) à requalifier ; prochain lot : 3 document\(s\) ; coût indicatif du reste : 0,06 \$\. Inactif/);
  });
});

describe('L113AC-U-06 — gardes statiques', () => {
  it('liste des documents : une seule période principale sous le sous-titre (lignes et vignettes, desktop et mobile), lecture groupée', () => {
    const vue = src('src/components/documents/v2/DocumentsByRubric.tsx');
    expect(vue.match(/data-testid="document-row-period"/g)).toHaveLength(2);
    expect(vue).toContain('{document.periodLine && (');
    const feed = src('src/services/documents/rubric-query.service.ts');
    expect(feed).toContain('readPrincipalPeriodLines(accountId, fileIds)');
    const recherche = src('src/services/search/global-search.service.ts');
    expect(recherche).toContain('readPrincipalPeriodLines(accountId, fileIds)');
  });

  it('surfaces : lecture groupée D11 (plus de requête d’historique parallèle) ; dossiers excluent les couvertures non établies', () => {
    const surf = src('src/services/documents/business-period-surfaces.ts');
    expect(surf).toContain('readOperationsCoverageHistories(accountId, liste, { max: SURFACE_MAX_OPERATIONS })');
    expect(surf).not.toMatch(/JOIN document_business_periods p ON p\.file_id = f\.id AND p\.account_id = d\.account_id AND p\.status = 'ACTIVE' AND p\.period_kind = 'COVERAGE'/);
    expect(src('src/services/exports/v12/data/source.ts')).toContain('dossierPeriodLines');
    const svc = src('src/services/documents/business-periods/service.ts');
    // Lecture groupée : plus aucune boucle `await operationPeriodResolution` par événement.
    expect(svc.slice(svc.indexOf('export async function readOperationsCoverageHistories'))).not.toContain('await canonicalOperation(');
  });

  it('BO : « Appliquer » désactivé avec la raison quand le prérequis manque ; refus serveur 409', () => {
    const panel = src('src/app/admin/exploitation/_components/BackfillsPanel.tsx');
    expect(panel).toContain('disabled={occupe || bloque}');
    expect(panel).toContain('backfill-${def.script}-unavailable');
    expect(panel).not.toMatch(/#[0-9a-fA-F]{6}\b/);
    const route = src('src/app/api/admin/ops/backfills/route.ts');
    expect(route).toContain("'BACKFILL_PREREQUISITE_MISSING'");
  });

  it('aucun texte nouveau visible ne dit « Opération »', () => {
    for (const f of ['src/lib/documents/business-period-surfaces.ts', 'src/services/documents/business-periods/requalification.ts']) {
      const textes = [...src(f).matchAll(/'([^'\n]*)'|`([^`\n]*)`/g)].map((m) => m[1] ?? m[2]);
      expect(textes.filter((t) => /Opération/.test(t))).toEqual([]);
    }
    const def = backfillDefinition('business-periods-v2-requalification')!;
    expect(`${def.label} ${def.description} ${def.warning}`).not.toMatch(/Opération/);
  });
});
