/**
 * Lot 43 (O4, décision PO Q5) — vente réalisée sur la fiche et à l'écran
 * « À traiter » : rendus desktop ET mobile (mêmes composants, mise en page
 * responsive). Le prix souhaité reste distinct (C18) ; aucune Opération
 * n'est montrée (P09).
 *
 * O4-UI-01 fiche (section « Informations générales ») : VENDU → date et prix
 *          réalisés ; TRANSMIS → date seule ; en service → rien.
 * O4-UI-02 fenêtre après passage à VENDU / TRANSMIS : facultative, date (+
 *          prix pour une vente), « Plus tard ».
 * O4-UI-03 déclenchement : seulement une carte de STATUT de bien résolue vers
 *          VENDU / TRANSMIS ; même fenêtre dans la file et la mascotte.
 * O4-UI-04 écriture : valeurs saisies seulement, prix en euros, date ISO.
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

(globalThis as { React?: typeof React }).React = React;
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const { AssetDetailSection, visibleFields } = await import('../AssetDetailSection');
const { getCommonFields } = await import('../AssetDetailsTab');
const { SaleDetailsForm } = await import('../SaleDetailsDialog');
const { saleFollowUpFor } = await import('@/components/to-process/useToProcessResolution');
const { saleDetailsPatch, saleDetailsPrompt, withoutSaleFields } = await import('@/lib/assets/sale-fields');

const lire = (p: string) => readFileSync(resolve(__dirname, '..', '..', '..', p), 'utf8').replace(/\r\n?/g, '\n');

function fiche(status: string, data: Record<string, unknown> = {}) {
  return renderToStaticMarkup(h(AssetDetailSection, {
    title: 'Informations générales', sectionKey: 'common', assetId: 7, onRefresh: () => undefined,
    fields: getCommonFields('VEHICULE'),
    data: { name: 'Clio', acquisitionPrice: 18000, status, saleDate: '2026-09-30', salePrice: 12000, ...data },
  })).replace(/&#x27;/g, "'");
}

describe('O4-UI-01 fiche du bien : vente réalisée selon le statut (desktop et mobile)', () => {
  it('VENDU : date de vente et prix de vente réalisé, distincts du prix d\'achat', () => {
    const html = fiche('VENDU');
    expect(html).toContain('Date de vente / cession');
    expect(html).toContain('Prix de vente réalisé (€)');
    expect(html).toContain('30 septembre 2026');
    expect(html).toContain('12');
    expect(html).toContain('Prix d\'achat (€)');
    expect(html).not.toContain('Prix souhaité');
  });

  it('TRANSMIS : date seule (cession sans prix)', () => {
    const html = fiche('TRANSMIS');
    expect(html).toContain('Date de vente / cession');
    expect(html).not.toContain('Prix de vente réalisé');
  });

  it('en service : aucun champ de vente', () => {
    const html = fiche('EN_SERVICE');
    expect(html).not.toContain('Date de vente');
    expect(html).not.toContain('Prix de vente réalisé');
    expect(visibleFields(getCommonFields('IMMOBILIER'), { status: 'EN_SERVICE' }).map((f) => f.key)).not.toContain('saleDate');
  });

  it('même composant desktop / mobile : grille responsive (1 colonne sur mobile), toutes familles', () => {
    expect(fiche('VENDU')).toMatch(/grid grid-cols-1 sm:grid-cols-2/);
    for (const famille of ['IMMOBILIER', 'VEHICULE', 'OBJECT']) {
      expect(visibleFields(getCommonFields(famille), { status: 'VENDU' }).map((f) => f.key), famille).toEqual(expect.arrayContaining(['saleDate', 'salePrice']));
    }
    // La route de la fiche renvoie les deux clés dans la section commune.
    expect(lire('app/api/assets/[id]/details/route.ts')).toMatch(/saleDate: kc\.saleDate \?\? null,\s*salePrice: kc\.salePrice \?\? null/);
  });
});

describe('O4-UI-02 fenêtre « Vente enregistrée » / « Transmission enregistrée »', () => {
  const rendu = (status: 'VENDU' | 'TRANSMIS') => renderToStaticMarkup(h(SaleDetailsForm, {
    followUp: { assetId: 7, assetName: 'Clio', prompt: saleDetailsPrompt(status)! }, onSubmit: () => undefined, onSkip: () => undefined,
  }));

  it('vente : date et prix réalisés, facultatifs (« Plus tard »), mise en page mobile d\'abord', () => {
    const html = rendu('VENDU');
    expect(html).toContain('data-sale-details="VENDU"');
    expect(html).toContain('Date de vente');
    expect(html).toContain('Prix de vente réalisé (€)');
    expect(html).toContain('Plus tard');
    expect(html).toContain('Enregistrer');
    expect(html).toMatch(/grid grid-cols-1 gap-4 sm:grid-cols-2/);
    expect(html).toMatch(/flex flex-col-reverse gap-2 pt-2 sm:flex-row/);
  });

  it('transmission : date seule', () => {
    const html = rendu('TRANSMIS');
    expect(html).toContain('Date de transmission');
    expect(html).not.toContain('Prix de vente');
  });
});

describe('O4-UI-03 déclenchement après une carte « À traiter »', () => {
  const carte = (over: Record<string, unknown> = {}) => ({
    publicId: 'a1', targetType: 'ASSET', targetId: 7, fieldKey: 'status', relationKey: null, actionKind: 'ARBITRATE', priority: 'NORMAL',
    ruleCode: 'ASSET-STATUS', question: 'Ce bien a-t-il été vendu ?', proposals: [], target: { label: 'Clio', assetName: 'Clio' }, ...over,
  }) as never;

  it('statut résolu vers VENDU / TRANSMIS → fenêtre ; autre valeur ou autre carte → rien', () => {
    expect(saleFollowUpFor(carte(), 'VENDU')).toMatchObject({ assetId: 7, assetName: 'Clio', prompt: { status: 'VENDU', askPrice: true } });
    expect(saleFollowUpFor(carte(), 'TRANSMIS')).toMatchObject({ prompt: { status: 'TRANSMIS', askPrice: false } });
    expect(saleFollowUpFor(carte(), 'EN_SERVICE')).toBeNull();
    expect(saleFollowUpFor(carte({ fieldKey: 'insuranceExpiry' }), 'VENDU')).toBeNull();
    expect(saleFollowUpFor(carte({ targetType: 'DOCUMENT' }), 'VENDU')).toBeNull();
  });

  it('même fenêtre dans la file (desktop / mobile) et dans les choix de la mascotte', () => {
    for (const f of ['components/to-process/ToProcessQueue.tsx', 'components/home/TodoChoicesDialog.tsx']) {
      expect(lire(f), f).toMatch(/<SaleDetailsDialog followUp=\{saleFollowUp\} onClose=\{closeSaleFollowUp\} \/>/);
    }
  });
});

describe('O4-UI-04 écriture vers la fiche', () => {
  it('valeurs saisies seulement, prix en euros, virgule acceptée ; rien saisi → aucune écriture', () => {
    const vente = saleDetailsPrompt('VENDU')!;
    expect(saleDetailsPatch(vente, { date: '2026-09-30', price: '12 000,50' })).toEqual({ fields: { saleDate: '2026-09-30', salePrice: 12000.5 } });
    expect(saleDetailsPatch(vente, { date: '', price: '9000' })).toEqual({ fields: { salePrice: 9000 } });
    expect(saleDetailsPatch(vente, { date: '', price: '' })).toBeNull();
    expect(saleDetailsPatch(vente, { date: '', price: '-3' })).toEqual({ error: 'Prix invalide.' });
    // Transmission : un prix n'est jamais envoyé.
    expect(saleDetailsPatch(saleDetailsPrompt('TRANSMIS')!, { date: '2026-08-01', price: '5000' })).toEqual({ fields: { saleDate: '2026-08-01' } });
    expect(saleDetailsPrompt('EN_SERVICE')).toBeNull();
  });

  it('transmission acceptée : la vente réalisée de l\'émetteur n\'est pas copiée chez le destinataire', () => {
    expect(withoutSaleFields({ saleDate: '2026-01-01', saleDate__origin: 'USER', salePrice: 10, salePrice__updatedAt: 'x', salePrice_origin: 'manual', acquisitionPrice: 5, saleDateNote: 'garde' }))
      .toEqual({ acquisitionPrice: 5, saleDateNote: 'garde' });
    expect(lire('app/api/transmission/[token]/route.ts')).toMatch(/keyCharacteristics: JSON\.stringify\(withoutSaleFields\(\{/);
  });
});
