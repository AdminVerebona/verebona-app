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

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useEntitlements } from '@/hooks/useEntitlements';
import { WriteBlockedDialog } from '@/components/premium/WriteBlockedDialog';
import {
  TRIAL_EXPIRED_MESSAGE,
  WRITE_BLOCKED_EVENT,
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

  // ── Refus constatés hors d'un composant (api-client, dépôt de fichier…) ──
  // Tout 403 de droits arrive ici et ouvre la même fenêtre qu'un clic gardé.
  useEffect(() => {
    const onBlocked = (e: Event) => {
      const recu = (e as CustomEvent<WriteBlockedInfo>).detail;
      if (!recu) return;
      setInfo(recu);
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

  const essaiExpire = entitlements?.trial.status === 'expired';

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
        return {
          code: essaiExpire ? 'TRIAL_EXPIRED' : 'SUBSCRIPTION_REQUIRED',
          message: essaiExpire
            ? TRIAL_EXPIRED_MESSAGE
            : 'Un abonnement actif est nécessaire pour effectuer cette action.',
        };
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
    [entitlements, essaiExpire, isLoading, isRestricted, refresh],
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
