/**
 * Rattrapage « Premium Duo — compte partagé » (lot 72D, ticket P0 §7, plan
 * de migration §4 de l'audit) — BO › Exploitation › Rattrapages, bloc 11
 * `duo-shared-account`. JAMAIS lancé automatiquement.
 *
 * Avant le lot 72D, l'invité d'un Duo n'avait AUCUNE adhésion au compte du
 * titulaire (seulement `duo_memberships`) et recevait un compte personnel
 * artificiel avec un essai de 7 jours. Ce rattrapage :
 *
 *   INV-A  titulaires sans adhésion `owner` active  → adhésion créée/réactivée ;
 *   INV-B  membres Duo actifs sans adhésion au compte partagé → adhésion
 *          `member` créée ou réactivée (places `max_members` respectées) ;
 *   INV-C  Duo dont le compte est indécidable → rapport seul ;
 *   INV-D  comptes personnels des invités (actuels ou passés) :
 *            D1 vide et artificiel → ARCHIVÉ (réversible, rien effacé) ;
 *            D2 avec données, D3 avec facturation Stripe, D4 avec biens reçus
 *            d'un transfert (lot 40) → rapport seul ;
 *   INV-E  essais indus (comptes des invités) → rapport seul, aucune remise
 *          à zéro ;
 *   INV-F  incohérences d'offre : `users.plan_type` = PREMIUM_DUO sans
 *          adhésion à un Duo → copie d'affichage corrigée ; Duo ↔ compte,
 *          Stripe Duo ↔ compte → rapport seul (rien côté Stripe) ;
 *   INV-G  demandes croisées en attente / biens verrouillés → rapport (0522) ;
 *   INV-H  anciens membres (LEFT / REMOVED) → rapport, rien créé ;
 *   INV-I  adhésions `member` actives dont l'inviteur n'est pas titulaire du
 *          compte (contrôle de la faille d'invitation de l'audit §1.4).
 *
 * Garanties : aucune fusion, aucun déplacement de bien, aucune suppression
 * physique, aucun appel Stripe. Chaque écriture est journalisée
 * (`duo_shared_account_journal`, avant / après) ; `restore <runId>` rejoue le
 * journal à l'envers. Idempotent : une seconde application n'écrit rien.
 * Simulation = lecture seule (même inventaire, mêmes décisions).
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';

type Sql = postgres.Sql | postgres.TransactionSql;

/** Tables à `account_id` remplies sans action de l'utilisateur (compte « vide » malgré elles). */
export const TECHNICAL_ACCOUNT_TABLES: readonly string[] = [
  'account_memberships', 'account_subscriptions', 'account_audit_log', 'trial_grants', 'signup_contexts',
  'funnel_events', 'notification_outbox', 'notification_events', 'home_mascot_cache', 'home_mascot_generations',
  'home_mascot_pregen_requests', 'home_mascot_events', 'account_analysis_counters', 'account_analysis_credits',
  'ai_account_cost_caps', 'admin_anomalies', 'admin_anomaly_occurrences', 'subscription_history',
  'account_reconciliation_runs', 't3_reconciliation_states', 'v2_classification_progress', 'duo_shared_account_journal',
  'annual_renewal_reminder_checks', 'ai_usage_account_counter', 'cdc15_migration_report', 'room_merge_runs',
  'reconciliation_runs', 'impact_queue', 'duo_accounts',
];

export type PersonalCategory = 'D1' | 'D2' | 'D3' | 'D4';

export interface DuoRow {
  duoId: number;
  status: string;
  accountId: number | null;
  ownerUserId: number;
  memberUserId: number | null;
  memberBefore: string | null;
  memberAfter: string | null;
  personalAccounts: Array<{ accountId: number; category: PersonalCategory; trial: string | null; tables: string[]; archived: boolean }>;
  anomalies: string[];
}

export interface Inventory {
  A: number; B: number; C: number; D1: number; D2: number; D3: number; D4: number;
  E: number; F: number; G: number; H: number; I: number;
}

