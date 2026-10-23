/**
 * Lot 53 — retour PO D17 (cohérence D4 / D15 / D17) : une date passée ne
 * prouve pas la réalisation. Cinq états distincts dans l'historique et le
 * suivi : « À venir », « Date échue », « Statut à confirmer », « Réalisé »,
 * « Annulé ». Un fait passé sans statut n'est ni affiché réalisé, ni masqué
 * comme terminé ; desktop ET mobile (mêmes composants, mêmes libellés).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeAttentionFlags, computeEffectiveStatus } from '../AgendaDomainService';
import { isAgendaOverdue, isPastHistoricalUnconfirmed } from '../agenda-historical';
import { EFFECTIVE_STATUS_LABELS, effectiveStatusLabel } from '@/lib/agenda/effective-status';

const NOW = new Date('2026-10-13T10:00:00');
const passe = { startDate: '2026-03-10', startTime: null, endDate: null, endTime: null, manualStatus: null };
const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

describe('PO-D17 — statuts distincts, jamais « réalisé » sur la seule date', () => {
  it('PO-D17-01 — cinq états : à venir, date échue, statut à confirmer, réalisé, annulé', () => {
    expect(computeEffectiveStatus({ ...passe, startDate: '2026-12-01' }, NOW)).toBe('a_venir');
    expect(computeEffectiveStatus({ ...passe, eventNature: 'DEADLINE' }, NOW)).toBe('en_retard');
    expect(computeEffectiveStatus({ ...passe, eventNature: 'HISTORICAL' }, NOW)).toBe('a_confirmer');
    expect(computeEffectiveStatus({ ...passe, eventNature: 'HISTORICAL', manualStatus: 'realise' }, NOW)).toBe('realise');
    expect(computeEffectiveStatus({ ...passe, eventNature: 'HISTORICAL', manualStatus: 'annule' }, NOW)).toBe('annule');
    expect(EFFECTIVE_STATUS_LABELS).toEqual({
      a_venir: 'À venir', en_retard: 'Date échue', a_confirmer: 'Statut à confirmer', realise: 'Réalisé', annule: 'Annulé',
    });
    expect(effectiveStatusLabel('a_confirmer')).toBe('Statut à confirmer');
  });

  it('PO-D17-02 — fait passé sans statut (achat, réparation, sinistre… lus d’un document) : à confirmer, ni en retard, ni réalisé ; rien n’est écrit', () => {
    for (const s of [{ eventNature: 'HISTORICAL' as const }, { businessType: 'repair' }, { originFieldKey: 'lastRevision' }, { businessType: 'purchase' }]) {
      const i = { ...passe, ...s };
      expect(computeEffectiveStatus(i, NOW)).toBe('a_confirmer');
      expect(isPastHistoricalUnconfirmed(i, NOW)).toBe(true);
      expect(isAgendaOverdue(i, NOW)).toBe(false);
      expect(computeAttentionFlags({ ...i, directAssetIds: [1], fileLinks: [], roomLinks: [], equipmentLinks: [] }, [], NOW)).not.toContain('en_retard');
    }
    expect(lire('src/services/agenda/agenda-historical.ts')).not.toMatch(/upsertAgendaItem|UPDATE agenda_items|db\.update/);
  });

  it('PO-D17-03 — suivi du bien : seuls réalisé et annulé sont « terminés » (masquables) ; « à confirmer » reste visible', () => {
    const route = lire('src/app/api/assets/[id]/followup/route.ts');
    expect(route).toContain("const isDone = effectiveStatus === 'realise' || effectiveStatus === 'annule';");
    expect(route).toContain("toConfirm: effectiveStatus === 'a_confirmer',");
    // Lot 84C : la vue d'ensemble lit sa Timeline par `services/agenda/timeline` (même règle).
    const overview = lire('src/app/api/assets/[id]/overview/route.ts');
    expect(overview).toContain("from '@/services/agenda/timeline/read'");
    const timeline = lire('src/services/agenda/timeline/model.ts');
    expect(timeline).toContain("isDone: r.manual_status === 'realise',");
    expect(timeline).toMatch(/toConfirm: ouvert && historique/);
  });

  it('PO-D17-04 — desktop ET mobile : toutes les vues affichent le statut reçu avec les libellés partagés, « à confirmer » compris', () => {
    // Lot 59 (point 5) : couleurs des statuts de « Mon agenda » dans les vues partagées.
    expect(lire('src/app/(dashboard)/agenda/page.tsx')).toContain('EFFECTIVE_STATUS_LABELS');
    expect(lire('src/app/(dashboard)/agenda/page.tsx')).toMatch(/STATUS_BORDER, STATUS_COLORS[\s\S]*from '@\/components\/agenda\/AgendaPeriodViews'/);
    for (const f of ['src/components/agenda/AgendaPeriodViews.tsx', 'src/components/assets/AssetAgendaTab.tsx', 'src/components/agenda/AgendaItemDrawer.tsx']) {
      const src = lire(f);
      expect(src, f).toContain('EFFECTIVE_STATUS_LABELS');
      expect(src, f).toMatch(/a_confirmer:/);
      expect(src, f).not.toMatch(/computeEffectiveStatus/);
    }
    expect(lire('src/components/assets/EquipmentDrawer.tsx')).toContain("item.effectiveStatus === 'a_confirmer'");
    expect(lire('src/components/assets/DocumentDrawer.tsx')).toContain('effectiveStatusLabel(');
    // Fiche du bien : timeline desktop (lg) ET mobile (lg:hidden) marquent « statut à confirmer ».
    // Lot 84C : les deux variantes sont rendues par le MÊME composant de Timeline
    // (`AssetTimelineList`, variantes desktop / mobile) — une seule ligne d'élément
    // (`TimelineRow`) porte le libellé et la pastille, pour les éléments seuls,
    // les groupes et les éléments liés d'un groupe.
    const fiche = lire('src/components/assets/AssetOverviewTab.tsx');
    expect(fiche).toContain('variant="desktop"');
    expect(fiche).toContain('variant="mobile"');
    const timeline = lire('src/components/assets/timeline/AssetTimeline.tsx');
    expect(timeline.match(/> · statut à confirmer</g)?.length).toBe(1);
    expect(timeline.match(/item\.toConfirm\s*\n?\s*\?/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(timeline).toMatch(/item\.toConfirm && <span[^>]*> · statut à confirmer<\/span>/);
  });
});
