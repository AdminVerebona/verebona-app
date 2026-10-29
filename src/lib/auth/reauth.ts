/**
 * Preuve de RÉAUTHENTIFICATION des actions sensibles — lot 92 (CDC 18 §18 ;
 * REAUTH-01/02/06/07 ; §30 REAUTH_REQUIRED / REAUTH_EXPIRED ; décision PO
 * Q7 : recommandation appliquée).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * API SERVEUR (utilisée aussi par le sous-lot 93 Google / Apple)
 *
 *   issueReauthProof(userId, sid, method, { request? })
 *       Émet la preuve APRÈS une réauthentification réussie, vérifiée côté
 *       serveur par la méthode `method`. Rien n'est demandé au client : la
 *       preuve est une ligne `reauth_proofs` liée à (user_id, sid), valable
 *       REAUTH_PROOF_TTL_MS (5 min). Refusée si la session est révoquée.
 *       Une nouvelle preuve remplace la précédente de la même session.
 *
 *   requireFreshReauth(request, { action, consume? })
 *       À appeler en tête d'une route sensible. Résout la session (mêmes
 *       contrôles que toute route : révocation globale ET unitaire), puis
 *       exige une preuve fraîche de CETTE session et de CET utilisateur :
 *         · aucune preuve           → 403 REAUTH_REQUIRED ;
 *         · preuve expirée / usée   → 403 REAUTH_EXPIRED ;
 *         · `consume: true`         → la preuve est consommée atomiquement
 *                                     (actions à risque maximal) ; sinon
 *                                     elle reste réutilisable 5 min dans le
 *                                     bloc Sécurité (§18.4).
 *       Une preuve d'une autre session (autre appareil, session remplacée ou
 *       révoquée) ne vaut jamais (REAUTH-02).
 *
 *   consumeReauthProof(proofId, action) — consommation après succès.
 *
 *   registerReauthMethod(method) / listReauthMethodsFor(userId)
 *       Interface des méthodes (§18.2) : `password` est fournie ici. Le
 *       sous-lot 93 enregistre `google` / `apple` (`kind: 'redirect'` :
 *       `startUrl(returnTo)` lance le parcours fournisseur, dont le retour —
 *       après vérification du MÊME subject lié — appelle `issueReauthProof`).
 *       Aucune double authentification en V1 (décision PO Q2, lot 96B).
 *
 * Aucun horodatage contrôlable par le client, aucun drapeau
 * « reauthenticated=true » accepté (§32).
 *
 * Aucune importation statique de `@/db` : les tests unitaires installent un
 * stockage en mémoire (`__setReauthProofStoreForTests`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { SessionService, type SessionPayload } from '@/lib/session-service';
import { logUserActivity } from '@/lib/audit-logger';
import { getSessionRecord } from './session-registry';

/** Durée de validité d'une preuve (CDC 18 §18.1, §19.2). */
export const REAUTH_PROOF_TTL_MS = 5 * 60 * 1000;

export type ReauthMethodId = 'password' | 'google' | 'apple' | (string & {});

export interface ReauthProofRecord {
  id: string;
  userId: number;
  sid: string;
  method: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  consumedFor: string | null;
}

export interface ReauthProofStore {
  /** Enregistre la preuve et retire les précédentes de la même session. */
  insert(p: ReauthProofRecord): Promise<void>;
  /** Dernière preuve de cette session pour cet utilisateur. */
  latest(userId: number, sid: string): Promise<ReauthProofRecord | null>;
  /** Consommation atomique : vrai si CET appel l'a consommée (non expirée, non consommée). */
  consume(id: string, action: string, now: Date): Promise<boolean>;
  /** Lot 96A : retire les preuves de l'utilisateur (toutes, ou celle d'une session). */
  invalidate(userId: number, sid?: string | null): Promise<number>;
  purge(now: Date): Promise<number>;
}

// ── Stockage en base ──────────────────────────────────────────────────────