export interface DuoSharedAccountReport {
  mode: 'simulate' | 'apply';
  runId: string | null;
  accountId: number | null;
  before: Inventory;
  after: Inventory | null;
  actions: {
    ownerMembershipsCreated: number;
    ownerMembershipsReactivated: number;
    memberMembershipsCreated: number;
    memberMembershipsReactivated: number;
    accountsArchived: number;
    planTypesFixed: number;
    lastSelectedSet: number;
  };
  duos: DuoRow[];
  undecidable: Array<{ duoId: number; reason: string }>;
  seatsExceeded: Array<{ duoId: number; accountId: number; userId: number }>;
  suspiciousInvitations: Array<{ accountId: number; userId: number; invitedBy: number | null }>;
  billingMismatches: Array<{ duoId: number; reason: string }>;
  ownerFixes: Array<{ accountId: number; userId: number }>;
  planTypeFixes: Array<{ userId: number; from: string; to: string }>;
}

export interface RestoreReport {
  runId: string;
  restored: number;
  skipped: number;
  conflicts: string[];
}

const ACTIVE_DUO = ['ACTIVE', 'UNPAID_RECOVERY', 'TRIALING'];

async function accountTablesWithRows(q: Sql, accountId: number): Promise<string[]> {
  const tables = await q<{ table_name: string }[]>`
    SELECT c.table_name FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = current_schema() AND c.column_name = 'account_id'
     ORDER BY 1`;
  const found: string[] = [];
  for (const { table_name } of tables) {
    if (TECHNICAL_ACCOUNT_TABLES.includes(table_name)) continue;
    const r = await q.unsafe<{ ok: number }[]>(`SELECT 1 AS ok FROM "${table_name.replace(/"/g, '')}" WHERE account_id = $1 LIMIT 1`, [accountId]);
    if (r.length > 0) found.push(table_name);
  }
  return found;
}

/** Classement d'un compte personnel d'invité (§4.2) — dans le doute, D2. */
async function classifyPersonalAccount(q: Sql, accountId: number, userId: number, joinedAt: Date | null): Promise<{ category: PersonalCategory; tables: string[]; trial: string | null }> {
  const [acc] = await q<{ stripe_customer_id: string | null; stripe_subscription_id: string | null; created_at: Date; archived_at: Date | null }[]>`
    SELECT stripe_customer_id, stripe_subscription_id, created_at, archived_at FROM accounts WHERE id = ${accountId}`;
  const [sub] = await q<{ status: string; stripe_customer_id: string | null; stripe_subscription_id: string | null; first_billed_at: Date | null }[]>`
    SELECT status, stripe_customer_id, stripe_subscription_id, first_billed_at FROM account_subscriptions WHERE account_id = ${accountId} LIMIT 1`;
  const trial = sub?.status ?? null;
  const [inv] = await q<{ ok: number }[]>`SELECT 1 AS ok FROM invoices WHERE account_id = ${accountId} LIMIT 1`;
  if (acc?.stripe_customer_id || acc?.stripe_subscription_id || sub?.stripe_customer_id || sub?.stripe_subscription_id || sub?.first_billed_at || inv) {
    return { category: 'D3', tables: [], trial };
  }
  const [recu] = await q<{ ok: number }[]>`SELECT 1 AS ok FROM asset_move_requests WHERE target_account_id = ${accountId} LIMIT 1`;
  if (recu) return { category: 'D4', tables: ['asset_move_requests'], trial };
  const [autres] = await q<{ n: number }[]>`
    SELECT count(*)::int AS n FROM account_memberships WHERE account_id = ${accountId} AND user_id IS NOT NULL AND user_id <> ${userId}`;
  if ((autres?.n ?? 0) > 0) return { category: 'D2', tables: ['account_memberships'], trial };
  const tables = await accountTablesWithRows(q, accountId);
  if (tables.length > 0) return { category: 'D2', tables, trial };
  // Créé par l'inscription sur invitation : compte né avant le rattachement
  // au Duo, et dans les 30 jours qui le précèdent ; sinon (compte ancien,
  // simplement inutilisé) → D2, aucune action.
  const created = acc?.created_at ? new Date(acc.created_at).getTime() : NaN;
  const joined = joinedAt ? new Date(joinedAt).getTime() : NaN;
  const artificiel = Number.isFinite(created) && Number.isFinite(joined) && created <= joined && joined - created <= 30 * 24 * 3600 * 1000;
  return { category: artificiel ? 'D1' : 'D2', tables, trial };
}

