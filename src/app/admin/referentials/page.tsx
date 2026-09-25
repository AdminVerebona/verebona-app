import { EcranEnCoursDeRealisation } from '@/components/admin/EcranEnCoursDeRealisation';

/** Entrée « Référentiels » de la navigation cible (CDC BO §3, §9). */
export default function AdminReferentialsPage() {
  return (
    <EcranEnCoursDeRealisation
      titre="Référentiels"
      description="Consultation des référentiels et de leurs usages : familles et catégories, types de documents, rubriques, règles et mappings."
      references="CDC Back-Office §9, REFD-001 à REFD-006"
    />
  );
}
