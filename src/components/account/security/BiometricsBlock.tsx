'use client';

/**
 * Mon compte › Sécurité — réglage « Déverrouillage biométrique » (CDC 18
 * §27.3 ; CDC 12 AUTH-05, AUTH-06, ACC-06 ; lot 97B, revu au lot 107A).
 * Affiché UNIQUEMENT dans l'application iOS / Android.
 *
 *   · PAR APPAREIL ET PAR COMPTE (lot 107A, #640) : le choix d'un compte ne
 *     vaut jamais pour un autre compte du même téléphone ;
 *   · état RÉEL du téléphone, relu à l'ouverture et au retour dans l'app :
 *     jamais proposé / reporté / actif / indisponible / à réactiver ;
 *   · activer (ou réactiver) : une vérification Face ID / Touch ID /
 *     biométrie réussie est exigée (refus ou annulation : rien ne change) ;
 *     désactiver : immédiat ;
 *   · AUCUN appel serveur : le choix reste sur ce téléphone et sert seulement
 *     à déverrouiller l'app. Il ne remplace jamais la confirmation d'identité
 *     de 5 minutes demandée pour les réglages de sécurité ; ce n'est pas une
 *     double authentification ;
 *   · interrupteur serveur `biometrics` coupé : réglage indisponible ;
 *   · lot 113J : Face ID refusé à Verebona dans les réglages du téléphone →
 *     explication + bouton « Ouvrir les réglages » (jamais ouvert
 *     automatiquement) ; état relu au retour au premier plan (`appStateChange`
 *     de la coque, en plus de `visibilitychange`).
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useSession } from '@/hooks/useSession';
import { NATIVE_PLUGINS, listenNative, nativePlatform, nativePlugin } from '@/lib/native/bridge';
import { canOpenNativeAppSettings, openNativeAppSettings } from '@/lib/native/push';
import {
  BIOMETRIC_SHARED_DEVICE_NOTE, changeBiometrics, readBiometricSetting, type BiometricSetting,
} from '@/lib/native/biometric-consent';
import { nativeFeatureOn } from '@/lib/native/features';

function capital(s: string): string {
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
}

/** Texte d'état (pur, testé). */
export function biometricsStatusText(s: BiometricSetting, featureOn: boolean): string {
  if (!featureOn) return 'Le déverrouillage biométrique est momentanément indisponible. L’application reste protégée par le code du téléphone.';
  if (!s.supported) return 'Ce téléphone ne permet pas à Verebona d’utiliser la biométrie.';
  if (s.state === 'reactivate') {
    return `À réactiver : les visages ou empreintes enregistrés dans ce téléphone ont changé. Réactivez l’option pour utiliser de nouveau ${s.label}.`;
  }
  if (s.blockedBySettings) {
    // Lot 113J : même forme que l'aide de réactivation des notifications (lot 109G).
    return 'Face ID est bloqué pour Verebona sur ce téléphone. Pour l’utiliser : ouvrez Réglages › Verebona, puis activez « Face ID ».';
  }
  if (!s.available) {
    return s.stored === 'active'
      ? `${capital(s.label)} n’est plus disponible sur ce téléphone : le code du téléphone sera proposé pour déverrouiller Verebona. Réactivez ${s.label} dans les réglages du téléphone, ou désactivez cette option.`
      : 'Aucune biométrie n’est configurée sur ce téléphone. Ajoutez-en une dans les réglages du téléphone pour utiliser cette option.';
  }
  return s.state === 'active'
    ? `Activé : ${s.label} déverrouille Verebona sur ce téléphone.`
    : 'Désactivé : le code du téléphone est demandé pour déverrouiller Verebona.';
}

