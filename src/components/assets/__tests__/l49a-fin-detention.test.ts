/**
 * Lot 49A (ticket 9) — « Date de fin du contrat / de la détention » dans la
 * section usage des informations du bien, pour une détention à durée
 * limitée (LLD, LOA, prêt, location…). Desktop et mobile : même composant
 * (`AssetDetailSection`, grille responsive) — rendu serveur vérifié.
 *
 * AC-T9-1  champ canonique EXISTANT (aucun doublon) : `leaseEndDate` (LLD /
 *          LOA, locataire — clé produite par T1 pour un contrat de location)
 *          ou `contractEndDate` (prêt, occupant gratuit, objet loué / prêté) ;
 * AC-T9-2  calculé si début + durée connus (affiché « Calculée », modifiable) ;
 * AC-T9-3  sinon trouvé dans les documents (affiché « Extraite d’un document ») ;
 * AC-T9-4  sinon saisi ; la saisie utilisateur prime toujours ;
 * AC-T9-5  visible SEULEMENT pour une détention à durée limitée ;
 * AC-T9-6  écriture par la primitive canonique (origine USER), valeur
 *          calculée non envoyée tant qu'elle n'est pas modifiée.
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { getField, resolveAliasDetailed, CANONICAL_FIELDS } from '@/services/canonical/registry';
import { readOrigin } from '@/services/ai/reconciliation/field-origin';
import {
  computeTenureEnd, resolveTenureEnd, tenureEndKey, tenureEndSectionFields, TENURE_END_LABEL, TENURE_META_KEY,
} from '@/lib/assets/tenure-end';
import { changedDetailFields } from '@/lib/asset-detail-rules';

(globalThis as { React?: typeof React }).React = React;
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const { AssetDetailSection, visibleFields } = await import('../AssetDetailSection');
const tab = await import('../AssetDetailsTab');
const { canonicalWritesOf } = await import('@/services/asset-details-write.service');

const lire = (p: string) => readFileSync(resolve(__dirname, '..', '..', '..', p), 'utf8').replace(/\r\n?/g, '\n');
const TAB = lire('components/assets/AssetDetailsTab.tsx');
// Lot 88A : sections de la route extraites dans `services/assets/details-sections.ts` (même fonction pour le diagnostic).
const ROUTE = lire('services/assets/details-sections.ts');

/** Champs réels d'une section de l'onglet. */
const sectionFields = (section: 'vehicle_usage' | 'occupancy_usage' | 'object_usage') => tab.sectionFieldDefs(section);

