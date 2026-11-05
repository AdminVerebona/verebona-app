'use client';

/**
 * Partage natif (lot 110A) — branchement dans la vue de l'application.
 *
 *   · jeton d'import remis au natif dès qu'une session est ouverte (et
 *     renouvelé avant échéance, ou au changement d'espace) ; retiré du
 *     téléphone à la déconnexion ;
 *   · reprise des imports « En attente de connexion » du compte connecté ;
 *   · « Importer et ouvrir Verebona » : ouverture du suivi / du document
 *     (après déverrouillage, comme toute navigation entrante) ;
 *   · état fidèle des imports de CE compte pour la carte d'état.
 * Sans plugin natif (binaire antérieur, navigateur) : aucun effet.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { listenNative, nativePlugin, NATIVE_PLUGINS } from '@/lib/native/bridge';
import { mobileClientHeaders } from '@/lib/mobile/native-shell';
import { onSessionTransition } from '@/lib/session/session-lifecycle';
import {
  acknowledgeShare, consumeOpenRequest, dropShareGrant, needsGrant, provisionShareGrant, readNativeShareState,
  resumeShares, shareImportAvailable, trackingPath, visibleShareItems, type NativeShareItem, type NativeShareState,
} from '@/lib/native/share-import';

export interface ShareImportHook {
  available: boolean;
  items: NativeShareItem[];
  acknowledge: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useShareImport(opts: {
  account: string | null;
  enabled: boolean;
  open: (path: string) => void;
}): ShareImportHook {
  const { account, enabled, open } = opts;
  const [state, setState] = useState<NativeShareState>({ available: false, grant: null, items: [] });
  const provisioning = useRef(false);
  const available = shareImportAvailable();

  const refresh = useCallback(async () => {
    if (!shareImportAvailable()) return;
    setState(await readNativeShareState());
  }, []);

  // Démarrage, retour au premier plan, changement d'état natif.
  useEffect(() => {
    if (!available) return;
    void refresh();
    const offNative = listenNative(nativePlugin(NATIVE_PLUGINS.shareImport), 'stateChanged', () => { void refresh(); });
    const offApp = listenNative<{ isActive: boolean }>(nativePlugin(NATIVE_PLUGINS.app), 'appStateChange', (s) => { if (s.isActive) void refresh(); });
    return () => { void offNative.then((f) => f()); void offApp.then((f) => f()); };
  }, [available, refresh]);

  // Jeton d'import : session ouverte → remis au natif (puis reprise des attentes).
  useEffect(() => {
    if (!available || !enabled || !account || provisioning.current) return;
    if (!needsGrant(state.grant, account)) return;
    provisioning.current = true;
    void provisionShareGrant(mobileClientHeaders())
      .then((ok) => (ok ? resumeShares() : undefined))
      .finally(() => { provisioning.current = false; void refresh(); });
  }, [available, enabled, account, state.grant, refresh]);

  // Déconnexion ou changement d'espace : jeton retiré du téléphone (la
  // révocation de la session le rend de toute façon inutilisable côté serveur).
  useEffect(() => onSessionTransition((t) => {
    if (t.reason === 'logout' || t.reason === 'account-change' || t.reason === 'auth-failure') {
      void dropShareGrant(mobileClientHeaders(), false).then(() => refresh());
    }
  }), [refresh]);

  // « Importer et ouvrir Verebona » : demande laissée par l'interface de partage.
  const lastOpen = useRef<string | null>(null);
  useEffect(() => {
    if (!available || !account) return;
    void consumeOpenRequest().then((id) => {
      if (!id || lastOpen.current === id) return;
      lastOpen.current = id;
      const item = state.items.find((i) => i.id === id);
      open(item ? trackingPath(item) : `/documents/import-partage?partage=${encodeURIComponent(id)}`);
    });
  }, [available, account, state.items, open]);

  const acknowledge = useCallback(async (id: string) => {
    await acknowledgeShare(id);
    await refresh();
  }, [refresh]);

  return { available, items: visibleShareItems(state.items, account), acknowledge, refresh };
}
