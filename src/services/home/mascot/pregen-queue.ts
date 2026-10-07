/**
 * Pré-génération DURABLE du texte T6 de la mascotte — lot 32, décision PO 6.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « PAS DE MODIFICATION DE TEXTE, MAIS LE TEXTE IA PLUS VITE »
 *
 * Depuis le lot 26, l'accueil affiche tout de suite le texte déterministe et
 * ne le remplace jamais sous les yeux de l'utilisateur ; la formulation T6 du
 * même contexte sert à l'affichage SUIVANT. Le texte IA n'apparaissait donc
 * qu'au deuxième passage — et seulement si la minuterie EN MÉMOIRE de
 * l'instance (`scheduleMascotPregeneration`) avait survécu jusque-là.
 *
 * Désormais, tout changement de la situation du compte DEMANDE une
 * pré-génération durable (`home_mascot_pregen_requests`, migration 0271) :
 *   · événements métier du compte (analyse terminée, document, bien,
 *     échéance, « À traiter » résolu ou créé…) — abonné du bus §25.7 ;
 *   · passage d'une échéance (tâche quotidienne `mascot-pregeneration-deadlines`) ;
 *   · connexion.
 * La tâche planifiée `mascot-pregeneration` (chaque minute) la traite ; le
 * chemin rapide en mémoire reste (3 s après le signal) et passe par la MÊME
 * prise en charge — jamais deux générations pour une demande.
 *
 * ── BORNÉ ET DÉDUPLIQUÉ ───────────────────────────────────────────────────
 *
 *   · une ligne par compte : une rafale de signaux = une demande ;
 *   · par situation : la génération est clé par l'empreinte des sujets
 *     (cache T6 du compte) — une situation déjà formulée coûte une lecture ;
 *   · par exécution : `MASCOT_PREGEN_BATCH` comptes au plus (défaut 20) ;
 *   · par compte : `MASCOT_PREGEN_DAILY_MAX` générations T6 de
 *     pré-génération par 24 h (défaut 24) — au-delà, la demande est close
 *     (`capped`) et l'affichage garde le chemin habituel ;
 *   · plafond IA mensuel du compte, disjoncteur et arrêt d'urgence T6 : ceux
 *     de `formulateWithT6`, inchangés.
 * Rien n'est jamais remplacé à l'écran : la présentation affichée reste celle
 * du premier rendu (RUN-001) ; seul le prochain affichage en profite.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { envNumber } from '@/lib/env-number';

type Row = Record<string, unknown>;
const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> =>
  (await pgClient.unsafe(sql, params as never[])) as unknown as Row[];

/** Comptes traités au plus par exécution de la tâche. */
export const mascotPregenBatch = (env: Record<string, string | undefined> = process.env) =>
  Math.min(200, Math.floor(envNumber('MASCOT_PREGEN_BATCH', 20, { min: 1 }, env)));
/** Générations T6 de pré-génération au plus par compte et par 24 h. */
export const mascotPregenDailyMax = (env: Record<string, string | undefined> = process.env) =>
  Math.floor(envNumber('MASCOT_PREGEN_DAILY_MAX', 24, { min: 0 }, env));

/** Attente minimale après le dernier signal : une rafale ne produit qu'une génération (RUN-009). */
export const PREGEN_SETTLE_MS = 3_000;
/** Bail d'une prise en charge. */
const CLAIM_MS = 5 * 60_000;
/** Essais au plus quand T6 n'a pas pu formuler (panne passagère). */
const MAX_ATTEMPTS = 3;

/** Événements du bus qui changent la situation présentée par la mascotte. */
export const PREGEN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'ASSET_CREATED', 'ASSET_UPDATED', 'ASSET_DELETED',
  'DOCUMENT_UPLOADED', 'DOCUMENT_ANALYSIS_COMPLETED', 'DOCUMENT_UPDATED', 'DOCUMENT_DELETED',
  'AGENDA_ITEM_CREATED', 'AGENDA_ITEM_UPDATED', 'AGENDA_ITEM_DELETED',
  'TO_PROCESS_ITEM_UPDATED', 'PLAN_CHANGED', 'ACCOUNT_PERMISSION_CHANGED', 'SUPPLIER_CHANGED',
]);

/**
 * Signale un changement de situation du compte. Ne lève jamais ; une ligne
 * par compte (la plus récente l'emporte).
 */
