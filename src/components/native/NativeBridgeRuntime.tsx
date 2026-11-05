'use client';

/**
 * Exécution des intégrations natives — lot 95 (Gate 0). Chargé UNIQUEMENT dans
 * l'application iOS / Android (voir `NativeBridgeHost`).
 *
 *   · identifiant d'installation (Keychain / Keystore) et en-têtes X-Verebona-* ;
 *   · contrôle d'environnement : un binaire de préproduction ne fonctionne
 *     qu'avec le serveur de préproduction, et inversement (§27, M7, REC-063/064) ;
 *   · « Connexion Internet indisponible » + « Réessayer » (NET-01/02, lot 108G) ;
 *   · verrouillage après 5 min en arrière-plan ; lot 107A : Face ID / Touch ID
 *     / biométrie Android lancé AUTOMATIQUEMENT si activé, écran de secours
 *     seulement en cas d'échec (`useNativeUnlock`), proposition unique
 *     d'activation après connexion (`useBiometricOffer`) (AUTH-05/06/09) ;
 *   · liens universels / App Links et retour Google / Apple (§19, M1) ;
 *   · notifications : enregistrement, demande contextualisée, ouverture de
 *     l'écran ciblé (PUSH-02/04/09) ; lot 109G : invitation « Autoriser les
 *     notifications ? » à la première connexion, par compte et installation,
 *     prioritaire sur la proposition biométrique (`usePushOnboarding`) ;
 *   · partage entrant → formulaire d'ajout habituel (IMP-02..04) ; lot 108G :
 *     reprise depuis la FILE TECHNIQUE locale (`lib/native/share-inbox`) après
 *     Face ID / connexion — plus de fichiers gardés en mémoire seulement ;
 *   · envoi natif de fond des documents (UPL-01/02) ;
 *   · lot 110A : partage natif à trois choix — l'import est lancé par
 *     l'interface native (aucune confirmation ici) ; jeton d'import remis au
 *     natif, état fidèle des imports (`useShareImport`). La file 108G
 *     ci-dessous ne sert plus qu'aux partages déposés par un binaire antérieur.
 * Les interrupteurs serveur (`MOBILE_FEATURES_OFF`, /api/mobile/config) sont
 * respectés : une fonction coupée n'est pas branchée (API-08).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { WifiOff, ShieldAlert, FileInput } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useSession } from '@/hooks/useSession';
import { APP_UPDATE_REQUIRED_EVENT, mobileClientHeaders } from '@/lib/mobile/native-shell';
import {
  CREATE_FLOW_HOST_READY, CREATE_FLOW_SETTLED, isCreateFlowHostReady, openCreateFlow, type CreateFlowSettled,
} from '@/lib/create-flows';
import { fileDepot, utiliserEnvoiNatif } from '@/lib/upload-queue';
import { onSessionTransition } from '@/lib/session/session-lifecycle';
import { NATIVE_PLUGINS, listenNative, nativePlugin } from '@/lib/native/bridge';
import { appBuildEnv, appUrlContext, expectedServerEnvironment, initInstallationId } from '@/lib/native/shell-info';
import { resolveAppUrl, pushTargetPath } from '@/lib/native/deep-links';
import { abandonNativeOAuth, completeNativeOAuth, nativeOAuthErrorMessage } from '@/lib/native/oauth';
import { syncNativePush, watchPushOpens, watchPushTokenRotation } from '@/lib/native/push';
import { readSharedFile } from '@/lib/native/share-in';
import {
  accountKey, claimInboxItem, claimedBy, loadInbox, nextToPresent, readClaims, recordAndroidShare, removeInboxItem,
  submittedToUploadQueue, visibleFor, type InboxItem,
} from '@/lib/native/share-inbox';
import { openExternalUrl } from '@/lib/native/open-external';
import { nativeUploadSender } from '@/lib/native/native-upload';
import { setNativeFeatures, setNativeOAuthReturn } from '@/lib/native/features';
import { NATIVE_COMMERCE_INFO_PATH, NATIVE_COMMERCE_MESSAGE, isCommercePath } from '@/lib/native/commerce';
import { useNativeUnlock } from './useNativeUnlock';
import { useBiometricOffer } from './useBiometricOffer';
import { usePushOnboarding } from './usePushOnboarding';
import { PushOnboardingCard } from './PushOnboardingCard';
import { NativeUnlockScreen } from './NativeUnlockScreen';
import { BiometricOfferCard } from './BiometricOfferCard';
import { useShareImport } from './useShareImport';
import { ShareImportStatusCard } from './ShareImportStatusCard';
import { SHARE_IMPORT_TRACKING_PATH, sessionAccountKey } from '@/lib/native/share-import';

type Features = Record<string, boolean>;

interface NetworkPlugin {
  getStatus(): Promise<{ connected: boolean }>;
  addListener?: (event: string, cb: (data: unknown) => void) => unknown;
}

/** Lot 108G : délai au-delà duquel une demande d'ouverture du formulaire est réputée refusée (quota, droits). */
const SHARE_OPEN_TIMEOUT_MS = 3000;

