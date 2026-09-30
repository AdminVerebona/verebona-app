/**
 * E2E-14 — Immatriculation : « Fiche, colonne, T2 et export identiques »
 * (CDC 15 §15). PARTIEL au lot 11.
 *
 * Couvert ici, sur le comportement EXISTANT (base réelle, migrations
 * rejouées) : la fiche (`key_characteristics`), la colonne
 * `registration_number` et la source d'export V12 (`loadExportSource`)
 * portent la même valeur quand elles ont été écrites ensemble ; et le cas
 * limite où seule la fiche la porte (colonne vide), tel qu'il se comporte
 * aujourd'hui.
 *
 * TODO(lot 11, agent B → L15/L16) : écrire la valeur par
 * `writeCanonicalAssetField` (src/services/canonical/asset-state) et lire la
 * fiche par `CanonicalAssetView` dès que la primitive est livrée ; lecture T2
 * ajoutée au lot 15 (`ASSISTANT_CANONICAL_READ`) ; reste l'export canonique (L16,
 * `EXPORTS_CANONICAL_SOURCE`). Le cas limite deviendra alors : colonne
 * miroir remplie par la primitive (D-10 : la fiche fait foi).
 */
import { it, expect } from 'vitest';
import { scenario } from '../scenario';

scenario('E2E-14', 'Immatriculation — fiche, colonne et export identiques', ({ sql, make }) => {
  it('nominal : fiche, colonne et source d’export portent la même immatriculation', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, {
      category: 'VEHICULE', registrationNumber: 'AB-123-CD',
      keyCharacteristics: { registrationNumber: 'AB-123-CD' },
    });

    const [ligne] = await sql<{ registration_number: string | null; key_characteristics: string | null }[]>`
      SELECT registration_number, key_characteristics FROM assets WHERE id = ${bien.id}`;
    const fiche = JSON.parse(ligne.key_characteristics ?? '{}') as Record<string, unknown>;

    const { loadExportSource } = await import('@/services/exports/v12/data/source');
    const source = await loadExportSource({
      assetId: bien.id, accountId: compte.id, userId: compte.ownerUserId, exportType: 'DOSSIER_COMPLET',
    });

    expect(ligne.registration_number).toBe('AB-123-CD');
    expect(fiche.registrationNumber).toBe('AB-123-CD');
    expect(source.asset.registrationNumber).toBe('AB-123-CD');
  });

  it('limite (comportement actuel) : fiche seule, colonne vide — l’export lit la colonne', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, {
      category: 'VEHICULE', registrationNumber: null,
      keyCharacteristics: { registrationNumber: 'EF-456-GH' },
    });
    const { loadExportSource } = await import('@/services/exports/v12/data/source');
    const source = await loadExportSource({
      assetId: bien.id, accountId: compte.id, userId: compte.ownerUserId, exportType: 'DOSSIER_COMPLET',
    });
    // Divergence constatée (X-02) : la colonne est vide, la valeur n'existe
    // que dans la fiche. Le rendu la rattrape (`mappers/common.ts` :
    // colonne ?? fiche) ; la cible D-10 est une colonne miroir remplie.
    expect(source.asset.registrationNumber).toBeNull();
    expect(source.asset.characteristics.registrationNumber ?? null).toBe('EF-456-GH');
  });

  it.todo('écriture par writeCanonicalAssetField : colonne miroir = fiche (D-10) — primitive de l’agent B');
  it('T2 répond la même immatriculation que la fiche (L15, ASSISTANT_CANONICAL_READ=enabled), colonne vide comprise', async () => {
    const avant = process.env.ASSISTANT_CANONICAL_READ;
    process.env.ASSISTANT_CANONICAL_READ = 'enabled';
    try {
      const compte = await make.account();
      const bien = await make.asset(compte, {
        category: 'VEHICULE', name: 'Clio', registrationNumber: null,
        keyCharacteristics: { registrationNumber: 'EF-456-GH' },
      });
      const { answerFromData } = await import('@/services/verebona-assistant/core/data-answer.service');
      const { accountDataRepository } = await import('@/services/verebona-assistant/core/account-data.repository');
      const { DEFAULT_THRESHOLDS } = await import('@/services/verebona-assistant/core/sufficiency');
      const r = await answerFromData({
        port: accountDataRepository, accountId: compte.id, message: 'Quelle est l’immatriculation de la Clio ?', thresholds: DEFAULT_THRESHOLDS,
      });
      expect(r.strategy).toBe('structured.asset_field');
      expect(r.answer).toContain('EF-456-GH');
      expect(r.sources[0].id).toBe(`asset_field:${bien.id}:registrationNumber`);
    } finally {
      if (avant === undefined) delete process.env.ASSISTANT_CANONICAL_READ; else process.env.ASSISTANT_CANONICAL_READ = avant;
    }
  });
});
