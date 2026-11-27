/**
 * Carte #851 — regroupement des liens d'Agenda par élément (`groupByAgendaItem`) :
 * strictement équivalent au `filter` par élément qu'il remplace (contenu ET
 * ordre), en un seul passage.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

describe('C851-U-AG — groupByAgendaItem', () => {
  it('C851-U-AG-01 — même résultat que filter() pour chaque élément, ordre conservé', async () => {
    const { groupByAgendaItem } = await import('@/services/agenda/AgendaQueryService');
    let graine = 851;
    const alea = () => { graine = (graine * 1103515245 + 12345) % 2147483648; return graine; };
    const lignes = Array.from({ length: 5000 }, (_, i) => ({ id: i + 1, agendaItemId: 1 + (alea() % 700), assetId: alea() % 40 }));
    const groupes = groupByAgendaItem(lignes);
    for (let item = 0; item <= 701; item += 1) {
      expect(groupes.get(item) ?? []).toEqual(lignes.filter((l) => l.agendaItemId === item));
    }
    expect([...groupes.values()].reduce((n, g) => n + g.length, 0)).toBe(lignes.length);
  });

  it('C851-U-AG-02 — liste vide, éléments sans lien', async () => {
    const { groupByAgendaItem } = await import('@/services/agenda/AgendaQueryService');
    expect(groupByAgendaItem([]).size).toBe(0);
    expect(groupByAgendaItem([{ agendaItemId: 3 }]).get(4)).toBeUndefined();
    // Lien sans élément (colonne nullable des conflits) : ignoré, comme par `filter`.
    const g = groupByAgendaItem([{ agendaItemId: null }, { agendaItemId: 5 }]);
    expect([...g.keys()]).toEqual([5]);
  });
});