interface Ctx {
  q: Sql;
  apply: boolean;
  runId: string;
  accountFilter: number | null;
  log: (m: string) => void;
}

async function journal(c: Ctx, action: string, entity: string, entityId: number, accountId: number | null, userId: number | null, before: unknown, after: unknown) {
  await c.q`
    INSERT INTO duo_shared_account_journal (run_id, action, entity, entity_id, account_id, user_id, before, after)
    VALUES (${c.runId}, ${action}, ${entity}, ${entityId}, ${accountId}, ${userId},
            ${before == null ? null : JSON.stringify(before)}::jsonb, ${after == null ? null : JSON.stringify(after)}::jsonb)`;
}

async function inventoryAndAct(c: Ctx): Promise<Omit<DuoSharedAccountReport, 'mode' | 'runId' | 'accountId' | 'before' | 'after'> & { inv: Inventory }> {
  const { q } = c;
  const inv: Inventory = { A: 0, B: 0, C: 0, D1: 0, D2: 0, D3: 0, D4: 0, E: 0, F: 0, G: 0, H: 0, I: 0 };
  const actions = {
    ownerMembershipsCreated: 0, ownerMembershipsReactivated: 0, memberMembershipsCreated: 0,
    memberMembershipsReactivated: 0, accountsArchived: 0, planTypesFixed: 0, lastSelectedSet: 0,
  };
  const now = new Date();
  const filtre = c.accountFilter;

  // ── INV-A : titulaires sans adhésion owner active ─────────────────────
  const ownerFixes = await q<{ account_id: number; user_id: number; membership_id: number | null; status: string | null; role: string | null }[]>`
    SELECT a.id AS account_id, a.owner_user_id AS user_id, m.id AS membership_id, m.status, m.role
      FROM accounts a
      LEFT JOIN account_memberships m ON m.account_id = a.id AND m.user_id = a.owner_user_id
     WHERE (${filtre}::int IS NULL OR a.id = ${filtre})
       AND NOT EXISTS (SELECT 1 FROM account_memberships x
                        WHERE x.account_id = a.id AND x.user_id = a.owner_user_id AND x.role = 'owner' AND lower(x.status) = 'active')
     ORDER BY a.id`;
  inv.A = ownerFixes.length;
  for (const f of ownerFixes) {
    if (!c.apply) continue;
    if (f.membership_id) {
      await q`UPDATE account_memberships SET role = 'owner', status = 'active', removed_at = NULL, ended_reason = NULL,
                     source = COALESCE(source, 'migration_72d'), updated_at = now() WHERE id = ${f.membership_id}`;
      await journal(c, 'MEMBERSHIP_OWNER_REACTIVATED', 'account_membership', f.membership_id, f.account_id, f.user_id,
        { status: f.status, role: f.role }, { status: 'active', role: 'owner' });
      actions.ownerMembershipsReactivated += 1;
    } else {
      const [m] = await q<{ id: number }[]>`
        INSERT INTO account_memberships (account_id, user_id, role, status, source, invited_at, joined_at, created_at, updated_at)
        VALUES (${f.account_id}, ${f.user_id}, 'owner', 'active', 'migration_72d', now(), now(), now(), now())
        RETURNING id`;
      await journal(c, 'MEMBERSHIP_OWNER_CREATED', 'account_membership', m.id, f.account_id, f.user_id, null, { status: 'active', role: 'owner' });
      actions.ownerMembershipsCreated += 1;
    }
  }

  // ── Duo et membres ────────────────────────────────────────────────────
  const duos = await q<{ duo_id: number; status: string; account_id: number | null; owner_user_id: number; stripe_sub: string | null; stripe_cus: string | null }[]>`
    -- Compte partagé : lien 0520, sinon l'UNIQUE compte qui porte ce Duo.
    SELECT d.id AS duo_id, d.subscription_status AS status,
           COALESCE(d.account_id, (SELECT CASE WHEN count(*) = 1 THEN min(a.id) END FROM accounts a WHERE a.duo_account_id = d.id)) AS account_id,
           d.billing_owner_user_id AS owner_user_id, d.stripe_subscription_id AS stripe_sub, d.stripe_customer_id AS stripe_cus
      FROM duo_accounts d
     ORDER BY d.id`;
  const rows: DuoRow[] = [];
  const undecidable: DuoSharedAccountReport['undecidable'] = [];
  const seatsExceeded: DuoSharedAccountReport['seatsExceeded'] = [];
  const billingMismatches: DuoSharedAccountReport['billingMismatches'] = [];
  const traites = new Set<number>();

  for (const d of duos) {
    if (filtre && d.account_id !== filtre) continue;
    const membres = await q<{ id: number; user_id: number; status: string; joined_at: Date | null; slot: number | null }[]>`
      SELECT id, user_id, status, joined_at, slot FROM duo_memberships
       WHERE duo_id = ${d.duo_id} AND user_id <> ${d.owner_user_id} ORDER BY id`;
    const actifs = membres.filter((m) => m.status === 'ACTIVE');
    const anciens = membres.filter((m) => m.status === 'LEFT' || m.status === 'REMOVED');
    inv.H += anciens.length;

    // Incohérences d'offre (rapport seul).
    if (d.account_id) {
      const [acc] = await q<{ plan_type: string; stripe_subscription_id: string | null; stripe_customer_id: string | null; max_members: number }[]>`
        SELECT plan_type, stripe_subscription_id, stripe_customer_id, max_members FROM accounts WHERE id = ${d.account_id}`;
      const duoActif = d.status === 'ACTIVE';
      if (acc && duoActif !== (String(acc.plan_type).toUpperCase() === 'PREMIUM_DUO')) {
        billingMismatches.push({ duoId: d.duo_id, reason: `Duo ${d.status} / compte ${acc.plan_type}` });
      }
      if (acc && d.stripe_sub && acc.stripe_subscription_id && d.stripe_sub !== acc.stripe_subscription_id) {
        billingMismatches.push({ duoId: d.duo_id, reason: 'abonnement Stripe du Duo ≠ abonnement du compte' });
      }
    }

    if (actifs.length === 0 && anciens.length === 0) continue;
    if (!d.account_id) {
      if (actifs.length > 0 && ACTIVE_DUO.includes(d.status)) {
        inv.C += 1;
        undecidable.push({ duoId: d.duo_id, reason: 'compte partagé indécidable (aucun ou plusieurs comptes portent ce Duo)' });
      }
      continue;
    }

    for (const m of [...actifs, ...anciens]) {
      const row: DuoRow = {
        duoId: d.duo_id, status: d.status, accountId: d.account_id, ownerUserId: d.owner_user_id, memberUserId: m.user_id,
        memberBefore: null, memberAfter: null, personalAccounts: [], anomalies: [],
      };
      const [am] = await q<{ id: number; status: string; role: string; ended_reason: string | null; removed_at: Date | null }[]>`
        SELECT id, status, role, ended_reason, removed_at FROM account_memberships WHERE account_id = ${d.account_id} AND user_id = ${m.user_id}`;
      row.memberBefore = am ? `${am.role}/${am.status}` : null;
      row.memberAfter = row.memberBefore;

      // ── INV-B : membre actif sans adhésion active ─────────────────────
      let personnelVide = false;
      // ── INV-D / INV-E : comptes personnels de l'invité ────────────────
      const persos = await q<{ id: number; archived_at: Date | null }[]>`
        SELECT a.id, a.archived_at FROM accounts a
          JOIN account_memberships o ON o.account_id = a.id AND o.user_id = ${m.user_id} AND o.role = 'owner'
         WHERE a.id <> ${d.account_id}
         ORDER BY a.id`;
      for (const p of persos) {
        const k = await classifyPersonalAccount(q, p.id, m.user_id, m.joined_at);
        inv[k.category] += 1;
        if (k.trial === 'trialing' || k.trial === 'readonly') inv.E += 1;
        let archived = p.archived_at != null;
        if (k.category === 'D1' && m.status === 'ACTIVE') {
          personnelVide = true;
          if (c.apply && !archived) {
            await q`UPDATE accounts SET archived_at = now(), archived_reason = 'duo_placeholder', updated_at = now() WHERE id = ${p.id} AND archived_at IS NULL`;
            await journal(c, 'ACCOUNT_ARCHIVED', 'account', p.id, p.id, m.user_id, { archived_at: null }, { archived_at: now.toISOString(), archived_reason: 'duo_placeholder' });
            actions.accountsArchived += 1;
            archived = true;
          }
        }
        row.personalAccounts.push({ accountId: p.id, category: k.category, trial: k.trial, tables: k.tables.slice(0, 10), archived });
      }

      const joinedIso = m.joined_at ? (m.joined_at instanceof Date ? m.joined_at.toISOString() : String(m.joined_at)) : null;
      if (m.status === 'ACTIVE' && !(am && am.status.toLowerCase() === 'active')) {
        inv.B += 1;
        const [{ n }] = await q<{ n: number }[]>`
          SELECT count(*)::int AS n FROM account_memberships WHERE account_id = ${d.account_id} AND lower(status) = 'active' AND user_id <> ${m.user_id}`;
        const [acc] = await q<{ max_members: number; plan_type: string }[]>`SELECT max_members, plan_type FROM accounts WHERE id = ${d.account_id}`;
        const capacite = Math.max(acc?.max_members ?? 1, String(acc?.plan_type ?? '').toUpperCase() === 'PREMIUM_DUO' ? 2 : 1);
        if (n >= capacite) {
          seatsExceeded.push({ duoId: d.duo_id, accountId: d.account_id, userId: m.user_id });
          row.anomalies.push('places du compte épuisées : adhésion non créée');
        } else if (c.apply) {
          if (am) {
            await q`UPDATE account_memberships SET role = 'member', status = 'active', removed_at = NULL, removed_by = NULL,
                           ended_reason = NULL, source = 'migration_72d', joined_at = COALESCE(joined_at, ${joinedIso}::timestamptz, now()),
                           last_selected_at = CASE WHEN ${personnelVide} THEN now() ELSE last_selected_at END,
                           updated_at = now()
                     WHERE id = ${am.id}`;
            await journal(c, 'MEMBERSHIP_MEMBER_REACTIVATED', 'account_membership', am.id, d.account_id, m.user_id,
              { status: am.status, role: am.role, ended_reason: am.ended_reason, removed_at: am.removed_at }, { status: 'active', role: 'member' });
            actions.memberMembershipsReactivated += 1;
          } else {
            const [nm] = await q<{ id: number }[]>`
              INSERT INTO account_memberships (account_id, user_id, role, status, source, invited_by, invited_at, joined_at, last_selected_at, created_at, updated_at)
              VALUES (${d.account_id}, ${m.user_id}, 'member', 'active', 'migration_72d', ${d.owner_user_id},
                      COALESCE(${joinedIso}::timestamptz, now()), COALESCE(${joinedIso}::timestamptz, now()),
                      CASE WHEN ${personnelVide} THEN now() END, now(), now())
              RETURNING id`;
            await journal(c, 'MEMBERSHIP_MEMBER_CREATED', 'account_membership', nm.id, d.account_id, m.user_id, null, { status: 'active', role: 'member' });
            actions.memberMembershipsCreated += 1;
          }
          if (personnelVide) actions.lastSelectedSet += 1;
          row.memberAfter = 'member/active';
        } else {
          row.memberAfter = 'member/active (à créer)';
        }
      }
      traites.add(m.user_id);
      rows.push(row);
    }
  }

  // ── INV-F : copie d'affichage users.plan_type ─────────────────────────
  const planFixes = await q<{ id: number; plan_type: string }[]>`
    SELECT u.id, u.plan_type FROM users u
     WHERE upper(u.plan_type) = 'PREMIUM_DUO'
       AND NOT EXISTS (SELECT 1 FROM account_memberships m JOIN accounts a ON a.id = m.account_id
                        WHERE m.user_id = u.id AND lower(m.status) = 'active' AND upper(a.plan_type) = 'PREMIUM_DUO')
       AND NOT EXISTS (SELECT 1 FROM duo_memberships dm JOIN duo_accounts d ON d.id = dm.duo_id
                        WHERE dm.user_id = u.id AND dm.status = 'ACTIVE' AND d.subscription_status IN ('ACTIVE', 'UNPAID_RECOVERY', 'TRIALING'))
       AND (${filtre}::int IS NULL OR EXISTS (SELECT 1 FROM account_memberships m WHERE m.user_id = u.id AND m.account_id = ${filtre}))
     ORDER BY u.id`;
  inv.F += planFixes.length + billingMismatches.length;
  const planTypeFixes: DuoSharedAccountReport['planTypeFixes'] = [];
  for (const u of planFixes) {
    const [own] = await q<{ plan_code: string; status: string }[]>`
      SELECT s.plan_code, s.status FROM account_memberships m JOIN account_subscriptions s ON s.account_id = m.account_id
       WHERE m.user_id = ${u.id} AND m.role = 'owner' AND lower(m.status) = 'active' LIMIT 1`;
    const to = own && (own.status === 'active' || own.status === 'trialing') && own.plan_code === 'premium' ? 'PREMIUM' : 'STANDARD';
    planTypeFixes.push({ userId: u.id, from: u.plan_type, to });
    if (c.apply) {
      await q`UPDATE users SET plan_type = ${to}, updated_at = now() WHERE id = ${u.id} AND upper(plan_type) = 'PREMIUM_DUO'`;
      await journal(c, 'USER_PLAN_TYPE_FIXED', 'user', u.id, null, u.id, { plan_type: u.plan_type }, { plan_type: to });
      actions.planTypesFixed += 1;
    }
  }

  // ── INV-G : demandes croisées / verrous (0522) ────────────────────────
  const [g] = await q<{ n: number }[]>`
    SELECT ((SELECT count(*) FROM asset_move_requests WHERE status = 'PENDING')
          + (SELECT count(*) FROM asset_delete_requests WHERE status = 'PENDING')
          + (SELECT count(*) FROM assets WHERE lock_state IN ('PENDING_MOVE', 'PENDING_DELETE')))::int AS n`;
  inv.G = g?.n ?? 0;

  // ── INV-I : adhésions member dont l'inviteur n'est pas titulaire ──────
  const suspects = await q<{ account_id: number; user_id: number; invited_by: number | null }[]>`
    SELECT m.account_id, m.user_id, m.invited_by FROM account_memberships m
     WHERE m.role = 'member' AND lower(m.status) = 'active'
       AND COALESCE(m.source, '') NOT IN ('duo_invitation', 'migration_72d')
       AND (${filtre}::int IS NULL OR m.account_id = ${filtre})
       AND NOT EXISTS (SELECT 1 FROM account_memberships o
                        WHERE o.account_id = m.account_id AND o.user_id = m.invited_by AND o.role = 'owner')
     ORDER BY m.account_id, m.user_id`;
  inv.I = suspects.length;

  return {
    inv, actions, duos: rows, undecidable, seatsExceeded,
    suspiciousInvitations: suspects.map((s) => ({ accountId: s.account_id, userId: s.user_id, invitedBy: s.invited_by })),
    billingMismatches,
    ownerFixes: ownerFixes.map((f) => ({ accountId: f.account_id, userId: f.user_id })),
    planTypeFixes,
  };
}

