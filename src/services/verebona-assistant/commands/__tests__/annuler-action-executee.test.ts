/**
 * « Annuler » une action EXÉCUTÉE depuis l'assistant — CDC BO IA T2-038 /
 * T2-039, décision produit : 15 minutes, actions réversibles seulement.
 *
 * Chaîne complète : confirmation (exécuteurs réels, services métier simulés)
 * → capture de la commande inverse et de l'état antérieur → annulation.
 * La base est simulée en mémoire : seules les requêtes des services de plan,
 * des exécuteurs et de l'annulation sont interprétées, transaction comprise
 * (tout est rétabli si la transaction lève).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Plan = {
  plan_id: string; account_id: number; user_id: number; conversation_id: number | null; message_id: number | null;
  status: string; summary: string; actions_payload: string; params_hash: string; expires_at: Date;
  undo_until: Date | null; undone_at: Date | null;
};
type Item = { id: number; account_id: number; title: string; start_date: string | null; manual_status: string | null; updated_at: string };
type Asset = {
  id: number; account_id: number; name: string; category: string; status: string; lock_state: string;
  key_characteristics: string | null; registration_number: string | null; purchase_date: string | null; updated_at: string;
};
type Step = {
  id: number; plan_id: string; account_id: number; user_id: number; action_id: string; command: string;
  target_type: string; target_id: number; inverse_op: string; before_json: Record<string, unknown>;
  version_before: string | null; version_after: string; label: string; undone_at: Date | null;
};
interface State {
  plans: Map<string, Plan>;
  items: Map<number, Item>;
  assets: Map<number, Asset>;
  links: Array<{ agenda_item_id: number; asset_id: number }>;
  steps: Step[];
  events: Array<{ plan_id: string; event_type: string; detail: Record<string, unknown> }>;
  occurrences: Array<{ agenda_item_id: number; event_type: string; detail: Record<string, unknown> }>;
  messages: Array<{ conversation_id: number; content: string; parent_message_id: number | null }>;
  conversations: Array<{ id: number; account_id: number; user_id: number; status: string }>;
  seq: number;
}

const h = vi.hoisted(() => ({
  db: null as unknown as State,
  emitBusinessEvent: vi.fn(async () => {}),
  notifyCoherenceEvent: vi.fn(),
}));
const db = () => h.db;
const stamp = () => `2026-09-28 10:00:00.${String(++db().seq).padStart(6, '0')}+00`;

function fresh(): State {
  return {
    plans: new Map(), items: new Map(), assets: new Map(), links: [], steps: [], events: [], occurrences: [],
    messages: [], conversations: [{ id: 11, account_id: 7, user_id: 3, status: 'active' }], seq: 0,
  };
}
const clone = (s: State): State => structuredClone(s);

async function unsafe(sql: string, params: unknown[] = []): Promise<unknown[]> {
  const q = sql.replace(/\s+/g, ' ').trim();
  const d = db();
  const own = (id: unknown, acc: unknown, usr: unknown) => {
    const p = d.plans.get(id as string);
    return p && p.account_id === acc && p.user_id === usr ? p : undefined;
  };

  if (q.startsWith('INSERT INTO verebona_command_events')) {
    d.events.push({ plan_id: params[0] as string, event_type: params[3] as string, detail: JSON.parse(params[4] as string) });
    return [];
  }
  if (q.includes("SET status = 'EXECUTING'")) {
    const p = own(params[0], params[1], params[2]);
    if (!p || p.status !== 'PENDING_CONFIRMATION') return [];
    p.status = 'EXECUTING';
    return [{ actions_payload: p.actions_payload, params_hash: p.params_hash, summary: p.summary, conversationId: p.conversation_id, messageId: p.message_id }];
  }
  if (q.startsWith('UPDATE verebona_command_plans SET status = $2, results_json')) {
    d.plans.get(params[0] as string)!.status = params[1] as string;
    return [];
  }
  if (q.startsWith('UPDATE verebona_command_plans SET undo_until')) {
    const p = d.plans.get(params[0] as string)!;
    p.undo_until = new Date(Date.now() + (params[1] as number) * 1000);
    return [{ undoUntil: p.undo_until }];
  }
  if (q.startsWith('SELECT status, undo_until IS NOT NULL')) {
    const p = own(params[0], params[1], params[2]);
    return p ? [{
      status: p.status, reversible: p.undo_until !== null, withinWindow: !!p.undo_until && p.undo_until.getTime() > Date.now(),
      conversationId: p.conversation_id, messageId: p.message_id,
    }] : [];
  }
  if (q.startsWith("UPDATE verebona_command_plans SET status = 'UNDONE'")) {
    const p = d.plans.get(params[0] as string)!;
    p.status = 'UNDONE'; p.undone_at = new Date();
    return [];
  }
  if (q.startsWith('SELECT plan_id AS "planId"')) {
    const [acc, usr, conv] = params;
    return [...d.plans.values()].filter((p) => p.account_id === acc && p.user_id === usr && p.conversation_id === conv)
      .map((p) => ({
        planId: p.plan_id, accountId: p.account_id, userId: p.user_id, conversationId: p.conversation_id, messageId: p.message_id,
        status: p.status, summary: p.summary, actionsPayload: p.actions_payload, expiresAt: p.expires_at, undoUntil: p.undo_until,
      }));
  }
  if (q.startsWith("UPDATE verebona_command_plans SET status = 'EXPIRED' WHERE status")) return [];

  // Étapes d'annulation.
  if (q.startsWith('INSERT INTO verebona_command_undo_steps')) {
    const [plan_id, account_id, user_id, action_id, command, target_type, target_id, inverse_op, before, vb, va, label] = params;
    if (d.steps.some((s) => s.plan_id === plan_id && s.action_id === action_id)) return [];
    d.steps.push({
      id: d.steps.length + 1, plan_id, account_id, user_id, action_id, command, target_type, target_id, inverse_op,
      before_json: JSON.parse(before as string), version_before: vb, version_after: va, label, undone_at: null,
    } as Step);
    return [];
  }
  if (q.startsWith('SELECT id, action_id AS "actionId"')) {
    return d.steps.filter((s) => s.plan_id === params[0] && s.account_id === params[1] && !s.undone_at)
      .sort((a, b) => b.id - a.id)
      .map((s) => ({
        id: s.id, actionId: s.action_id, command: s.command, targetType: s.target_type, targetId: s.target_id,
        inverseOp: s.inverse_op, before: s.before_json, versionBefore: s.version_before, versionAfter: s.version_after, label: s.label,
      }));
  }
  if (q.startsWith('UPDATE verebona_command_undo_steps SET undone_at')) {
    for (const s of d.steps) if (s.plan_id === params[0] && !s.undone_at) s.undone_at = new Date();
    return [];
  }
  if (q.startsWith('DELETE FROM verebona_command_undo_steps')) return [];

  // Échéances.
  if (q.startsWith('SELECT id, title, to_char(start_date')) {
    const i = d.items.get(params[0] as number);
    if (!i || i.account_id !== params[1]) return [];
    return [{ id: i.id, title: i.title, startDate: i.start_date, manualStatus: i.manual_status, updatedAt: i.updated_at }];
  }
  if (q.startsWith('UPDATE agenda_items SET manual_status = $3')) {
    const i = d.items.get(params[0] as number)!;
    i.manual_status = params[2] as string | null; i.updated_at = stamp();
    return [];
  }
  if (q.startsWith('INSERT INTO agenda_occurrence_events')) {
    d.occurrences.push({ agenda_item_id: params[0] as number, event_type: 'STATUS_CHANGED', detail: JSON.parse(params[2] as string) });
    return [];
  }
  if (/^DELETE FROM agenda_(asset|file|room|equipment)_links/.test(q)) {
    if (q.startsWith('DELETE FROM agenda_asset_links')) d.links = d.links.filter((l) => l.agenda_item_id !== params[0]);
    return [];
  }
  if (q.startsWith('UPDATE agenda_data_conflicts') || q.startsWith('UPDATE agenda_item_sources')
    || q.startsWith('UPDATE energy_works') || q.startsWith('UPDATE impact_queue')
    || q.startsWith('DELETE FROM agenda_occurrence_events')) return [];
  if (q.startsWith('DELETE FROM agenda_items')) {
    const i = d.items.get(params[0] as number);
    if (i && i.account_id === params[1]) d.items.delete(i.id);
    return [];
  }

  // Biens.
  if (q.startsWith('SELECT count(*)::int AS n FROM assets WHERE id = ANY($1::int[]) AND purchase_date IS NULL')) {
    return [{ n: (params[0] as number[]).filter((id) => d.assets.get(id) && !d.assets.get(id)!.purchase_date).length }];
  }
  if (q.startsWith('SELECT count(*)::int AS n FROM assets WHERE id = ANY($1::int[]) AND account_id = $2')) {
    return [{ n: (params[0] as number[]).filter((id) => d.assets.get(id)?.account_id === params[1]).length }];
  }
  if (q.startsWith('SELECT count(*)::int AS n FROM agenda_asset_links')) {
    return [{ n: d.links.filter((l) => l.agenda_item_id === params[0] && !d.assets.get(l.asset_id)?.purchase_date).length }];
  }
  if (q.startsWith('SELECT id, name, status, lock_state')) {
    const a = d.assets.get(params[0] as number);
    if (!a || a.account_id !== params[1]) return [];
    return [{
      id: a.id, name: a.name, status: a.status, lockState: a.lock_state, keyCharacteristics: a.key_characteristics,
      registrationNumber: a.registration_number, purchaseDate: a.purchase_date, updatedAt: a.updated_at,
    }];
  }
  if (q.startsWith('SELECT id, name, city, category, status, lock_state AS "lockState", key_characteristics AS kc')) {
    const a = d.assets.get(params[0] as number);
    if (!a || a.account_id !== params[1]) return [];
    return [{ id: a.id, name: a.name, city: null, category: a.category, status: a.status, lockState: a.lock_state,
      kc: a.key_characteristics, purchaseDate: a.purchase_date, purchasePriceCents: null, registrationNumber: a.registration_number }];
  }
  if (q.startsWith('UPDATE assets SET key_characteristics = $3')) {
    const a = d.assets.get(params[0] as number)!;
    a.key_characteristics = params[2] as string | null; a.registration_number = params[3] as string | null; a.updated_at = stamp();
    return [];
  }

  // Fil.
  if (q.startsWith('INSERT INTO verebona_messages')) {
    const [conv, acc, usr, content, parent] = params as [number, number, number, string, number | null];
    if (!d.conversations.find((c) => c.id === conv && c.account_id === acc && c.user_id === usr && c.status === 'active')) return [];
    d.messages.push({ conversation_id: conv, content, parent_message_id: parent });
    return [{ conversation_id: conv }];
  }
  if (q.startsWith('UPDATE verebona_conversations')) return [];
  throw new Error(`SQL non simulé : ${q.slice(0, 90)}`);
}

async function begin<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
  const sauvegarde = clone(h.db);
  const tx = { unsafe: (q: string, p?: unknown[]) => unsafe(q, p), savepoint: async (f: (t: unknown) => Promise<unknown>) => f(tx) };
  try {
    return await fn(tx);
  } catch (e) {
    h.db = sauvegarde;
    throw e;
  }
}

vi.mock('@/db', () => ({
  pgClient: Object.assign(vi.fn(), { unsafe: vi.fn((q: string, p?: unknown[]) => unsafe(q, p)), begin: vi.fn((fn: never) => begin(fn)) }),
  db: {},
  ensureMigrations: vi.fn(async () => {}),
  ensureUnaccent: vi.fn(async () => {}),
}));

// Services métier de l'interface, simulés sur la même base en mémoire (y
// compris la synchronisation « achat » échéance → bien).
vi.mock('@/services/agenda/AgendaWriteService', () => {
  const syncAchat = (itemId: number) => {
    const i = h.db.items.get(itemId)!;
    if (!i.title.toLowerCase().includes('achat') || !i.start_date) return;
    for (const l of h.db.links.filter((x) => x.agenda_item_id === itemId)) {
      const a = h.db.assets.get(l.asset_id)!;
      if (!a.purchase_date) a.purchase_date = i.start_date;
    }
  };
  return {
    async createAgendaItem(input: { title: string; startDate: string; assetIds: number[] }, accountId: number) {
      const id = 100 + h.db.items.size + h.db.seq;
      h.db.items.set(id, { id, account_id: accountId, title: input.title, start_date: input.startDate, manual_status: null, updated_at: stamp() });
      for (const a of input.assetIds) h.db.links.push({ agenda_item_id: id, asset_id: a });
      syncAchat(id);
      return { id, title: input.title };
    },
    async updateManualStatus(id: number, status: string | null, accountId: number) {
      const i = h.db.items.get(id);
      if (!i || i.account_id !== accountId) throw new Error('Item not found');
      i.manual_status = status; i.updated_at = stamp();
      if (status === 'realise') syncAchat(id);
      return { id, title: i.title };
    },
  };
});
// Colonnes miroirs (CDC 15, D-10) : capturées TOUJOURS depuis le lot 16b-3
// (plus de commutateur `CANONICAL_WRITE_MODE`), simulées sur la base en mémoire.
vi.mock('@/services/canonical/asset-state/mirror-columns', () => ({
  async readMirrorColumns(_run: unknown, accountId: number, assetId: number) {
    const a = h.db.assets.get(assetId);
    if (!a || a.account_id !== accountId) return null;
    return { registration_number: a.registration_number, purchase_date: a.purchase_date };
  },
  async restoreMirrorColumns(_run: unknown, accountId: number, assetId: number, mirrors: Record<string, unknown>) {
    const a = h.db.assets.get(assetId);
    if (!a || a.account_id !== accountId) return;
    if ('registration_number' in mirrors) a.registration_number = mirrors.registration_number as string | null;
    if ('purchase_date' in mirrors) a.purchase_date = mirrors.purchase_date as string | null;
  },
}));
vi.mock('@/services/asset-details-write.service', () => {
  class AssetDetailsError extends Error { constructor(public code: string, message: string) { super(message); } }
  return {
    AssetDetailsError,
    async loadWritableAsset(id: number, accountId: number) {
      const a = h.db.assets.get(id);
      if (!a || a.account_id !== accountId) throw new AssetDetailsError('NOT_FOUND', 'Asset not found');
      return a;
    },
    async updateAssetDetails(p: { assetId: number; fields: Record<string, unknown> }) {
      const a = h.db.assets.get(p.assetId)!;
      const kc = JSON.parse(a.key_characteristics ?? '{}');
      Object.assign(kc, p.fields);
      if ('estimatedValue' in p.fields) kc.valuationHistory = [...(kc.valuationHistory ?? []), { value: p.fields.estimatedValue }];
      a.key_characteristics = JSON.stringify(kc);
      if ('registrationNumber' in p.fields) a.registration_number = p.fields.registrationNumber as string;
      a.updated_at = stamp();
      return { updated: true };
    },
  };
});
// Lecture canonique de l'état du bien (T2-40, seule lecture depuis le lot
// 16b-2), simulée sur la même base : clé, puis colonne historique.
vi.mock('@/services/verebona-assistant/canonical/commands', async (orig) => ({
  ...(await orig<typeof import('../../canonical/commands')>()),
  async commandAssetState(accountId: number, assetId: number) {
    const a = h.db.assets.get(assetId);
    if (!a || a.account_id !== accountId) return null;
    const kc = JSON.parse(a.key_characteristics ?? '{}') as Record<string, unknown>;
    return {
      id: a.id, name: a.name, city: null, category: a.category, status: a.status, lockState: a.lock_state,
      characteristics: { ...kc, registrationNumber: kc.registrationNumber ?? a.registration_number, acquisitionDate: kc.acquisitionDate ?? a.purchase_date },
    };
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', () => ({ emitBusinessEvent: h.emitBusinessEvent }));
vi.mock('@/services/ai/reconciliation/account-reconciliation.service', () => ({ notifyCoherenceEvent: h.notifyCoherenceEvent }));

const { confirmCommandPlan, hashActions, listThreadCommandPlans } = await import('../plan.service');
const { undoCommandPlan, UNDO_WINDOW_MS, UNDO_EXPIRED_MESSAGE, UNDO_IRREVERSIBLE_MESSAGE } = await import('../undo.service');
import type { PlannedAction } from '../catalog';

const owner = { accountId: 7, userId: 3 };
const canWrite = async () => ({ allowed: true });

function plan(id: string, actions: PlannedAction[], over: Partial<Plan> = {}): Plan {
  const payload = JSON.stringify(actions);
  const p: Plan = {
    plan_id: id, account_id: 7, user_id: 3, conversation_id: 11, message_id: 101, status: 'PENDING_CONFIRMATION',
    summary: 'Confirmez-vous ?', actions_payload: payload, params_hash: hashActions(payload),
    expires_at: new Date(Date.now() + 10 * 60_000), undo_until: null, undone_at: null, ...over,
  };
  db().plans.set(id, p);
  return p;
}
const creer = (actionId: string, title: string, assetIds: number[] = []): PlannedAction => ({
  actionId, command: 'CREATE_AGENDA_ITEM', targets: [], dependsOn: [],
  params: { title, startDate: '2026-10-03', assetIds }, preview: `Créer « ${title} ».`, effects: [],
});
const statut = (actionId: string, command: 'MARK_AGENDA_DONE' | 'CANCEL_AGENDA_ITEM', agendaItemId: number): PlannedAction => ({
  actionId, command, targets: [{ type: 'agenda_item', id: agendaItemId, label: 'x' }], dependsOn: [],
  params: { agendaItemId }, preview: 'Changer le statut.', effects: [],
});
const champ = (actionId: string, field: string, value: string | number, previous: unknown, section = 'common'): PlannedAction => ({
  actionId, command: 'UPDATE_ASSET_FIELD', targets: [{ type: 'asset', id: 12, label: 'Polo' }], dependsOn: [],
  params: { assetId: 12, section, field, value, previous }, preview: 'Modifier.',
  effects: ['Bien : Polo', `Champ : ${field === 'estimatedValue' ? 'Valeur estimée' : 'Immatriculation'}`, `Valeur actuelle : ${previous ?? 'non renseigné'}`, `Nouvelle valeur : ${value}`],
});
const item = (id: number, over: Partial<Item> = {}) => {
  db().items.set(id, { id, account_id: 7, title: 'Entretien chaudière', start_date: '2026-09-01', manual_status: null, updated_at: stamp(), ...over });
};
const asset = (over: Partial<Asset> = {}) => {
  db().assets.set(over.id ?? 12, {
    id: 12, account_id: 7, name: 'Polo', category: 'VEHICULE', status: 'EN_SERVICE', lock_state: 'NONE',
    key_characteristics: JSON.stringify({ estimatedValue: 9000, coherenceAlerts: [{ field: 'estimatedValue' }] }),
    registration_number: 'AB-123-CD', purchase_date: null, updated_at: stamp(), ...over,
  });
};
const confirmer = (id: string) => confirmCommandPlan({ planId: id, ...owner }, { canWrite });
const annuler = (id: string, who = owner) => undoCommandPlan({ planId: id, ...who }, { canWrite });
const types = () => db().events.map((e) => e.event_type);

beforeEach(() => {
  h.db = fresh();
  h.emitBusinessEvent.mockClear();
  h.notifyCoherenceEvent.mockClear();
});

describe('actions réversibles : commande inverse appliquée', () => {
  it('création d’échéance : fenêtre de 15 min ouverte, puis échéance supprimée (liens compris)', async () => {
    asset({ purchase_date: '2019-01-01' });
    plan('p1', [creer('a1', 'Vidange', [12])]);
    const c = await confirmer('p1');
    expect(c).toMatchObject({ ok: true, status: 'EXECUTED' });
    const until = new Date((c as { undoUntil: string }).undoUntil).getTime();
    expect(until - Date.now()).toBeGreaterThan(UNDO_WINDOW_MS - 5_000);
    expect(until - Date.now()).toBeLessThanOrEqual(UNDO_WINDOW_MS);
    expect(db().steps).toEqual([expect.objectContaining({ inverse_op: 'DELETE_AGENDA_ITEM', action_id: 'a1' })]);
    expect(db().items.size).toBe(1);

    const r = await annuler('p1');
    expect(r).toMatchObject({ ok: true, status: 'UNDONE', alreadyHandled: false });
    expect((r as { message: string }).message).toBe('J’ai annulé cette action : l’échéance « Vidange » a été supprimée.');
    expect(db().items.size).toBe(0);
    expect(db().links).toHaveLength(0);
    expect(db().plans.get('p1')!.status).toBe('UNDONE');
    expect(types()).toEqual(['CONFIRMED', 'EXECUTED', 'UNDONE']);
    expect(db().messages.at(-1)).toMatchObject({ content: (r as { message: string }).message, parent_message_id: 101 });
    await vi.waitFor(() => expect(h.emitBusinessEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'AGENDA_ITEM_DELETED' })));
  });

  it('échéance marquée réalisée : statut précédent rétabli et tracé dans l’historique de l’occurrence', async () => {
    item(5);
    plan('p1', [statut('a1', 'MARK_AGENDA_DONE', 5)]);
    await confirmer('p1');
    expect(db().items.get(5)!.manual_status).toBe('realise');
    const r = await annuler('p1');
    expect(r).toMatchObject({ ok: true, status: 'UNDONE' });
    expect((r as { message: string }).message).toMatch(/l’échéance « Entretien chaudière » a retrouvé son statut précédent \(à traiter\)/);
    expect(db().items.get(5)!.manual_status).toBeNull();
    expect(db().occurrences).toEqual([expect.objectContaining({ agenda_item_id: 5, detail: { manualStatus: null, undoOfPlan: 'p1' } })]);
  });

  it('échéance annulée : statut précédent rétabli (ici « réalisée »)', async () => {
    item(6, { manual_status: 'realise' });
    plan('p1', [statut('a1', 'CANCEL_AGENDA_ITEM', 6)]);
    await confirmer('p1');
    expect(db().items.get(6)!.manual_status).toBe('annule');
    expect(await annuler('p1')).toMatchObject({ ok: true });
    expect(db().items.get(6)!.manual_status).toBe('realise');
  });

  it('caractéristique d’un bien : valeur précédente rétablie, y compris ce que l’écriture avait ajouté', async () => {
    asset();
    const avant = db().assets.get(12)!.key_characteristics;
    plan('p1', [champ('a1', 'estimatedValue', 8500, 9000, 'valuation')]);
    await confirmer('p1');
    expect(JSON.parse(db().assets.get(12)!.key_characteristics!)).toMatchObject({ estimatedValue: 8500, valuationHistory: [{ value: 8500 }] });
    const r = await annuler('p1');
    expect((r as { message: string }).message).toBe('J’ai annulé cette action : « Valeur estimée » de Polo a retrouvé sa valeur précédente (9000).');
    expect(db().assets.get(12)!.key_characteristics).toBe(avant);
    await vi.waitFor(() => expect(h.notifyCoherenceEvent).toHaveBeenCalledWith(7, expect.objectContaining({ objectType: 'asset', objectId: 12 })));
  });

  it('immatriculation (colonne recopiée) : colonne ET caractéristiques rétablies', async () => {
    asset();
    plan('p1', [champ('a1', 'registrationNumber', 'ZZ-999-ZZ', 'AB-123-CD', 'vehicle_identification')]);
    await confirmer('p1');
    expect(db().assets.get(12)!.registration_number).toBe('ZZ-999-ZZ');
    await annuler('p1');
    expect(db().assets.get(12)!.registration_number).toBe('AB-123-CD');
  });

  it('plan multi-actions : tout est défait, en ordre inverse — y compris deux étapes sur la même échéance', async () => {
    item(5);
    plan('p1', [creer('a1', 'Vidange'), statut('a2', 'MARK_AGENDA_DONE', 5), statut('a3', 'CANCEL_AGENDA_ITEM', 5)]);
    await confirmer('p1');
    expect(db().items.get(5)!.manual_status).toBe('annule');
    const r = await annuler('p1');
    expect(r).toMatchObject({ ok: true });
    expect(db().items.get(5)!.manual_status).toBeNull();
    expect(db().items.size).toBe(1);
    expect((r as { message: string }).message.split('\n')).toHaveLength(4);
  });
});

describe('refus : rien n’est modifié', () => {
  it('délai de 15 minutes dépassé', async () => {
    item(5);
    plan('p1', [statut('a1', 'MARK_AGENDA_DONE', 5)]);
    await confirmer('p1');
    db().plans.get('p1')!.undo_until = new Date(Date.now() - 1000);
    expect(await annuler('p1')).toEqual({ ok: false, code: 'UNDO_EXPIRED', message: UNDO_EXPIRED_MESSAGE, status: 'EXECUTED' });
    expect(db().items.get(5)!.manual_status).toBe('realise');
  });

  it('cible modifiée depuis l’exécution : message clair, tracé et restitué dans le fil', async () => {
    item(5);
    plan('p1', [statut('a1', 'MARK_AGENDA_DONE', 5)]);
    await confirmer('p1');
    db().items.get(5)!.title = 'Entretien chaudière (fait par Dupont)';
    db().items.get(5)!.updated_at = stamp();
    const r = await annuler('p1');
    expect(r).toMatchObject({ ok: false, code: 'UNDO_CONFLICT', status: 'EXECUTED' });
    expect((r as { message: string }).message).toBe(
      'Annulation impossible : l’échéance « Entretien chaudière » a changé depuis l’exécution de l’action. Rien n’a été modifié ; vous pouvez faire la correction directement depuis l’écran concerné.');
    expect(db().items.get(5)!.manual_status).toBe('realise');
    expect(db().plans.get('p1')!.status).toBe('EXECUTED');
    expect(types().at(-1)).toBe('UNDO_REFUSED');
    expect(db().messages.at(-1)!.content).toBe((r as { message: string }).message);
  });

  it('modification concurrente détectée même sans changement de valeur (date de mise à jour)', async () => {
    asset();
    plan('p1', [champ('a1', 'estimatedValue', 8500, 9000, 'valuation')]);
    await confirmer('p1');
    db().assets.get(12)!.updated_at = stamp();
    expect(await annuler('p1')).toMatchObject({ ok: false, code: 'UNDO_CONFLICT' });
    expect(JSON.parse(db().assets.get(12)!.key_characteristics!).estimatedValue).toBe(8500);
  });

  it('cible supprimée depuis : « n’existe plus »', async () => {
    plan('p1', [creer('a1', 'Vidange')]);
    await confirmer('p1');
    db().items.clear();
    const r = await annuler('p1');
    expect(r).toMatchObject({ ok: false, code: 'UNDO_CONFLICT' });
    expect((r as { message: string }).message).toMatch(/n’existe plus/);
  });

  it('atomique : un conflit sur une étape n’en défait aucune autre', async () => {
    item(5);
    plan('p1', [creer('a1', 'Vidange'), statut('a2', 'MARK_AGENDA_DONE', 5)]);
    await confirmer('p1');
    // L'étape a1 (défaite en dernier) est en conflit ; a2 aurait été défaite avant.
    const cree = [...db().items.values()].find((i) => i.title === 'Vidange')!;
    cree.updated_at = stamp();
    expect(await annuler('p1')).toMatchObject({ ok: false, code: 'UNDO_CONFLICT' });
    expect(db().items.get(5)!.manual_status).toBe('realise');
    expect(db().items.size).toBe(2);
    expect(db().steps.every((s) => s.undone_at === null)).toBe(true);
    expect(db().plans.get('p1')!.status).toBe('EXECUTED');
  });

  it('plan d’un autre utilisateur (Duo) ou d’un autre compte : inexistant (404), rien ne change', async () => {
    item(5);
    plan('p1', [statut('a1', 'MARK_AGENDA_DONE', 5)]);
    await confirmer('p1');
    expect(await annuler('p1', { accountId: 7, userId: 4 })).toMatchObject({ ok: false, code: 'PLAN_NOT_FOUND' });
    expect(await annuler('p1', { accountId: 8, userId: 3 })).toMatchObject({ ok: false, code: 'PLAN_NOT_FOUND' });
    expect(db().items.get(5)!.manual_status).toBe('realise');
    expect(types()).not.toContain('UNDONE');
  });

  it('compte en lecture seule (offre, impayé) : refusé, rien n’est modifié', async () => {
    item(5);
    plan('p1', [statut('a1', 'MARK_AGENDA_DONE', 5)]);
    await confirmer('p1');
    const r = await undoCommandPlan({ planId: 'p1', ...owner }, { canWrite: async () => ({ allowed: false, message: 'Votre compte est en lecture seule.' }) });
    expect(r).toMatchObject({ ok: false, code: 'WRITE_REFUSED', message: 'Votre compte est en lecture seule.' });
    expect(db().items.get(5)!.manual_status).toBe('realise');
  });

  it('proposition non exécutée : rien à défaire', async () => {
    plan('p1', [creer('a1', 'Vidange')]);
    expect(await annuler('p1')).toMatchObject({ ok: false, code: 'NOT_UNDOABLE', status: 'PENDING_CONFIRMATION' });
  });
});

describe('idempotence', () => {
  it('rejouée : même résultat, sans nouvelle écriture, trace ni message', async () => {
    item(5);
    plan('p1', [statut('a1', 'MARK_AGENDA_DONE', 5)]);
    await confirmer('p1');
    await annuler('p1');
    const evenements = db().events.length;
    const messages = db().messages.length;
    db().items.get(5)!.manual_status = 'realise'; // modifiée ensuite par l'utilisateur
    const r2 = await annuler('p1');
    expect(r2).toMatchObject({ ok: true, status: 'UNDONE', alreadyHandled: true });
    expect(db().items.get(5)!.manual_status).toBe('realise');
    expect(db().events).toHaveLength(evenements);
    expect(db().messages).toHaveLength(messages);
  });
});

describe('actions irréversibles : aucun bouton, annulation refusée', () => {
  it('échéance « achat » sur un bien sans date d’achat (synchronisation échéance → bien)', async () => {
    asset({ purchase_date: null });
    plan('p1', [creer('a1', 'Achat pneus', [12])]);
    const c = await confirmer('p1');
    expect(c).toMatchObject({ ok: true, undoUntil: null });
    expect(db().assets.get(12)!.purchase_date).toBe('2026-10-03');
    expect(db().steps).toHaveLength(0);
    expect(db().events.find((e) => e.event_type === 'EXECUTED')!.detail.undo).toMatchObject({ reversible: false });
    expect(await annuler('p1')).toEqual({ ok: false, code: 'IRREVERSIBLE', message: UNDO_IRREVERSIBLE_MESSAGE, status: 'EXECUTED' });
    expect(db().items.size).toBe(1);
  });

  it('échéance « achat » marquée réalisée : irréversible', async () => {
    asset({ purchase_date: null });
    item(5, { title: 'Achat Polo', start_date: '2019-03-12' });
    db().links.push({ agenda_item_id: 5, asset_id: 12 });
    plan('p1', [statut('a1', 'MARK_AGENDA_DONE', 5)]);
    expect(await confirmer('p1')).toMatchObject({ undoUntil: null });
    expect(await annuler('p1')).toMatchObject({ code: 'IRREVERSIBLE' });
  });

  it('« achat » sans effet sur le bien (date déjà connue) : reste réversible', async () => {
    asset({ purchase_date: '2019-01-01' });
    plan('p1', [creer('a1', 'Achat pneus', [12])]);
    expect((await confirmer('p1') as { undoUntil: string | null }).undoUntil).not.toBeNull();
  });

  it('T2-039 : une seule étape irréversible rend tout le plan non annulable', async () => {
    asset({ purchase_date: null });
    item(5);
    plan('p1', [statut('a1', 'MARK_AGENDA_DONE', 5), creer('a2', 'Achat pneus', [12])]);
    expect(await confirmer('p1')).toMatchObject({ undoUntil: null });
    expect(db().steps).toHaveLength(0);
    expect(await annuler('p1')).toMatchObject({ code: 'IRREVERSIBLE' });
    expect(db().items.get(5)!.manual_status).toBe('realise');
  });
});

describe('restitution dans le fil', () => {
  it('fenêtre rendue pour un plan exécuté réversible ; plus rien une fois annulé', async () => {
    item(5);
    plan('p1', [statut('a1', 'MARK_AGENDA_DONE', 5)]);
    await confirmer('p1');
    const [avant] = await listThreadCommandPlans(7, 3, 11);
    expect(avant.undoUntil).toEqual(expect.any(String));
    await annuler('p1');
    const [apres] = await listThreadCommandPlans(7, 3, 11);
    expect(apres).toMatchObject({ status: 'UNDONE', undoUntil: null });
  });
});
