/**
 * Lot 47A — O9 : écrans BO du diagnostic des Opérations (CDC Opérations V1
 * ch. 21, B23, C26.1, C26.2, C27 ; F-182, F-183 ; décisions PO Q8, Q9).
 *
 * Rendu statique des vues PURES (`_components/views.tsx`) : contenu attendu,
 * aucune action d'édition (lecture seule — seule exception : « Rétablir » une
 * séparation d'identité, lot 79A, testée dans `l79a-restore-ui.test.ts`), mêmes composants desktop et
 * mobile (tableaux défilants, grilles responsives). Navigation : entrée
 * depuis Dashboard › Supervision et depuis la fiche compte ; barre latérale
 * inchangée (15 entrées du CDC BO).
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { INDICATORS, HARD_ANOMALY_CODES, HARD_ANOMALY_LABELS, CORRECTION_PROCEDURE } from '@/services/business-operations/diagnostics/model';
import type { IndicatorsReport, OperationDetail, OperationListItem, HoldItem } from '@/services/business-operations/diagnostics/service';

(globalThis as { React?: typeof React }).React = React;

const { OperationsTable, HoldsTable, IndicatorsView, OperationDetailView, indicatorHeadline, READ_ONLY_NOTICE } = await import('../_components/views');

const ROOT = process.cwd();
const lire = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Aucun contrôle d'édition rendu : ni bouton, ni champ, ni formulaire. */
const AUCUNE_ACTION = /<(button|input|select|textarea|form)\b/;

const item = (over: Partial<OperationListItem> = {}): OperationListItem => ({
  id: 41, accountId: 3, accountName: 'Compte Martin', typeCode: 'INTERVENTION', typeLabel: 'Intervention', status: 'REALIZED',
  label: 'Remplacement chaudière', assets: [{ id: 8, name: 'Maison' }], equipments: [],
  principalDate: '2026-03-12', netCents: 120000, netPartial: false, activeSourceCount: 2, sourceCount: 3, componentCount: 1,
  lastReconciledAt: '2026-10-01T10:00:00Z', createdAt: '2026-03-13T10:00:00Z', invalidatedAt: null, invalidationReason: null,
  mergedIntoOperationId: null, ...over,
});

describe('O9-UI-01 liste (B23 : colonnes) — lecture seule', () => {
  const html = renderToStaticMarkup(h(OperationsTable, { items: [item(), item({ id: 42, assets: [], mergedIntoOperationId: 41, invalidatedAt: '2026-04-01T00:00:00Z', activeSourceCount: 0 })] }));
  it('colonnes B23 / C26.1', () => {
    for (const col of ['ID', 'Compte', 'Type', 'Statut', 'Libellé', 'Bien(s) / équipement(s)', 'Date principale', 'Net indicatif', 'Sources', 'Composantes', 'Dernière réconciliation', 'État']) {
      expect(html).toContain(`>${col}<`);
    }
    expect(html).toContain('href="/admin/operations/41"');
    expect(html).toContain('href="/admin/accounts/3"');
    expect(html).toContain('Fusionnée → #41');
    expect(html).toContain('sans bien');
  });
  it('aucune action ; tableau défilant (mobile)', () => {
    expect(html).not.toMatch(AUCUNE_ACTION);
    expect(html).toContain('overflow-x-auto');
  });
});

describe('O9-UI-02 candidats en attente : motif lisible et lien document sans nom de fichier', () => {
  const hold: HoldItem = {
    id: 5, accountId: 3, accountName: 'Compte Martin', fileId: 77, candidateKey: 'c1', confidence: 'probable', established: true,
    typeHint: 'INTERVENTION', summary: 'Réparation', outcome: 'HOLD_UNRESOLVED', reason: 'PROBABLE_WITHOUT_MATCH',
    reasonLabel: 'source probable sans Opération correspondante : pas de création', operationId: null, proposedOperationIds: [41],
    processedAt: '2026-10-01T10:00:00Z', createdAt: '2026-09-01T10:00:00Z',
  };
  const html = renderToStaticMarkup(h(HoldsTable, { items: [hold] }));
  it('motif, Opérations proposées, document vers ses exécutions IA', () => {
    expect(html).toContain('pas de création');
    expect(html).toContain('PROBABLE_WITHOUT_MATCH');
    expect(html).toContain('href="/admin/ai-executions?accountId=3&amp;objectType=asset_file&amp;objectId=77"');
    expect(html).toContain('href="/admin/operations/41"');
    expect(html).not.toMatch(AUCUNE_ACTION);
  });
});

