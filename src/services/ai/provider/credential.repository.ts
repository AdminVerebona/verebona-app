/**
 * Credentials fournisseur IA — CDC BO IA SCR-10, WF-21.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE TEST EST UN VRAI APPEL, SANS DONNÉE UTILISATEUR
 *
 * Le SCR-10 : « effectue un vrai appel minimal sans donnée utilisateur ». Les
 * deux moitiés comptent.
 *
 * Un vrai appel, parce qu'une clé peut être syntaxiquement valide, acceptée à
 * l'authentification, et refusée à la génération — quota épuisé, facturation
 * suspendue, modèle retiré du compte. C'est exactement ce qui nous est arrivé
 * le 18 septembre avec `gemini-2.5-flash-lite` : la clé était bonne, le modèle
 * ne l'était plus.
 *
 * Sans donnée utilisateur, parce qu'un test d'exploitation ne doit ni consommer
 * le quota d'un compte, ni exposer son contenu à une clé qu'on ne connaît pas
 * encore.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * L'ORDRE DE RÉSOLUTION
 *
 * Clé active en base, puis variable d'environnement. L'environnement reste
 * l'amorçage : exiger une saisie rendrait tout déploiement neuf muet jusqu'à ce
 * qu'un administrateur se connecte.
 */
import { pgClient } from '@/db';

type Row = Record<string, unknown>;

export type CredentialStatus = 'CANDIDATE' | 'ACTIVE' | 'RETIRED';

export interface Credential {
  id: number;
  provider: string;
  status: CredentialStatus;
  /** Aperçu masqué. Le secret complet ne sort que sur demande explicite. */
  preview: string;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastTestDetail: unknown;
  createdAt: Date;
  activatedAt: Date | null;
}

/**
 * Aperçu d'un secret : quatre premiers et quatre derniers caractères.
 *
 * Le SCR-10 autorise l'affichage en clair, et l'écran le propose sur demande.
 * Mais l'afficher SANS demande le ferait apparaître dans toute capture
 * d'écran, tout partage de session, tout enregistrement de réunion — sans
 * qu'aucune décision n'ait été prise. L'aperçu suffit à reconnaître une clé ;
 * la révéler reste un geste.
 */
export function maskSecret(secret: string): string {
  if (secret.length <= 12) return `${secret.slice(0, 2)}…`;
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

function toCredential(r: Row): Credential {
  return {
    id: Number(r.id),
    provider: String(r.provider),
    status: String(r.status) as CredentialStatus,
    preview: maskSecret(String(r.secret)),
    lastTestAt: r.last_test_at ? new Date(String(r.last_test_at)) : null,
    lastTestOk: r.last_test_ok == null ? null : Boolean(r.last_test_ok),
    lastTestDetail: r.last_test_detail ?? null,
    createdAt: new Date(String(r.created_at)),
    activatedAt: r.activated_at ? new Date(String(r.activated_at)) : null,
  };
}

const COLS = `id, provider, secret, status, last_test_at, last_test_ok,
              last_test_detail, created_at, activated_at`;

export async function listCredentials(provider = 'gemini'): Promise<Credential[]> {
  const rows = await pgClient.unsafe(
    `SELECT ${COLS} FROM ai_provider_credential
      WHERE provider = $1 AND status <> 'RETIRED'
      ORDER BY status, created_at DESC`,
    [provider] as never[],
  );
  return (rows as unknown as Row[]).map(toCredential);
}

/**
 * Secret réellement utilisé pour appeler le fournisseur.
 *
 * Rend le secret brut — jamais journalisé, jamais renvoyé par une route.
 */
export async function resolveSecret(provider = 'gemini'): Promise<string | null> {
  try {
    const rows = await pgClient.unsafe(
      `SELECT secret FROM ai_provider_credential
        WHERE provider = $1 AND status = 'ACTIVE' LIMIT 1`,
      [provider] as never[],
    );
    const r = (rows as unknown as Row[])[0];
    if (r) return String(r.secret);
  } catch {
    // Table absente avant la migration : on retombe sur l'environnement plutôt
    // que de priver l'application de sa clé.
  }
  return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY ?? null;
}

/** Secret d'une ligne précise — pour le test et pour l'affichage sur demande. */
export async function getSecret(id: number): Promise<string | null> {
  const rows = await pgClient.unsafe(
    `SELECT secret FROM ai_provider_credential WHERE id = $1 LIMIT 1`,
    [id] as never[],
  );
  const r = (rows as unknown as Row[])[0];
  return r ? String(r.secret) : null;
}

export async function addCandidate(secret: string, userId: number, provider = 'gemini'): Promise<Credential> {
  const rows = await pgClient.unsafe(
    `INSERT INTO ai_provider_credential (provider, secret, status, created_by)
     VALUES ($1, $2, 'CANDIDATE', $3)
     RETURNING ${COLS}`,
    [provider, secret, userId] as never[],
  );
  return toCredential((rows as unknown as Row[])[0]);
}

export interface TestDetail {
  authenticated: boolean;
  modelsListed: number | null;
  generationOk: boolean;
  model: string | null;
  error?: string;
}

export async function recordTest(id: number, ok: boolean, detail: TestDetail): Promise<void> {
  await pgClient.unsafe(
    `UPDATE ai_provider_credential
        SET last_test_at = NOW(), last_test_ok = $2, last_test_detail = $3::jsonb
      WHERE id = $1`,
    [id, ok, JSON.stringify(detail)] as never[],
  );
}

/**
 * Active une candidate — refuse si son dernier test n'est pas un succès.
 *
 * Le contrôle est en base, dans la condition du `UPDATE`, et non lu puis
 * vérifié : entre la lecture et l'écriture, un second test pourrait avoir
 * échoué. La bascule et la rétrogradation de l'ancienne active tiennent dans
 * une seule instruction, pour que l'index unique ne rejette jamais une moitié
 * du changement.
 */
export async function activateCandidate(
  id: number, userId: number, provider = 'gemini',
): Promise<{ activated: boolean; previousId: number | null }> {
  const rows = await pgClient.unsafe(
    `WITH candidate AS (
       SELECT id FROM ai_provider_credential
        WHERE id = $1 AND provider = $3 AND status = 'CANDIDATE' AND last_test_ok IS TRUE
     ), ancienne AS (
       UPDATE ai_provider_credential
          SET status = 'RETIRED', retired_at = NOW()
        WHERE provider = $3 AND status = 'ACTIVE'
          AND EXISTS (SELECT 1 FROM candidate)
        RETURNING id
     ), promue AS (
       UPDATE ai_provider_credential
          SET status = 'ACTIVE', activated_by = $2, activated_at = NOW()
        WHERE id IN (SELECT id FROM candidate)
        RETURNING id
     )
     SELECT (SELECT id FROM promue) AS promoted, (SELECT id FROM ancienne) AS previous`,
    [id, userId, provider] as never[],
  );

  const r = (rows as unknown as Row[])[0];
  return {
    activated: r?.promoted != null,
    previousId: r?.previous == null ? null : Number(r.previous),
  };
}

export async function discardCandidate(id: number): Promise<boolean> {
  const rows = await pgClient.unsafe(
    `UPDATE ai_provider_credential SET status = 'RETIRED', retired_at = NOW()
      WHERE id = $1 AND status = 'CANDIDATE' RETURNING id`,
    [id] as never[],
  );
  return (rows as unknown as Row[]).length > 0;
}
