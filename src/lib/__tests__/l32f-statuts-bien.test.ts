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
  it('quatre statuts, et seulement eux', () => {
    expect([...ASSET_STATUSES].sort()).toEqual(['ARCHIVED', 'EN_SERVICE', 'TRANSMIS', 'VENDU']);
    expect(ASSET_STATUSES.map(assetStatusLabel)).toEqual(['En service', 'Vendu', 'Transmis', 'Archivé']);
  });

  it('anciennes valeurs lisibles, converties comme la migration 0278', () => {
    for (const v of ['EN_MAINTENANCE', 'HORS_SERVICE', 'EN_PANNE', 'EN_REPARATION', 'INACTIF']) expect(normalizeAssetStatus(v)).toBe('EN_SERVICE');
    expect(normalizeAssetStatus('DETRUIT')).toBe('ARCHIVED');
    expect(normalizeAssetStatus(null)).toBe('EN_SERVICE');
    expect(normalizeAssetStatus('vendu')).toBe('VENDU');
    const migration = read('src/db/migrations/0278_asset_status_official_list.sql');
    for (const ancien of Object.keys(LEGACY_ASSET_STATUS_MAP)) expect(migration, ancien).toContain(`'${ancien}'`);
    expect(migration).toMatch(/SET status = 'ARCHIVED'[\s\S]*WHERE status = 'DETRUIT'/);
    expect(migration).toMatch(/WHERE status IN \('EN_MAINTENANCE', 'HORS_SERVICE', 'EN_PANNE', 'EN_REPARATION', 'INACTIF'\)/);
  });

  it('contrainte en base = liste officielle (migration 0278 et schéma Drizzle)', () => {
    const liste = ASSET_STATUSES.map((s) => `'${s}'`).join(', ');
    expect(read('src/db/migrations/0278_asset_status_official_list.sql')).toContain(`CHECK (status IN (${liste})) NOT VALID`);
    expect(read('src/db/schema.ts')).toContain(`${'${table.status}'} IN (${liste})`);
  });

  it('API : création / modification et fiche n’acceptent que la liste officielle', () => {
    const api = read('src/app/api/assets/route.ts');
    expect(api).toContain('const VALID_STATUSES: readonly string[] = ASSET_STATUSES;');
    expect(api).not.toMatch(/'EN_PANNE'|'DETRUIT'|'INACTIF'/);
    const fiche = read('src/services/asset-details-write.service.ts');
    expect(fiche).toContain("ASSET_STATUSES.filter((s) => s !== 'ARCHIVED')");
  });

  it('interface : badges et filtres depuis la liste officielle ; vendu sorti du portefeuille mais modifiable', () => {
    expect(isOutOfPortfolioStatus('VENDU')).toBe(true);
    expect(isOutOfPortfolioStatus('EN_PANNE')).toBe(false);
    expect(isReadOnlyAssetStatus('VENDU')).toBe(false);
    expect(isReadOnlyAssetStatus('TRANSMIS')).toBe(true);
    expect(isReadOnlyAssetStatus('ARCHIVED')).toBe(true);
    expect(assetStatusBadgeVariant('VENDU')).toBe('sold');
    expect(assetStatusBadgeVariant('HORS_SERVICE')).toBe('active');
    for (const f of ['src/app/(dashboard)/assets/page.tsx', 'src/app/(dashboard)/assets/[id]/page.tsx', 'src/components/dashboard/AssetCard.tsx']) {
      const src = read(f);
      expect(src, f).toContain("from '@/lib/asset-status'");
      expect(src, f).not.toMatch(/'EN_PANNE'|'EN_REPARATION'|'DETRUIT'|'INACTIF'|'HORS_SERVICE'|'EN_MAINTENANCE'/);
    }
    expect(read('src/app/(dashboard)/assets/page.tsx')).toContain('Afficher les biens vendus, transmis ou archivés');
  });

  it('exports : libellé officiel, ancienne valeur exportée sous son statut officiel', () => {
    const src = read('src/services/exports/v12/data/mappers/common.ts');
    expect(src).toContain('assetStatusLabel(s.asset.status)');
    expect(src).not.toContain("EN_PANNE: 'En panne'");
  });

  it('assistant : VENDU exclu comme ARCHIVED / TRANSMIS (bien cédé, sorti du portefeuille)', () => {
    expect(new Set(ASSISTANT_EXCLUDED_ASSET_STATUSES)).toEqual(new Set(OUT_OF_PORTFOLIO_ASSET_STATUSES));
    expect(isAssetAvailableForAssistant({ status: 'VENDU' })).toBe(false);
    expect(isAssetAvailableForAssistant({ status: 'VENDU' }, { includeArchived: true })).toBe(true);
    expect(isAssetAvailableForAssistant({ status: 'EN_SERVICE' })).toBe(true);
  });

  it('accueil et listes : biens vendus exclus par défaut comme transmis / archivés', () => {
    expect(read('src/services/home/HomeSummaryService.ts')).toContain('notInArray(assets.status, [...OUT_OF_PORTFOLIO_ASSET_STATUSES])');
    expect(read('src/app/api/assets/route.ts')).toContain('notInArray(assets.status, [...OUT_OF_PORTFOLIO_ASSET_STATUSES])');
  });
});
