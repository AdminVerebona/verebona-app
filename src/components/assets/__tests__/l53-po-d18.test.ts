/**
 * Lot 53 — retour PO D18 : fin contractuelle PRÉVUE ≠ fin réelle de
 * détention ; aucune date inventée pour un bien acheté ; origine dite
 * (calculée, extraite, déclarée). Recette adaptée : la date n'est affichée
 * que si elle est connue ou justifiée, et seulement pour une détention à
 * durée limitée. Desktop et mobile : même composant (`AssetDetailSection`).
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { readOrigin } from '@/services/ai/reconciliation/field-origin';
import { TENURE_END_LABEL, TENURE_META_KEY, tenureEndKey, tenureEndSectionFields, tenureSourceLabel } from '@/lib/assets/tenure-end';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as { React?: typeof React }).React = React;
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/db', () => ({ db: {}, pgClient: {} }));
const { AssetDetailSection } = await import('../AssetDetailSection');
const tab = await import('../AssetDetailsTab');

const rendre = (section: 'vehicle_usage' | 'occupancy_usage' | 'object_usage', data: Record<string, unknown>) =>
  renderToStaticMarkup(h(AssetDetailSection, {
    title: 'Usage', sectionKey: section, assetId: 7, onRefresh: () => undefined, fields: tab.sectionFieldDefs(section), data,
  })).replace(/&#x27;/g, "'");

describe('PO-D18 — fin de contrat prévue, jamais une fin de détention inventée', () => {
  it('PO-D18-01 — libellé : fin CONTRACTUELLE prévue, jamais « détention » ni « cession »', () => {
    expect(TENURE_END_LABEL).toBe('Fin de contrat prévue');
    expect(TENURE_END_LABEL).not.toMatch(/détention|cession|vente/i);
    const html = rendre('vehicle_usage', { vehicleOwnershipStatus: 'LLD', ...tenureEndSectionFields('VEHICULE', { contractStartDate: '2024-03-20', leaseDurationMonths: 36 }, { vehicleOwnershipStatus: 'LLD' }, readOrigin) });
    expect(html).toContain('Fin de contrat prévue');
    expect(html).not.toMatch(/fin de (la )?détention/i);
  });

  it('PO-D18-02 — bien acheté (propriétaire, crédit, objet acheté) : aucune date, même avec un début et une durée', () => {
    const kc = { contractStartDate: '2024-03-20', leaseDurationMonths: 36 };
    for (const [famille, ctx] of [
      ['VEHICULE', { vehicleOwnershipStatus: 'PROPRIETAIRE' }], ['VEHICULE', { vehicleOwnershipStatus: 'CREDIT' }],
      ['IMMOBILIER', { occupancyStatus: 'PROPRIETAIRE' }], ['OBJET', { acquisitionMode: 'Achat en magasin' }],
    ] as const) {
      expect(tenureEndKey(famille, ctx)).toBeNull();
      const f = tenureEndSectionFields(famille, kc, ctx, readOrigin);
      expect(f[TENURE_META_KEY]).toEqual({ key: null, source: null });
      expect(Object.entries(f).filter(([k, v]) => k !== TENURE_META_KEY && v !== null)).toEqual([]);
    }
    expect(rendre('vehicle_usage', { vehicleOwnershipStatus: 'PROPRIETAIRE', contractStartDate: '2024-03-20', leaseDurationMonths: 36 })).not.toContain(TENURE_END_LABEL);
  });

  it('PO-D18-03 — origine toujours dite : calculée, extraite d’un document, déclarée', () => {
    expect(tenureSourceLabel('computed')).toBe('Calculée (début + durée)');
    expect(tenureSourceLabel('document')).toBe('Extraite d’un document');
    expect(tenureSourceLabel('user')).toBe('Déclarée');
    const declaree = tenureEndSectionFields('VEHICULE', { leaseEndDate: '2026-12-31', leaseEndDate__origin: 'USER' }, { vehicleOwnershipStatus: 'LOA' }, readOrigin);
    expect(rendre('vehicle_usage', { vehicleOwnershipStatus: 'LOA', ...declaree })).toContain('Déclarée');
  });
});
