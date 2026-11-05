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
 *
 * Lot 111P : la remise du jeton passe par `ShareGrantProvisioner`
 * (src/lib/native/share-grant-provisioner.ts) — déclencheurs explicites,
 * motif de chaque échec, reprise bornée, renouvellement après refus serveur
 * et avant échéance, vérification serveur légère, journal technique.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { listenNative, nativePlugin, NATIVE_PLUGINS } from '@/lib/native/bridge';
import { mobileClientHeaders } from '@/lib/mobile/native-shell';
import { onSessionTransition } from '@/lib/session/session-lifecycle';
import { apiClient } from '@/lib/api-client';
import {
  acknowledgeShare, consumeOpenRequest, dropShareGrant, fetchActiveGrantRefs, provisionShareGrant, readNativeShareState,
  resumeShares, shareImportAvailable, trackingPath, visibleShareItems, type NativeShareItem, type NativeShareState,
} from '@/lib/native/share-import';
import { ShareGrantProvisioner, type ProvisionStatus } from '@/lib/native/share-grant-provisioner';
import { appendShareImportJournal, lastShareImportJournalCode, mergeNativeShareDiagnostics } from '@/lib/native/share-import-journal';

export interface ShareImportHook {
  available: boolean;
  items: NativeShareItem[];
  acknowledge: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
  /** Lot 111P : où en est la remise du jeton (carte d'état des imports en attente). */
  provision: ProvisionStatus;
  /** Lot 111P : dernier code du journal technique (recette), jamais une donnée. */
  lastCode: string | null;
}

export function useShareImport(opts: {
  account: string | null;
  enabled: boolean;
  open: (path: string) => void;
}): ShareImportHook {
  const { account, enabled, open } = opts;
  const [state, setState] = useState<NativeShareState>({ available: false, grant: null, items: [] });
  const [provision, setProvision] = useState<ProvisionStatus>({ phase: 'idle', code: null, nextRetryAt: null });
  const [lastCode, setLastCode] = useState<string | null>(null);
  const available = shareImportAvailable();

  const read = useCallback(async () => {
    const s = await readNativeShareState();
    if (s.diagnostics?.length) mergeNativeShareDiagnostics(s.diagnostics);
    setState(s);
    setLastCode(lastShareImportJournalCode());
    return s;
  }, []);

  // Lot 111P : remise FIABLE du jeton (déclencheurs, reprise bornée, renouvellement) — une instance par vue.
  const provisioner = useRef<ShareGrantProvisioner | null>(null);
  if (available && !provisioner.current) {
    provisioner.current = new ShareGrantProvisioner({
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      readState: read,
      provision: () => provisionShareGrant(mobileClientHeaders(), () => apiClient.refreshToken()),
      checkServer: () => fetchActiveGrantRefs(mobileClientHeaders()),
      resume: resumeShares,
      journal: (code, detail) => { appendShareImportJournal(code, detail); setLastCode(code); },
      onStatus: setProvision,
    });
  }
  useEffect(() => {
    const p = provisioner.current;
    p?.activate();
    return () => p?.dispose();
  }, []);

  const refresh = useCallback(async () => {
    if (!shareImportAvailable()) return;
    await read();
  }, [read]);

  // Démarrage, retour au premier plan, changement d'état natif (dont : jeton refusé par le serveur).
  useEffect(() => {
    if (!available) return;
    void read().then((s) => provisioner.current?.trigger('start', s));
    const offNative = listenNative(nativePlugin(NATIVE_PLUGINS.shareImport), 'stateChanged', () => {
      void read().then((s) => provisioner.current?.trigger('native', s));
    });
    const offApp = listenNative<{ isActive: boolean }>(nativePlugin(NATIVE_PLUGINS.app), 'appStateChange', (st) => {
      if (st.isActive) void read().then((s) => provisioner.current?.trigger('resume', s));
    });
    return () => { void offNative.then((f) => f()); void offApp.then((f) => f()); };
  }, [available, read]);

  // Session ouverte (connexion), changement d'espace, interrupteur serveur : jeton (re)demandé.
  useEffect(() => {
    if (!available) return;
    provisioner.current?.setContext(enabled ? account : null, enabled);
  }, [available, enabled, account]);

  // Déconnexion ou changement d'espace : jeton retiré du téléphone (la
  // révocation de la session le rend de toute façon inutilisable côté serveur).
  useEffect(() => onSessionTransition((t) => {
    if (t.reason === 'logout' || t.reason === 'account-change' || t.reason === 'auth-failure') {
      appendShareImportJournal('GRANT_DROPPED', { reason: t.reason.toUpperCase().replace('-', '_') });
      // Changement d'espace : le jeton du nouvel espace est redemandé (déclencheur natif, borné).
      void dropShareGrant(mobileClientHeaders(), false).then(() => read()).then((s) => provisioner.current?.trigger('native', s));
    }
  }), [read]);

  // « Importer et ouvrir Verebona » / notification « Document ajouté » touchée : ouverture du suivi.
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

  return { available, items: visibleShareItems(state.items, account), acknowledge, refresh, provision, lastCode };
}
