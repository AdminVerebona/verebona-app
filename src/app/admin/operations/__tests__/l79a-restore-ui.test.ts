/**
 * Lot 79A — BO › Opérations › détail, section « Identité économique et
 * provenance » : bouton « Rétablir » une séparation automatique (seule
 * exception à la lecture seule Q9). Desktop ET mobile : mêmes composants.
 *
 *   · L79A-U01 motif : 10 à 500 caractères, mêmes règles écran / route ;
 *   · L79A-U02 bouton rendu UNIQUEMENT pour une séparation encore effective
 *     (pas pour un doute, un doublon, une séparation rétablie ou bloquée,
 *     ni sans l'action de la page détail — tiroir « Données du compte ») ;
 *   · L79A-U03 trace « Rétablie par … le … — motif : … », contradictions arbitrées ;
 *   · L79A-U04 fenêtre de confirmation : résumé (document, Opération d'origine,
 *     montants, effet TCO), motif obligatoire, bouton pleine largeur sur mobile.
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CORRECTION_PROCEDURE } from '@/services/business-operations/diagnostics/model';
import type { OperationDetail } from '@/services/business-operations/diagnostics/service';
import {
  RESTORE_LABELS, RESTORE_REASON_MAX, RESTORE_REASON_MIN, canRestore, normalizeRestoreReason, restoreHref, restoreTcoEffect, type RestoreSummary,
} from '@/services/business-operations/identity-restore.model';

(globalThis as { React?: typeof React }).React = React;
const { OperationDetailView, restoredByLabel } = await import('../_components/views');
const { RestoreSeparationButton } = await import('../_components/RestoreSeparationButton');
const { identityReviewView } = await import('@/services/business-operations/diagnostics/service');
const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const restore: RestoreSummary = {
  reviewId: 9, fileId: 77, candidateKey: 'op1', summary: 'Acte authentique de vente', originOperationId: 41, currentOperationId: 52,
  amounts: [{ role: 'REALIZED_COST', amountMinor: 49_000_000, currency: 'EUR' }],
};
const revue = (over: Record<string, unknown> = {}) => ({
  id: 9, kind: 'SEPARATED', status: 'APPLIED', operation_id: 41, target_operation_id: 52, file_id: 77, candidate_key: 'op1', source_id: 3,
  signals: ['!AMOUNT_INCOMPATIBLE'], created_at: '2026-10-21T10:00:00Z', restore_block: null, restore, restoredBy: null, ...over,
});
const detail = (identityReviews: Array<Record<string, unknown>>, attributeProvenance: Record<string, unknown> | null = null): OperationDetail => ({
  operation: {
    id: 41, accountId: 3, accountName: 'Compte Martin', typeCode: 'ACQUISITION', typeLabel: 'Acquisition', status: 'REALIZED', label: 'Commande', assets: [],
    equipments: [], parentOperationId: null, principalDate: '2025-05-12', netCents: 27735, netPartial: false, activeSourceCount: 1, sourceCount: 2,
    componentCount: 1, lastReconciledAt: null, createdAt: '2025-05-13T10:00:00Z', invalidatedAt: null, invalidationReason: null, mergedIntoOperationId: null,
    provider: 'Tikamoon', plannedDate: null, startDate: null, realizedDate: '2025-05-12', endDate: null, closedAt: null, updatedAt: null, version: 3, active: true,
  },
  canonicalOperationId: null, assetLinks: [], equipmentLinks: [], sources: [], components: [], references: [], contractDetails: null, financingDetails: null,
  claimDetails: null, parent: null, children: [], mergedFrom: [], history: [], matchDecisions: [], agendaItems: [], projectionSuppressions: [], candidates: [],
  identityReviews, attributeProvenance, lastT3Pass: null, procedure: CORRECTION_PROCEDURE,
  reconciliation: { state: 'A_JOUR', label: 'à jour', pending: 0, blocked: 0, lastReconciledAt: null },
});
const action = (r: RestoreSummary) => h('button', { 'data-restore': r.reviewId }, 'Rétablir');
const rendu = (rows: Array<Record<string, unknown>>, withAction = true) =>
  renderToStaticMarkup(h(OperationDetailView, { d: detail(rows), ...(withAction ? { identityAction: action } : {}) }));

describe('L79A-U01 motif obligatoire (mêmes règles écran et route)', () => {
  it('10 à 500 caractères, espaces ignorés, chaîne seulement', () => {
    expect(RESTORE_REASON_MIN).toBe(10);
    expect(RESTORE_REASON_MAX).toBe(500);
    expect(normalizeRestoreReason('  123456789 ')).toBeNull();
    expect(normalizeRestoreReason(' 1234567890 ')).toBe('1234567890');
    expect(normalizeRestoreReason('x'.repeat(500))).toHaveLength(500);
    expect(normalizeRestoreReason('x'.repeat(501))).toBeNull();
    expect(normalizeRestoreReason(undefined)).toBeNull();
    expect(normalizeRestoreReason(1234567890)).toBeNull();
    expect(restoreHref(41, 9)).toBe('/api/admin/operations/41/identity-reviews/9/restore');
  });
});

describe('L79A-U02 bouton rendu uniquement pour une séparation encore effective', () => {
  it('séparation effective + action de la page détail → un bouton', () => {
    expect(rendu([revue()]).match(/data-restore="9"/g)).toHaveLength(1);
    expect(canRestore(revue())).toBe(true);
  });
  it.each([
    ['doute (SUSPECT)', { kind: 'SUSPECT', status: 'OPEN', restore: null }],
    ['doublon', { kind: 'DUPLICATE_RELOCATED', restore: null }],
    ['déjà rétablie', { status: 'REVERTED', restore: null, restoredBy: { adminId: 7, adminEmail: 'a@x.fr', at: '2026-10-22T09:00:00Z', reason: 'Vérifié avec le client' } }],
    ['plus effective (source supprimée)', { restore: null, restore_block: 'SOURCE_DELETED' }],
  ])('%s → aucun bouton', (_n, over) => {
    const html = rendu([revue(over)]);
    expect(html).not.toMatch(/data-restore=/);
    expect(html).not.toMatch(/<button/);
  });
  it('séparation bloquée : motif lisible à la place du bouton', () => {
    expect(rendu([revue({ restore: null, restore_block: 'ORIGIN_MERGED' })])).toContain('fusionnée depuis');
  });
  it('sans action (tiroir « Données du compte », tests O9) : lecture seule stricte', () => {
    expect(rendu([revue()], false)).not.toMatch(/<button/);
  });
  it('vue serveur : `restore` calculé seulement si séparation APPLIQUÉE sans blocage', () => {
    const base = {
      id: '9', kind: 'SEPARATED', status: 'APPLIED', operation_id: '41', file_id: 77, candidate_key: 'op1', restore_block: null,
      restore_summary: 'Acte', restore_current_operation_id: '52', restore_hints: [{ role: 'REALIZED_COST', amountMinor: 49_000_000, currency: 'EUR' }, null],
    };
    expect(identityReviewView(base).restore).toEqual({ ...restore, summary: 'Acte' });
    expect(identityReviewView({ ...base, restore_block: 'CANDIDATE_GONE' }).restore).toBeNull();
    expect(identityReviewView({ ...base, kind: 'SUSPECT' }).restore).toBeNull();
    expect(identityReviewView({ ...base, status: 'REVERTED' }).restore).toBeNull();
  });
});

describe('L79A-U03 trace du rétablissement et contradictions arbitrées', () => {
  it('« Rétablie par … le … — motif : … » (journal d’audit admin ; repli sur le journal 0609)', () => {
    const html = rendu([revue({ status: 'REVERTED', restore: null, restoredBy: { adminId: 7, adminEmail: 'admin@verebona.fr', at: '2026-10-22T09:00:00Z', reason: 'Vérifié avec le client' } })]);
    expect(html).toContain('Rétablie par admin@verebona.fr le ');
    expect(html).toContain('motif : Vérifié avec le client');
    expect(restoredByLabel({ adminId: 7, adminEmail: null, at: null, reason: null })).toBe('Rétablie par administrateur #7 le —');
    const v = identityReviewView({ id: '9', kind: 'SEPARATED', status: 'REVERTED', resolved_by_admin_id: 7, resolved_at: '2026-10-22T09:00:00Z',
      restored_by_admin_id: 7, restored_by_admin_email: 'admin@verebona.fr', restored_at: '2026-10-22T09:00:01Z', restore_details: JSON.stringify({ reason: 'Vérifié avec le client' }) });
    expect(v.restoredBy).toEqual({ adminId: 7, adminEmail: 'admin@verebona.fr', at: '2026-10-22T09:00:01Z', reason: 'Vérifié avec le client' });
  });
  it('contradiction arbitrée par un rétablissement : tableau distinct, hors « à examiner »', () => {
    const html = renderToStaticMarkup(h(OperationDetailView, { d: detail([revue()], {
      fields: {}, conflicts: [], arbitratedConflicts: [{ field: 'realizedDate', values: [{ value: '2025-05-12', sourceIds: [1] }, { value: '2021-06-30', sourceIds: [3] }], retained: '2025-05-12' }],
    }) }));
    expect(html).toContain('Attribut arbitré au BO (rétablissement)');
    expect(html).not.toContain('Attribut contradictoire');
  });
});

describe('L79A-U04 fenêtre de confirmation (desktop et mobile)', () => {
  it('bouton libellé, pleine largeur sur mobile, fenêtre fermée par défaut', () => {
    const html = renderToStaticMarkup(h(RestoreSeparationButton, { operationId: 41, restore }));
    expect(html).toContain(RESTORE_LABELS.button);
    expect(html).toContain('w-full sm:w-auto');
    expect(html).toContain('data-testid="identity-restore"');
    expect(html).not.toContain(RESTORE_LABELS.title);
  });
  it('résumé : document, Opération d’origine, montants, effet TCO ; motif obligatoire ; confirmation désactivée tant qu’invalide', () => {
    const src = lire('src/app/admin/operations/_components/RestoreSeparationButton.tsx');
    expect(src).toContain('AlertDialog');
    expect(src).toContain('<Textarea');
    expect(src).toMatch(/disabled=\{busy \|\| !valid\}/);
    for (const t of ['Document', 'Opération d’origine', 'Montants concernés', 'restoreTcoEffect(r)']) expect(src).toContain(t);
    expect(src).toContain('grid-cols-1 sm:grid-cols-[auto_1fr]');
    expect(restoreTcoEffect(restore)).toMatch(/de nouveau comptés dans l’Opération #41 et retirés de l’Opération #52/);
    expect(restoreTcoEffect({ ...restore, amounts: [], currentOperationId: null })).toMatch(/le TCO ne change pas/);
  });
});
