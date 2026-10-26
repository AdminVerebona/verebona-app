/**
 * Restriction de canaux d'une réémission (CDC 3 §20.3, revue lot 21).
 *
 * La réémission (`notification-reemission.service`) dépose dans
 * `payload_json._reemission` les canaux encore à servir ; le dispatcher la lit
 * ici, coupe les autres canaux — y compris une cloche obligatoire déjà livrée —
 * et retire la clé avant le rendu du contenu.
 */

export const REEMISSION_KEY = '_reemission';

export type ReemissionChannel = 'bell' | 'email' | 'push';

export interface ReemissionRestriction {
  canaux: ReemissionChannel[];
  /** Appareils push à servir (ceux en échec) ; absent = aucun push. */
  pushSubscriptionIds?: string[];
}

const CANAUX: readonly ReemissionChannel[] = ['bell', 'email', 'push'];

/** Sépare la restriction du contenu. `restriction: null` = aucune (envoi normal). */
export function lireRestrictionReemission(payload: unknown): {
  payload: Record<string, unknown>;
  restriction: ReemissionRestriction | null;
} {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? { ...(payload as Record<string, unknown>) } : {};
  const brut = p[REEMISSION_KEY];
  delete p[REEMISSION_KEY];
  if (!brut || typeof brut !== 'object') return { payload: p, restriction: null };
  const r = brut as { canaux?: unknown; pushSubscriptionIds?: unknown };
  // Restriction illisible : on ne sert RIEN plutôt que tout (pas de doublon).
  const canaux = Array.isArray(r.canaux) ? r.canaux.filter((c): c is ReemissionChannel => CANAUX.includes(c as ReemissionChannel)) : [];
  const subs = Array.isArray(r.pushSubscriptionIds) ? r.pushSubscriptionIds.filter((s): s is string => typeof s === 'string') : [];
  return {
    payload: p,
    restriction: { canaux, ...(canaux.includes('push') ? { pushSubscriptionIds: subs } : {}) },
  };
}

/** Applique la restriction aux canaux résolus (après préférences et activation BO). */
export function appliquerRestrictionReemission<T extends Record<ReemissionChannel, boolean>>(
  channels: T,
  restriction: ReemissionRestriction | null,
): T {
  if (!restriction) return channels;
  const out = { ...channels };
  for (const c of CANAUX) if (!restriction.canaux.includes(c)) out[c] = false as T[typeof c];
  return out;
}
