'use client';

/**
 * Mon compte › Notifications — « Ce téléphone » (lot 109G). Uniquement dans
 * l'application iOS / Android (rien sur le Web : aucun Web Push).
 *
 * Distinct des préférences par catégorie : ici, l'AUTORISATION du téléphone
 * et l'enregistrement de cet appareil.
 *   · autorisation indéterminée → « Autoriser les notifications » (demande système) ;
 *   · refusée → explication iOS / Android ; iOS : « Ouvrir les réglages »
 *     (AppLauncher `app-settings:`) ; Android : chemin dans les Paramètres ;
 *   · accordée → jeton synchronisé ; échec d'enregistrement → « Réessayer ».
 * L'état est relu au retour dans l'app (l'utilisateur a pu changer les réglages).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { BellRing, BellOff, Smartphone } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { NATIVE_PLUGINS, isNativeApp, listenNative, nativePlatform, nativePlugin } from '@/lib/native/bridge';
import { nativeFeatureOn } from '@/lib/native/features';
import {
  canOpenNativeNotificationSettings, nativePushPermission, openNativeNotificationSettings, requestNativePush, syncNativePush,
} from '@/lib/native/push';
import {
  PUSH_ONBOARDING_ALLOW, devicePushStatusText, pushRequestOutcomeMessage, type DevicePushStatus,
} from '@/lib/native/push-onboarding';

export function NativePushDeviceSettings({ onChanged }: { onChanged?: () => void }) {
  // Lu après le montage (rendu serveur identique au Web : pas d'écart d'hydratation).
  const [native, setNative] = useState(false);
  useEffect(() => { setNative(isNativeApp()); }, []);
  const [status, setStatus] = useState<DevicePushStatus>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const platform = native ? nativePlatform() : null;

  const relire = useCallback(async () => {
    if (!nativeFeatureOn('push')) { setStatus({ kind: 'off' }); return; }
    const p = await nativePushPermission();
    if (p === 'granted') setStatus({ kind: 'granted', registered: await syncNativePush() });
    else setStatus({ kind: p });
  }, []);

  useEffect(() => {
    if (!native) return;
    void relire();
    const off = listenNative<{ isActive: boolean }>(nativePlugin(NATIVE_PLUGINS.app), 'appStateChange', (s) => {
      if (s.isActive) void relire().then(() => onChanged?.());
    });
    return () => { void off.then((f) => f()); };
  }, [native, relire, onChanged]);

  const autoriser = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const r = await requestNativePush();
      const m = pushRequestOutcomeMessage(r, platform);
      if (m.kind === 'success') toast.success(m.text);
      else if (m.kind === 'error' && r.state !== 'granted') toast.error(m.text);
      setStatus(r.state === 'granted' ? { kind: 'granted', registered: r.registered } : { kind: r.state });
      onChanged?.();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const reessayer = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const ok = await syncNativePush();
      setStatus({ kind: 'granted', registered: ok });
      if (ok) { toast.success('Notifications activées sur ce téléphone.'); onChanged?.(); }
      else toast.error('Ce téléphone n’a pas pu être enregistré. Vérifiez la connexion puis réessayez.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const ouvrirReglages = async () => {
    if (!(await openNativeNotificationSettings())) toast.error('Les réglages n’ont pas pu être ouverts. Ouvrez l’app Réglages du téléphone.');
  };

  if (!native) return null;
  const ok = status.kind === 'granted' && status.registered;
  const Icon = ok ? BellRing : status.kind === 'denied' ? BellOff : Smartphone;
  return (
    <div data-testid="native-push-device" className="space-y-2 rounded-md border border-border/60 p-3">
      <p className="text-sm font-medium">Ce téléphone</p>
      <p className="flex items-start gap-2 text-sm" aria-live="polite">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span>{devicePushStatusText(status, platform)}</span>
      </p>
      {status.kind === 'prompt' && (
        <Button size="sm" onClick={() => { void autoriser(); }} disabled={busy}>{PUSH_ONBOARDING_ALLOW}</Button>
      )}
      {status.kind === 'granted' && !status.registered && (
        <Button size="sm" variant="outline" onClick={() => { void reessayer(); }} disabled={busy}>Réessayer</Button>
      )}
      {status.kind === 'denied' && canOpenNativeNotificationSettings() && (
        <Button size="sm" variant="outline" onClick={() => { void ouvrirReglages(); }}>Ouvrir les réglages</Button>
      )}
      <p className="text-xs text-muted-foreground">
        Cette autorisation concerne uniquement ce téléphone. Les sujets reçus se règlent ci-dessous, dans Mes préférences.
      </p>
    </div>
  );
}