interface ShareInFlight { item: InboxItem; files: File[]; since: number; opened: boolean; consumed: boolean }

function featureOn(features: Features | null, name: string): boolean {
  // Configuration pas encore lue : fonction active (défaut serveur) ; une
  // coupure serveur s'applique dès la lecture.
  return features ? features[name] !== false : true;
}

export default function NativeBridgeRuntime() {
  const router = useRouter();
  const pathname = usePathname();
  const { status, user } = useSession();
  const authenticated = status === 'authenticated';
  const account = authenticated ? accountKey(user?.id) : null;

  const [features, setFeatures] = useState<Features | null>(null);
  const [envMismatch, setEnvMismatch] = useState(false);
  const [offline, setOffline] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // Lot 109G : écran bloquant « Mise à jour requise » (AppUpdateRequiredGate) — aucune invitation dessous.
  const [updateRequired, setUpdateRequired] = useState(false);

  // Lot 108G : file technique des partages (persistante), éléments déjà proposés pendant ce lancement.
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [shareTick, setShareTick] = useState(0);
  const presented = useRef<Set<string>>(new Set());
  const inFlight = useRef<ShareInFlight | null>(null);
  const loginHintShown = useRef(false);
  const shareOffHintShown = useRef(false);
  const lastAccount = useRef<string | null>(null);
  const featuresRef = useRef<Features | null>(null);

  // Lot 107A : verrou après 5 min en arrière-plan, déverrouillage automatique.
  const unlock = useNativeUnlock(featuresRef);
  const lockRef = useRef(false);
  lockRef.current = unlock.locked;

  // Navigation interne validée, différée tant que l'app est verrouillée (PUSH-04, AG-03).
  const ouvrir = unlock.open;

  // Lot 110A : partage natif (import direct, jeton d'import, état fidèle).
  const shareImport = useShareImport({
    account: authenticated ? sessionAccountKey(user?.id, user?.accountId) : null,
    enabled: featureOn(features, 'share_in'),
    open: ouvrir,
  });

  // ── Démarrage : installation, configuration, envoi natif ────────────────
  const lireConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/mobile/config', { headers: mobileClientHeaders(), cache: 'no-store' });
      if (!res.ok) return;
      const cfg = await res.json() as {
        environment?: string | null; platforms?: Record<string, { features?: Features }>; auth?: { appOAuthReturn?: unknown };
        client?: { updateRequired?: boolean };
      };
      setNativeOAuthReturn(cfg.auth?.appOAuthReturn);
      if (cfg.client?.updateRequired) setUpdateRequired(true);
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
  }, [lireConfig]);

  useEffect(() => {
    const onUpdate = () => setUpdateRequired(true);
    window.addEventListener(APP_UPDATE_REQUIRED_EVENT, onUpdate);
    return () => window.removeEventListener(APP_UPDATE_REQUIRED_EVENT, onUpdate);
  }, []);

  // Lot 108G : lecture de la file technique des partages (iOS : groupe d'apps ; Android : références locales).
  const rafraichirInbox = useCallback(async () => {
    const { items, expired } = await loadInbox();
    if (expired > 0) {
      toast.message(`${expired > 1 ? `${expired} documents partagés` : 'Un document partagé'} il y a plus de 7 jours sans être importé${expired > 1 ? 's ont été effacés' : ' a été effacé'} du téléphone. Partagez-le de nouveau si besoin.`);
    }
    setInbox(items);
  }, []);

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

  // « Réessayer » du bandeau : nouvelle mesure du réseau, sans recharger la page.
  const reessayerReseau = useCallback(async () => {
    setRetrying(true);
    try {
      const net = nativePlugin<NetworkPlugin>(NATIVE_PLUGINS.network);
      const s = net ? await net.getStatus() : { connected: typeof navigator === 'undefined' || navigator.onLine !== false };
      setOffline(!s.connected);
      if (s.connected) void lireConfig();
      else toast.message('Toujours pas de connexion. Le bandeau disparaîtra dès le retour du réseau.');
    } catch {
      /* mesure impossible : bandeau conservé */
    } finally {
      setRetrying(false);
    }
  }, [lireConfig]);

  // ── Cycle de vie : retour au premier plan (HOME-04) ─────────────────────
  // Le verrou (AUTH-09) est géré par `useNativeUnlock` ; ici, relecture de la
  // configuration seulement.
  useEffect(() => {
    const off = listenNative<{ isActive: boolean }>(nativePlugin(NATIVE_PLUGINS.app), 'appStateChange', (s) => {
      if (s.isActive) { void lireConfig(); void rafraichirInbox(); }
    });
    return () => { void off.then((f) => f()); };
  }, [lireConfig, rafraichirInbox]);

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
      // Lot 108G : lien de l'environnement exclu de l'app (offres, administration…) →
      // navigateur SYSTÈME, hors de l'app (brique 108H `lib/native/open-external` :
      // AppLauncher). Plus jamais le plugin Browser (SFSafariViewController /
      // Custom Tabs, intégrés à l'app).
      else if (r.kind === 'external') void openExternalUrl(r.url).then((o) => { if (!o.ok) toast.error('Ce lien n’a pas pu être ouvert dans le navigateur.'); });
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

  // Jeton synchronisé à chaque session (autorisation déjà accordée : aucune demande).
  // Lot 109G : aussi à chaque changement de compte (jeton rattaché à la bonne session).
  const sessionUserId = authenticated ? (user?.id ?? null) : null;
  useEffect(() => {
    if (sessionUserId === null || !featureOn(features, 'push')) return;
    void syncNativePush();
  }, [sessionUserId, features]);

  // ── Partage entrant (IMP-02..06, lot 108G) ─────────────────────────────
  // Un élément par partage, gardé dans la file technique locale jusqu'à
  // l'ajout confirmé ou l'abandon explicite ; proposé dans le formulaire
  // d'ajout habituel après connexion / déverrouillage ; isolé par compte.
  const relancerPartage = useCallback(() => setShareTick((n) => n + 1), []);

  const presenter = useCallback(async (item: InboxItem, acct: string) => {
    presented.current.add(item.id);
    claimInboxItem(item.id, acct);
    for (const r of item.refused) toast.error(`${r.name} : ${r.reason}`);
    for (const f of item.files) {
      if (f.convertedFrom) toast.message(`${f.name} : photo ${f.convertedFrom} convertie en JPEG (qualité maximale).`);
    }
    const res = await Promise.allSettled(item.files.map(readSharedFile));
    const files: File[] = [];
    res.forEach((r, i) => {
      if (r.status === 'fulfilled') files.push(r.value);
      else toast.error(`${item.files[i].name} : fichier plus disponible sur ce téléphone. Partagez-le de nouveau vers Verebona.`);
    });
    if (files.length === 0) {
      await removeInboxItem(item);
      void rafraichirInbox();
      return;
    }
    inFlight.current = { item, files, since: Date.now(), opened: false, consumed: false };
    openCreateFlow({ flow: 'document', files, requestId: item.id });
    // Formulaire non ouvert (fenêtre de refus : quota, essai terminé…) : l'élément
    // reste en attente, proposé dans le bandeau « Importer / Abandonner ».
    window.setTimeout(() => {
      if (inFlight.current?.item.id === item.id && !inFlight.current.opened) { inFlight.current = null; relancerPartage(); }
    }, SHARE_OPEN_TIMEOUT_MS);
  }, [rafraichirInbox, relancerPartage]);

  // Démarrage + retour de l'extension iOS (`inboxChanged` au premier plan).
  useEffect(() => {
    void rafraichirInbox();
    const off = listenNative(nativePlugin(NATIVE_PLUGINS.shareInbox), 'inboxChanged', () => { void rafraichirInbox(); });
    return () => { void off.then((f) => f()); };
  }, [rafraichirInbox]);

  // Android : intent SEND / SEND_MULTIPLE → élément persistant AVANT toute autre action.
  useEffect(() => {
    const off = listenNative<{ files?: unknown }>(nativePlugin(NATIVE_PLUGINS.shareTarget), 'shareReceived', (e) => {
      const r = recordAndroidShare(e?.files);
      if (!r.added) for (const x of r.refused) toast.error(`${x.name} : ${x.reason}`);
      void rafraichirInbox();
    });
    return () => { void off.then((f) => f()); };
  }, [rafraichirInbox]);

  // Proposition du prochain élément (session ouverte, app déverrouillée, hôte prêt).
  useEffect(() => {
    if (inFlight.current || inbox.length === 0) return;
    if (!featureOn(features, 'share_in')) {
      if (!shareOffHintShown.current) {
        shareOffHintShown.current = true;
        toast.message('Le partage vers Verebona est momentanément indisponible. Vos documents partagés restent en attente sur ce téléphone.');
      }
      return;
    }
    if (status === 'unauthenticated') {
      if (!loginHintShown.current) {
        loginHintShown.current = true;
        toast.message('Connectez-vous pour importer le document partagé : il reste en attente sur ce téléphone.');
      }
      return;
    }
    if (!account || lockRef.current || !isCreateFlowHostReady()) return;
    const next = nextToPresent(inbox, readClaims(), account, presented.current);
    if (next) void presenter(next, account);
  }, [inbox, status, account, features, unlock.locked, pathname, shareTick, presenter]);

  useEffect(() => {
    const onReady = () => relancerPartage();
    window.addEventListener(CREATE_FLOW_HOST_READY, onReady);
    return () => window.removeEventListener(CREATE_FLOW_HOST_READY, onReady);
  }, [relancerPartage]);

  // Issue du formulaire : ajout confirmé (ou fichiers remis à la file de dépôt) → copies effacées.
  useEffect(() => {
    const consommer = (c: ShareInFlight) => {
      if (c.consumed) return;
      c.consumed = true;
      void removeInboxItem(c.item).then(() => rafraichirInbox());
    };
    const onSettled = (e: Event) => {
      const d = (e as CustomEvent<CreateFlowSettled>).detail;
      const c = inFlight.current;
      if (!c || !d || d.requestId !== c.item.id) return;
      if (d.outcome === 'opened') { c.opened = true; return; }
      if (d.outcome === 'success' || submittedToUploadQueue(fileDepot.getSnapshot().elements, c.files, c.since)) consommer(c);
      inFlight.current = null;
      relancerPartage();
    };
    window.addEventListener(CREATE_FLOW_SETTLED, onSettled);
    const offDepot = fileDepot.subscribe(() => {
      const c = inFlight.current;
      if (c && submittedToUploadQueue(fileDepot.getSnapshot().elements, c.files, c.since)) consommer(c);
    });
    return () => { window.removeEventListener(CREATE_FLOW_SETTLED, onSettled); offDepot(); };
  }, [rafraichirInbox, relancerPartage]);

  // Déconnexion EXPLICITE : les partages pris par ce compte sont effacés du téléphone
  // (une session simplement expirée les conserve pour la reconnexion).
  useEffect(() => { if (account) lastAccount.current = account; }, [account]);
  useEffect(() => onSessionTransition((t) => {
    const acct = lastAccount.current;
    if (t.reason !== 'logout' || !acct) return;
    lastAccount.current = null;
    const ids = new Set(claimedBy(readClaims(), acct));
    presented.current.clear();
    loginHintShown.current = false;
    void Promise.all(inbox.filter((i) => ids.has(i.id)).map(removeInboxItem)).then(() => rafraichirInbox());
  }), [inbox, rafraichirInbox]);

  const abandonnerPartage = useCallback(async (item: InboxItem) => {
    await removeInboxItem(item);
    toast.message('Document partagé retiré du téléphone. Rien n’a été ajouté à votre compte.');
    void rafraichirInbox();
  }, [rafraichirInbox]);

  const partagesEnAttente = account && !inFlight.current
    ? visibleFor(inbox, readClaims(), account).filter((i) => presented.current.has(i.id))
    : [];

  // ── Pages commerciales (lot 97B, COM-01/05, STORE-08) ───────────────────
  // Deuxième barrière (la première est le middleware) : aussi pour l'interface
  // embarquée et la navigation côté client. L'écran est masqué tout de suite,
  // puis remplacé par l'écran d'information (aucun lien d'achat).
  const commerce = isCommercePath(pathname);
  useEffect(() => {
    if (commerce) router.replace(NATIVE_COMMERCE_INFO_PATH);
  }, [commerce, router]);

  // ── Proposition d'activation biométrique (lot 107A, #640) ───────────────
  const locked = unlock.locked && status !== 'unauthenticated';
  const blocked = locked || commerce || envMismatch || updateRequired;

  // ── Invitation notifications, prioritaire (lot 109G) ───────────────────
  // Une seule invitation à la fois : tant que la décision push du compte est
  // attendue ou que l'invitation est/a été présentée pendant ce lancement, la
  // proposition biométrique attend le lancement suivant.
  const [bioVisible, setBioVisible] = useState(false);
  const push = usePushOnboarding(featureOn(features, 'push'), blocked, offline, bioVisible);
  const offer = useBiometricOffer(features, blocked, push.holdBiometrics);
  useEffect(() => { setBioVisible(offer.visible); }, [offer.visible]);

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

  return (
    <>
      {offline && !locked && (
        <div
          role="status"
          className="fixed inset-x-0 top-0 z-[999] flex items-center justify-center gap-2 bg-[color:var(--accent)] px-4 py-2 text-sm text-[color:var(--on-accent)]"
          style={{ paddingTop: 'max(0.5rem, var(--vb-safe-top))' }}
        >
          <WifiOff className="h-4 w-4 shrink-0" aria-hidden />
          <span>Connexion Internet indisponible — rien n’est perdu, vos saisies restent à l’écran.</span>
          <button
            type="button"
            className="ml-1 shrink-0 rounded-md border border-current px-2 py-0.5 text-xs font-semibold disabled:opacity-60"
            disabled={retrying}
            onClick={() => { void reessayerReseau(); }}
          >
            Réessayer
          </button>
        </div>
      )}

      {partagesEnAttente.length > 0 && !locked && (
        <div
          role="status"
          aria-labelledby="vb-share-title"
          className="fixed inset-x-3 z-[997] rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 shadow-lg"
          style={{ bottom: 'max(1rem, calc(var(--vb-safe-bottom) + 4.5rem))' }}
        >
          <div className="flex items-start gap-3">
            <FileInput className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--accent)]" aria-hidden />
            <div className="min-w-0 space-y-3">
              <p id="vb-share-title" className="text-sm font-medium">
                {partagesEnAttente.length > 1 ? `${partagesEnAttente.length} partages en attente d’import` : 'Document partagé en attente d’import'}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {partagesEnAttente[0].files.map((f) => f.name).join(', ')}
              </p>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => { presented.current.delete(partagesEnAttente[0].id); relancerPartage(); }}>Importer</Button>
                <Button size="sm" variant="outline" onClick={() => { void abandonnerPartage(partagesEnAttente[0]); }}>Abandonner</Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Lot 110A : état des imports du partage natif (jamais de seconde confirmation). */}
      {!locked && partagesEnAttente.length === 0 && !pathname?.startsWith(SHARE_IMPORT_TRACKING_PATH) && (
        <ShareImportStatusCard items={shareImport.items} onOpen={ouvrir} onClose={(id) => { void shareImport.acknowledge(id); }} />
      )}

      {offer.visible && (
        <BiometricOfferCard type={offer.type} busy={offer.busy} onActivate={offer.activate} onLater={offer.later} />
      )}

      {/* Lot 109G : une seule invitation à la fois, notifications prioritaires
          (jamais superposée à la proposition biométrique). */}
      {push.visible && !offer.visible && (
        <PushOnboardingCard busy={push.busy} onAllow={push.allow} onLater={push.later} />
      )}

      {/* Lot 107A : plus d'écran statique de verrouillage dans le parcours normal — voile
          neutre pendant la vérification automatique, écran de secours sobre
          seulement après un échec, une annulation ou sans biométrie. */}
      <NativeUnlockScreen state={unlock.state} shortLabel={unlock.shortLabel} retryLabel={unlock.retryLabel} onAction={unlock.onAction} />
    </>
  );
}
