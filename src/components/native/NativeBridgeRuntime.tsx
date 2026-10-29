'use client';

/**
 * Exécution des intégrations natives — lot 95 (Gate 0). Chargé UNIQUEMENT dans
 * l'application iOS / Android (voir `NativeBridgeHost`).
 *
 *   · identifiant d'installation (Keychain / Keystore) et en-têtes X-Verebona-* ;
 *   · contrôle d'environnement : un binaire de préproduction ne fonctionne
 *     qu'avec le serveur de préproduction, et inversement (§27, M7, REC-063/064) ;
 *   · « Connexion Internet requise » (NET-01/02) ;
 *   · verrouillage après 5 min en arrière-plan, déverrouillage biométrique
 *     facultatif (AUTH-05/06/09) ;
 *   · liens universels / App Links et retour Google / Apple (§19, M1) ;
 *   · notifications : enregistrement, demande contextualisée, ouverture de
 *     l'écran ciblé (PUSH-02/04/09) ;
 *   · partage entrant → formulaire d'ajout habituel (IMP-02..04) ;
 *   · envoi natif de fond des documents (UPL-01/02).
 * Les interrupteurs serveur (`MOBILE_FEATURES_OFF`, /api/mobile/config) sont
 * respectés : une fonction coupée n'est pas branchée (API-08).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Lock, WifiOff, Bell, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useSession } from '@/hooks/useSession';
import { apiClient } from '@/lib/api-client';
import { mobileClientHeaders } from '@/lib/mobile/native-shell';
import { CREATE_FLOW_HOST_READY, isCreateFlowHostReady, openCreateFlow } from '@/lib/create-flows';
import { utiliserEnvoiNatif } from '@/lib/upload-queue';
import { NATIVE_PLUGINS, listenNative, nativePlugin } from '@/lib/native/bridge';
import { appBuildEnv, appUrlContext, expectedServerEnvironment, initInstallationId } from '@/lib/native/shell-info';
import { resolveAppUrl, pushTargetPath } from '@/lib/native/deep-links';
import { abandonNativeOAuth, completeNativeOAuth, nativeOAuthErrorMessage } from '@/lib/native/oauth';
import {
  biometricsEnabled, biometryAvailability, clearBackgroundAt, readBackgroundAt, rememberBackgroundAt,
  shouldLockOnResume, unlockPath, verifyUser,
} from '@/lib/native/app-lock';
import { enableNativePush, nativePushPermission, syncNativePush, watchPushOpens, watchPushTokenRotation } from '@/lib/native/push';
import { readSharedFile, triageSharedFiles } from '@/lib/native/share-in';
import { nativeUploadSender } from '@/lib/native/native-upload';
import { setNativeFeatures, setNativeOAuthReturn } from '@/lib/native/features';
import { NATIVE_COMMERCE_INFO_PATH, NATIVE_COMMERCE_MESSAGE, isCommercePath } from '@/lib/native/commerce';

type Features = Record<string, boolean>;
const PUSH_PROMPT_DISMISSED_KEY = 'verebona:native:push-prompt-dismissed';

interface NetworkPlugin {
  getStatus(): Promise<{ connected: boolean }>;
  addListener?: (event: string, cb: (data: unknown) => void) => unknown;
}
interface BrowserPlugin { open(o: { url: string }): Promise<void> }

function featureOn(features: Features | null, name: string): boolean {
  // Configuration pas encore lue : fonction active (défaut serveur) ; une
  // coupure serveur s'applique dès la lecture.
  return features ? features[name] !== false : true;
}

export default function NativeBridgeRuntime() {
  const router = useRouter();
  const pathname = usePathname();
  const { status } = useSession();
  const authenticated = status === 'authenticated';

  const [features, setFeatures] = useState<Features | null>(null);
  const [envMismatch, setEnvMismatch] = useState(false);
  const [offline, setOffline] = useState(false);
  const [lockDue, setLockDue] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [pushPrompt, setPushPrompt] = useState(false);

  const lockRef = useRef(false);
  const pendingNav = useRef<string | null>(null);
  const pendingFiles = useRef<File[] | null>(null);
  const featuresRef = useRef<Features | null>(null);

  const setLock = useCallback((v: boolean) => { lockRef.current = v; setLockDue(v); }, []);

  // Navigation interne validée, différée tant que l'app est verrouillée (PUSH-04, AG-03).
  const ouvrir = useCallback((path: string) => {
    if (lockRef.current) { pendingNav.current = path; return; }
    router.push(path);
  }, [router]);

  // ── Démarrage : installation, configuration, envoi natif ────────────────
  const lireConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/mobile/config', { headers: mobileClientHeaders(), cache: 'no-store' });
      if (!res.ok) return;
      const cfg = await res.json() as {
        environment?: string | null; platforms?: Record<string, { features?: Features }>; auth?: { appOAuthReturn?: unknown };
      };
      setNativeOAuthReturn(cfg.auth?.appOAuthReturn);
      const env = appBuildEnv();
      if (env && cfg.environment && cfg.environment !== expectedServerEnvironment(env)) setEnvMismatch(true);
      const platform = mobileClientHeaders()['X-Verebona-Client'] === 'IOS' ? 'ios' : 'android';
      const f = cfg.platforms?.[platform]?.features ?? null;
      featuresRef.current = f;
      setNativeFeatures(f);
      setFeatures(f);
    } catch { /* hors réseau : bannière dédiée */ }
  }, []);

  useEffect(() => {
    void initInstallationId();
    void lireConfig();
    if (shouldLockOnResume(readBackgroundAt(), Date.now())) setLock(true);
  }, [lireConfig, setLock]);

  useEffect(() => {
    const on = featureOn(features, 'background_upload');
    utiliserEnvoiNatif(on ? nativeUploadSender() : null);
    return () => utiliserEnvoiNatif(null);
  }, [features]);

  // ── Réseau (NET-01/02) ──────────────────────────────────────────────────
  useEffect(() => {
    const net = nativePlugin<NetworkPlugin>(NATIVE_PLUGINS.network);
    void net?.getStatus().then((s) => setOffline(!s.connected)).catch(() => undefined);
    const off = listenNative<{ connected: boolean }>(net, 'networkStatusChange', (s) => {
      setOffline(!s.connected);
      if (s.connected) void lireConfig();
    });
    return () => { void off.then((f) => f()); };
  }, [lireConfig]);

  // ── Cycle de vie : arrière-plan / retour (AUTH-09, HOME-04) ─────────────
  useEffect(() => {
    const off = listenNative<{ isActive: boolean }>(nativePlugin(NATIVE_PLUGINS.app), 'appStateChange', (s) => {
      if (!s.isActive) { rememberBackgroundAt(); return; }
      if (shouldLockOnResume(readBackgroundAt(), Date.now())) setLock(true);
      else clearBackgroundAt();
      void lireConfig();
    });
    return () => { void off.then((f) => f()); };
  }, [lireConfig, setLock]);

  // Hors session : aucun verrou (l'écran de connexion fait foi).
  useEffect(() => {
    if (status === 'unauthenticated' && lockRef.current) { setLock(false); clearBackgroundAt(); }
  }, [status, setLock]);

  const deverrouiller = useCallback(async () => {
    setUnlocking(true);
    try {
      const [enabled, dispo] = await Promise.all([biometricsEnabled(), biometryAvailability()]);
      const voie = unlockPath({
        biometricsEnabled: enabled && featureOn(featuresRef.current, 'biometrics'),
        biometryAvailable: dispo.available,
        deviceSecure: dispo.deviceSecure,
      });
      if (voie === 'full_sign_in') {
        // Aucune vérification locale possible : connexion complète (AUTH-06).
        await apiClient.signOut();
        setLock(false);
        clearBackgroundAt();
        window.location.assign(`/login?returnUrl=${encodeURIComponent(pathname || '/accueil')}`);
        return;
      }
      const r = await verifyUser({ biometryOnly: voie === 'biometry', reason: 'Déverrouiller Verebona' });
      if (r === 'ok') {
        setLock(false);
        clearBackgroundAt();
        const next = pendingNav.current;
        pendingNav.current = null;
        if (next) router.push(next);
      }
    } finally {
      setUnlocking(false);
    }
  }, [pathname, router, setLock]);

  // ── Liens entrants (§19) et retour Google / Apple (M1) ──────────────────
  useEffect(() => {
    const off = listenNative<{ url?: string }>(nativePlugin(NATIVE_PLUGINS.app), 'appUrlOpen', (e) => {
      const ctx = appUrlContext();
      if (!ctx) return;
      const r = resolveAppUrl(e?.url, ctx);
      if (r.kind === 'oauth') {
        void completeNativeOAuth(r.handoff).then((o) => {
          // Connexion, ou association / confirmation de Mon compte (lot 97B).
          if (o.status === 'signed_in' || o.status === 'account_done') window.location.assign(o.redirectTo);
          else if (o.status === 'failed') toast.error(o.message);
        });
        return;
      }
      if (r.kind === 'oauth_error') {
        // Lot 97B : parcours refusé par le serveur (ticket expiré, identité déjà liée…).
        void abandonNativeOAuth();
        toast.error(nativeOAuthErrorMessage(r.code));
        return;
      }
      if (r.kind === 'share') return; // contenu remis par l'événement `shareReceived`
      if (!featureOn(featuresRef.current, 'deep_links')) return;
      if (r.kind === 'route') ouvrir(r.path);
      else if (r.kind === 'external') void nativePlugin<BrowserPlugin>(NATIVE_PLUGINS.browser)?.open({ url: r.url }).catch(() => undefined);
      else toast.error('Ce lien ne peut pas être ouvert dans l’application.');
    });
    return () => { void off.then((f) => f()); };
  }, [ouvrir]);

  // ── Notifications (PUSH-02/04/09) ───────────────────────────────────────
  useEffect(() => {
    const offOpen = watchPushOpens((data) => {
      const ctx = appUrlContext();
      const path = ctx ? pushTargetPath(data, ctx) : null;
      ouvrir(path ?? '/accueil');
    });
    const offToken = watchPushTokenRotation();
    return () => { void offOpen.then((f) => f()); void offToken.then((f) => f()); };
  }, [ouvrir]);

  useEffect(() => {
    if (!authenticated || !featureOn(features, 'push')) return;
    void syncNativePush();
    void nativePushPermission().then((p) => {
      let dismissed = false;
      try { dismissed = localStorage.getItem(PUSH_PROMPT_DISMISSED_KEY) === '1'; } catch { /* sans stockage */ }
      setPushPrompt(p === 'prompt' && !dismissed);
    });
  }, [authenticated, features]);

  const fermerInvitationPush = (activer: boolean) => {
    setPushPrompt(false);
    try { localStorage.setItem(PUSH_PROMPT_DISMISSED_KEY, '1'); } catch { /* sans stockage */ }
    if (activer) {
      void enableNativePush().then((r) => {
        if (r === 'denied') toast.message('Notifications désactivées. Vous pourrez les activer dans les réglages du téléphone.');
      });
    }
  };

  // ── Partage entrant (IMP-02..04) ────────────────────────────────────────
  const livrerFichiers = useCallback(() => {
    const files = pendingFiles.current;
    if (!files || !authenticated || lockRef.current || !isCreateFlowHostReady()) return;
    pendingFiles.current = null;
    openCreateFlow({ flow: 'document', files });
  }, [authenticated]);

  useEffect(() => {
    const off = listenNative<{ files?: unknown }>(nativePlugin(NATIVE_PLUGINS.shareTarget), 'shareReceived', (e) => {
      if (!featureOn(featuresRef.current, 'share_in')) {
        toast.error('Le partage vers Verebona est momentanément indisponible. Ajoutez le document depuis l’application.');
        return;
      }
      const { accepted, refused } = triageSharedFiles(e?.files);
      for (const r of refused) toast.error(`${r.name} : ${r.reason}`);
      if (accepted.length === 0) return;
      void Promise.allSettled(accepted.map(readSharedFile)).then((res) => {
        const files: File[] = [];
        res.forEach((r, i) => {
          if (r.status === 'fulfilled') files.push(r.value);
          else toast.error(`${accepted[i].name} : fichier illisible.`);
        });
        if (files.length === 0) return;
        pendingFiles.current = files;
        // IMP-04 : conservés en mémoire ; si la connexion recharge l'app, ils sont perdus → consigne claire.
        if (!authenticated) toast.message('Connectez-vous pour ajouter ce document. S’il n’apparaît pas ensuite, partagez-le à nouveau vers Verebona.');
        livrerFichiers();
      });
    });
    return () => { void off.then((f) => f()); };
  }, [authenticated, livrerFichiers]);

  useEffect(() => {
    livrerFichiers();
    const onReady = () => livrerFichiers();
    window.addEventListener(CREATE_FLOW_HOST_READY, onReady);
    return () => window.removeEventListener(CREATE_FLOW_HOST_READY, onReady);
  }, [livrerFichiers, lockDue, pathname]);

  // ── Pages commerciales (lot 97B, COM-01/05, STORE-08) ───────────────────
  // Deuxième barrière (la première est le middleware) : aussi pour l'interface
  // embarquée et la navigation côté client. L'écran est masqué tout de suite,
  // puis remplacé par l'écran d'information (aucun lien d'achat).
  const commerce = isCommercePath(pathname);
  useEffect(() => {
    if (commerce) router.replace(NATIVE_COMMERCE_INFO_PATH);
  }, [commerce, router]);

  // ── Rendu ───────────────────────────────────────────────────────────────
  if (commerce) {
    return (
      <div role="alertdialog" aria-modal="true" aria-labelledby="vb-commerce-title" className="fixed inset-0 z-[1001] flex items-center justify-center bg-background p-6">
        <div className="w-full max-w-sm space-y-4 text-center">
          <h1 id="vb-commerce-title" className="vb-app-title">Abonnement</h1>
          <p className="text-sm text-muted-foreground">{NATIVE_COMMERCE_MESSAGE}</p>
        </div>
      </div>
    );
  }
  if (envMismatch) {
    return (
      <div role="alertdialog" aria-modal="true" aria-labelledby="vb-env-title" className="fixed inset-0 z-[1001] flex items-center justify-center bg-background p-6">
        <div className="w-full max-w-sm space-y-4 text-center">
          <ShieldAlert className="mx-auto h-10 w-10 text-[color:var(--accent)]" aria-hidden />
          <h1 id="vb-env-title" className="vb-app-title">Application inutilisable ici</h1>
          <p className="text-sm text-muted-foreground">
            Cette version de l’application n’est pas reliée au bon service Verebona. Installez la version officielle
            depuis la boutique d’applications ou le canal de test qui vous a été indiqué.
          </p>
        </div>
      </div>
    );
  }

  const locked = lockDue && status !== 'unauthenticated';
  return (
    <>
      {offline && !locked && (
        <div
          role="status"
          className="fixed inset-x-0 top-0 z-[999] flex items-center justify-center gap-2 bg-[color:var(--accent)] px-4 py-2 text-sm text-[color:var(--on-accent)]"
          style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}
        >
          <WifiOff className="h-4 w-4" aria-hidden /> Connexion Internet requise
        </div>
      )}

      {pushPrompt && !locked && (
        <div
          role="dialog"
          aria-labelledby="vb-push-title"
          className="fixed inset-x-3 z-[998] rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 shadow-lg"
          style={{ bottom: 'max(1rem, calc(env(safe-area-inset-bottom) + 4.5rem))' }}
        >
          <div className="flex items-start gap-3">
            <Bell className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--accent)]" aria-hidden />
            <div className="space-y-3">
              <p id="vb-push-title" className="text-sm font-medium">Recevoir vos rappels sur ce téléphone ?</p>
              <p className="text-xs text-muted-foreground">Échéances, documents à traiter, invitations Duo. Vous choisissez les sujets dans Mon compte › Notifications.</p>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => fermerInvitationPush(true)}>Activer</Button>
                <Button size="sm" variant="outline" onClick={() => fermerInvitationPush(false)}>Plus tard</Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {locked && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="vb-lock-title"
          className="fixed inset-0 z-[1000] flex items-center justify-center bg-background p-6"
          style={{ paddingTop: 'max(1.5rem, env(safe-area-inset-top))', paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}
        >
          <div className="w-full max-w-sm space-y-4 text-center">
            <Lock className="mx-auto h-10 w-10 text-[color:var(--accent)]" aria-hidden />
            <h1 id="vb-lock-title" className="vb-app-title">Verebona est verrouillé</h1>
            <p className="text-sm text-muted-foreground">Pour protéger vos documents, l’application se verrouille après 5 minutes sans utilisation.</p>
            <Button className="w-full" onClick={() => void deverrouiller()} disabled={unlocking || status === 'checking'}>
              Déverrouiller
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