export async function requestMascotPregeneration(accountId: number, reason: string): Promise<void> {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) return;
  try {
    await rows(
      `INSERT INTO home_mascot_pregen_requests (account_id, requested_at, reason)
       VALUES ($1, clock_timestamp(), $2)
       ON CONFLICT (account_id) DO UPDATE
         SET requested_at = clock_timestamp(), reason = EXCLUDED.reason, attempts = 0`,
      [accountId, reason.slice(0, 60)],
    );
  } catch (e) {
    // Table absente (migration 0271 en cours) ou base indisponible : le chemin
    // en mémoire et l'affichage suffisent.
    console.warn('[mascotte] demande de pré-génération non enregistrée :', (e as Error).message);
  }
}

const EN_ATTENTE = `(processed_at IS NULL OR requested_at > processed_at)
  AND requested_at <= clock_timestamp() - ($1::int * INTERVAL '1 millisecond')
  AND (claimed_until IS NULL OR claimed_until < clock_timestamp())
  AND attempts < ${MAX_ATTEMPTS}`;

interface Claim { accountId: number; requestedAt: string }

async function claimBatch(limit: number): Promise<Claim[]> {
  const r = await rows(
    `UPDATE home_mascot_pregen_requests r
        SET claimed_until = clock_timestamp() + ($2::int * INTERVAL '1 millisecond'), attempts = r.attempts + 1
      WHERE r.account_id IN (
        SELECT account_id FROM home_mascot_pregen_requests
         WHERE ${EN_ATTENTE}
         ORDER BY requested_at
         LIMIT $3
         FOR UPDATE SKIP LOCKED)
      RETURNING r.account_id AS "accountId", r.requested_at::text AS "requestedAt"`,
    [PREGEN_SETTLE_MS, CLAIM_MS, limit],
  );
  return r.map((x) => ({ accountId: Number(x.accountId), requestedAt: String(x.requestedAt) }));
}

async function claimAccount(accountId: number, settleMs: number): Promise<Claim | null> {
  const r = await rows(
    `UPDATE home_mascot_pregen_requests
        SET claimed_until = clock_timestamp() + ($2::int * INTERVAL '1 millisecond'), attempts = attempts + 1
      WHERE account_id = $3 AND ${EN_ATTENTE}
      RETURNING account_id AS "accountId", requested_at::text AS "requestedAt"`,
    [settleMs, CLAIM_MS, accountId],
  );
  return r[0] ? { accountId: Number(r[0].accountId), requestedAt: String(r[0].requestedAt) } : null;
}

/** Générations T6 de pré-génération du compte sur 24 h glissantes. */
async function pregenGeneratedToday(accountId: number): Promise<number> {
  const [r] = await rows(
    `SELECT count(*)::int AS n FROM home_mascot_generations
      WHERE account_id = $1 AND mode = 'pregen' AND status = 'generated' AND created_at > NOW() - INTERVAL '24 hours'`,
    [accountId],
  );
  return Number(r?.n ?? 0);
}

export type PregenOutcome = 'formulated' | 'nothing_to_say' | 'fallback' | 'capped' | 'error';

/**
 * Clôture d'une demande : `processed_at` = l'instant de la demande TRAITÉE —
 * un signal arrivé pendant le traitement la laisse en attente.
 */
async function close(c: Claim, status: PregenOutcome, contextHash: string | null, retry: boolean): Promise<void> {
  await rows(
    retry
      ? `UPDATE home_mascot_pregen_requests
            SET claimed_until = clock_timestamp() + INTERVAL '2 minutes', last_status = $2
          WHERE account_id = $1`
      : `UPDATE home_mascot_pregen_requests
            SET processed_at = GREATEST(coalesce(processed_at, '-infinity'::timestamptz), $3::timestamptz),
                last_status = $2, last_context_hash = coalesce($4, last_context_hash), claimed_until = NULL
          WHERE account_id = $1`,
    retry ? [c.accountId, status] : [c.accountId, status, c.requestedAt, contextHash],
  );
}

/** Traite une demande prise en charge. Ne lève jamais. */
async function processClaim(c: Claim): Promise<PregenOutcome> {
  try {
    if (await pregenGeneratedToday(c.accountId) >= mascotPregenDailyMax()) {
      await close(c, 'capped', null, false);
      return 'capped';
    }
    const { getMascotPresentation } = await import('./mascot.service');
    const p = await getMascotPresentation(c.accountId, 'pregen');
    const formulable = p.paragraphs.some((x) => x.sourceCode !== 'CLEAR');
    const outcome: PregenOutcome = !formulable ? 'nothing_to_say' : p.source === 't6' ? 'formulated' : 'fallback';
    // T6 n'a pas formulé (panne passagère, disjoncteur) : nouvel essai borné.
    await close(c, outcome, p.contextHash, outcome === 'fallback');
    return outcome;
  } catch (e) {
    console.error(`[mascotte] pré-génération du compte ${c.accountId} en échec :`, (e as Error).message);
    await close(c, 'error', null, true).catch(() => {});
    return 'error';
  }
}

