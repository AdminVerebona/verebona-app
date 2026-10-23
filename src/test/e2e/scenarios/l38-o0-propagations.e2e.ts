/**
 * Lot 38 — O0 (CDC Opérations V1 §19, §24, B18, B24, C18) — base PostgreSQL
 * réelle : migration 0315 (moteur de propagation retiré au lot 82B), primitive canonique et
 * `valuationHistory` (décision PO Q12).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { scenario } from '../scenario';

scenario('L38-O0', 'Propagations génériques neutralisées, valorisation tracée', ({ sql, make }) => {
  it('O0-E2E-01 migration 0315 : règles génériques désactivées, idempotente (lot 82B : le moteur qui les lisait est retiré)', async () => {
    const regles = await sql<{ id: number }[]>`
      INSERT INTO field_dependencies (source_field, target_field, category, impact_type, transform_rule, confidence, is_active)
      VALUES ('amountCents', 'acquisitionPrice', NULL, 'propagation', 'cents_to_euros', 'certain', true),
             ('amountCents', 'estimatedValue', NULL, 'propagation', 'cents_to_euros', 'probable', true),
             ('documentDate', 'acquisitionDate', NULL, 'propagation', 'copy_date', 'probable', true),
             ('documentDate', 'documentDate_agenda', NULL, 'agenda_creation', NULL, 'certain', true)
      ON CONFLICT (source_field, target_field, category) DO UPDATE SET is_active = true
      RETURNING id`;
    const ids = regles.map((r) => r.id);
    try {
      // La migration désactive ; rejouée, elle ne change plus rien.
      const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0315_neutralize_generic_propagations.sql'), 'utf8');
      await sql.unsafe(migration);
      await sql.unsafe(migration);
      const etats = await sql<{ active: boolean }[]>`SELECT is_active AS active FROM field_dependencies WHERE id = ANY(${ids})`;
      expect(etats.map((e) => e.active)).toEqual([false, false, false, false]);
      // Lot 82B (C-Q9) : plus aucun moteur ne lit ces règles.
      const { existsSync } = await import('node:fs');
      expect(existsSync(join(process.cwd(), 'src/services/coherence/impact-propagation.service.ts'))).toBe(false);
    } finally {
      await sql`DELETE FROM field_dependencies WHERE id = ANY(${ids})`;
    }
  });

  it('O0-E2E-02 / F-161 valorisation automatique (T3) : valuationHistory alimenté avec sa source ; prix d’achat jamais', async () => {
    const { writeCanonicalAssetField } = await import('@/services/canonical/asset-state');
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'OBJECT', name: 'Tableau' });
    const expertise = await make.assetFile(compte, { assetId: bien.id, name: 'expertise.pdf' });
    const facture = await make.assetFile(compte, { assetId: bien.id, name: 'facture.pdf' });
    const auto = await writeCanonicalAssetField({
      assetId: bien.id, accountId: compte.id, key: 'estimatedValue', value: 4500, origin: 'RECONCILIATION',
      source: { type: 'document', id: expertise.id }, trace: { sourceDate: '2026-09-01T00:00:00.000Z' }, emitEvent: false,
    });
    expect(auto.field?.outcome).toBe('written');
    await writeCanonicalAssetField({
      assetId: bien.id, accountId: compte.id, key: 'acquisitionPrice', value: 3000, origin: 'RECONCILIATION',
      source: { type: 'document', id: facture.id }, emitEvent: false,
    });
    const [a] = await sql<{ kc: string; evc: number | null }[]>`SELECT key_characteristics AS kc, estimated_value_cents AS evc FROM assets WHERE id = ${bien.id}`;
    const kc = JSON.parse(a.kc);
    expect(a.evc).toBe(450000);
    expect(kc.valuationHistory).toEqual([expect.objectContaining({
      value: 4500, date: '2026-09-01', source: 'AI', origin: 'RECONCILIATION', sourceType: 'document', sourceId: String(expertise.id), evidenceId: null,
    })]);
  });
});
