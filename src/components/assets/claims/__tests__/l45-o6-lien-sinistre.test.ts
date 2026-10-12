/**
 * Lot 45 — O6 : source « sinistre » de l'assistant (desktop ET mobile —
 * même page de bien, même rubrique responsive). Le lien
 * `/assets/<id>?tab=details&highlight=claims&claim=<id>` ouvre la rubrique
 * Sinistres sur ce sinistre ; jamais une page « Opération » (P09).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hrefSource } from '@/services/verebona-assistant/core/entity-ref';

const lire = (p: string) => readFileSync(resolve(__dirname, '..', '..', '..', '..', p), 'utf8').replace(/\r\n?/g, '\n');

describe('O6-UI-01 — ouverture d’une source sinistre (desktop et mobile)', () => {
  it('le lien mène à la fiche du bien, onglet Détails, rubrique Sinistres, sinistre choisi', () => {
    const href = hrefSource('claim:12:34');
    expect(href).toBe('/assets/12?tab=details&highlight=claims&claim=34');
    expect(href).not.toMatch(/operation/i);
  });

  it('la page transmet le sinistre demandé ; la rubrique s’ouvre, défile et sélectionne ce sinistre s’il est du bien', () => {
    const page = lire('app/(dashboard)/assets/[id]/page.tsx');
    expect(page).toContain("highlightClaimId={Number(searchParams.get('claim')) || null}");
    const onglet = lire('components/assets/AssetDetailsTab.tsx');
    expect(onglet).toContain("defaultOpen={highlightField === 'claims'}");
    expect(onglet).toContain("initialClaimId={highlightField === 'claims' ? highlightClaimId : null}");
    const rubrique = lire('components/assets/claims/AssetClaimsSection.tsx');
    expect(rubrique).toContain('data.claims.some((c) => c.id === initialClaimId)');
    expect(rubrique).toContain("getElementById('asset-section-claims')");
    // Une seule rubrique pour les deux affichages (pas de variante mobile séparée).
    expect(rubrique).toMatch(/Desktop et mobile : même composant/);
  });
});
