/**
 * Lot 53 (53B) — retour PO Q18 (étiquetage multi-biens des sélecteurs de
 * pièces et de photos) et D23 (BO › Relations intercomptes) : câblage des
 * écrans, ordinateur ET mobile (mêmes composants, mise en page responsive).
 *
 * Lot 83D (V-Q1) : le formulaire Sinistre et ses routes sont retirés —
 * PO-Q18-05 et PO-Q18-07 (formulaire et route `/claims`) n'ont plus d'objet ;
 * l'absence de ces chemins est prouvée par L83D-U01. Restent les sélecteurs
 * génériques (étiquette du bien porteur) et le contrôle de compte du service
 * de références.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const lire = (p: string) => readFileSync(resolve(__dirname, '..', '..', '..', '..', '..', p), 'utf8').replace(/\r\n?/g, '\n');

describe('PO-Q18 — sélecteurs de pièces et de photos (étiquette du bien porteur)', () => {
  it('PO-Q18-06 — chaque pièce / photo d’un autre bien est étiquetée du nom de son bien (sélecteurs multiple et simple)', () => {
    const picker = lire('src/components/assets/additional-infos/AdditionalInfosRefPicker.tsx');
    expect(picker).toContain('meta: [p.assetName, frDate(p.date)]');
    expect(picker).toContain('meta: [d.assetName, d.typeLabel, frDate(d.date)]');
    // Responsive : largeur bornée à l'écran (mobile), liste défilante.
    expect(picker).toContain('w-[min(92vw,380px)]');
    expect(picker).toContain('max-h-72 overflow-y-auto');
    const field = lire('src/components/assets/additional-infos/AdditionalInfosListField.tsx');
    expect(field).toContain("{d.assetName ? ` · ${d.assetName}` : ''}");
    const dto = lire('src/lib/assets/additional-infos.ts');
    expect(dto).toMatch(/occupantData: boolean; assetId\?: number; assetName\?: string \| null/);
  });

  it('PO-Q18-07 — serveur : photos vérifiées par leur bien porteur, dans le compte courant', () => {
    const svc = lire('src/services/exports/additional-infos-references.service.ts');
    expect(svc).toContain('innerJoin(assets, and(eq(assets.id, assetPhotos.assetId), eq(assets.accountId, accountId), isNull(assets.deletedAt)))');
  });
});

describe('PO-D23 — BO › Exploitation › Relations intercomptes (ordinateur et mobile)', () => {
  it('PO-D23-11 — qualification par catégorie, tuiles corrigeables / Duo / indécidables, journal et accès à la correction', () => {
    const p = lire('src/app/admin/exploitation/_components/CrossAccountPanel.tsx');
    expect(p).toContain('function Qualification');
    expect(p).toContain('Duo : signalées, non corrigées');
    expect(p).toContain('Indécidables (compte inconnu)');
    expect(p).toContain('/admin/exploitation?tab=rattrapages');
    expect(p).toContain('testId="cross-account-journal"');
    expect(p).toContain("{ key: 'a_traiter', label: 'À traiter' }");
    // Mobile : grilles 2 colonnes puis 3/4, tableaux défilants, textes qui reviennent à la ligne.
    expect(p).toContain('grid grid-cols-2 sm:grid-cols-3 gap-3');
    expect(p.match(/overflow-x-auto/g)?.length).toBeGreaterThanOrEqual(2);
    expect(p).toContain('break-words');
  });
});
