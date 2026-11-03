/**
 * Lot 107E — retour vers la carte, dans son état, après un lien direct.
 *
 * · Tiroir (document, équipement, pièce, événement) : il s'ouvre PAR-DESSUS
 *   la file, qui reste montée — ordre, position, saisie en cours et justificatifs
 *   dépliés sont conservés tels quels ; la fermeture rend la carte.
 * · Page (fiche d'un bien, fiche fournisseur) : la file est démontée. Juste
 *   avant de naviguer, la file note son état (ordre d'affichage, défilement,
 *   carte, lien touché, saisies non validées) dans le stockage de SESSION de
 *   l'onglet ; au retour (« Précédent », geste retour iOS / Android), elle le
 *   relit UNE fois et le supprime. Ce n'est pas une préférence mémorisée
 *   (ATP-02 : une nouvelle visite s'ouvre toujours « Par priorité ») : l'état
 *   expire après `RETURN_STATE_TTL_MS` et n'est jamais relu deux fois.
 *
 * Aucune donnée métier n'y est écrite : des identifiants publics de carte et
 * les saisies non validées de l'utilisateur, dans son propre onglet.
 */

export const RETURN_STATE_KEY = 'a-traiter:retour';
/** Durée de validité d'un retour (au-delà : nouvelle visite). */
export const RETURN_STATE_TTL_MS = 30 * 60 * 1000;
/** Événement émis par un lien direct juste avant de quitter la page. */
export const TO_PROCESS_LEAVING_EVENT = 'a-traiter:depart';

export interface ReturnState {
  at: number;
  orderMode: 'BY_PRIORITY' | 'BY_ACTION';
  scrollY: number;
  cardId: string | null;
  linkKey: string | null;
  drafts: Record<string, string>;
}

// ── Saisies non validées (« À compléter » en ligne) ────────────────────────

const drafts = new Map<string, string>();
export const getDraft = (publicId: string) => drafts.get(publicId) ?? '';
export function setDraft(publicId: string, value: string): void {
  if (value) drafts.set(publicId, value.slice(0, 500)); else drafts.delete(publicId);
}
export const clearDraft = (publicId: string) => { drafts.delete(publicId); };
export const draftsSnapshot = (): Record<string, string> => Object.fromEntries(drafts);

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function saveReturnState(storage: StorageLike | null | undefined, s: Omit<ReturnState, 'at' | 'drafts'>, now = Date.now()): void {
  try {
    storage?.setItem(RETURN_STATE_KEY, JSON.stringify({ ...s, at: now, drafts: draftsSnapshot() } satisfies ReturnState));
  } catch { /* stockage indisponible : retour sans restauration */ }
}

/** Lit l'état de retour une seule fois (supprimé), `null` s'il est absent, invalide ou expiré. */
export function consumeReturnState(storage: StorageLike | null | undefined, now = Date.now()): ReturnState | null {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(RETURN_STATE_KEY) ?? null;
    storage?.removeItem(RETURN_STATE_KEY);
  } catch { return null; }
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<ReturnState>;
    if (typeof s.at !== 'number' || now - s.at > RETURN_STATE_TTL_MS || now < s.at - 60_000) return null;
    const out: ReturnState = {
      at: s.at,
      orderMode: s.orderMode === 'BY_ACTION' ? 'BY_ACTION' : 'BY_PRIORITY',
      scrollY: typeof s.scrollY === 'number' && Number.isFinite(s.scrollY) && s.scrollY >= 0 ? s.scrollY : 0,
      cardId: typeof s.cardId === 'string' && /^[0-9a-zA-Z-]{8,64}$/.test(s.cardId) ? s.cardId : null,
      linkKey: typeof s.linkKey === 'string' && /^[a-z0-9:]{1,64}$/i.test(s.linkKey) ? s.linkKey : null,
      drafts: {},
    };
    for (const [k, v] of Object.entries(s.drafts ?? {})) {
      if (/^[0-9a-zA-Z-]{8,64}$/.test(k) && typeof v === 'string') { out.drafts[k] = v.slice(0, 500); setDraft(k, v); }
    }
    return out;
  } catch {
    return null;
  }
}

/** Un lien direct quitte la page : la file note son état (écoute synchrone). */
export function notifyLeaving(cardId: string, linkKey: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(TO_PROCESS_LEAVING_EVENT, { detail: { cardId, linkKey } }));
}
