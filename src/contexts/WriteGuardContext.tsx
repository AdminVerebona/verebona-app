'use client';

/**
 * Garde d'écriture, partagée par toute l'application — CDC 1 §8.3, §9.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DOUZE ACTIONS, UNE SEULE FENÊTRE
 *
 * Ajout de bien, de document, d'échéance, d'équipement, de pièce ; le bouton
 * « + » ; les exports ; les boutons « modifier » des fiches ; l'envoi à
 * l'assistant. Toutes doivent, essai terminé, ouvrir la même fenêtre.
 *
 * Deux gardes existaient déjà — dans `DashboardLayout` et dans le menu mobile
 * — avec la même logique recopiée, et un simple bandeau pour tout message.
 * Un bandeau disparaît ; l'utilisateur qui vient de cliquer sur « Ajouter »
 * ne comprend pas pourquoi rien ne s'ouvre.
 *
 * ── UN CONTEXTE, ET NON UN CROCHET PAR COMPOSANT ──────────────────────────
 *
 * Un crochet local rendrait une fenêtre par composant : douze instances, dont
 * plusieurs pourraient s'ouvrir ensemble. Le contexte en tient une seule,
 * montée à la racine.
 *
 * ── LE SERVEUR RESTE SEUL JUGE ────────────────────────────────────────────
 *
 * Ce contrôle client est une courtoisie : il évite de remplir un formulaire
 * pour rien. Une écriture refusée côté serveur le reste, et `signalerRefus`
 * permet d'afficher le message réel quand un 403 arrive malgré tout.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useEntitlements } from '@/hooks/useEntitlements';
import { WriteBlockedDialog } from '@/components/premium/WriteBlockedDialog';
import { isUnpaid } from '@/lib/trial-status';
import {
  WRITE_BLOCKED_EVENT,
  restrictedWriteInfo,
  setWriteBlockedListenerMounted,
  type WriteBlockedInfo,
} from '@/lib/write-blocked';

type Quota = 'assets' | 'documents';

interface WriteGuardValue {
  /**
   * Exécute `action` si l'écriture est permise, sinon ouvre la fenêtre.
   *
   *     <Button onClick={() => garder(() => setOuvert(true))}>Ajouter</Button>
   *
   * `quota` précise la limite à vérifier en plus de l'état du compte. Omis,
   * seul l'accès en écriture est contrôlé — ce qui suffit pour une
   * modification, un export ou une question à l'assistant.
   */
  garder: (action: () => void, quota?: Quota) => void;
  /** Vrai si l'action serait refusée — pour griser un bouton. */
  estBloque: (quota?: Quota) => boolean;
  /** Affiche le refus renvoyé par le serveur, qui fait foi. */
  signalerRefus: (info: WriteBlockedInfo) => void;
}

const Contexte = createContext<WriteGuardValue | null>(null);

