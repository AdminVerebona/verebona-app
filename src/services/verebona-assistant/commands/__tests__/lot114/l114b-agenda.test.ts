/**
 * Lot 114B (Trello #753, CDC T2 §9.4, §14.3 W15-W17, §14.4 « Agenda », M28-M29) —
 * COMMANDES AGENDA DEPUIS L'ASSISTANT.
 *
 *   A01  W15 : date FACULTATIVE — une échéance sans date est préparée (règle
 *        remplacée : « pour quelle date ? ») ; « Sans échéance » seulement
 *        s'il est demandé ; date + « sans échéance » : refusé ;
 *   A02  W16 : déplacer / renommer une échéance retrouvée dans le compte ;
 *   A03  W17 : supprimer cette échéance ou toute la série — portée et nombre
 *        annoncés, figés ;
 *   A04  aucune ou plusieurs échéances : on demande, jamais un choix arbitraire ;
 *   A05  une question n'est jamais une commande ; aucun statut « réalisé » ;
 *   A06  catalogue fermé : fiche de commande complète (§14.3).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const { parseCommand, parseCommands } = await import('../../parser');
const { resolveDraft } = await import('../../plan.service');
const { WRITE_COMMAND_CATALOG, actionKind } = await import('../../catalog');
type Lookup = import('../../plan.service').CommandLookup;
type Candidate = import('../../plan.service').AgendaCandidate;

const TODAY = '2026-11-13';
const input = { accountId: 1, userId: 2, planType: 'STANDARD', message: '', clientRequestId: 'x', locale: 'fr-FR' } as never;
const clio = { id: 7, name: 'Clio', city: null };
const vidange: Candidate = { id: 31, title: 'Vidange', startDate: '2027-03-12', version: 'v31', seriesCount: 1, assetLabel: 'Clio' };
const serie = (n: number): Candidate[] => Array.from({ length: n }, (_, i) => ({ id: 40 + i, title: 'Rappel vidange', startDate: `2027-0${i + 1}-10`, version: `v${40 + i}`, seriesCount: n, assetLabel: 'Clio' }));

const lookup = (items: Candidate[], vu: { q?: unknown } = {}): Lookup => ({
  today: () => TODAY,
  async findAssets(_a, w) { return w.includes('clio') ? [clio] : []; },
  async getAsset(_a, id) { return id === 7 ? clio : null; },
  async findAgendaItems(_a, q) { vu.q = q; return items; },
});

describe('L114B-A01 — W15 : la date est facultative', () => {
  it('sans date : échéance préparée « Sans date », jamais une question obligatoire', async () => {
    const d = parseCommand('Ajoute un entretien pour la Clio', TODAY)!;
    expect(d).toMatchObject({ command: 'CREATE_AGENDA_ITEM', date: null, noDeadline: false, assetWords: ['clio'] });
    const a = await resolveDraft(d, input, lookup([]));
    expect(a).not.toHaveProperty('needInfo');
    expect(a).toMatchObject({ command: 'CREATE_AGENDA_ITEM', params: { startDate: null, assetIds: [7] } });
    expect((a as { params: object }).params).not.toHaveProperty('noDeadline');
    expect((a as { preview: string }).preview).toBe('Créer l’échéance « Entretien » (sans date), rattachée à Clio.');
    expect((a as { effects: string[] }).effects).toContain('Date : Sans date');
  });

  it('avec date : comportement inchangé', async () => {
    const a = await resolveDraft(parseCommand('Ajoute un rappel vidange le 12 mars 2027 pour la Clio', TODAY)!, input, lookup([]));
    expect(a).toMatchObject({ params: { title: 'Vidange', startDate: '2027-03-12', assetIds: [7] } });
    expect((a as { preview: string }).preview).toBe('Créer l’échéance « Vidange » le 12 mars 2027, rattachée à Clio.');
  });

  it('« sans échéance » demandé : option posée ; avec une date : refus, rien de préparé', async () => {
    const a = await resolveDraft(parseCommand('Ajoute un rappel ramonage sans échéance', TODAY)!, input, lookup([]));
    expect(a).toMatchObject({ params: { startDate: null, noDeadline: true } });
    expect((a as { effects: string[] }).effects).toContain('Date : Sans échéance');
    const b = await resolveDraft(parseCommand('Ajoute un rappel ramonage sans échéance le 12 mars 2027', TODAY)!, input, lookup([]));
    expect(b).toHaveProperty('needInfo');
  });
});

describe('L114B-A02 — W16 : modifier une échéance', () => {
  it('déplacer : la nouvelle date suit « au », ce qui précède désigne l’échéance', async () => {
    const d = parseCommand('Reporte l’échéance vidange de la Clio au 20 mars 2027', TODAY)!;
    expect(d).toMatchObject({ command: 'UPDATE_AGENDA_ITEM', newDate: '2027-03-20', newTitle: null, itemWords: ['vidange'], assetWords: ['clio'] });
    const vu: { q?: unknown } = {};
    const a = await resolveDraft(d, input, lookup([vidange], vu));
    expect(vu.q).toEqual({ words: ['vidange'], date: null, assetIds: [7] });
    expect(a).toMatchObject({
      command: 'UPDATE_AGENDA_ITEM', targets: [{ type: 'agenda_item', id: 31, label: 'Vidange' }],
      params: { kind: 'agenda_update', agendaItemId: 31, patch: { startDate: '2027-03-20' }, expectedVersion: 'v31' },
      preview: 'Déplacer l’échéance « Vidange » du 12 mars 2027 — Clio au 20 mars 2027.',
    });
  });

  it('déplacer « celle du 12 mars » : l’ancienne date désigne, la nouvelle modifie', () => {
    expect(parseCommand('Décale le rendez-vous du 12 mars 2027 au 15/03/2027', TODAY))
      .toMatchObject({ command: 'UPDATE_AGENDA_ITEM', itemDate: '2027-03-12', newDate: '2027-03-15' });
  });

  it('renommer : nouveau titre repris tel qu’écrit', async () => {
    const d = parseCommand('Renomme l’échéance vidange en Révision annuelle', TODAY)!;
    expect(d).toMatchObject({ command: 'UPDATE_AGENDA_ITEM', newTitle: 'Révision annuelle', newDate: null, itemWords: ['vidange'] });
    const a = await resolveDraft(d, input, lookup([vidange]));
    expect(a).toMatchObject({ params: { patch: { title: 'Révision annuelle' } } });
    expect((a as { effects: string[] }).effects).toContain('Titre : Vidange → Révision annuelle');
  });

  it('même valeur : rien à modifier, aucun plan', async () => {
    const a = await resolveDraft(parseCommand('Reporte l’échéance vidange au 12 mars 2027', TODAY)!, input, lookup([vidange]));
    expect(a).toHaveProperty('needInfo');
  });
});

describe('L114B-A03 — W17 : supprimer une échéance ou une série', () => {
  it('par défaut : cette échéance seulement, annoncée irréversible', async () => {
    const d = parseCommand('Supprime l’échéance vidange du 12 mars 2027', TODAY)!;
    expect(d).toMatchObject({ command: 'DELETE_AGENDA_ITEM', scope: 'OCCURRENCE', itemWords: ['vidange'], itemDate: '2027-03-12' });
    const a = await resolveDraft(d, input, lookup([vidange])) as { params: object; preview: string; effects: string[] };
    expect(a.params).toEqual({ kind: 'agenda_delete', agendaItemId: 31, scope: 'OCCURRENCE', expectedVersion: 'v31', expectedCount: 1 });
    expect(a.preview).toBe('Supprimer l’échéance « Vidange » du 12 mars 2027 — Clio.');
    expect(a.effects.join(' ')).toMatch(/cette échéance seulement/);
    expect(a.effects.join(' ')).toMatch(/Suppression définitive/);
  });

  it('une occurrence d’une série : les autres sont dites conservées', async () => {
    const s = serie(3);
    const a = await resolveDraft(parseCommand('Supprime le rappel vidange du 10 janvier 2027', TODAY)!, input, lookup([s[0]])) as { params: { scope: string; expectedCount: number }; effects: string[] };
    expect(a.params).toMatchObject({ scope: 'OCCURRENCE', expectedCount: 1 });
    expect(a.effects.join(' ')).toMatch(/les 2 autres de la série sont conservées/);
  });

  it('« toute la série » : nombre d’échéances annoncé et figé', async () => {
    const d = parseCommand('Supprime toute la série des rappels vidange', TODAY)!;
    expect(d).toMatchObject({ command: 'DELETE_AGENDA_ITEM', scope: 'SERIES' });
    const a = await resolveDraft(d, input, lookup(serie(3))) as { params: object; preview: string };
    expect(a.params).toMatchObject({ kind: 'agenda_delete', scope: 'SERIES', expectedCount: 3, agendaItemId: 40 });
    expect(a.preview).toBe('Supprimer toute la série « Rappel vidange » : 3 échéances.');
  });

  it('série demandée pour une échéance isolée : on demande, on ne supprime rien', async () => {
    const a = await resolveDraft(parseCommand('Supprime toute la série des rappels vidange', TODAY)!, input, lookup([vidange]));
    expect(a).toHaveProperty('needInfo');
  });
});

describe('L114B-A04 — aucune ou plusieurs échéances', () => {
  it('aucune : on le dit', async () => {
    const a = await resolveDraft(parseCommand('Supprime l’échéance ramonage', TODAY)!, input, lookup([]));
    expect((a as { needInfo: string }).needInfo).toMatch(/pas trouvé cette échéance/);
  });

  it('plusieurs également plausibles : liste, jamais un choix à la place de l’utilisateur', async () => {
    const autre: Candidate = { ...vidange, id: 32, startDate: '2028-03-12', version: 'v32' };
    const a = await resolveDraft(parseCommand('Supprime l’échéance vidange', TODAY)!, input, lookup([vidange, autre]));
    expect((a as { needInfo: string }).needInfo).toMatch(/Plusieurs échéances correspondent : « Vidange » du 12 mars 2027 — Clio ; « Vidange » du 12 mars 2028 — Clio/);
  });

  it('bien nommé absent du compte : aucune recherche élargie', async () => {
    const vu: { q?: unknown } = {};
    const a = await resolveDraft(parseCommand('Supprime l’échéance vidange de la Polo', TODAY)!, input, lookup([vidange], vu));
    expect(a).toHaveProperty('needInfo');
    expect(vu.q).toBeUndefined();
  });
});

describe('L114B-A05 — ce qui n’est pas une commande', () => {
  it.each([
    'Quand est la prochaine échéance de la Clio ?',
    'Indique-moi les rappels à supprimer',
    'Combien de rendez-vous ai-je supprimés ?',
    'J’ai fait l’entretien de ma voiture hier',
  ])('%s', (q) => {
    const d = parseCommand(q, TODAY);
    expect(d === null || !['UPDATE_AGENDA_ITEM', 'DELETE_AGENDA_ITEM'].includes(d.command)).toBe(true);
  });

  it('aucun statut « réalisé » : « marque l’entretien comme fait » ne produit aucune commande', () => {
    expect(parseCommand('Marque l’entretien de la Clio comme fait', TODAY)).toBeNull();
  });

  it('plusieurs commandes : « puis » rend la suppression dépendante', () => {
    const s = parseCommands('Ajoute un rappel vidange le 12 mars 2027 puis supprime l’échéance ramonage', TODAY)!;
    expect(s.map((x) => x.draft.command)).toEqual(['CREATE_AGENDA_ITEM', 'DELETE_AGENDA_ITEM']);
    expect(s[1].dependsOnPrevious).toBe(true);
  });
});

describe('L114B-A06 — catalogue fermé', () => {
  it('les deux commandes sont des écritures confirmées, avec leur fiche complète', () => {
    for (const c of ['UPDATE_AGENDA_ITEM', 'DELETE_AGENDA_ITEM'] as const) {
      expect(actionKind(c)).toBe('write_command');
      const spec = WRITE_COMMAND_CATALOG[c].spec!;
      expect(spec.targetKind).toBe('agenda_item');
      expect(spec.readBeforeWrite).toBe(true);
      expect(spec.requiredFields).toContain('expectedVersion');
      expect(spec.retrySafety).toBe('PLAN_TAKEN_ONCE');
      expect(spec.successEvent).toMatch(/^AGENDA_ITEM_/);
    }
    expect(WRITE_COMMAND_CATALOG.DELETE_AGENDA_ITEM.spec!.undoPolicy).toBe('IRREVERSIBLE');
    expect(Object.keys(WRITE_COMMAND_CATALOG)).not.toContain('MARK_AGENDA_DONE');
  });
});