function rendre(section: 'vehicle_usage' | 'occupancy_usage' | 'object_usage', data: Record<string, unknown>) {
  return renderToStaticMarkup(h(AssetDetailSection, {
    title: 'Usage', sectionKey: section, assetId: 7, onRefresh: () => undefined, fields: sectionFields(section), data,
  })).replace(/&#x27;/g, "'");
}

const vehicule = (status: string, kc: Record<string, unknown>) =>
  tenureEndSectionFields('VEHICULE', kc, { vehicleOwnershipStatus: status }, readOrigin);

describe('AC-T9-1 — champ canonique existant, celui de la projection documentaire', () => {
  it('aucune nouvelle clé : leaseEndDate et contractEndDate existent, agenda « Fin de bail » / « Fin de contrat »', () => {
    expect(getField('leaseEndDate')).toMatchObject({ valueType: 'date', agendaEffect: { nature: 'DEADLINE', businessType: 'lease' } });
    expect(getField('contractEndDate')).toMatchObject({ valueType: 'date', agendaEffect: { nature: 'DEADLINE', businessType: 'contract' } });
    expect(CANONICAL_FIELDS.filter((f) => /tenure|detention|holdingEnd/i.test(f.key))).toEqual([]);
  });

  it('T1 : « dateFinContrat » d’un contrat LLD / LOA → leaseEndDate ; d’un contrat non locatif → contractEndDate', () => {
    expect(resolveAliasDetailed('dateFinContrat', 'VEHICULE', { documentType: 'CONTRAT_LLD' })?.key).toBe('leaseEndDate');
    expect(resolveAliasDetailed('dateFinContrat', 'VEHICULE', { documentType: 'LOA' })?.key).toBe('leaseEndDate');
    expect(resolveAliasDetailed('dateFinContrat', 'VEHICULE')?.key).toBe('contractEndDate');
    // Objet : leaseEndDate ne s'applique pas → contractEndDate.
    expect(resolveAliasDetailed('dateFinContrat', 'OBJECT', { documentType: 'CONTRAT_LOCATION' })?.key).toBe('contractEndDate');
  });

  it('clé retenue selon la situation', () => {
    expect(tenureEndKey('VEHICULE', { vehicleOwnershipStatus: 'LLD' })).toBe('leaseEndDate');
    expect(tenureEndKey('VEHICULE', { vehicleOwnershipStatus: 'LOA' })).toBe('leaseEndDate');
    expect(tenureEndKey('VEHICULE', { vehicleOwnershipStatus: 'PRET_GRATUIT' })).toBe('contractEndDate');
    expect(tenureEndKey('IMMOBILIER', { occupancyStatus: 'LOCATAIRE' })).toBe('leaseEndDate');
    expect(tenureEndKey('IMMOBILIER', { occupancyStatus: 'OCCUPANT_GRATUIT' })).toBe('contractEndDate');
    expect(tenureEndKey('OBJET', { acquisitionMode: 'Location longue durée' })).toBe('contractEndDate');
    expect(tenureEndKey('OBJET', { acquisitionMode: 'Prêté par mon frère' })).toBe('contractEndDate');
    expect(tenureEndKey('OBJET', { acquisitionMode: 'Loué' })).toBe('contractEndDate');
  });
});

describe('AC-T9-5 — visible seulement pour une détention à durée limitée', () => {
  it('propriétaire, crédit, statut vide, logement possédé ou mis en location, objet acheté : rien', () => {
    for (const s of ['PROPRIETAIRE', 'CREDIT', '']) expect(tenureEndKey('VEHICULE', { vehicleOwnershipStatus: s })).toBeNull();
    for (const s of ['PROPRIETAIRE', 'USUFRUITIER', '']) expect(tenureEndKey('IMMOBILIER', { occupancyStatus: s })).toBeNull();
    for (const m of ['Achat', 'Cadeau', 'Héritage', '', null]) expect(tenureEndKey('OBJET', { acquisitionMode: m })).toBeNull();
  });

  it('fiche véhicule (desktop et mobile, même rendu) : LLD → champ affiché ; propriétaire → absent', () => {
    const lld = rendre('vehicle_usage', { vehicleOwnershipStatus: 'LLD', ...vehicule('LLD', { leaseEndDate: '2027-03-19', leaseEndDate__origin: 'DOCUMENT_EXTRACTION' }) });
    expect(lld).toContain(TENURE_END_LABEL);
    expect(lld).toContain('19 mars 2027');
    const prop = rendre('vehicle_usage', { vehicleOwnershipStatus: 'PROPRIETAIRE', ...vehicule('PROPRIETAIRE', { leaseEndDate: '2027-03-19' }) });
    expect(prop).not.toContain(TENURE_END_LABEL);
    // Grille responsive : une colonne en mobile, plusieurs en desktop.
    expect(lld).toMatch(/grid-cols-1 sm:grid-cols-2 lg:grid-cols-3/);
  });

  it('fiche logement : locataire → affiché ; propriétaire → absent ; objet loué → affiché', () => {
    const imm = tenureEndSectionFields('IMMOBILIER', { leaseEndDate: '2028-06-30' }, { occupancyStatus: 'LOCATAIRE' }, readOrigin);
    expect(rendre('occupancy_usage', { occupancyStatus: 'LOCATAIRE', ...imm })).toContain(TENURE_END_LABEL);
    expect(rendre('occupancy_usage', { occupancyStatus: 'PROPRIETAIRE', ...imm })).not.toContain(TENURE_END_LABEL);
    const obj = tenureEndSectionFields('OBJET', { contractEndDate: '2026-12-31' }, { acquisitionMode: 'Location' }, readOrigin);
    expect(obj).not.toHaveProperty('leaseEndDate');
    expect(rendre('object_usage', { acquisitionMode: 'Location', ...obj })).toContain('31 décembre 2026');
  });

  it('un seul champ visible à la fois (pas de doublon à l’écran)', () => {
    const f = sectionFields('vehicle_usage');
    for (const s of ['LLD', 'LOA', 'PRET_GRATUIT']) {
      expect(visibleFields(f, { vehicleOwnershipStatus: s }).filter((x) => x.label === TENURE_END_LABEL)).toHaveLength(1);
    }
    expect(visibleFields(f, { vehicleOwnershipStatus: 'CREDIT' }).filter((x) => x.label === TENURE_END_LABEL)).toHaveLength(0);
  });
});

describe('AC-T9-2 / AC-T9-3 / AC-T9-4 — calculé, trouvé dans un document, saisi', () => {
  it('calcul : début + durée (mois) − 1 jour, fin de mois bornée', () => {
    expect(computeTenureEnd('2024-03-20', 36)).toBe('2027-03-19');
    expect(computeTenureEnd('2024-01-01', 12)).toBe('2024-12-31');
    expect(computeTenureEnd('2024-01-31', 1)).toBe('2024-02-28');
    expect(computeTenureEnd('2023-12-31', 2)).toBe('2024-02-28');
    expect(computeTenureEnd('2024-03-20', '48')).toBe('2028-03-19');
    for (const [d, n] of [[null, 36], ['2024-03-20', null], ['2024-03-20', 0], ['2024-03-20', 2.5], ['pas une date', 12]] as const) {
      expect(computeTenureEnd(d, n)).toBeNull();
    }
  });

  it('AC-T9-2 — début + durée connus, rien d’enregistré : valeur calculée, pastille « Calculée »', () => {
    const f = vehicule('LLD', { contractStartDate: '2024-03-20', leaseDurationMonths: 36 });
    expect(f).toMatchObject({ leaseEndDate: '2027-03-19', [TENURE_META_KEY]: { key: 'leaseEndDate', source: 'computed' } });
    const html = rendre('vehicle_usage', { vehicleOwnershipStatus: 'LLD', ...f });
    expect(html).toContain('Calculée (début + durée)');
    expect(html).toContain('19 mars 2027');
  });

  it('AC-T9-3 — valeur d’un document (origine automatique) : affichée telle quelle, pastille « document »', () => {
    const f = vehicule('LOA', { leaseEndDate: '2027-04-01', leaseEndDate__origin: 'DOCUMENT_EXTRACTION', contractStartDate: '2024-03-20', leaseDurationMonths: 36 });
    expect(f).toMatchObject({ leaseEndDate: '2027-04-01', [TENURE_META_KEY]: { source: 'document' } });
    expect(rendre('vehicle_usage', { vehicleOwnershipStatus: 'LOA', ...f })).toContain('Extraite d’un document');
  });

  it('AC-T9-4 — la saisie utilisateur prime sur le calcul et sur le document ; aucune pastille', () => {
    const f = vehicule('LLD', { leaseEndDate: '2026-12-31', leaseEndDate__origin: 'USER', contractStartDate: '2024-03-20', leaseDurationMonths: 36 });
    expect(f).toMatchObject({ leaseEndDate: '2026-12-31', [TENURE_META_KEY]: { source: 'user' } });
    expect(resolveTenureEnd({ stored: '2026-12-31', origin: 'ADMIN', start: '2024-03-20', months: 36 }).source).toBe('user');
    const html = rendre('vehicle_usage', { vehicleOwnershipStatus: 'LLD', ...f });
    expect(html).not.toContain('Calculée');
    expect(html).not.toContain('Extraite d’un document');
    // Rien d'enregistré, rien de calculable : vide, saisissable.
    expect(vehicule('LLD', {})).toMatchObject({ leaseEndDate: null, [TENURE_META_KEY]: { source: null } });
  });
});

describe('AC-T9-6 — écriture', () => {
  it('valeur calculée non envoyée tant qu’elle n’est pas modifiée ; modifiée → envoyée (saisie)', () => {
    const data = { vehicleOwnershipStatus: 'LLD', ...vehicule('LLD', { contractStartDate: '2024-03-20', leaseDurationMonths: 36 }) };
    expect(changedDetailFields(data, { ...data, mileage: 12000 })).toEqual({ mileage: 12000 });
    expect(changedDetailFields(data, { ...data, leaseEndDate: '2027-06-30' })).toEqual({ leaseEndDate: '2027-06-30' });
  });

  it('clés écrites par la primitive canonique pour la famille (origine USER, comme leurs voisines)', () => {
    expect(canonicalWritesOf({ leaseEndDate: '2027-06-30' }, 'VEHICULE')).toEqual([{ key: 'leaseEndDate', value: '2027-06-30' }]);
    expect(canonicalWritesOf({ contractEndDate: '2027-06-30' }, 'VEHICULE')).toEqual([{ key: 'contractEndDate', value: '2027-06-30' }]);
    expect(canonicalWritesOf({ leaseEndDate: '2028-06-30' }, 'IMMOBILIER')).toHaveLength(1);
    expect(canonicalWritesOf({ contractEndDate: '2026-12-31' }, 'OBJECT')).toHaveLength(1);
    // La métadonnée de provenance n'est jamais une clé du registre.
    expect(canonicalWritesOf({ [TENURE_META_KEY]: { key: 'leaseEndDate' } }, 'VEHICULE')).toEqual([]);
  });

  it('route GET /details : les trois sections usage portent la date de fin (et sa provenance)', () => {
    for (const s of ['occupancy_usage', 'vehicle_usage', 'object_usage']) {
      const bloc = new RegExp(`sections\\.${s} = \\{([\\s\\S]*?)\\n\\s+\\};`).exec(ROUTE)![1];
      expect(bloc, s).toMatch(/\.\.\.tenureEndFields\(/);
    }
    expect(TAB).toContain("...tenureEndDefs('VEHICULE')");
  });
});