interface ProofRow {
  id: string; user_id: number; sid: string; method: string; created_at: Date; expires_at: Date;
  consumed_at: Date | null; consumed_for: string | null;
}
const fromRow = (r: ProofRow): ReauthProofRecord => ({
  id: r.id, userId: Number(r.user_id), sid: r.sid, method: r.method,
  createdAt: new Date(r.created_at), expiresAt: new Date(r.expires_at),
  consumedAt: r.consumed_at ? new Date(r.consumed_at) : null, consumedFor: r.consumed_for,
});
const sqlClient = async () => (await import('@/db')).pgClient;

const dbStore: ReauthProofStore = {
  async insert(p) {
    const sql = await sqlClient();
    await sql.begin(async (tx) => {
      await tx`DELETE FROM reauth_proofs WHERE sid = ${p.sid}`;
      await tx`
        INSERT INTO reauth_proofs (id, user_id, sid, method, created_at, expires_at)
        VALUES (${p.id}, ${p.userId}, ${p.sid}, ${p.method}, ${p.createdAt.toISOString()}, ${p.expiresAt.toISOString()})`;
    });
  },
  async latest(userId, sid) {
    const sql = await sqlClient();
    const rows = await sql<ProofRow[]>`
      SELECT * FROM reauth_proofs WHERE user_id = ${userId} AND sid = ${sid} ORDER BY created_at DESC LIMIT 1`;
    return rows[0] ? fromRow(rows[0]) : null;
  },
  async consume(id, action, now) {
    const sql = await sqlClient();
    const rows = await sql`
      UPDATE reauth_proofs SET consumed_at = ${now.toISOString()}, consumed_for = ${action}
       WHERE id = ${id} AND consumed_at IS NULL AND expires_at > ${now.toISOString()}
      RETURNING id`;
    return rows.length > 0;
  },
  async invalidate(userId, sid) {
    const sql = await sqlClient();
    const rows = sid
      ? await sql`DELETE FROM reauth_proofs WHERE user_id = ${userId} AND sid = ${sid} RETURNING id`
      : await sql`DELETE FROM reauth_proofs WHERE user_id = ${userId} RETURNING id`;
    return rows.length;
  },
  async purge(now) {
    const sql = await sqlClient();
    const rows = await sql`DELETE FROM reauth_proofs WHERE expires_at < ${new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()} RETURNING id`;
    return rows.length;
  },
};

// Surcharge portée par `globalThis` : elle survit à `vi.resetModules()` dans les tests.
const OVERRIDE_KEY = '__verebonaReauthProofStore';
const store = (): ReauthProofStore =>
  ((globalThis as Record<string, unknown>)[OVERRIDE_KEY] as ReauthProofStore | null | undefined) ?? dbStore;

/** TESTS UNITAIRES SEULEMENT (`src/test/setup.ts`). `null` rétablit la base. */
export function __setReauthProofStoreForTests(s: ReauthProofStore | null): void {
  (globalThis as Record<string, unknown>)[OVERRIDE_KEY] = s;
}

// ── Méthodes de réauthentification (§18.2) ────────────────────────────────

export type ReauthVerifyResult =
  | { status: 'success' }
  | { status: 'failed'; code: string; message: string; httpStatus: number }
  /** Refus avant vérification (limiteur) : réponse prête. */
  | { status: 'blocked'; response: NextResponse };

export interface ReauthMethod {
  id: ReauthMethodId;
  /** Libellé du bouton (« Mot de passe », « Continuer avec Google »…). */
  label: string;
  /** `password` : formulaire vérifié par `verify` ; `redirect` : parcours externe (`startUrl`). */
  kind: 'password' | 'redirect';
  /** La méthode est-elle liée à ce compte ? (« une méthode déjà liée », §18.2) */
  isAvailableFor(userId: number): Promise<boolean>;
  verify?(ctx: { request: NextRequest; userId: number; input: Record<string, unknown> }): Promise<ReauthVerifyResult>;
  startUrl?(returnTo: string): string;
}

const methods = new Map<string, ReauthMethod>();

export function registerReauthMethod(method: ReauthMethod): void {
  methods.set(method.id, method);
}

export function getReauthMethod(id: string): ReauthMethod | null {
  return methods.get(id) ?? null;
}