const report = (over: Partial<IndicatorsReport> = {}): IndicatorsReport => ({
  period: { from: '2026-09-01', to: '2026-09-30', days: 30 }, accountId: null, computedAt: '2026-10-01T10:00:00Z',
  indicators: INDICATORS.map((d) => ({ ...d, value: { count: 0, total: 0, pct: null } })),
  anomalies: HARD_ANOMALY_CODES.map((code) => ({ code, label: HARD_ANOMALY_LABELS[code], count: 0, accountIds: [], samples: [] })),
  hardAnomalyTotal: 0, procedure: CORRECTION_PROCEDURE, ...over,
});

describe('O9-UI-03 / C26.2 indicateurs : 13 cartes, anomalies dures en alerte avec procédure', () => {
  it('13 indicateurs affichés, grille responsive (1 colonne sur mobile)', () => {
    const html = renderToStaticMarkup(h(IndicatorsView, { report: report() }));
    expect(html.match(/data-indicator="/g)?.length).toBe(13);
    for (const d of INDICATORS) expect(html).toContain(d.label.replace(/>/g, '&gt;'));
    expect(html).toContain('grid-cols-1 sm:grid-cols-2 xl:grid-cols-3');
    expect(html).toContain('Anomalies dures : 0');
    expect(html).not.toMatch(/role="alert"/);
    expect(html).not.toMatch(AUCUNE_ACTION);
  });

  it('anomalie dure : alerte, lien compte et Opération, procédure, File IA du compte — sans outil d’édition', () => {
    const anomalies = report().anomalies.map((a) => (a.code === 'NEGATIVE_COMPONENT'
      ? { ...a, count: 2, accountIds: [9], samples: [{ accountId: 9, operationId: 90, detail: 'montant négatif' }] }
      : a));
    const html = renderToStaticMarkup(h(IndicatorsView, { report: report({ anomalies, hardAnomalyTotal: 2 }) }));
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-anomaly="NEGATIVE_COMPONENT"');
    expect(html).toContain('href="/admin/accounts/9"');
    expect(html).toContain('href="/admin/operations/90"');
    expect(html).toContain('href="/admin/ai-queue?treatment=T3&amp;accountId=9&amp;status="');
    expect(html).toContain('ne modifie jamais');
    expect(html).not.toMatch(AUCUNE_ACTION);
  });

  it('valeur principale lisible de chaque indicateur', () => {
    const t2 = { ...INDICATORS[12], value: { total: 10, operationOnlyPct: 50, mixedPct: 30, fallbackOnlyPct: 20 } };
    expect(indicatorHeadline(t2)).toBe('50 % / 30 % / 20 % (10)');
    const ages = { ...INDICATORS[7], value: { h24: 1, d7: 2, d30: 3, older: 4 } };
    expect(indicatorHeadline(ages)).toBe('1 / 2 / 3 / 4');
  });
});

describe('O9-UI-04 / C26.1 détail complet — lecture seule, desktop et mobile', () => {
  const d: OperationDetail = {
    operation: { ...item(), provider: 'Chauffage Plus', plannedDate: null, startDate: null, realizedDate: '2026-03-12', endDate: null, closedAt: null, updatedAt: null, version: 3, active: true },
    canonicalOperationId: null,
    assetLinks: [{ asset_id: 8, asset_name: 'Maison', link_role: 'PRIMARY', authority: 'DOCUMENT', source_id: 11, active: true }],
    equipmentLinks: [],
    sources: [{ id: 11, source_kind: 'DOCUMENT', source_entity_key: '77', file_id: 77, source_role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain', match_method: 'M1', match_reason: 'MATCH_M1', match_reason_label: 'référence métier identique', locator: { candidateKey: 'c1' }, active: true }],
    components: [{ id: 3, kind: 'REALIZED_COST', amount_minor: 120000, currency: 'EUR', amount_eur_cents: null, economic_date: '2026-03-12', active: true, sources: [{ sourceId: 11, evidenceRole: 'SUPPORTS', isPrimary: true, sourceActive: true }] }],
    references: [{ reference_kind: 'INVOICE', reference_value: 'FA-1', normalized_value: 'FA1', active: true }],
    contractDetails: null, financingDetails: null,
    claimDetails: null,
    mergedFrom: [{ id: 42 }],
    history: [{ created_at: '2026-03-13T10:00:00Z', event_type: 'CREATED', reason_code: 'T3_CREATE_NEW', reason_code_label: 'création par la consolidation T3', correlation_id: 'corr-1' }],
    matchDecisions: [{ decision: 'REJECTED', origin: 'USER_ARBITRATION', reason_code: 'USER_REJECTED', reason_code_label: 'rapprochement refusé par l’utilisateur', source_kind: 'DOCUMENT', source_entity_key: '78', active: true }],
    agendaItems: [{ id: 6, title: 'Entretien', start_date: '2027-03-12', projection_origin: 'OPERATION' }],
    projectionSuppressions: [{ projection_kind: 'AGENDA', projection_key: 'k', user_id: 2, created_at: '2026-05-01T00:00:00Z' }],
    candidates: [{ id: 5, file_id: 77, summary: 'Facture', confidence: 'certain', established: true, t3_outcome: 'CREATE_NEW', t3_reason_label: 'aucune Opération correspondante, source certaine : création', t3_operation_id: 41, status: 'ACTIVE' }],
    lastT3Pass: { jobId: 12, status: 'DONE', origin: 'automatic', triggerCode: 'source_analyzed', businessResult: 'APPLIED', createdAt: null, finishedAt: '2026-10-01T10:00:00Z', attempts: 1, lastError: null, correlationId: 'corr-9' },
    procedure: CORRECTION_PROCEDURE,
    reconciliation: { state: 'A_JOUR', label: 'à jour : aucun traitement en attente', pending: 0, blocked: 0, lastReconciledAt: '2026-10-01T10:00:00Z' },
    operationMatchBranch: { available: false, version: 't3_master_v1@bo' },
  };
  const html = renderToStaticMarkup(h(OperationDetailView, { d }));

  it('L55B-E3 — état de réconciliation, exécution IA et branche OPERATION_MATCH affichés (même composant ordinateur / mobile)', () => {
    expect(html).toContain('État de réconciliation');
    expect(html).toContain('à jour : aucun traitement en attente');
    expect(html).toContain('Exécution IA');
    expect(html).toContain('ABSENT de la configuration active');
    expect(html).not.toContain('>Parent<');   // lot 83D (V-Q2) : hiérarchie retirée
  });

  it('toutes les sections du ch. 21 / C26.1', () => {
    for (const t of ['Identité', 'Biens et équipements', 'Sources (actives et historiques)', 'Composantes financières', 'Références',
      'Fusion', 'Décisions de rapprochement (REJECTED / CONFIRMED)', 'Candidats T1 liés et issue T3',
      'Agenda (projection et suppressions)', 'Historique', 'Dernier passage T3 du compte']) {
      expect(html).toContain(t);
    }
    expect(html).toContain('référence métier identique');
    expect(html).toContain('REJECTED');
    expect(html).toContain('projeté (T4)');
    expect(html).toContain('corr-9');
    expect(html).toContain('href="/admin/operations/42"');
    expect(html).toContain(READ_ONLY_NOTICE.replace(/’/g, '’'));
  });

  it('F-182 : aucune action d’édition ; mobile : sections empilées, tableaux défilants, grilles 1 colonne', () => {
    expect(html).not.toMatch(AUCUNE_ACTION);
    // L79A : même avec l'action « Rétablir » fournie, rien n'est rendu sans séparation effective.
    expect(renderToStaticMarkup(h(OperationDetailView, { d, identityAction: () => h('button', null, 'Rétablir') }))).not.toMatch(AUCUNE_ACTION);
    expect(html).toContain('overflow-x-auto');
    expect(html).toContain('grid-cols-1 sm:grid-cols-2 lg:grid-cols-3');
  });
});

describe('O9-UI-05 navigation BO, droits et référentiel', () => {
  it('barre latérale inchangée : 15 entrées (Opérations atteint depuis Supervision et la fiche compte)', async () => {
    const { ADMIN_NAVIGATION } = await import('@/components/AdminSidebar');
    expect(ADMIN_NAVIGATION.length).toBe(15);
    expect(ADMIN_NAVIGATION.map((n) => n.href as string)).not.toContain('/admin/operations');
    expect(lire('src/app/admin/_dashboard/SupervisionTab.tsx')).toContain('<Link href="/admin/operations"><Layers className="h-4 w-4 mr-1.5" />Opérations</Link>');
    const compte = lire('src/app/admin/accounts/[id]/page.tsx');
    expect(compte).toContain('href={`/admin/operations?accountId=${account.id}`}>Opérations du compte</Link>');
  });

  it('pages : garde du layout BO, aucune écriture (fetch GET seulement), filtres empilés sur mobile', () => {
    const page = lire('src/app/admin/operations/page.tsx');
    const detail = lire('src/app/admin/operations/[id]/page.tsx');
    for (const src of [page, detail]) {
      expect(src).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'|apiClient\.(post|put|patch|delete)/);
      expect(src).not.toMatch(/from '@\/db'/);
    }
    // EXCEPTION UNIQUE à Q9 (lot 79A, décision PO du 22/10/2026) : le détail d'Opération rend
    // « Rétablir » pour une séparation d'identité encore effective — et AUCUNE autre action.
    expect([...detail.matchAll(/from '\.\.\/_components\/(\w+)'/g)].map((m) => m[1]).sort()).toEqual(['RestoreSeparationButton', 'views']);
    expect(detail).toMatch(/identityAction=\{\(restore\) => <RestoreSeparationButton operationId=\{Number\(id\)\} restore=\{restore\} onDone=\{load\} \/>\}/);
    const bouton = lire('src/app/admin/operations/_components/RestoreSeparationButton.tsx');
    expect([...bouton.matchAll(/apiClient\.(get|post|put|patch|delete)/g)].map((m) => m[0])).toEqual(['apiClient.post']);
    expect(bouton).toMatch(/apiClient\.post\(restoreHref\(operationId, r\.reviewId\), \{ reason: reason\.trim\(\) \}\)/);
    expect(lire('src/app/admin/operations/_components/views.tsx')).not.toMatch(/apiClient|fetch\(/);
    expect(page).toContain('flex flex-col md:flex-row');
    expect(page).toContain('TabsList className="flex-wrap h-auto"');
    expect(lire('src/app/admin/layout.tsx')).toMatch(/user\.role !== 'ADMIN' && user\.role !== 'SUPER_ADMIN'/);
  });

  it('alerte de Supervision : origine de résolution automatique libellée sur l’écran de traitement', async () => {
    const { OPERATIONS_ANOMALY_ORIGIN } = await import('@/services/business-operations/diagnostics/alerts');
    expect(lire('src/app/admin/supervision/[id]/page.tsx')).toContain(`${OPERATIONS_ANOMALY_ORIGIN}: 'Anomalie dure des Opérations revenue à 0`);
  });

  it('F-183 référentiel des types : nombre d’utilisations réel, dont actives ; non mesurable plutôt que 0', async () => {
    const { buildOperationTypeReferentials } = await import('@/app/api/admin/referentials/referentials-data');
    const rows = buildOperationTypeReferentials(null, new Map([['CLAIM', 3]]), new Map([['CLAIM', 2]]));
    expect(rows.find((r) => r.code === 'CLAIM')).toMatchObject({ usage: 3 });
    expect(rows.find((r) => r.code === 'CLAIM')?.details).toMatch(/dont 2 active\(s\)$/);
    expect(buildOperationTypeReferentials(null, null).every((r) => r.usage === null)).toBe(true);
  });
});
