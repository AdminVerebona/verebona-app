import { redirect } from 'next/navigation';

/**
 * « Suivi IA » — entrée SUPPRIMÉE (CDC Back-Office V1 §3 encadré, §14,
 * REC-NAV-02 ; CDC BO IA V2 : consommation et coûts dans les écrans IA).
 *
 * L'URL redirige vers le Tableau de bord IA, qui porte désormais la
 * supervision des traitements, des coûts et des exécutions.
 */
export default function AiUsageRedirect() {
  redirect('/admin/ai-dashboard');
}
