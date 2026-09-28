/**
 * Couche « droits et offre » du prompt — CDC §17.3 (couche 3).
 *
 * Elle était STATIQUE (« les droits du compte ont déjà été vérifiés ») : le
 * modèle ignorait ce que l'offre du compte permet réellement. Elle est
 * désormais construite à chaque appel, à partir du registre des capacités
 * (§25.6) — offre effective, capacités ouvertes et fermées, flags du §39 —,
 * et injectée dans la variable {{RIGHTS}} du prompt maître.
 *
 * Contenu SERVEUR uniquement : aucune donnée venue du client ou d'une source.
 */
import { CAPABILITY_LABELS, capabilitiesForPlan, isPlanAiEligible } from '../registries/capability-registry';

const OFFRES: Record<string, string> = {
  STANDARD: 'Standard',
  PREMIUM: 'Premium',
  PREMIUM_DUO: 'Premium Duo',
  PREMIUM_PRO: 'Premium Pro',
};

export interface RightsInput {
  planType: string;
  planLimit?: 'TRIAL_EXPIRED' | 'SUBSCRIPTION_REQUIRED' | null;
  /** Commandes d'écriture actives (écart acté au §4.8). */
  writeCommands?: boolean;
}

/** Texte de la couche « droits et offre », une ligne par fait. */
export function describeAccountRights(r: RightsInput): string {
  const { open, closed } = capabilitiesForPlan(r.planType);
  const libelle = (code: string) => CAPABILITY_LABELS[code] ?? code;
  const lignes = [
    `- Offre effective : ${OFFRES[r.planType] ?? r.planType}.`,
    `- Réponses rédigées à partir des documents : ${isPlanAiEligible(r.planType) ? 'autorisées' : 'non incluses'}.`,
    `- Capacités ouvertes : ${open.length ? open.map((c) => libelle(c.code)).join(' ; ') : 'aucune'}.`,
    `- Capacités non incluses ou désactivées : ${closed.length ? closed.map((c) => libelle(c.code)).join(' ; ') : 'aucune'}.`,
    '- Aucune action n’est exécutée par l’assistant : les boutons proposés sont décidés par le serveur.',
  ];
  if (r.writeCommands === false) lignes.push('- Modifications depuis l’assistant : désactivées.');
  if (r.planLimit === 'TRIAL_EXPIRED') lignes.push('- Essai terminé : seules la recherche et l’aide restent ouvertes.');
  if (r.planLimit === 'SUBSCRIPTION_REQUIRED') lignes.push('- Aucune offre active : seules la recherche et l’aide restent ouvertes.');
  return lignes.join('\n');
}
