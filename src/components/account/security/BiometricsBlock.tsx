'use client';

/**
 * Mon compte › Sécurité — bloc « Biométrie » (CDC 18 §27.3 ; CDC 12 AUTH-05,
 * AUTH-06, ACC-06 ; lot 97B). Affiché UNIQUEMENT dans l'application iOS /
 * Android (détection `lib/native/bridge`).
 *
 *   · état RÉEL du téléphone, relu à l'ouverture et au retour dans l'app
 *     (biométrie configurée ou non, code du téléphone) ;
 *   · activer : une vérification Face ID / Touch ID / empreinte réussie est
 *     exigée (refus ou annulation : rien ne change) ; désactiver : immédiat ;
 *   · AUCUN appel serveur : le choix reste sur ce téléphone et sert seulement
 *     à déverrouiller l'app. Il ne remplace jamais la confirmation d'identité
 *     de 5 minutes demandée pour les réglages de sécurité ;
 *   · interrupteur serveur `biometrics` coupé : réglage indisponible.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { nativePlatform } from '@/lib/native/bridge';
import { changeBiometrics, readBiometricSetting, type BiometricSetting } from '@/lib/native/app-lock';
import { nativeFeatureOn } from '@/lib/native/features';

/** Texte d'état (pur, testé). */
export function biometricsStatusText(s: BiometricSetting, featureOn: boolean): string {
  if (!featureOn) return 'Le déverrouillage biométrique est momentanément indisponible. L’application reste protégée par le code du téléphone.';
  if (!s.supported) return 'Ce téléphone ne permet pas à Verebona d’utiliser la biométrie.';
  if (!s.available) {
    return s.enabled
      ? `La biométrie n’est plus configurée sur ce téléphone : le code du téléphone sera demandé pour déverrouiller Verebona. Réactivez ${s.label} dans les réglages du téléphone, ou désactivez cette option.`
      : 'Aucune biométrie n’est configurée sur ce téléphone. Ajoutez-en une dans les réglages du téléphone pour utiliser cette option.';
  }
  return s.enabled
    ? `Activée : ${s.label} déverrouille Verebona sur ce téléphone.`
    : `Désactivée : le code du téléphone est demandé pour déverrouiller Verebona.`;
}

export function BiometricsBlock() {
  const [setting, setSetting] = useState<BiometricSetting | null>(null);
  const [busy, setBusy] = useState(false);
  const featureOn = nativeFeatureOn('biometrics');

  const reload = useCallback(async () => {
    setSetting(await readBiometricSetting(nativePlatform()));
  }, []);

  useEffect(() => {
    void reload();
    // Retour dans l'app : l'utilisateur a pu modifier les réglages du téléphone.
    const onVisible = () => { if (document.visibilityState === 'visible') void reload(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [reload]);

  const toggle = async (next: boolean) => {
    if (busy || !setting) return;
    setBusy(true);
    try {
      const r = await changeBiometrics(next);
      if (r === 'enabled') toast.success(`${setting.label.charAt(0).toUpperCase()}${setting.label.slice(1)} déverrouillera Verebona sur ce téléphone.`);
      else if (r === 'disabled') toast.success('Déverrouillage biométrique désactivé sur ce téléphone.');
      else if (r === 'refused') toast.message('Vérification non aboutie : rien n’a été modifié.');
      else if (r === 'unavailable') toast.error('Aucune biométrie n’est utilisable sur ce téléphone pour le moment.');
      else toast.error('Le réglage n’a pas pu être enregistré sur ce téléphone. Réessayez.');
    } finally {
      await reload();
      setBusy(false);
    }
  };

  if (!setting) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" />Lecture des réglages du téléphone…</div>;
  }

  // Désactiver reste toujours possible ; activer exige une biométrie utilisable.
  const canToggle = featureOn && setting.supported && (setting.enabled || setting.available);
  const checked = setting.enabled && featureOn;
  return (
    <div className="space-y-2" data-testid="biometrics-block">
      <div className="flex items-start justify-between gap-3">
        <label htmlFor="biometrics-switch" className="min-w-0 text-sm">
          <span className="block font-medium text-[color:var(--text-primary)]">Déverrouiller avec {setting.label}</span>
          <span className="block text-[color:var(--text-muted)]" data-testid="biometrics-status">{biometricsStatusText(setting, featureOn)}</span>
        </label>
        <Switch
          id="biometrics-switch"
          checked={checked}
          disabled={!canToggle || busy}
          onCheckedChange={(v) => void toggle(v)}
          aria-label={`Déverrouiller avec ${setting.label}`}
        />
      </div>
      <p className="text-xs text-[color:var(--text-muted)]">
        Ce réglage ne concerne que ce téléphone. Verebona ne reçoit jamais vos données biométriques, et la biométrie ne remplace
        pas la confirmation d’identité demandée pour les réglages de sécurité.
      </p>
    </div>
  );
}
