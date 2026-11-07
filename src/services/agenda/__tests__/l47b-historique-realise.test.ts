/**
 * Lot 47B — point 2 : règle partagée de NATURE (`agenda-historical.ts`) — un
 * fait HISTORIQUE n'est jamais une action.
 *
 * #715 (lot 113P) : plus de statut d'événement — les cas O7b-H02 (statut
 * effectif « à confirmer » / « en retard ») et le statut à 4 états de
 * l'assistant (H03) sont RETIRÉS ; H04 vérifie désormais l'ABSENCE de statut
 * dans les vues et les lecteurs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeAttentionFlags } from '../AgendaDomainService';
import { HISTORICAL_ONLY_BUSINESS_TYPES, historicalSql, isHistoricalAgendaEvent } from '../agenda-historical';
import { isAgendaActionItemT4 } from '@/services/home/mascot/collector';

describe('O7b-H01 — règle partagée : nature historique (0223, champ d\'origine, type métier)', () => {
  it('nature 0223 prioritaire ; à défaut champ d\'origine du registre ; à défaut type métier exclusivement historique', () => {
    expect(isHistoricalAgendaEvent({ eventNature: 'HISTORICAL' })).toBe(true);
    expect(isHistoricalAgendaEvent({ eventNature: 'DEADLINE', businessType: 'purchase' })).toBe(false);
    expect(isHistoricalAgendaEvent({ originFieldKey: 'acquisitionDate' })).toBe(true);
    expect(isHistoricalAgendaEvent({ originFieldKey: 'nextInspection' })).toBe(false);
    for (const t of ['purchase', 'repair', 'claim', 'sale']) expect(isHistoricalAgendaEvent({ businessType: t })).toBe(true);
    expect(HISTORICAL_ONLY_BUSINESS_TYPES).toEqual(expect.arrayContaining(['purchase', 'repair', 'claim', 'sale']));
    // Type à double nature sans nature : échéance (comme avant).
    expect(isHistoricalAgendaEvent({ businessType: 'maintenance' })).toBe(false);
    // Élément saisi à la main (aucun indice) : échéance.
    expect(isHistoricalAgendaEvent({})).toBe(false);
  });

  it('jumeau SQL : mêmes règles (nature, champ d\'origine, type métier) ; colonnes 0223 absentes : sans elles', () => {
    const s = historicalSql('i', true);
    expect(s).toContain('i.event_nature');
    expect(s).toContain("'acquisitionDate'");
    expect(s).toContain("'purchase'");
    expect(s).toContain("'nextInspection'");
    const sans = historicalSql('i', false);
    expect(sans).not.toContain('i.event_nature');
    expect(sans).not.toContain('i.business_type');
    expect(historicalSql('i', true, '$5')).toContain('= ANY($5::text[])');
  });
});

describe('L113P — #715 : plus aucun signal « en retard »', () => {
  it('drapeaux d’attention : jamais « en_retard », passé comme à venir', () => {
    const base = { directAssetIds: [1], fileLinks: [], roomLinks: [], equipmentLinks: [] };
    for (const startDate of ['2020-03-10', '2099-12-01']) {
      expect(computeAttentionFlags({ ...base, startDate, eventNature: 'DEADLINE' }, [])).not.toContain('en_retard');
    }
  });
});

describe('O7b-H03 — assistant (lot 34 « qu\'est-ce qui est en retard ? »), accueil et mascotte', () => {
  it('accueil / mascotte / actions de l\'assistant : un fait historique n\'est jamais une action (donc jamais en retard)', () => {
    const base = { homeCategory: 'action', originType: 'qualified_document', title: 'Achat' };
    expect(isAgendaActionItemT4({ ...base, eventNature: 'HISTORICAL' })).toBe(false);
    expect(isAgendaActionItemT4({ ...base, eventNature: null, businessType: 'purchase' })).toBe(false);
    expect(isAgendaActionItemT4({ ...base, eventNature: 'DEADLINE', businessType: 'maintenance', title: 'Révision' })).toBe(true);
  });
});

describe('O7b-H04 — #715 : aucun statut d’événement, ni dans les vues ni dans les lecteurs serveur', () => {
  const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

  it('vues agenda (page desktop/mobile, onglet du bien, tiroirs) : ni `effectiveStatus`, ni `manualStatus`, ni sélecteur « Statut »', () => {
    for (const f of [
      'src/app/(dashboard)/agenda/page.tsx', 'src/components/assets/AssetAgendaTab.tsx', 'src/components/agenda/AgendaItemDrawer.tsx',
      'src/components/agenda/CreateAgendaItemDrawer.tsx', 'src/components/agenda/AgendaPeriodViews.tsx',
      'src/components/assets/EquipmentDrawer.tsx', 'src/components/assets/DocumentDrawer.tsx', 'src/components/assets/timeline/AssetTimeline.tsx',
    ]) {
      const src = lire(f);
      expect(src, f).not.toMatch(/effectiveStatus|manualStatus|isOverdue|toConfirm|\/statut`/);
      expect(src, f).not.toMatch(/>\s*(Réalisé|Annulé|Statut à confirmer|Date échue)\s*</);
    }
  });

  it('lecteurs serveur : plus de calcul de statut (liste, recherche, suivi, équipement, Timeline)', () => {
    for (const f of [
      'src/services/agenda/AgendaQueryService.ts', 'src/services/agenda/timeline/model.ts', 'src/services/agenda/timeline/read.ts',
      'src/app/api/assets/[id]/followup/route.ts', 'src/app/api/equipments/[id]/agenda/route.ts',
    ]) {
      expect(lire(f), f).not.toMatch(/computeEffectiveStatus|manual_status AS|completion_proven|validCompletionProof/);
    }
    expect(lire('src/services/agenda/AgendaDomainService.ts')).not.toMatch(/export function computeEffectiveStatus/);
  });

  it('aucune écriture de statut : la règle de nature n\'appelle ni la primitive d\'écriture ni une mise à jour', () => {
    const regle = lire('src/services/agenda/agenda-historical.ts');
    expect(regle).not.toMatch(/upsertAgendaItem|UPDATE agenda_items|db\.update/);
  });
});