/**
 * Simulation (lecture seule) ou application (une transaction, verrou
 * consultatif dédié, journal). Rejouée après application : 0 action.
 */
export async function runDuoSharedAccountBackfill(sql: postgres.Sql, opts: {
  apply: boolean;
  accountId?: number | null;
  log?: (m: string) => void;
}): Promise<DuoSharedAccountReport> {
  const log = opts.log ?? (() => {});
  const runId = randomUUID();
  const accountFilter = opts.accountId ?? null;

  if (!opts.apply) {
    const r = await inventoryAndAct({ q: sql, apply: false, runId, accountFilter, log });
    log(`simulation : ${r.inv.A} titulaire(s), ${r.inv.B} membre(s) à rattacher, ${r.inv.D1} compte(s) artificiel(s) vide(s)`);
    const { inv, ...rest } = r;
    return { mode: 'simulate', runId: null, accountId: accountFilter, before: inv, after: null, ...rest };
  }

  const r = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('l72d-duo-shared-account'))`;
    return inventoryAndAct({ q: tx, apply: true, runId, accountFilter, log });
  });
  const apres = await inventoryAndAct({ q: sql, apply: false, runId, accountFilter, log });
  log(`application ${runId} : ${r.actions.memberMembershipsCreated + r.actions.memberMembershipsReactivated} adhésion(s) membre, `
    + `${r.actions.ownerMembershipsCreated + r.actions.ownerMembershipsReactivated} titulaire(s), ${r.actions.accountsArchived} archivage(s)`);
  const { inv, ...rest } = r;
  return { mode: 'apply', runId, accountId: accountFilter, before: inv, after: apres.inv, ...rest };
}

/** Rejoue le journal d'une exécution à l'envers (rien de supprimé). */
export async function restoreDuoSharedAccountRun(sql: postgres.Sql, runId: string): Promise<RestoreReport> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('l72d-duo-shared-account'))`;
    const lignes = await tx<{ id: number; action: string; entity_id: number; before: Record<string, unknown> | null }[]>`
      SELECT id, action, entity_id, before FROM duo_shared_account_journal
       WHERE run_id = ${runId} AND restored_at IS NULL ORDER BY id DESC`;
    const out: RestoreReport = { runId, restored: 0, skipped: 0, conflicts: [] };
    for (const l of lignes) {
      let n = 0;
      switch (l.action) {
        case 'MEMBERSHIP_OWNER_CREATED':
        case 'MEMBERSHIP_MEMBER_CREATED':
          n = (await tx`UPDATE account_memberships SET status = 'removed', removed_at = now(), ended_reason = 'restore_72d', updated_at = now()
                        WHERE id = ${l.entity_id} AND lower(status) = 'active'`).count;
          break;
        case 'MEMBERSHIP_OWNER_REACTIVATED':
        case 'MEMBERSHIP_MEMBER_REACTIVATED': {
          const b = l.before ?? {};
          n = (await tx`UPDATE account_memberships
                           SET status = ${String(b.status ?? 'removed')}, role = ${String(b.role ?? 'member')},
                               ended_reason = ${(b.ended_reason as string | null) ?? 'restore_72d'},
                               removed_at = COALESCE(${b.removed_at ? String(b.removed_at) : null}::timestamptz, now()), updated_at = now()
                         WHERE id = ${l.entity_id}`).count;
          break;
        }
        case 'ACCOUNT_ARCHIVED':
          n = (await tx`UPDATE accounts SET archived_at = NULL, archived_reason = NULL, updated_at = now()
                        WHERE id = ${l.entity_id} AND archived_reason = 'duo_placeholder'`).count;
          break;
        case 'USER_PLAN_TYPE_FIXED':
          n = (await tx`UPDATE users SET plan_type = ${String(l.before?.plan_type ?? 'PREMIUM_DUO')}, updated_at = now()
                        WHERE id = ${l.entity_id}`).count;
          break;
        default:
          out.skipped += 1;
          continue;
      }
      if (n === 0) out.conflicts.push(`${l.action} #${l.entity_id} : état modifié depuis l’application, non restauré`);
      else out.restored += 1;
      await tx`UPDATE duo_shared_account_journal SET restored_at = now() WHERE id = ${l.id}`;
    }
    return out;
  });
}
