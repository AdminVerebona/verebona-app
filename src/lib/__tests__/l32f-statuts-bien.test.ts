/**
 * Lot 32 — PO-Q11 : liste officielle des statuts d'un bien (EN_SERVICE,
 * ARCHIVED, TRANSMIS, VENDU — « pas besoin de maintenance etc »), alignée
 * entre API, interface, base (0278), À traiter (ASSET-STATUS), assistant et
 * exports.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {} }));

import {
  ASSET_STATUSES, LEGACY_ASSET_STATUS_MAP, OUT_OF_PORTFOLIO_ASSET_STATUSES, assetStatusBadgeVariant, assetStatusLabel,
  isOutOfPortfolioStatus, isReadOnlyAssetStatus, normalizeAssetStatus,
} from '../asset-status';
import { isAssetAvailableForAssistant, ASSISTANT_EXCLUDED_ASSET_STATUSES } from '@/services/verebona-assistant/core/asset-availability';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

describe('PO-Q11 — liste officielle', () => {
  // Carte #849 (arbitrages PO du 25/11/2026) — règle remplacée : la liste officielle du lot 32 (quatre
  // statuts EN_SERVICE / VENDU / TRANSMIS / ARCHIVED) est réduite à DEUX statuts ; VENDU et ARCHIVED sont
  // convertis en TRANSMIS (migration 2013, trace idempotente). Les assertions ci-dessous encodaient la
  // liste à quatre valeurs, déclarée défectueuse par la carte : elles sont adaptées, même portée.
  it('deux statuts, et seulement eux (#849)', () => {
    expect([...ASSET_STATUSES].sort()).toEqual(['EN_SERVICE', 'TRANSMIS']);
    expect(ASSET_STATUSES.map(assetStatusLabel)).toEqual(['En service', 'Transmis']);
  });

  it('anciennes valeurs lisibles, converties comme les migrations 0278 et 2013', () => {
    for (const v of ['EN_MAINTENANCE', 'HORS_SERVICE', 'EN_PANNE', 'EN_REPARATION', 'INACTIF']) expect(normalizeAssetStatus(v)).toBe('EN_SERVICE');
    for (const v of ['DETRUIT', 'VENDU', 'vendu', 'ARCHIVED']) expect(normalizeAssetStatus(v)).toBe('TRANSMIS');
    expect(normalizeAssetStatus(null)).toBe('EN_SERVICE');
    const migration = read('src/db/migrations/0278_asset_status_official_list.sql');
    for (const ancien of ['EN_MAINTENANCE', 'HORS_SERVICE', 'EN_PANNE', 'EN_REPARATION', 'INACTIF', 'DETRUIT']) {
      expect(LEGACY_ASSET_STATUS_MAP[ancien], ancien).toBeDefined();
      expect(migration, ancien).toContain(`'${ancien}'`);
    }
    expect(migration).toMatch(/SET status = 'ARCHIVED'[\s\S]*WHERE status = 'DETRUIT'/);
    expect(migration).toMatch(/WHERE status IN \('EN_MAINTENANCE', 'HORS_SERVICE', 'EN_PANNE', 'EN_REPARATION', 'INACTIF'\)/);
    expect(read('src/db/migrations/2013_c849_statuts_bien_deux_valeurs.sql'))
      .toMatch(/UPDATE assets SET status = 'TRANSMIS' WHERE status IN \('VENDU', 'ARCHIVED', 'DETRUIT'\)/);
  });

  it('contrainte en base = liste officielle (migration 2013 et schéma Drizzle)', () => {
    const liste = ASSET_STATUSES.map((s) => `'${s}'`).join(', ');
    expect(read('src/db/migrations/2013_c849_statuts_bien_deux_valeurs.sql')).toContain(`CHECK (status IN (${liste})) NOT VALID`);
    expect(read('src/db/schema.ts')).toContain(`${'${table.status}'} IN (${liste})`);
  });

  it('API : création / modification et fiche n’acceptent que la liste officielle', () => {
    const api = read('src/app/api/assets/route.ts');
    expect(api).toContain('const VALID_STATUSES: readonly string[] = ASSET_STATUSES;');
    expect(api).not.toMatch(/'EN_PANNE'|'DETRUIT'|'INACTIF'/);
    const fiche = read('src/services/asset-details-write.service.ts');
    expect(fiche).toContain('const VALID_STATUSES: readonly string[] = ASSET_STATUSES;');
  });

  it('interface : badges et filtres depuis la liste officielle ; transmis sorti du portefeuille et en consultation seule', () => {
    expect(isOutOfPortfolioStatus('TRANSMIS')).toBe(true);
    expect(isOutOfPortfolioStatus('VENDU')).toBe(true);
    expect(isOutOfPortfolioStatus('EN_PANNE')).toBe(false);
    expect(isReadOnlyAssetStatus('TRANSMIS')).toBe(true);
    expect(isReadOnlyAssetStatus('EN_SERVICE')).toBe(false);
    expect(assetStatusBadgeVariant('TRANSMIS')).toBe('sold');
    expect(assetStatusBadgeVariant('HORS_SERVICE')).toBe('active');
    // Lot 65A : `components/dashboard/AssetCard.tsx` supprimé (aucun écran ne l'utilisait).
    for (const f of ['src/app/(dashboard)/assets/page.tsx', 'src/app/(dashboard)/assets/[id]/page.tsx']) {
      const src = read(f);
      expect(src, f).toContain("from '@/lib/asset-status'");
      expect(src, f).not.toMatch(/'EN_PANNE'|'EN_REPARATION'|'DETRUIT'|'INACTIF'|'HORS_SERVICE'|'EN_MAINTENANCE'/);
    }
    expect(read('src/app/(dashboard)/assets/page.tsx')).toContain('Biens transmis');
  });

  it('exports : libellé officiel, ancienne valeur exportée sous son statut officiel', () => {
    const src = read('src/services/exports/v12/data/mappers/common.ts');
    expect(src).toContain('assetStatusLabel(s.asset.status)');
    expect(src).not.toContain("EN_PANNE: 'En panne'");
  });

  it('assistant : bien transmis (et anciennes valeurs) exclu de la résolution standard', () => {
    for (const s of OUT_OF_PORTFOLIO_ASSET_STATUSES) expect(new Set(ASSISTANT_EXCLUDED_ASSET_STATUSES).has(s)).toBe(true);
    expect(isAssetAvailableForAssistant({ status: 'TRANSMIS' })).toBe(false);
    expect(isAssetAvailableForAssistant({ status: 'VENDU' })).toBe(false);
    expect(isAssetAvailableForAssistant({ status: 'VENDU' }, { includeArchived: true })).toBe(true);
    expect(isAssetAvailableForAssistant({ status: 'EN_SERVICE' })).toBe(true);
  });

  it('accueil et listes : biens transmis exclus par défaut', () => {
    expect(read('src/services/home/HomeSummaryService.ts')).toContain('notInArray(assets.status, [...OUT_OF_PORTFOLIO_ASSET_STATUSES])');
    expect(read('src/app/api/assets/route.ts')).toContain('notInArray(assets.status, [...OUT_OF_PORTFOLIO_ASSET_STATUSES])');
  });
});
