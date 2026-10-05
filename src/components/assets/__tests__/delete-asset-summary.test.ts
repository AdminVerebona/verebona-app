/**
 * DeleteAssetDialog : le décompte annoncé avant confirmation.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/api-client', () => ({ apiClient: {} }));
const { describeDeletionSummary } = await import('../DeleteAssetDialog');

describe('describeDeletionSummary', () => {
  it('annonce chaque élément non nul, avec accord du pluriel', () => {
    expect(describeDeletionSummary({ documents: 12, photos: 0, deadlines: 1, events: 3, rooms: 0, equipments: 2 }))
      .toEqual(['12 documents', '1 échéance', '3 événements', '2 équipements']);
  });
  it('rien de rattaché : liste vide', () => {
    expect(describeDeletionSummary({ documents: 0, photos: 0, deadlines: 0, events: 0, rooms: 0, equipments: 0 })).toEqual([]);
  });
});

// « Mes biens » avait sa propre confirmation, sans décompte : la même
// suppression annonçait ce qu'elle emportait depuis la fiche, pas depuis la
// liste.
describe('page « Mes biens »', () => {
  it('utilise DeleteAssetDialog (avec décompte), plus de confirmation maison', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const page = readFileSync(join(process.cwd(), 'src/app/(dashboard)/assets/page.tsx'), 'utf8');
    expect(page).toContain('<DeleteAssetDialog');
    expect(page).not.toMatch(/<AlertDialog[\s>]/);
  });
});
