/**
 * Lot 105E — décision PO du 02/11/2026 : badges « Automatique » et « Donnée à
 * qualifier » supprimés de toutes les vues Agenda (fiche, liste, onglet du bien),
 * quel que soit le statut ou le mode de création. Les métadonnées restent en base.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { visibleAttentionFlags, attentionFlagLabel, HIDDEN_ATTENTION_FLAGS } from '@/lib/agenda/attention-flags';

const lire = (f: string) => readFileSync(f, 'utf8');
const VUES = [
  'src/components/agenda/AgendaItemDrawer.tsx',
  'src/app/(dashboard)/agenda/page.tsx',
  'src/components/assets/AssetAgendaTab.tsx',
];

describe('L105E — badges internes retirés de l’Agenda', () => {
  it('« Donnée à qualifier » n’est jamais affiché, quel que soit le statut', () => {
    for (const flags of [['donnee_distincte_a_qualifier'], ['donnee_distincte_a_qualifier', 'en_retard'], ['en_retard', 'donnee_distincte_a_qualifier', 'sans_bien']]) {
      expect(visibleAttentionFlags(flags)).not.toContain('donnee_distincte_a_qualifier');
    }
    expect(visibleAttentionFlags(['sans_bien', 'date_incoherente'])).toEqual(['sans_bien', 'date_incoherente']);
    expect(HIDDEN_ATTENTION_FLAGS.has('donnee_distincte_a_qualifier')).toBe(true);
    // Le signal reste connu (diagnostic, BO) : seul l'affichage utilisateur est retiré.
    expect(attentionFlagLabel('donnee_distincte_a_qualifier')).toBe('Donnée à qualifier');
  });

  it('aucune vue Agenda ne rend un badge « Automatique » ni un signal non filtré', () => {
    for (const f of VUES) {
      const src = lire(f);
      expect(src, f).not.toMatch(/>\s*Automatique\s*</);
      expect(src, f).not.toMatch(/\/>\s*Automatique/);
      // Les signaux passent toujours par la règle unique.
      if (src.includes('attentionFlags')) expect(src, f).toMatch(/visibleAttentionFlags\(/);
    }
  });

  // #715 : plus de statut d'événement — test « le statut métier reste affiché dans la fiche » supprimé
  // (il ne testait que le statut retiré) ; l'absence de statut est vérifiée par l113p-agenda-sans-statut.test.ts.
});