export interface ReauthMethodView { id: string; label: string; kind: 'password' | 'redirect'; startUrl?: string }

/** Méthodes utilisables par cet utilisateur (pour la fenêtre de confirmation). */
export async function listReauthMethodsFor(userId: number, returnTo = '/mon-compte#securite'): Promise<ReauthMethodView[]> {
  const out: ReauthMethodView[] = [];
  for (const m of methods.values()) {
    if (!(await m.isAvailableFor(userId).catch(() => false))) continue;
    out.push({ id: m.id, label: m.label, kind: m.kind, ...(m.kind === 'redirect' && m.startUrl ? { startUrl: m.startUrl(returnTo) } : {}) });
  }
  return out;
}

// Méthode fournie : mot de passe local (limiteur partagé du lot 53A conservé).
registerReauthMethod({
  id: 'password',
  label: 'Mot de passe',
  kind: 'password',
  async isAvailableFor(userId) {
    const sql = await sqlClient();
    const rows = await sql<{ ok: boolean }[]>`SELECT (password_hash IS NOT NULL AND password_hash <> '') AS ok FROM users WHERE id = ${userId}`;
    return !!rows[0]?.ok;
  },
  async verify({ request, userId, input }) {
    const { reauthBlockedResponse, recordReauthFailure, recordReauthSuccess } = await import('./reauth-throttle');
    const blocked = await reauthBlockedResponse(request, userId);
    if (blocked) return { status: 'blocked', response: blocked };
    const password = typeof input.password === 'string' ? input.password : '';
    if (!password) return { status: 'failed', code: 'PASSWORD_REQUIRED', message: 'Saisissez votre mot de passe.', httpStatus: 400 };
    const sql = await sqlClient();
    const rows = await sql<{ password_hash: string | null }[]>`SELECT password_hash FROM users WHERE id = ${userId}`;
    const hash = rows[0]?.password_hash;
    const bcrypt = (await import('bcrypt')).default;
    const ok = !!hash && await bcrypt.compare(password, hash);
    if (!ok) {
      await recordReauthFailure(request, userId, 'reauth');
      // Code non renouvelable côté client (`api-client`) : une saisie fausse n'est pas une session expirée.
      return { status: 'failed', code: 'INVALID_CURRENT_PASSWORD', message: 'Le mot de passe est incorrect.', httpStatus: 401 };
    }
    await recordReauthSuccess(userId);
    return { status: 'success' };
  },
});

// ── Émission / exigence ───────────────────────────────────────────────────

export class ReauthError extends Error {
  constructor(public code: 'SESSION_REVOKED' | 'SESSION_REQUIRED') {
    super(code);
    this.name = 'ReauthError';
  }
}

/**
 * Émet la preuve après une réauthentification RÉUSSIE (vérifiée côté serveur
 * par l'appelant). Lève `ReauthError('SESSION_REVOKED')` si la session est
 * terminée dans le registre.
 */
export async function issueReauthProof(
  userId: number,
  sid: string,
  method: ReauthMethodId,
  opts: {
    request?: NextRequest; now?: Date;
    /** Échéance imposée (report d'une preuve sur la session qui remplace la sienne) — jamais au-delà de 5 min. */
    expiresAt?: Date;
  } = {},
): Promise<{ expiresAt: Date }> {
  if (!sid) throw new ReauthError('SESSION_REQUIRED');
  const row = await getSessionRecord(sid);
  if (row && (row.userId !== userId || row.revokedAt)) throw new ReauthError('SESSION_REVOKED');
  const now = opts.now ?? new Date();
  const max = now.getTime() + REAUTH_PROOF_TTL_MS;
  const expiresAt = new Date(Math.min(max, opts.expiresAt?.getTime() ?? max));
  await store().insert({ id: randomUUID(), userId, sid, method, createdAt: now, expiresAt, consumedAt: null, consumedFor: null });
  void logUserActivity({
    activityType: 'REAUTH_SUCCESS',
    userId,
    userEmail: '',
    details: { method, sid, expiresAt: expiresAt.toISOString() },
    request: opts.request,
  });
  return { expiresAt };
}

