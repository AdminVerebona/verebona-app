/**
 * Commandes métier depuis le chat, après confirmation explicite.
 *
 * demande → préparation → prévisualisation → confirmation → exécution → résultat.
 * Aucune écriture avant confirmation ; paramètres figés ; exécution par les
 * services métier de l'interface ; droits évalués à la confirmation.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseCommand, parseDateFr } from '../parser';
import { resolveDraft, hashActions, planStatusFrom, type CommandLookup } from '../plan.service';
import { actionKind, WRITE_COMMAND_CATALOG } from '../catalog';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const TODAY = '2026-09-25';

const lookup: CommandLookup = {
  today: () => TODAY,
  async findAssets(_a, w) {
    const all = [{ id: 890, name: 'Clio', city: null }, { id: 842, name: 'Maison', city: 'Lyon' }, { id: 887, name: 'Maison', city: 'Annecy' }];
    return all.filter((a) => w.some((x) => a.name.toLowerCase().includes(x)));
  },
  async getAsset(_a, id) { return id === 42 ? { id: 42, name: 'Maison', city: 'Lyon' } : null; },
  async findAgendaItems(_a, w) { return w.includes('ramonage') ? [{ id: 7, title: 'Ramonage', date: '2026-10-15' }] : []; },
  async getAgendaItem(_a, id) { return id === 7 ? { id: 7, title: 'Ramonage', date: '2026-10-15', manualStatus: null } : null; },
  async listOpenAgendaItems() { return []; },
};
const input = { accountId: 1, userId: 2, planType: 'PREMIUM', message: '', clientRequestId: 'x', locale: 'fr-FR' };

describe('catalogue : navigation, parcours, commande d’écriture', () => {
  it('distingue les trois natures', () => {
    expect(actionKind('OPEN_DOCUMENT')).toBe('navigation');
    expect(actionKind('START_ADD_AGENDA_ITEM')).toBe('start_flow');
    expect(actionKind('CREATE_AGENDA_ITEM')).toBe('write_command');
  });

  it('chaque commande désigne le service métier appelé', () => {
    expect(WRITE_COMMAND_CATALOG.CREATE_AGENDA_ITEM.service).toBe('AgendaWriteService.createAgendaItem');
  });
});

describe('reconnaissance (intention claire seulement)', () => {
  it('création d’une échéance', () => {
    expect(parseCommand('Ajoute un rappel ramonage le 15 octobre pour ma Clio', TODAY)).toEqual({
      command: 'CREATE_AGENDA_ITEM', title: 'Ramonage', date: '2026-10-15', assetWords: ['clio'], assetFromContext: false,
    });
  });

  it('marquer réalisée / annuler', () => {
    expect(parseCommand('Marque le ramonage comme fait', TODAY)).toMatchObject({ command: 'MARK_AGENDA_DONE', targetWords: ['ramonage'] });
    expect(parseCommand("Annule l'échéance vidange", TODAY)).toMatchObject({ command: 'CANCEL_AGENDA_ITEM', targetWords: ['vidange'] });
  });

  it('une question n’est pas une commande', () => {
    expect(parseCommand('Quand est mon prochain rappel ?', TODAY)).toBeNull();
    expect(parseCommand('Combien de documents pour ma maison ?', TODAY)).toBeNull();
  });

  it('dates : prochaine occurrence, formats usuels', () => {
    expect(parseDateFr('le 2 janvier', TODAY)).toBe('2027-01-02');
    expect(parseDateFr('le 3/11/2026', TODAY)).toBe('2026-11-03');
    expect(parseDateFr('le 31 février', TODAY)).toBeNull();
  });
});

describe('préparation : résolue dans le compte, figée, présentée', () => {
  it('aperçu et effets de la création', async () => {
    const a = await resolveDraft(parseCommand('Ajoute un rappel ramonage le 15 octobre pour ma Clio', TODAY)!, input, lookup);
    expect('needInfo' in a).toBe(false);
    if ('needInfo' in a || Array.isArray(a)) return;
    expect(a.params).toEqual({ title: 'Ramonage', startDate: '2026-10-15', assetIds: [890] });
    expect(a.preview).toBe('Créer l’échéance « Ramonage » le 15 octobre 2026, rattachée à Clio.');
    expect(a.effects).toContain('Bien : Clio');
  });

  it('bien ambigu, date absente, échéance introuvable : on demande, on ne prépare rien', async () => {
    const amb = await resolveDraft(parseCommand('Ajoute un rappel entretien le 3 novembre pour ma maison', TODAY)!, input, lookup);
    expect('needInfo' in amb && amb.needInfo).toMatch(/Plusieurs biens correspondent/);
    const sansDate = await resolveDraft(parseCommand('Ajoute un rappel entretien pour ma Clio', TODAY)!, input, lookup);
    expect('needInfo' in sansDate && sansDate.needInfo).toMatch(/Pour quelle date/);
    const introuvable = await resolveDraft(parseCommand('Marque la vidange comme faite', TODAY)!, input, lookup);
    expect('needInfo' in introuvable).toBe(true);
  });

  it('« cette échéance » / « la deuxième » : référence du fil', async () => {
    const a = await resolveDraft(parseCommand('Marque la deuxième comme réalisée', TODAY)!,
      { ...input, reference: { type: 'agenda_item', id: 7, method: 'ordinal' } }, lookup);
    expect('needInfo' in a || Array.isArray(a) ? null : a.params).toEqual({ agendaItemId: 7 });
  });

  it('empreinte : toute modification des paramètres figés est détectée', () => {
    const payload = JSON.stringify([{ params: { title: 'Ramonage' } }]);
    expect(hashActions(payload)).not.toBe(hashActions(payload.replace('Ramonage', 'Autre')));
  });
});

describe('confirmation et exécution', () => {
  const S = read('src/services/verebona-assistant/commands/plan.service.ts');
  const E = read('src/services/verebona-assistant/commands/executors.ts');
  const O = read('src/services/verebona-assistant/core/assistant-orchestrator.service.ts');

  it('prise atomique : propriétaire, en attente, non expiré', () => {
    expect(S).toMatch(/WHERE plan_id = \$1 AND account_id = \$2 AND user_id = \$3\s+AND status = 'PENDING_CONFIRMATION' AND expires_at > now\(\)/);
  });

  it('droits d’écriture évalués À LA CONFIRMATION', () => {
    expect(S.indexOf('defaultCanWrite')).toBeGreaterThan(-1);
    expect(S.indexOf("'WRITE_REFUSED'")).toBeLessThan(S.lastIndexOf('executeActions(actions'));
  });

  it('exécution par les services métier, pas d’INSERT direct', () => {
    expect(E).toMatch(/createAgendaItem\(/);
    expect(E).toMatch(/updateManualStatus\(p\.agendaItemId, 'realise'/);
    expect(E).not.toMatch(/INSERT INTO agenda_items/);
  });

  it('la route de confirmation n’accepte aucun paramètre du client', () => {
    const r = read('src/app/api/verebona/commands/[planId]/confirm/route.ts');
    expect(r).not.toMatch(/req\.json\(/);
    expect(r).toMatch(/confirmCommandPlan\(\{ planId, accountId, userId: session\.userId \}\)/);
  });

  it('l’orchestrateur prépare et présente, n’exécute jamais', () => {
    expect(O).toMatch(/ports\.prepareCommand\(input\)/);
    expect(O).not.toMatch(/confirmCommandPlan/);
  });

  it('statut du plan selon les résultats', () => {
    expect(planStatusFrom([{ actionId: 'a1', status: 'SUCCESS', message: '' }])).toBe('EXECUTED');
    expect(planStatusFrom([{ actionId: 'a1', status: 'FAILED', message: '' }])).toBe('FAILED');
  });
});
