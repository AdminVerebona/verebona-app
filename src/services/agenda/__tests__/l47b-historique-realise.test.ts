/**
 * Lot 47B — point 2 : un fait HISTORIQUE passé n'est plus « en retard »
 * (décision PO du 12/10). Affiché réalisé PARTOUT (vues agenda desktop et
 * mobile, fiche, équipement, document, accueil, mascotte, assistant) via UNE
 * règle partagée (`agenda-historical.ts`) ; aucun statut écrit ; une
 * échéance passée non faite reste « en retard ».
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeAttentionFlags, computeEffectiveStatus } from '../AgendaDomainService';
import {
  HISTORICAL_ONLY_BUSINESS_TYPES, historicalSql, isAgendaOverdue, isHistoricalAgendaEvent, isPastHistoricalShownDone,
} from '../agenda-historical';
import { agendaStatus4 } from '@/services/verebona-assistant/canonical/agenda';
import { isAgendaActionItemT4 } from '@/services/home/mascot/collector';

const NOW = new Date('2026-10-12T10:00:00');
const passe = { startDate: '2026-03-10', startTime: null, endDate: null, endTime: null, manualStatus: null };
const futur = { ...passe, startDate: '2026-12-01' };

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

describe('O7b-H02 — statut effectif : historique passé = réalisé ; échéance passée = en retard (inchangé)', () => {
  it('historique passé sans statut → « realise » (affichage) ; aucun statut écrit (calcul de lecture)', () => {
    const item = { ...passe, eventNature: 'HISTORICAL' as const };
    expect(computeEffectiveStatus(item, NOW)).toBe('realise');
    expect(item.manualStatus).toBeNull();
    expect(isPastHistoricalShownDone(item, NOW)).toBe(true);
    expect(isAgendaOverdue(item, NOW)).toBe(false);
    // Achat / sinistre / cession / réparation lus par T4 sans nature : même règle.
    for (const businessType of ['purchase', 'claim', 'sale', 'repair']) {
      expect(computeEffectiveStatus({ ...passe, businessType }, NOW)).toBe('realise');
    }
  });

  it('échéance passée non faite → « en_retard » comme aujourd\'hui ; à venir → « a_venir »', () => {
    expect(computeEffectiveStatus(passe, NOW)).toBe('en_retard');
    expect(computeEffectiveStatus({ ...passe, eventNature: 'DEADLINE' }, NOW)).toBe('en_retard');
    expect(isAgendaOverdue({ ...passe, eventNature: 'DEADLINE' }, NOW)).toBe(true);
    expect(computeEffectiveStatus(futur, NOW)).toBe('a_venir');
    expect(computeEffectiveStatus({ ...futur, eventNature: 'HISTORICAL' }, NOW)).toBe('a_venir');
  });

  it('un statut posé par l\'utilisateur l\'emporte toujours (annulé reste annulé, même historique)', () => {
    expect(computeEffectiveStatus({ ...passe, eventNature: 'HISTORICAL', manualStatus: 'annule' }, NOW)).toBe('annule');
    expect(computeEffectiveStatus({ ...passe, manualStatus: 'realise' }, NOW)).toBe('realise');
  });

  it('drapeau d\'attention « en retard » : jamais pour un historique passé', () => {
    const base = { directAssetIds: [1], fileLinks: [], roomLinks: [], equipmentLinks: [] };
    expect(computeAttentionFlags({ ...passe, ...base, eventNature: 'HISTORICAL' }, [], NOW)).not.toContain('en_retard');
    expect(computeAttentionFlags({ ...passe, ...base }, [], NOW)).toContain('en_retard');
  });
});

describe('O7b-H03 — assistant (lot 34 « qu\'est-ce qui est en retard ? »), accueil et mascotte', () => {
  it('statut à 4 états : historique passé = réalisé, jamais « non prouvé » ; échéance passée inchangée', () => {
    expect(agendaStatus4(null, false, '2026-03-10', '2026-10-12', true)).toBe('completed');
    expect(agendaStatus4(null, false, '2026-03-10', '2026-10-12')).toBe('not_proven');
    expect(agendaStatus4('annule', false, '2026-03-10', '2026-10-12', true)).toBe('not_completed');
  });

  it('accueil / mascotte / actions de l\'assistant : un fait historique n\'est jamais une action (donc jamais en retard)', () => {
    const base = { homeCategory: 'action', originType: 'qualified_document', title: 'Achat' };
    expect(isAgendaActionItemT4({ ...base, eventNature: 'HISTORICAL' })).toBe(false);
    expect(isAgendaActionItemT4({ ...base, eventNature: null, businessType: 'purchase' })).toBe(false);
    expect(isAgendaActionItemT4({ ...base, eventNature: 'DEADLINE', businessType: 'maintenance', title: 'Révision' })).toBe(true);
  });
});

describe('O7b-H04 — rendu desktop ET mobile : un seul calcul serveur, affiché tel quel', () => {
  const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

  it('vues agenda (page desktop/mobile, onglet du bien, tiroirs) : badge = `effectiveStatus` du serveur, aucun recalcul de date côté client', () => {
    for (const f of [
      'src/app/(dashboard)/agenda/page.tsx', 'src/components/assets/AssetAgendaTab.tsx', 'src/components/agenda/AgendaItemDrawer.tsx',
      'src/components/assets/EquipmentDrawer.tsx', 'src/components/assets/DocumentDrawer.tsx',
    ]) {
      const src = lire(f);
      expect(src).toMatch(/effectiveStatus/);
      expect(src).not.toMatch(/computeEffectiveStatus|en_retard['"]\s*:\s*\w+\s*</);
    }
    // Page agenda : même composant de ligne aux deux tailles (badge non masqué sur mobile).
    const page = lire('src/app/(dashboard)/agenda/page.tsx');
    expect(page).toContain('STATUS_LABELS[item.effectiveStatus]');
    expect(page).not.toMatch(/hidden sm:[^"]*\$\{STATUS_COLORS/);
  });

  it('chaque calcul serveur du statut lit la nature (règle partagée) : liste, recherche, fiche, suivi, équipement', () => {
    const q = lire('src/services/agenda/AgendaQueryService.ts');
    expect(q.match(/eventNature: natures\?\.get\(item\.id\)\?\.nature/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(q).toContain('...signaux,');
    for (const f of ['src/app/api/assets/[id]/followup/route.ts', 'src/app/api/equipments/[id]/agenda/route.ts', 'src/app/api/assets/[id]/overview/route.ts']) {
      expect(lire(f)).toContain('loadEventNatures(');
    }
    expect(lire('src/app/api/assets/[id]/overview/route.ts')).toContain('isHistoricalAgendaEvent(');
  });

  it('aucune écriture de statut : la règle n\'appelle ni la primitive d\'écriture ni une mise à jour', () => {
    const regle = lire('src/services/agenda/agenda-historical.ts');
    expect(regle).not.toMatch(/upsertAgendaItem|UPDATE agenda_items|db\.update/);
  });
});
