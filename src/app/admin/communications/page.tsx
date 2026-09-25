import { EcranEnCoursDeRealisation } from '@/components/admin/EcranEnCoursDeRealisation';

/** Entrée « Communications » de la navigation cible (CDC BO §3, §10). */
export default function AdminCommunicationsPage() {
  return (
    <EcranEnCoursDeRealisation
      titre="Communications"
      description="Modèles de communication par événement et par canal (e-mail, push, in-app) : activation, prévisualisation et test."
      references="CDC Back-Office §10, COM-001 à COM-015"
    />
  );
}
