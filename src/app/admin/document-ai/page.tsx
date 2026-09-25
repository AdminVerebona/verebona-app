import { redirect } from 'next/navigation';

/**
 * « Gestion IA » — entrée SUPPRIMÉE (CDC Back-Office V1 §3 encadré, §14, §15,
 * REC-NAV-02).
 *
 * Elle n'est plus une entrée fonctionnelle du BO : l'URL redirige vers le
 * Tableau de bord IA. Les mappings de taxonomie restent consultables par l'API
 * (`/api/admin/document-ai/mappings`, lecture seule) en attendant l'onglet
 * Référentiels > Règles et mappings (§9).
 */
export default function DocumentAiRedirect() {
  redirect('/admin/ai-dashboard');
}
