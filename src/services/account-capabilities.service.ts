/**
 * Capacités fonctionnelles d'un compte — source UNIQUE de la matrice
 * offre → fonctionnalités Pièces et Équipements.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PLAN / DROITS → CAPACITÉS → CONTEXTE DES TRAITEMENTS
 *
 * Les traitements IA (T1 notamment) ne connaissent jamais le nom de l'offre :
 * ils reçoivent des capacités (`{ rooms, equipments }`), résolues ici côté
 * serveur à partir des droits effectifs (`entitlements.service`). Faire évoluer
 * une offre se fait dans cette matrice, sans réécrire les règles de T1.
 *
 *   Offre effective   Pièces   Équipements
 *   ───────────────   ──────   ───────────
 *   standard          non      non
 *   premium           oui      oui
 *   premium_duo       oui      oui
 *   trial             oui      oui   (essai = Premium, comme l'interface)
 *   none              non      non   (sans abonnement, restreint, impayé)
 *
 * PREMIUM_PRO : jamais autorisé implicitement. Les droits effectifs ne
 * connaissent pas cette offre (elle retombe en `standard`) et la colonne
 * `plan_limits.features_json` (migration 0066, `premium_pro` à true) n'est
 * PAS lue : elle n'est pas la source de vérité.
 *
 * En cas d'erreur de lecture : aucune capacité (repli prudent — l'information
 * reste conservée comme connaissance générique, rien n'est perdu).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { getEntitlements, type EntitlementPlan } from './entitlements.service';

export interface AccountCapabilities {
  rooms: boolean;
  equipments: boolean;
}

const ALL: AccountCapabilities = Object.freeze({ rooms: true, equipments: true });
export const NO_CAPABILITIES: AccountCapabilities = Object.freeze({ rooms: false, equipments: false });

/** Matrice V1 — le SEUL endroit où elle est écrite. */
const CAPABILITIES_BY_PLAN: Readonly<Record<EntitlementPlan, AccountCapabilities>> = Object.freeze({
  standard: NO_CAPABILITIES,
  premium: ALL,
  premium_duo: ALL,
  trial: ALL,
  none: NO_CAPABILITIES,
});

/** Capacités d'une offre effective (pure). Toute valeur inconnue : aucune capacité. */
export function capabilitiesForPlan(plan: string | null | undefined): AccountCapabilities {
  const c = CAPABILITIES_BY_PLAN[plan as EntitlementPlan];
  return c ? { ...c } : { ...NO_CAPABILITIES };
}

/** Capacités effectives d'un compte, au moment de l'appel. */
export async function getAccountCapabilities(accountId: number): Promise<AccountCapabilities> {
  try {
    const ent = await getEntitlements(accountId);
    return capabilitiesForPlan(ent.plan);
  } catch (error) {
    console.error(`[capabilities] droits du compte ${accountId} illisibles — aucune capacité :`, (error as Error).message);
    return { ...NO_CAPABILITIES };
  }
}

/** Type de cible interdit par les capacités du compte ? */
export function isTargetForbidden(type: string, caps: AccountCapabilities): boolean {
  return (type === 'ROOM' && !caps.rooms) || (type === 'EQUIPMENT' && !caps.equipments);
}
