/**
 * Lot 26 — point 11 : notifications « quota d'analyses » retirées.
 *
 * L26-11-AC5 : ANALYSIS_QUOTA_90 / ANALYSIS_QUOTA_100 n'existent plus
 *              (types, catalogue — donc ni e-mail, ni push, ni cloche).
 * L26-11-AC6 : plus aucun déclencheur dans le modèle commercial.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getCatalogEntry } from '@/lib/notifications/catalog';
import { NOTIFICATION_TYPES } from '@/types/notifications';

const racine = resolve(__dirname, '..', '..', '..', '..');

describe('quota d’analyses : notifications retirées', () => {
  it('L26-11-AC5 : types et catalogue', () => {
    for (const t of ['ANALYSIS_QUOTA_90', 'ANALYSIS_QUOTA_100']) {
      expect(Object.keys(NOTIFICATION_TYPES)).not.toContain(t);
      expect(getCatalogEntry(t)).toBeUndefined();
    }
  });

  it('L26-11-AC6 : aucun déclencheur ni modèle d’e-mail référencé', () => {
    const service = readFileSync(resolve(racine, 'src/services/commercial-model.service.ts'), 'utf8');
    expect(service).not.toMatch(/ANALYSIS_QUOTA_(90|100)/);
    expect(service).not.toMatch(/emitThresholdNotifications/);
    const catalogue = readFileSync(resolve(racine, 'src/lib/notifications/catalog.ts'), 'utf8');
    expect(catalogue).not.toMatch(/notif_quota/);
  });
});
