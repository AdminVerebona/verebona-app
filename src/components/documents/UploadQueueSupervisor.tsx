"use client";

/**
 * Supervision de la file de dépôt — APP-PERF-29, lot 31 (L31-5).
 *
 * Monté une fois dans le gabarit de l'application, SANS RENDU : le suivi
 * flottant « Envoi de documents » a été supprimé (« La notification
 * suffit », voir `@/lib/upload-queue-feedback`). Ce composant garde ce que
 * ce suivi portait au-delà de l'affichage :
 *   · rattachement de la file au stockage local de l'utilisateur (reprise
 *     après fermeture, 24 h ; la purge par session reste dans la file) ;
 *   · avertissement du navigateur si l'onglet se ferme pendant un envoi ;
 *   · reprise automatique, au retour au premier plan, d'un envoi échoué
 *     application masquée (même opération — jamais de doublon) ;
 *   · signalement VISIBLE des envois interrompus restaurés et de l'échec
 *     d'une reprise automatique (message d'erreur avec « Reprendre », qui
 *     ouvre la modale d'ajout sur les envois à reprendre).
 * Les échecs d'un lot sont signalés par la modale qui l'a lancé (fin de lot).
 * Seul rendu possible : la modale d'ajout, ouverte par « Reprendre ».
 */
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useFileDepot } from '@/hooks/useFileDepot';
import { fileDepot, stockageLocal } from '@/lib/upload-queue';
import {
  ACTION_REPRISE, DESCRIPTION_REPRISE, EVENEMENT_REPRISE_DEPOTS, nouvelleMemoireSignalements, ouvrirRepriseDepots, signalementsDepot,
} from '@/lib/upload-queue-feedback';
import { LazyUnifiedDocumentDialog } from '@/components/mobile/add-forms';

const signaler = (message: string) => toast.error(message, {
  description: DESCRIPTION_REPRISE,
  duration: 15_000,
  action: { label: ACTION_REPRISE, onClick: ouvrirRepriseDepots },
});

export function UploadQueueSupervisor({ userId }: { userId?: number | null }) {
  const { elements, enCours } = useFileDepot();
  const echouesMasque = useRef(new Set<string>());
  const memoire = useRef(nouvelleMemoireSignalements());
  const [repriseOuverte, setRepriseOuverte] = useState(false);

  // « Reprendre » (message d'échec) : la modale d'ajout s'ouvre sur ses
  // « Envois à reprendre ».
  useEffect(() => {
    const ouvrir = () => setRepriseOuverte(true);
    window.addEventListener(EVENEMENT_REPRISE_DEPOTS, ouvrir);
    return () => window.removeEventListener(EVENEMENT_REPRISE_DEPOTS, ouvrir);
  }, []);

  // Dépôts non terminés de CET utilisateur (stockage local, 24 h).
  useEffect(() => {
    fileDepot.utiliserStockage(userId ? stockageLocal(userId) : null);
  }, [userId]);

  // Fermeture ou rechargement de l'onglet pendant un envoi : avertissement
  // du navigateur (la navigation interne, elle, n'interrompt rien).
  useEffect(() => {
    if (enCours === 0) return;
    const avertir = (ev: BeforeUnloadEvent) => { ev.preventDefault(); ev.returnValue = ''; };
    window.addEventListener('beforeunload', avertir);
    return () => window.removeEventListener('beforeunload', avertir);
  }, [enCours]);

  // Signalements : envois restaurés « interrompus », reprise automatique échouée.
  useEffect(() => {
    for (const message of signalementsDepot(elements, memoire.current)) signaler(message);
  }, [elements]);

  // Échec survenu application masquée (veille, PWA suspendue) : une reprise
  // automatique au retour, sur la même opération — jamais de doublon.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'hidden') {
      for (const e of elements) {
        if (e.etape === 'echec' && e.reprise !== null && (e.fichierDisponible || e.reprise === 'confirmation')) {
          echouesMasque.current.add(e.operationId);
        }
      }
    }
  }, [elements]);
  useEffect(() => {
    const surRetour = () => {
      if (document.visibilityState !== 'visible') return;
      const ids = [...echouesMasque.current];
      echouesMasque.current.clear();
      for (const id of ids) {
        try { fileDepot.reprendre(id); memoire.current.relances.add(id); } catch { /* reprise manuelle (modale d'ajout) */ }
      }
    };
    document.addEventListener('visibilitychange', surRetour);
    return () => document.removeEventListener('visibilitychange', surRetour);
  }, []);

  if (!repriseOuverte) return null;
  return <LazyUnifiedDocumentDialog open onOpenChange={(v: boolean) => { if (!v) setRepriseOuverte(false); }} />;
}
