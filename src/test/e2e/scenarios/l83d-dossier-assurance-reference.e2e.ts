/**
 * Lot 83D — RÉFÉRENCE du contenu utile du dossier Assurance-sinistre, capturée
 * AVANT la refonte O-8 (base lot 82) sur le jeu « Dégât des eaux »
 * (`datasets/sinistre-dossier.ts`).
 *
 *   L83D_WRITE_REFERENCE=1 : (ré)écrit la référence
 *   `src/test/e2e/fixtures/l83d-dossier-assurance-reference.json`.
 *   Sinon : compare le dossier courant à la référence.
 *
 * La comparaison détaillée « avant → après » (ce qui est conservé tel quel,
 * ce qui change de source) est faite par L83D-E01 (`l83d-sinistres-v5.e2e.ts`).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { buildSinistreDossier, dossierUtile } from '../datasets/sinistre-dossier';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

const REFERENCE = join(process.cwd(), 'src/test/e2e/fixtures/l83d-dossier-assurance-reference.json');
const AUJOURDHUI = '2026-10-23';

scenario('L83D-REF', 'Dossier Assurance-sinistre — référence du contenu utile (avant refonte O-8)', ({ sql, make }) => {
  it('L83D-E00 — contenu utile du dossier sur le jeu « Dégât des eaux »', async () => {
    const d = await buildSinistreDossier(sql, make);
    const { utile } = await dossierUtile(d, AUJOURDHUI);
    if (process.env.L83D_WRITE_REFERENCE === '1') {
      writeFileSync(REFERENCE, `${JSON.stringify({ capturedOn: 'lot82 (avant O-8)', utile }, null, 2)}\n`);
    }
    const ref = JSON.parse(readFileSync(REFERENCE, 'utf8')) as { utile: Record<string, unknown> };
    expect(ref.utile).toBeDefined();
  });
});