/**
 * Chemin rapide (même instance, quelques secondes après le signal) : prend
 * la demande du compte si elle est toujours en attente — la tâche planifiée
 * ne la retraitera pas.
 */
export async function processMascotPregenerationFor(accountId: number): Promise<PregenOutcome | null> {
  let c: Claim | null = null;
  try {
    c = await claimAccount(accountId, 0);
  } catch (e) {
    console.warn('[mascotte] prise en charge de la pré-génération impossible :', (e as Error).message);
    return null;
  }
  return c ? processClaim(c) : null;
}

export interface PregenRunResult {
  claimed: number;
  formulated: number;
  fallback: number;
  capped: number;
  nothing: number;
  errors: number;
}

/** Tâche planifiée `mascot-pregeneration` : un lot borné de demandes en attente. */
export async function runMascotPregeneration(opts: { deadline?: number; batch?: number } = {}): Promise<PregenRunResult> {
  const out: PregenRunResult = { claimed: 0, formulated: 0, fallback: 0, capped: 0, nothing: 0, errors: 0 };
  const claims = await claimBatch(opts.batch ?? mascotPregenBatch());
  out.claimed = claims.length;
  for (const c of claims) {
    if (opts.deadline && Date.now() >= opts.deadline) {
      // Rend la main : les demandes non traitées redeviennent disponibles.
      await rows(`UPDATE home_mascot_pregen_requests SET claimed_until = NULL, attempts = GREATEST(0, attempts - 1) WHERE account_id = $1`, [c.accountId]).catch(() => {});
      continue;
    }
    const o = await processClaim(c);
    if (o === 'formulated') out.formulated += 1;
    else if (o === 'fallback') out.fallback += 1;
    else if (o === 'capped') out.capped += 1;
    else if (o === 'nothing_to_say') out.nothing += 1;
    else out.errors += 1;
  }
  return out;
}

/**
 * Tâche quotidienne `mascot-pregeneration-deadlines` : la situation d'un
 * compte change aussi sans action de personne — une échéance arrive à sa
 * date (« prochaine échéance » → « c'est fait ? »), passe la veille, ou sort
 * de la fenêtre de rappel. Les comptes concernés sont signalés (bornés).
 */
export async function enqueueDeadlineSituations(today: string, lookbackDays: number, limit = 5_000): Promise<number> {
  const r = await rows(
    `INSERT INTO home_mascot_pregen_requests (account_id, requested_at, reason)
     SELECT DISTINCT i.account_id, clock_timestamp(), 'deadline'
       FROM agenda_items i
       JOIN accounts a ON a.id = i.account_id
      WHERE (i.manual_status IS NULL OR trim(i.manual_status) = '')
        AND i.start_date IN ($1::date, $1::date - 1, $1::date - ($2::int + 1))
      LIMIT $3
     ON CONFLICT (account_id) DO UPDATE SET requested_at = clock_timestamp(), reason = 'deadline', attempts = 0
     RETURNING account_id`,
    [today, lookbackDays, limit],
  );
  return r.length;
}

let abonne = false;

/**
 * Abonné du bus des événements métier (§25.7) : tout changement de situation
 * d'un compte demande une pré-génération (durable + chemin rapide).
 * Enregistré au démarrage (`instrumentation-node.ts`) ; idempotent.
 */
export async function registerMascotPregenerationHandler(): Promise<void> {
  if (abonne) return;
  abonne = true;
  const { onBusinessEvent } = await import('@/services/verebona-assistant/events/business-events');
  onBusinessEvent('mascot-pregeneration', (e) => {
    if (e.accountId == null || !PREGEN_EVENT_TYPES.has(e.type)) return;
    const accountId = e.accountId;
    // Jamais attendu : l'opération qui émet ne patiente pas pour la mascotte.
    void import('./mascot.service')
      .then((m) => m.scheduleMascotPregeneration(accountId, undefined, e.type))
      .catch(() => {});
  });
}
