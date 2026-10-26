/**
 * « Bien mis en location » retiré : l'usage « Mis en location » de la fiche
 * est la seule donnée qui dit qu'un bien est loué.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { isRentedFromCharacteristics, occupancyUsageLabel, OCCUPANCY_USAGE_OPTIONS, SQL_IS_RENTED } from '../occupancy';
import { isResolvableFromCard } from '@/services/to-process/resolve-action.service';
import { findRule } from '@/services/to-process/rules-catalog';

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('usage « Mis en location »', () => {
  it('libellé clarifié, code stocké inchangé', () => {
    expect(OCCUPANCY_USAGE_OPTIONS).toContainEqual({ value: 'LOCATIF', label: 'Mis en location' });
    expect(OCCUPANCY_USAGE_OPTIONS.some((o) => o.label === 'Locatif')).toBe(false);
    expect(occupancyUsageLabel('LOCATIF')).toBe('Mis en location');
  });
  it('lecture tolérante des caractéristiques', () => {
    expect(isRentedFromCharacteristics('{"occupancyUsage":"LOCATIF"}')).toBe(true);
    expect(isRentedFromCharacteristics({ occupancyUsage: 'RESIDENCE_PRINCIPALE' })).toBe(false);
    expect(isRentedFromCharacteristics('pas du json')).toBe(false);
    expect(isRentedFromCharacteristics(null)).toBe(false);
  });
  it('lecture SQL sans conversion jsonb', () => {
    expect(SQL_IS_RENTED('a')).not.toMatch(/::jsonb/);
    expect(SQL_IS_RENTED('a')).toMatch(/LOCATIF/);
  });
});

describe('attribut retiré', () => {
  it('plus de composant, de route ni de service', () => {
    for (const p of ['src/components/assets/v2/RentalStatusField.tsx', 'src/app/api/v2/assets/[id]/rental/route.ts', 'src/services/assets/rental-status.service.ts']) {
      expect(existsSync(join(process.cwd(), p))).toBe(false);
    }
    expect(src('src/components/assets/AssetDetailsTab.tsx')).not.toMatch(/RentalStatusField/);
  });
  it('plus de règle À traiter ni d’écriture depuis une carte', () => {
    expect(findRule('ASSET', 'isRented')).toBeUndefined();
    expect(isResolvableFromCard('ASSET', 'isRented')).toBe(false);
  });
  it('visibilité de la Rubrique locative et assistant : lus sur l’usage', () => {
    expect(src('src/services/documents/rubric-query.service.ts')).toMatch(/isRentedFromCharacteristics/);
    expect(src('src/services/verebona-assistant/core/account-data.repository.ts')).not.toMatch(/is_rented/);
    expect(src('src/db/schema.ts')).not.toMatch(/isRented:/);
  });
  it('migration : report sans écraser un usage saisi, actions ouvertes closes', () => {
    const m = src('src/db/migrations/0160_rental_attribute_to_occupancy_usage.sql');
    expect(m).toMatch(/coalesce\(kc->>'occupancyUsage', ''\) = ''/);
    expect(m).toMatch(/field_key = 'isRented' AND resolved_at IS NULL/);
    expect(m).not.toMatch(/DROP COLUMN/);
  });
});
