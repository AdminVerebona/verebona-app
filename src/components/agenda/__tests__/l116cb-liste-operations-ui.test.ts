/**
 * Carte #806 §6 (lot 116C, seconde partie) — LISTE de l'Agenda : accès
 * identifiable à la fiche de CHAQUE opération d'un événement (gardes de code ;
 * le comportement est prouvé sur PostgreSQL réel par `l116cb-agenda-timeline.e2e.ts`).
 *
 *   L116CB-L1  la route de l'Agenda joint les opérations aux éléments dans ses DEUX réponses (liste, liste + facettes)
 *   L116CB-L2  la ligne rend un lien par opération (jamais la première seulement), vers l'adresse stable de la fiche,
 *              sans ouvrir le tiroir de l'événement, avec le texte EXISTANT de la Timeline détaillée
 *   L116CB-L3  aucune vue regroupée ni ligne d'opération dans l'Agenda : la liste reste groupée par DATE seulement
 *   L116CB-L4  la jointure ne change ni l'ordre ni le nombre des éléments (aucune requête sans élément)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const lire = (p: string) => readFileSync(resolve(__dirname, '..', '..', '..', '..', p), 'utf8').replace(/\r\n?/g, '\n');
const PAGE = lire('src/app/(dashboard)/agenda/page.tsx');
const ROUTE = lire('src/app/api/agenda/route.ts');

describe('L116CB-L — liste de l’Agenda : toutes les opérations d’un événement (#806 §6)', () => {
  it('L116CB-L1 — la route joint les opérations dans ses deux réponses', () => {
    expect(ROUTE.match(/attachReferenceEvents\(accountId, /g)).toHaveLength(2);
    // Les deux réponses rendent la liste JOINTE, jamais la liste brute.
    expect(ROUTE).not.toMatch(/const \{ items, equipmentFacet, roomFacet \} = await getAgendaItemsWithEquipmentFacet/);
    expect(ROUTE).not.toMatch(/const items = await getAgendaItems\(query\)/);
  });

  it('L116CB-L2 — un lien par opération, vers la fiche, sans ouvrir le tiroir', () => {
    const bloc = PAGE.slice(PAGE.indexOf('data-agenda-references'), PAGE.indexOf('Lot 114V (#742) : « Planifier »'));
    expect(bloc).toContain('item.referenceEvents!.map((r) => (');
    expect(bloc).toContain('href={referenceEventHref(r.id)}');
    expect(bloc).toContain('onClick={(e) => e.stopPropagation()}');
    expect(bloc).toContain('{TIMELINE_REFERENCE_EVENT_LINK} : {r.label}');
    // Jamais une seule opération choisie arbitrairement.
    expect(bloc).not.toMatch(/referenceEvents!?\[0\]/);
    expect(PAGE).not.toMatch(/referenceEvents\?\.\[0\]|referenceEvents!?\[0\]/);
    // Charte Sérénité : jetons de couleur seulement ; zone tactile mobile conservée.
    expect(bloc).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(/);
    expect(bloc).toContain('min-h-[32px]');
    expect(bloc).toContain('text-[color:var(--accent)]');
  });

  it('L116CB-L3 — l’Agenda reste une chronologie d’événements : aucune ligne d’opération, aucun regroupement par opération', () => {
    const groupes = PAGE.slice(PAGE.indexOf('const grouped = useMemo'), PAGE.indexOf('return groups;'));
    expect(groupes).not.toContain('referenceEvents');
    expect(groupes).not.toContain('operationId');
    expect(groupes).toContain('groupUndated(undated)');
    expect(groupes).toContain('const key = item.startDate!;');
  });

  it('L116CB-L4 — la jointure conserve l’ordre et le nombre des éléments ; liste vide : aucune lecture', async () => {
    const lecture = vi.fn(async (_c: number, ids: readonly number[]) => new Map<number, Array<{ operationId: number; label: string }>>(
      ids.includes(2) ? [[2, [{ operationId: 9, label: 'B' }, { operationId: 7, label: 'A' }]]] : []));
    vi.doMock('@/services/business-operations/graph/read', () => ({ readAgendaItemsReferenceEvents: lecture }));
    const { attachReferenceEvents } = await import('@/services/agenda/agenda-reference-events');
    expect(await attachReferenceEvents(1, [])).toEqual([]);
    expect(lecture).not.toHaveBeenCalled();
    const items = [{ id: 3, title: 'c' }, { id: 2, title: 'b' }, { id: 5, title: 'a' }] as never[];
    const out = await attachReferenceEvents(1, items);
    expect(lecture).toHaveBeenCalledTimes(1);
    expect(lecture).toHaveBeenCalledWith(1, [3, 2, 5]);
    expect(out.map((i) => i.id)).toEqual([3, 2, 5]);
    expect(out.map((i) => i.referenceEvents)).toEqual([[], [{ id: 9, label: 'B' }, { id: 7, label: 'A' }], []]);
    // Les éléments reçus ne sont pas modifiés en place.
    expect((items[1] as { referenceEvents?: unknown }).referenceEvents).toBeUndefined();
  });
});
