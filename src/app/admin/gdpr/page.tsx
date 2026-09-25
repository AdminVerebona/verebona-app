import { EcranEnCoursDeRealisation } from '@/components/admin/EcranEnCoursDeRealisation';

/** Entrée « RGPD » de la navigation cible (CDC BO §3, §12). */
export default function AdminGdprPage() {
  return (
    <EcranEnCoursDeRealisation
      titre="RGPD"
      description="Suivi opérationnel des demandes RGPD : demandes système et demandes manuelles, échéances, traitement et historique."
      references="CDC Back-Office §12, GDP-001 à GDP-022"
    />
  );
}