/** Échec d'une réauthentification (journal §23.1, sans aucune valeur saisie). */
export function logReauthFailure(request: NextRequest, userId: number, method: string, code: string): void {
  void logUserActivity({ activityType: 'REAUTH_FAILED', userId, userEmail: '', details: { method, code }, request });
}

export type FreshReauthState = { state: 'fresh'; proof: ReauthProofRecord } | { state: 'missing' } | { state: 'expired' };

/** État de la preuve de cette session (aucune écriture). */
export async function getReauthState(userId: number, sid: string | null | undefined, now = new Date()): Promise<FreshReauthState> {
  if (!sid) return { state: 'missing' };
  const proof = await store().latest(userId, sid);
  if (!proof) return { state: 'missing' };
  if (proof.consumedAt || proof.expiresAt <= now) return { state: 'expired' };
  return { state: 'fresh', proof };
}

const REAUTH_MESSAGES = {
  REAUTH_REQUIRED: 'Pour votre sécurité, confirmez votre identité pour continuer.',
  REAUTH_EXPIRED: 'Votre confirmation d’identité a expiré. Confirmez de nouveau votre identité pour continuer.',
} as const;

export function reauthRequiredResponse(code: keyof typeof REAUTH_MESSAGES): NextResponse {
  return NextResponse.json({ error: code, code, message: REAUTH_MESSAGES[code] }, { status: 403 });
}

export async function consumeReauthProof(proofId: string, action: string, now = new Date()): Promise<boolean> {
  return store().consume(proofId, action, now);
}

export type RequireFreshReauthResult =
  | { ok: true; session: SessionPayload & { sid: string }; proof: ReauthProofRecord }
  | { ok: false; response: NextResponse };

export async function requireFreshReauth(
  request: NextRequest,
  opts: { action: string; consume?: boolean; now?: Date },
): Promise<RequireFreshReauthResult> {
  let session: SessionPayload;
  try {
    session = await SessionService.getSession(request);
  } catch (error) {
    return { ok: false, response: SessionService.handleSessionError(error) };
  }
  const now = opts.now ?? new Date();
  const state = await getReauthState(session.userId, session.sid, now);
  if (state.state !== 'fresh' || !session.sid) {
    return { ok: false, response: reauthRequiredResponse(state.state === 'expired' ? 'REAUTH_EXPIRED' : 'REAUTH_REQUIRED') };
  }
  if (opts.consume && !(await store().consume(state.proof.id, opts.action, now))) {
    return { ok: false, response: reauthRequiredResponse('REAUTH_EXPIRED') };
  }
  return { ok: true, session: session as SessionPayload & { sid: string }, proof: state.proof };
}

/**
 * Lot 96A (CDC 18 Q7 : « invalider la preuve lors d'une déconnexion,
 * révocation ou changement d'identifiants ») — retire les preuves :
 *   · d'UNE session (`sid`) : déconnexion de cette session, y compris une
 *     session ouverte avant le registre (sans ligne `user_sessions`) ;
 *   · de TOUTES les sessions de l'utilisateur : changement d'identifiant
 *     (mot de passe ajouté, adresse principale, Google / Apple associé ou
 *     dissocié). Le mot de passe changé et les révocations passent déjà par
 *     la révocation globale / du registre, qui retire les preuves.
 * Une preuve n'est JAMAIS prolongée : seule une nouvelle réauthentification
 * en émet une (5 min à compter de cette réauthentification). Jamais bloquant.
 */
export async function invalidateReauthProofs(userId: number, opts: { sid?: string | null; reason: string }): Promise<number> {
  try {
    return await store().invalidate(userId, opts.sid ?? null);
  } catch (e) {
    if ((e as { code?: string })?.code !== '42P01') {
      console.error(`[reauth] invalidation des preuves (${opts.reason}) impossible :`, (e as Error)?.message ?? e);
    }
    return 0;
  }
}

export async function purgeReauthProofs(now = new Date()): Promise<number> {
  try {
    return await store().purge(now);
  } catch (e) {
    if ((e as { code?: string })?.code === '42P01') return 0;
    throw e;
  }
}