export function WriteGuardProvider({ children }: { children: React.ReactNode }) {
  const { entitlements, isLoading, isRestricted, refresh } = useEntitlements();
  const [info, setInfo] = useState<WriteBlockedInfo | null>(null);
  const [open, setOpen] = useState(false);
  // Lu par l'écouteur d'événement sans le réabonner à chaque rendu.
  const entitlementsRef = useRef(entitlements);
  entitlementsRef.current = entitlements;

  // ── Refus constatés hors d'un composant (api-client, dépôt de fichier…) ──
  // Tout 403 de droits arrive ici et ouvre la même fenêtre qu'un clic gardé.
  useEffect(() => {
    const onBlocked = (e: Event) => {
      const recu = (e as CustomEvent<WriteBlockedInfo>).detail;
      if (!recu) return;
      // Un compte sans offre (essai terminé, abonnement absent) qui touche
      // une fonction Premium n'a pas à lire « Passez à Premium » : son
      // blocage, c'est l'absence d'offre. Même fenêtre que partout ailleurs.
      const droits = entitlementsRef.current;
      const sansOffre = droits?.isRestricted === true;
      const impaye = isUnpaid(droits);
      if (recu.code === 'PREMIUM_REQUIRED' && sansOffre) {
        setInfo(restrictedWriteInfo(impaye ? droits : { trial: droits?.trial }));
      } else if (impaye && (recu.code === 'SUBSCRIPTION_REQUIRED' || recu.code === 'TRIAL_EXPIRED')) {
        // Refus serveur pendant un impayé : son message dit déjà la date
        // limite ; on y ajoute le contexte qui fait proposer la mise à jour
        // du moyen de paiement plutôt que le choix d'une offre.
        setInfo({ ...restrictedWriteInfo(droits), message: recu.message || restrictedWriteInfo(droits).message });
      } else {
        setInfo(recu);
      }
      setOpen(true);
      // Le serveur vient de dire que les droits ont changé : on les relit
      // pour que les prochains clics soient gardés sans aller-retour.
      void refresh();
    };
    window.addEventListener(WRITE_BLOCKED_EVENT, onBlocked);
    setWriteBlockedListenerMounted(true);
    return () => {
      window.removeEventListener(WRITE_BLOCKED_EVENT, onBlocked);
      setWriteBlockedListenerMounted(false);
    };
  }, [refresh]);

  /** Refus applicable, ou `null` si l'action peut se faire. */
  const refus = useCallback(
    (quota?: Quota): WriteBlockedInfo | null => {
      // Droits inconnus : on laisse passer. Bloquer sur une information
      // absente refuserait l'action à un compte valide, le temps d'un
      // chargement — et le serveur tranchera de toute façon.
      if (isLoading) return null;

      // Droits jamais obtenus (session ouverte après le montage, réseau…) :
      // on laisse passer — le serveur refusera et la fenêtre s'ouvrira via
      // `WRITE_BLOCKED_EVENT` — mais on relance la lecture pour la suite.
      if (!entitlements) {
        setTimeout(() => { void refresh(); }, 0);
        return null;
      }

      if (isRestricted || entitlements?.canWrite === false) {
        // Impayé, essai expiré ou absence d'offre : trois discours distincts.
        return restrictedWriteInfo(isUnpaid(entitlements) ? entitlements : { trial: entitlements.trial });
      }

      if (!quota) return null;

      const q = entitlements?.quotas?.[quota];
      if (q && q.limit > 0 && q.used >= q.limit) {
        return {
          code: quota === 'assets' ? 'ASSET_QUOTA_REACHED' : 'DOCUMENT_QUOTA_REACHED',
          message:
            quota === 'assets'
              ? `Vous avez atteint la limite de ${q.limit} biens de votre offre.`
              : `Vous avez atteint la limite de ${q.limit} documents de votre offre.`,
          limit: q.limit,
        };
      }
      return null;
    },
    [entitlements, isLoading, isRestricted, refresh],
  );

  const valeur = useMemo<WriteGuardValue>(
    () => ({
      garder: (action, quota) => {
        const bloque = refus(quota);
        if (!bloque) {
          action();
          return;
        }
        setInfo(bloque);
        setOpen(true);
      },
      estBloque: (quota) => refus(quota) !== null,
      signalerRefus: (recu) => {
        setInfo(recu);
        setOpen(true);
      },
    }),
    [refus],
  );

  return (
    <Contexte.Provider value={valeur}>
      {children}
      <WriteBlockedDialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setInfo(null);
        }}
        info={info}
      />
    </Contexte.Provider>
  );
}

/**
 * Garde d'écriture.
 *
 * Hors du fournisseur, rend une garde passive plutôt que de lever : un
 * composant monté dans un contexte inattendu — un aperçu, un test — doit
 * continuer de fonctionner. Le serveur refusera si nécessaire.
 */
export function useWriteGuard(): WriteGuardValue {
  const ctx = useContext(Contexte);
  return (
    ctx ?? {
      garder: (action) => action(),
      estBloque: () => false,
      signalerRefus: () => {},
    }
  );
}
