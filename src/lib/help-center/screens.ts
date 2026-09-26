/**
 * Contexte d'écran pour le choix des articles — CDC Centre d'aide §5, T2-05.
 *
 * « Le contexte plateforme / connexion / offre / rôle / écran / type d'objet
 * est transmis et vérifié à chaque interaction. » Les articles du corpus
 * (`corpus-t2.json`) déclarent les écrans où ils s'appliquent, avec les
 * libellés du référentiel `SCREENS` du site public. Ce module traduit une
 * route de l'application vers ces libellés, et extrait les identifiants du
 * bien / document ouverts (CDC Assistant §13.3, §27.1).
 *
 * Aucune dépendance serveur : utilisé par le tiroir (client) et par le
 * service de corpus (serveur).
 */

/** Libellés d'écran du référentiel du Centre d'aide, par motif de route. */
const ROUTE_SCREENS: ReadonlyArray<{ pattern: RegExp; screens: string[]; objectType?: string }> = [
  { pattern: /^\/accueil\/a-traiter(\/|$)/, screens: ['À traiter'] },
  { pattern: /^\/accueil\/?$/, screens: ['Accueil'] },
  { pattern: /^\/assets\/\d+/, screens: ['Fiche bien', 'Bien'], objectType: 'bien' },
  { pattern: /^\/assets\/?$/, screens: ['Mes biens'] },
  { pattern: /^\/documents\/\d+/, screens: ['Détail document', 'Document', 'Tiroir document'], objectType: 'document' },
  { pattern: /^\/documents\/?$/, screens: ['Mes documents'] },
  { pattern: /^\/agenda(\/|$)/, screens: ['Agenda'], objectType: 'échéance' },
  { pattern: /^\/mon-compte(\/|$)/, screens: ['Mon compte', 'Mon compte > Informations'] },
  { pattern: /^\/abonnement(\/|$)/, screens: ['Mon abonnement', 'Offres'], objectType: 'abonnement' },
  { pattern: /^\/notifications(\/|$)/, screens: ['Notifications', 'Cloche'], objectType: 'notification' },
];

export interface HelpScreenContext {
  screens: string[];
  objectType: string | null;
}

export function helpScreenForRoute(route: string | null | undefined): HelpScreenContext {
  const r = (route ?? '').split(/[?#]/)[0];
  const hit = ROUTE_SCREENS.find((s) => s.pattern.test(r));
  return hit ? { screens: hit.screens, objectType: hit.objectType ?? null } : { screens: [], objectType: null };
}

/**
 * Contexte de page enrichi — CDC Assistant §13.3, §27.1 (audit P2 « contexte
 * de page (bien ouvert) transmis et utilisé »).
 *
 * Le layout n'envoyait que `{ route }` : « ce bien » sur `/assets/42` restait
 * sans cible. L'identifiant est lu dans la route ; le serveur le revalide
 * (entier positif, appartenance au compte) avant tout usage.
 */
export function enrichPageContext(
  ctx: Record<string, string> | undefined,
  platform?: 'web' | 'mobile',
): Record<string, string> | undefined {
  if (!ctx) return platform ? { platform } : undefined;
  const out: Record<string, string> = { ...ctx };
  const route = (ctx.route ?? '').split(/[?#]/)[0];
  const asset = /^\/assets\/(\d+)(\/|$)/.exec(route);
  const doc = /^\/documents\/(\d+)(\/|$)/.exec(route);
  if (asset && !out.assetId) out.assetId = asset[1];
  if (doc && !out.documentId) out.documentId = doc[1];
  if (platform && !out.platform) out.platform = platform;
  return out;
}
