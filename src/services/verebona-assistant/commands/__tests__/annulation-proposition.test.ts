/**
 * Annulation d'une commande proposée et non confirmée — CDC §5.3
 * (« possibilité d'annulation »), §9.6 (états CANCELLED / EXPIRED), §27.5
 * (idempotence), §28.2 (issue enregistrée dans le fil).
 *
 * La base est simulée en mémoire : seules les requêtes du service de plans
 * sont interprétées, avec les mêmes conditions que le SQL (propriétaire,
 * état, expiration).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Plan = {
  plan_id: string; account_id: number; user_id: number; conversation_id: number | null; message_id: number | null;
  status: string; summary: string; actions_payload: string; params_hash: string; expires_at: Date; created_at: Date;
};
type Msg = { conversation_id: number; account_id: number; role: string; content: string; intent: string; parent_message_id: number | null };

const db = vi.hoisted(() => ({
  plans: new Map<string, unknown>(),
  events: [] as Array<{ plan_id: string; event_type: string }>,
  messages: [] as unknown[],
  conversations: [] as Array<{ id: number; account_id: number; user_id: number; status: string }>,
}));

const now = () => Date.now();
const P = () => db.plans as Map<string, Plan>;

async function unsafe(sql: string, params: unknown[] = []): Promise<unknown[]> {
  const q = sql.replace(/\s+/g, ' ');
  const own = (p: Plan | undefined, id: unknown, acc: unknown, usr: unknown) =>
    p && p.plan_id === id && p.account_id === acc && p.user_id === usr ? p : undefined;

  if (q.includes("INSERT INTO verebona_command_events")) {
    db.events.push({ plan_id: params[0] as string, event_type: params[3] as string });
    return [];
  }
  if (q.includes("SET status = 'CANCELLED'")) {
    const p = own(P().get(params[0] as string), params[0], params[1], params[2]);
    if (!p || p.status !== 'PENDING_CONFIRMATION' || p.expires_at.getTime() <= now()) return [];
    p.status = 'CANCELLED';
    return [{ conversationId: p.conversation_id, messageId: p.message_id }];
  }
  if (q.includes("SET status = 'EXECUTING'")) {
    const p = own(P().get(params[0] as string), params[0], params[1], params[2]);
    if (!p || p.status !== 'PENDING_CONFIRMATION' || p.expires_at.getTime() <= now()) return [];
    p.status = 'EXECUTING';
    return [{ actions_payload: p.actions_payload, params_hash: p.params_hash, summary: p.summary, conversationId: p.conversation_id, messageId: p.message_id }];
  }
  if (q.startsWith('SELECT status, expires_at < now() AS expired')) {
    const p = own(P().get(params[0] as string), params[0], params[1], params[2]);
    return p ? [{ status: p.status, expired: p.expires_at.getTime() < now(), conversationId: p.conversation_id, messageId: p.message_id }] : [];
  }
  if (q.includes("SET status = 'EXPIRED' WHERE plan_id = $1")) {
    const p = P().get(params[0] as string);
    if (!p || p.status !== 'PENDING_CONFIRMATION') return [];
    p.status = 'EXPIRED';
    return [{ plan_id: p.plan_id }];
  }
  if (q.includes("SET status = 'EXPIRED' WHERE status = 'PENDING_CONFIRMATION'")) {
    const [acc, usr] = params as [number | null, number | null];
    const out: unknown[] = [];
    for (const p of P().values()) {
      if (p.status === 'PENDING_CONFIRMATION' && p.expires_at.getTime() <= now()
        && (acc == null || p.account_id === acc) && (usr == null || p.user_id === usr)) {
        p.status = 'EXPIRED';
        out.push({ plan_id: p.plan_id, account_id: p.account_id, user_id: p.user_id });
      }
    }
    return out;
  }
  if (q.startsWith('UPDATE verebona_command_plans SET status = $2, results_json')) {
    const p = P().get(params[0] as string);
    if (p) p.status = params[1] as string;
    return [];
  }
  if (q.startsWith('SELECT plan_id AS "planId"')) {
    const [acc, usr, conv] = params;
    return [...P().values()]
      .filter((p) => p.account_id === acc && p.user_id === usr && p.conversation_id === conv && p.message_id != null)
      .map((p) => ({
        planId: p.plan_id, accountId: p.account_id, userId: p.user_id, conversationId: p.conversation_id,
        messageId: p.message_id, status: p.status, summary: p.summary, actionsPayload: p.actions_payload, expiresAt: p.expires_at,
      }));
  }
  if (q.startsWith('INSERT INTO verebona_messages')) {
    const [conv, acc, usr, content, parent] = params as [number, number, number, string, number | null];
    const c = db.conversations.find((x) => x.id === conv && x.account_id === acc && x.user_id === usr && x.status === 'active');
    if (!c) return [];
    (db.messages as Msg[]).push({ conversation_id: conv, account_id: acc, role: 'assistant', content, intent: 'WRITE_COMMAND', parent_message_id: parent });
    return [{ conversation_id: conv }];
  }
  if (q.startsWith('UPDATE verebona_conversations')) return [];
  // Purge quotidienne des annulations d'actions exécutées (undo.service).
  if (q.startsWith('DELETE FROM verebona_command_undo_steps')) return [];
  throw new Error(`SQL non simulé : ${q.slice(0, 80)}`);
}

vi.mock('@/db', () => ({
  pgClient: Object.assign(vi.fn(), { unsafe: vi.fn((sql: string, params?: unknown[]) => unsafe(sql, params)), begin: vi.fn() }),
  db: {},
  ensureMigrations: vi.fn(async () => {}),
  ensureUnaccent: vi.fn(async () => {}),
}));

const { cancelCommandPlan, confirmCommandPlan, expirePendingPlans, listThreadCommandPlans, hashActions,
  CANCELLED_MESSAGE, EXPIRED_MESSAGE } = await import('../plan.service');

const ACTIONS = JSON.stringify([{
  actionId: 'a1', command: 'MARK_AGENDA_DONE', targets: [{ type: 'agenda_item', id: 5, label: 'Entretien chaudière' }],
  params: { agendaItemId: 5 }, dependsOn: [], preview: 'Marquer comme réalisée l’échéance « Entretien chaudière ».', effects: [],
}]);

function plan(id: string, over: Partial<Plan> = {}): Plan {
  const p: Plan = {
    plan_id: id, account_id: 7, user_id: 3, conversation_id: 11, message_id: 101,
    status: 'PENDING_CONFIRMATION', summary: 'Marquer… Confirmez-vous ?', actions_payload: ACTIONS, params_hash: hashActions(ACTIONS),
    expires_at: new Date(now() + 10 * 60_000), created_at: new Date(), ...over,
  };
  P().set(id, p);
  return p;
}
const owner = { accountId: 7, userId: 3 };
const executors = () => {
  const run = vi.fn(async (a: { actionId: string }) => ({ actionId: a.actionId, status: 'SUCCESS' as const, message: 'fait' }));
  return { run, all: { CREATE_AGENDA_ITEM: run, MARK_AGENDA_DONE: run, CANCEL_AGENDA_ITEM: run, UPDATE_ASSET_FIELD: run } };
};

beforeEach(() => {
  db.plans.clear();
  db.events.length = 0;
  db.messages.length = 0;
  db.conversations.length = 0;
  db.conversations.push({ id: 11, account_id: 7, user_id: 3, status: 'active' });
});

describe('annuler une proposition en attente', () => {
  it('passe à CANCELLED, trace, et enregistre l’issue dans le fil (rattachée au message du plan)', async () => {
    plan('p1');
    const r = await cancelCommandPlan({ planId: 'p1', ...owner });
    expect(r).toEqual({ ok: true, status: 'CANCELLED', alreadyHandled: false, message: CANCELLED_MESSAGE });
    expect(P().get('p1')!.status).toBe('CANCELLED');
    expect(db.events.map((e) => e.event_type)).toEqual(['CANCELLED']);
    expect(db.messages).toEqual([expect.objectContaining({ conversation_id: 11, content: CANCELLED_MESSAGE, parent_message_id: 101 })]);
    expect(CANCELLED_MESSAGE).toMatch(/rien n’a été modifié/);
  });

  it('idempotente : rejouée, même résultat, sans seconde trace ni second message', async () => {
    plan('p1');
    await cancelCommandPlan({ planId: 'p1', ...owner });
    const r2 = await cancelCommandPlan({ planId: 'p1', ...owner });
    expect(r2).toMatchObject({ ok: true, status: 'CANCELLED', alreadyHandled: true });
    expect(db.events).toHaveLength(1);
    expect(db.messages).toHaveLength(1);
  });

  it('une proposition annulée ne peut plus être confirmée : aucune exécution', async () => {
    plan('p1');
    await cancelCommandPlan({ planId: 'p1', ...owner });
    const ex = executors();
    const c = await confirmCommandPlan({ planId: 'p1', ...owner }, { executors: ex.all, canWrite: async () => ({ allowed: true }) });
    expect(c).toMatchObject({ ok: false, code: 'PLAN_ALREADY_HANDLED', status: 'CANCELLED' });
    expect(ex.run).not.toHaveBeenCalled();
  });

  it('après confirmation, l’annulation est refusée (pas de retour arrière sur une écriture exécutée)', async () => {
    plan('p1');
    const ex = executors();
    await confirmCommandPlan({ planId: 'p1', ...owner }, { executors: ex.all, canWrite: async () => ({ allowed: true }) });
    const r = await cancelCommandPlan({ planId: 'p1', ...owner });
    expect(r).toMatchObject({ ok: false, code: 'PLAN_ALREADY_HANDLED', status: 'EXECUTED' });
    expect(P().get('p1')!.status).toBe('EXECUTED');
  });

  it('proposition expirée : close comme EXPIRED, rien à annuler, issue enregistrée une seule fois', async () => {
    plan('p1', { expires_at: new Date(now() - 1000) });
    const r = await cancelCommandPlan({ planId: 'p1', ...owner });
    expect(r).toEqual({ ok: true, status: 'EXPIRED', alreadyHandled: false, message: EXPIRED_MESSAGE });
    expect(P().get('p1')!.status).toBe('EXPIRED');
    const r2 = await cancelCommandPlan({ planId: 'p1', ...owner });
    expect(r2).toMatchObject({ ok: true, status: 'EXPIRED', alreadyHandled: true });
    expect(db.messages).toHaveLength(1);
  });

  it('plan d’un autre utilisateur (Duo) ou d’un autre compte : inexistant, rien ne change', async () => {
    plan('p1');
    expect(await cancelCommandPlan({ planId: 'p1', accountId: 7, userId: 4 })).toMatchObject({ ok: false, code: 'PLAN_NOT_FOUND' });
    expect(await cancelCommandPlan({ planId: 'p1', accountId: 8, userId: 3 })).toMatchObject({ ok: false, code: 'PLAN_NOT_FOUND' });
    expect(P().get('p1')!.status).toBe('PENDING_CONFIRMATION');
    expect(db.messages).toHaveLength(0);
  });

  it('fil effacé entre-temps : l’annulation réussit, aucun message n’est recréé', async () => {
    plan('p1');
    db.conversations.length = 0;
    const r = await cancelCommandPlan({ planId: 'p1', ...owner });
    expect(r).toMatchObject({ ok: true, status: 'CANCELLED' });
    expect(db.messages).toHaveLength(0);
  });
});

describe('expiration des propositions', () => {
  it('confirmation tardive refusée, proposition close comme EXPIRED', async () => {
    plan('p1', { expires_at: new Date(now() - 1000) });
    const ex = executors();
    const c = await confirmCommandPlan({ planId: 'p1', ...owner }, { executors: ex.all, canWrite: async () => ({ allowed: true }) });
    expect(c).toMatchObject({ ok: false, code: 'PLAN_EXPIRED', status: 'EXPIRED' });
    expect(ex.run).not.toHaveBeenCalled();
  });

  it('expirePendingPlans ne clôt que les propositions en attente dépassées (du périmètre demandé)', async () => {
    plan('vieux', { expires_at: new Date(now() - 1000) });
    plan('frais');
    plan('autre', { expires_at: new Date(now() - 1000), account_id: 9 });
    plan('fait', { expires_at: new Date(now() - 1000), status: 'EXECUTED' });
    expect(await expirePendingPlans({ accountId: 7, userId: 3 })).toBe(1);
    expect(P().get('vieux')!.status).toBe('EXPIRED');
    expect(P().get('frais')!.status).toBe('PENDING_CONFIRMATION');
    expect(P().get('autre')!.status).toBe('PENDING_CONFIRMATION');
    expect(P().get('fait')!.status).toBe('EXECUTED');
    expect(await expirePendingPlans()).toBe(1);
    expect(P().get('autre')!.status).toBe('EXPIRED');
  });
});

describe('état restitué dans le fil', () => {
  it('chaque plan revient sur son message avec son état réel ; seuls ceux de l’utilisateur', async () => {
    plan('attente');
    plan('annule', { message_id: 102, status: 'CANCELLED' });
    plan('perime', { message_id: 103, expires_at: new Date(now() - 1000) });
    plan('duo', { message_id: 104, user_id: 4 });
    const list = await listThreadCommandPlans(7, 3, 11);
    expect(list.map((p) => [p.planId, p.messageId, p.status])).toEqual([
      ['attente', 101, 'PENDING_CONFIRMATION'], ['annule', 102, 'CANCELLED'], ['perime', 103, 'EXPIRED'],
    ]);
    // Aperçu seulement : jamais les paramètres exécutables.
    expect(list[0].actions[0]).toEqual(expect.objectContaining({ actionId: 'a1', preview: expect.any(String) }));
    expect(JSON.stringify(list)).not.toContain('agendaItemId');
  });

  it('confirmation : l’issue de l’exécution est aussi enregistrée dans le fil', async () => {
    plan('p1');
    const ex = executors();
    const c = await confirmCommandPlan({ planId: 'p1', ...owner }, { executors: ex.all, canWrite: async () => ({ allowed: true }) });
    expect(c.ok).toBe(true);
    expect(db.messages).toEqual([expect.objectContaining({ content: 'fait', parent_message_id: 101 })]);
  });
});
