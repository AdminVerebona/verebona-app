/**
 * Anti-énumération des comptes — lot 37 (C3), CDC 18 §9.1, §10.4, §11.2, §30.
 *
 * Les parcours publics (connexion, renvoi de vérification, mot de passe
 * oublié) ne doivent révéler l'existence d'un compte ni par le statut, ni
 * par le corps, ni par le temps de réponse :
 *
 *   · connexion : le mot de passe est TOUJOURS comparé avec bcrypt — contre
 *     une empreinte factice de même coût quand l'adresse est inconnue —, et
 *     aucun état du compte (non vérifié, suspendu, supprimé) n'est dit avant
 *     la preuve du mot de passe ;
 *   · e-mails : la réponse ne dépend que de la requête ; le travail qui
 *     dépend du compte (lecture, jeton, envoi) s'exécute APRÈS la réponse,
 *     hors de son chemin (`runDetached`), et ses échecs vont au journal.
 */
import bcrypt from 'bcrypt';

/**
 * Empreinte bcrypt factice, coût 10 (celui des empreintes réelles :
 * inscription, changement et réinitialisation du mot de passe). Elle ne
 * correspond à aucun mot de passe connu.
 */
export const DUMMY_BCRYPT_HASH = '$2b$10$R2JVC66X00SABwMsDRVi.O2zWAYCHpNKpsFQFKIO.tNalJxJRZ/XG';

/**
 * Compare un mot de passe à une empreinte — ou à l'empreinte factice si le
 * compte n'existe pas : même coût dans les deux cas. Ne lève jamais (empreinte
 * malformée → `false`).
 */
export async function comparePasswordConstantTime(password: string, hash: string | null | undefined): Promise<boolean> {
  const target = typeof hash === 'string' && hash.startsWith('$2') ? hash : DUMMY_BCRYPT_HASH;
  try {
    const ok = await bcrypt.compare(String(password), target);
    return ok && target !== DUMMY_BCRYPT_HASH;
  } catch {
    return false;
  }
}

// ── Travail détaché ─────────────────────────────────────────────────────────

const pending = new Set<Promise<void>>();

/**
 * Lance un traitement APRÈS la réponse (serveur Node long : `next start`).
 * Ne lève jamais ; les erreurs sont journalisées sous `label`, sans donnée
 * personnelle.
 */
export function runDetached(label: string, task: () => Promise<unknown>): void {
  const p = (async () => {
    try {
      await task();
    } catch (e) {
      console.error(`[auth] ${label} : échec du traitement en arrière-plan —`, (e as Error)?.message ?? e);
    }
  })();
  pending.add(p);
  void p.finally(() => pending.delete(p));
}

/** Tests : attend la fin des traitements détachés en cours. */
export async function settleDetachedAuthTasks(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}
