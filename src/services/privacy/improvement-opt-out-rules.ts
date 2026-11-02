/**
 * Opposition à l'utilisation secondaire des données pour l'amélioration —
 * RÈGLE et LIBELLÉS (lot 102D). PUR : importé par les écrans (web, mobile),
 * l'API, le BO et les tests.
 *
 * Décision PO (30/10/2026) : l'usage INTERNE des données pour les tests, la
 * qualité et l'optimisation des traitements automatisés est permis selon la
 * politique de confidentialité ; jamais d'entraînement générique des modèles
 * des prestataires ; pas d'accès humain général aux documents pour améliorer
 * l'IA (accès exceptionnel : support, incident, sécurité).
 *
 * L'utilisateur peut s'y OPPOSER (Mon compte › Confidentialité). Un compte
 * opposé n'alimente plus aucun usage d'amélioration :
 *   · qualification des modèles et des prompts (comptes réels et rejeu des
 *     entrées capturées : `qualification/repository.ts`), donc aussi la mise
 *     en conformité automatique des prompts (non-régression) ;
 *   · exports d'exécutions IA du BO (contenu des échanges retiré) ;
 * et ce qui a été capturé AVANT ou PENDANT l'opposition reste exclu, même si
 * l'opposition est retirée ensuite (colonne `excluded_before`).
 *
 * NON concernés (service rendu, support, sécurité) : les traitements du
 * compte lui-même (T1 à T6, rattrapages, rejeu d'une analyse invalide pour
 * CE compte), la capture des appels (preuve et support, supprimée avec le
 * compte), la consultation unitaire d'une exécution par le support, le
 * diagnostic technique (contenus déjà remplacés par leur empreinte), la
 * supervision agrégée. Les campagnes de mesure utilisent un compte technique
 * et un corpus synthétique (aucune donnée de compte).
 */
import { legalPublicUrl } from '@/lib/legal/public-legal';

/** Libellés factuels (aucun texte juridique ; renvoi à la politique publique). */
export const IMPROVEMENT_OPT_OUT_TEXT = Object.freeze({
  title: 'Amélioration de Verebona',
  description:
    'Verebona peut utiliser les données de votre compte, en interne, pour tester et améliorer la qualité de ses traitements automatisés. Elles ne servent pas à entraîner les modèles généraux des prestataires d’IA et personne ne consulte vos documents pour cela.',
  switchLabel: 'Je m’oppose à l’utilisation des données de mon compte pour améliorer Verebona',
  effect:
    'Votre service reste identique. Le support peut toujours consulter un traitement si c’est nécessaire pour répondre à votre demande, à un incident ou pour la sécurité.',
  optedOutSince: (date: string) => `Opposition enregistrée le ${date}.`,
  memberCannotWithdraw: 'Seul le titulaire du compte, ou la personne qui a fait l’opposition, peut la retirer.',
  privacyLinkLabel: 'Politique de confidentialité',
});

/** Libellé exact enregistré dans la preuve, selon l'action. */
export function improvementProofLabel(optOut: boolean): string {
  return optOut
    ? `${IMPROVEMENT_OPT_OUT_TEXT.switchLabel} — activé`
    : `${IMPROVEMENT_OPT_OUT_TEXT.switchLabel} — désactivé`;
}

export type ImprovementChannel = 'web' | 'mobile' | 'admin';

/** Qui peut changer le réglage (pur). Opposer : tout membre actif. Retirer : titulaire ou auteur. */
export function canChangeImprovementOptOut(input: {
  role: string | null;
  userId: number;
  wantOptOut: boolean;
  current: { optOut: boolean; optedOutByUserId: number | null } | null;
}): boolean {
  if (!input.role) return false;
  if (input.wantOptOut) return true;
  if (!input.current?.optOut) return true;
  return input.role === 'owner' || input.current.optedOutByUserId === input.userId;
}

/**
 * Lien public « Confidentialité » (site public = source juridique unique).
 * Sans argument : configuration unique 102B (`lib/legal/public-legal`) ; dans
 * un composant, préférer `useLegalLinks().confidentialite` (bascule à chaud).
 */
export function privacyPolicyUrl(env?: Record<string, string | undefined>): string {
  if (!env) return legalPublicUrl('confidentialite');
  const e = env;
  const full = (e.NEXT_PUBLIC_LEGAL_PRIVACY_URL ?? '').trim();
  if (/^https:\/\/[^\s]+$/i.test(full)) return full;
  const base = (e.NEXT_PUBLIC_PUBLIC_SITE_URL || 'https://www.verebona.fr').trim().replace(/\/+$/, '');
  return `${base}/legal/confidentialite`;
}

// ── Prédicats SQL (une seule écriture de la règle pour tous les usages) ─────

/**
 * Vrai si le compte `accountIdExpr` peut alimenter l'amélioration (aucune
 * opposition ACTIVE). Pour sélectionner des comptes.
 */
export function improvementAccountAllowedSql(accountIdExpr: string): string {
  return `NOT EXISTS (SELECT 1 FROM account_data_use_preferences adup
                       WHERE adup.account_id = ${accountIdExpr} AND adup.improvement_opt_out)`;
}

/**
 * Vrai si la capture (alias `c` de `ai_call_captures`) peut servir à
 * l'amélioration : son compte n'est pas opposé ET elle n'a pas été faite
 * avant la fin d'une opposition (`excluded_before`).
 */
export function improvementCaptureUsableSql(alias = 'c'): string {
  return `NOT EXISTS (SELECT 1 FROM account_data_use_preferences adup
                       WHERE adup.account_id = ${alias}.account_id
                         AND (adup.improvement_opt_out OR ${alias}.captured_at < adup.excluded_before))`;
}