export function BiometricsBlock() {
  const { user } = useSession();
  const userId = user?.id ?? null;
  const [setting, setSetting] = useState<BiometricSetting | null>(null);
  const [busy, setBusy] = useState(false);
  const featureOn = nativeFeatureOn('biometrics');

  const reload = useCallback(async (): Promise<BiometricSetting> => {
    const next = await readBiometricSetting(nativePlatform(), userId, featureOn);
    setSetting(next);
    return next;
  }, [userId, featureOn]);

  useEffect(() => {
    void reload();
    // Retour dans l'app : l'utilisateur a pu modifier les réglages du téléphone.
    const onVisible = () => { if (document.visibilityState === 'visible') void reload(); };
    document.addEventListener('visibilitychange', onVisible);
    // Lot 113J : retour depuis Réglages › Verebona (événement de la coque, plus fiable dans la WebView iOS).
    const off = listenNative<{ isActive: boolean }>(nativePlugin(NATIVE_PLUGINS.app), 'appStateChange', (st) => {
      if (st.isActive) void reload();
    });
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      void off.then((f) => f());
    };
  }, [reload]);

  const ouvrirReglages = async () => {
    if (!(await openNativeAppSettings())) toast.error('Les réglages n’ont pas pu être ouverts. Ouvrez l’app Réglages du téléphone.');
  };

  const toggle = async (next: boolean) => {
    if (busy || !setting || userId === null) return;
    setBusy(true);
    let r: Awaited<ReturnType<typeof changeBiometrics>> | null = null;
    try {
      r = await changeBiometrics(next, userId);
      if (r === 'enabled') toast.success(`${capital(setting.label)} déverrouillera Verebona sur ce téléphone.`);
      // Désactivation : l'interrupteur relu montre l'état ; pas de toast de confirmation redondant (107B).
      else if (r === 'disabled') { /* état visible sur l'interrupteur */ }
      else if (r === 'refused') toast.message('Vérification non aboutie : rien n’a été modifié.');
      else if (r === 'storage_error') toast.error('Le réglage n’a pas pu être enregistré sur ce téléphone. Réessayez.');
    } finally {
      const now = await reload();
      // Lot 113J : Face ID refusé dans la demande du système → l'état relu l'explique (bouton vers les réglages).
      if (r === 'unavailable' && !now.blockedBySettings) toast.error('Aucune biométrie n’est utilisable sur ce téléphone pour le moment.');
      setBusy(false);
    }
  };

  if (!setting || userId === null) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" />Lecture des réglages du téléphone…</div>;
  }

  // Désactiver reste toujours possible ; activer / réactiver exige une biométrie utilisable.
  const checked = setting.state === 'active';
  const canToggle = featureOn && setting.supported && (setting.stored === 'active' || setting.available);
  return (
    <div className="space-y-2" data-testid="biometrics-block" data-state={setting.state}>
      <div className="flex items-start justify-between gap-3">
        <label htmlFor="biometrics-switch" className="min-w-0 text-sm">
          <span className="block font-medium text-[color:var(--text-primary)]">Déverrouillage biométrique</span>
          <span className="block text-[color:var(--text-muted)]" data-testid="biometrics-status">{biometricsStatusText(setting, featureOn)}</span>
        </label>
        <Switch
          id="biometrics-switch"
          checked={checked}
          disabled={!canToggle || busy}
          onCheckedChange={(v) => void toggle(v)}
          aria-label={`Déverrouillage biométrique avec ${setting.label}`}
        />
      </div>
      {setting.blockedBySettings && featureOn && canOpenNativeAppSettings() && (
        <Button size="sm" variant="outline" data-testid="biometrics-open-settings" onClick={() => { void ouvrirReglages(); }}>Ouvrir les réglages</Button>
      )}
      <p className="text-xs text-[color:var(--text-muted)]">
        Ce réglage ne concerne que ce téléphone et votre compte. {BIOMETRIC_SHARED_DEVICE_NOTE} Verebona ne reçoit jamais vos
        données biométriques, et la biométrie ne remplace pas la confirmation d’identité demandée pour les réglages de sécurité.
      </p>
    </div>
  );
}
