'use client';

/**
 * Mon compte › Sécurité — double authentification (lot 110B, ticket §7) :
 * « Clés d'accès » (liste, ajouter, nommer, supprimer), « Application
 * d'authentification » (activer, remplacer, retirer), « Codes de
 * récupération » (nombre restant, régénérer). Chaque modification passe par
 * la confirmation d'identité (`useReauth`, forte dès que la double
 * authentification est obligatoire). Jamais la dernière méthode retirée.
 * Aucune réinitialisation possible par l'assistance : dit à l'écran.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { KeyRound, Loader2, Pencil, RefreshCw, ShieldCheck, Smartphone, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { apiClient, ApiClientError } from '@/lib/api-client';
import { createPasskey, passkeysUsableHere, PASSKEY_ERROR_TEXT } from '@/lib/auth/mfa/client';
import { RecoveryCodesView } from '@/components/auth/mfa/RecoveryCodesView';
import { TotpSetup, type TotpStart } from '@/components/auth/mfa/TotpSetup';
import { useReauth } from './ReauthProvider';

interface MfaSummary {
  required: boolean;
  enrolled: boolean;
  enforcedFrom: string | null;
  passkeysAvailable: boolean;
  passkeys: Array<{ id: number; name: string; createdAt: string; lastUsedAt: string | null; synced: boolean }>;
  totp: { active: boolean; confirmedAt: string | null };
  recoveryCodes: { remaining: number; total: number; confirmed: boolean };
}

const PARIS = 'Europe/Paris';
const dateFr = (iso: string | null) => (iso ? new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, dateStyle: 'medium' }).format(new Date(iso)) : '—');
const msg = (e: unknown, fallback: string) => (e instanceof ApiClientError && e.serverMessage ? e.serverMessage : fallback);

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between py-2 border-b border-[color:var(--border-subtle)] last:border-b-0">{children}</div>;
}

export function MfaBlock() {
  const { ensureFresh, withReauth } = useReauth();
  const [data, setData] = useState<MfaSummary | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [totpOpen, setTotpOpen] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const [webauthnHere, setWebauthnHere] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await apiClient.get<MfaSummary>('/api/users/me/security/mfa', { cache: 'no-store' }));
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);
  useEffect(() => { void load(); void passkeysUsableHere().then(setWebauthnHere); }, [load]);

  const addPasskey = async () => {
    if (!(await ensureFresh('Avant d’ajouter une clé d’accès.'))) return;
    setBusy('passkey-add');
    try {
      const o = await withReauth(() => apiClient.post<{ options: unknown; challengeId: string }>('/api/users/me/security/mfa/passkeys', { stage: 'options' }));
      const c = await createPasskey(o.options);
      if (!c.ok) { toast.error(PASSKEY_ERROR_TEXT[c.error]); return; }
      const v = await withReauth(() => apiClient.post<{ recoveryCodes?: string[] | null }>('/api/users/me/security/mfa/passkeys', { stage: 'verify', challengeId: o.challengeId, response: c.response }));
      toast.success('Clé d’accès ajoutée.');
      if (v.recoveryCodes?.length) setCodes(v.recoveryCodes);
      await load();
    } catch (e) {
      toast.error(msg(e, 'La clé d’accès n’a pas pu être ajoutée.'));
    } finally {
      setBusy(null);
    }
  };

  const removePasskey = async (id: number) => {
    setBusy(`pk-${id}`);
    try {
      await withReauth(() => apiClient.delete(`/api/users/me/security/mfa/passkeys/${id}`), 'Avant de supprimer une clé d’accès.');
      toast.success('Clé d’accès supprimée.');
      await load();
    } catch (e) {
      toast.error(msg(e, 'La clé d’accès n’a pas pu être supprimée.'));
    } finally {
      setBusy(null);
    }
  };

  const saveName = async () => {
    if (!renaming) return;
    setBusy(`pk-${renaming.id}`);
    try {
      await apiClient.patch(`/api/users/me/security/mfa/passkeys/${renaming.id}`, { name: renaming.name });
      setRenaming(null);
      await load();
    } catch (e) {
      toast.error(msg(e, 'Le nom n’a pas pu être modifié.'));
    } finally {
      setBusy(null);
    }
  };

  const openTotp = async () => {
    if (await ensureFresh(data?.totp.active ? 'Avant de remplacer votre application d’authentification.' : 'Avant d’activer une application d’authentification.')) setTotpOpen(true);
  };
  const startTotp = useCallback(async (): Promise<TotpStart> => {
    return withReauth(() => apiClient.post<TotpStart>('/api/users/me/security/mfa/totp', { stage: 'start' }));
  }, [withReauth]);
  const confirmTotp = async (code: string): Promise<string | null> => {
    try {
      const r = await withReauth(() => apiClient.post<{ recoveryCodes?: string[] | null; replaced?: boolean }>('/api/users/me/security/mfa/totp', { stage: 'confirm', code }));
      setTotpOpen(false);
      toast.success(r.replaced ? 'Application d’authentification remplacée.' : 'Application d’authentification activée.');
      if (r.recoveryCodes?.length) setCodes(r.recoveryCodes);
      await load();
      return null;
    } catch (e) {
      return msg(e, 'Code incorrect ou expiré.');
    }
  };
  const removeTotp = async () => {
    setBusy('totp-remove');
    try {
      await withReauth(() => apiClient.delete('/api/users/me/security/mfa/totp'), 'Avant de retirer votre application d’authentification.');
      toast.success('Application d’authentification retirée.');
      await load();
    } catch (e) {
      toast.error(msg(e, 'L’application d’authentification n’a pas pu être retirée.'));
    } finally {
      setBusy(null);
    }
  };

  const regenerate = async () => {
    setBusy('codes');
    try {
      const r = await withReauth(() => apiClient.post<{ recoveryCodes: string[] }>('/api/users/me/security/mfa/recovery-codes', {}), 'Avant de créer de nouveaux codes de récupération.');
      setCodes(r.recoveryCodes);
    } catch (e) {
      toast.error(msg(e, 'Les codes n’ont pas pu être créés.'));
    } finally {
      setBusy(null);
    }
  };

  const confirmCodes = async () => {
    await apiClient.post('/api/users/me/security/mfa/recovery-codes/confirm', {}).catch(() => null);
    setCodes(null);
    await load();
  };

  if (loadError) return <p className="text-sm text-[color:var(--text-muted)]">Réglages de sécurité indisponibles pour le moment.</p>;
  if (!data) return <div className="flex justify-center py-3"><Loader2 className="w-5 h-5 animate-spin text-[color:var(--text-muted)]" /></div>;

  const strongCount = data.passkeys.length + (data.totp.active ? 1 : 0);
  const canAddPasskey = data.passkeysAvailable && webauthnHere;

  return (
    <div className="space-y-4" data-testid="security-mfa">
      {!data.enrolled && (
        <p className="text-sm text-[color:var(--text-muted)]">
          Protégez vos connexions avec une clé d’accès ou une application d’authentification.
          {data.enforcedFrom ? ` Elle sera obligatoire à partir du ${dateFr(data.enforcedFrom)}.` : ''}
        </p>
      )}

      <div className="space-y-1">
        <h4 className="flex items-center gap-2 text-sm font-medium"><KeyRound className="w-4 h-4" />Clés d’accès</h4>
        {data.passkeys.length === 0 && <p className="text-sm text-[color:var(--text-muted)]">Aucune clé d’accès.</p>}
        {data.passkeys.map((p) => (
          <Row key={p.id}>
            <div className="min-w-0">
              {renaming?.id === p.id ? (
                <div className="flex gap-2">
                  <Input value={renaming.name} maxLength={60} onChange={(e) => setRenaming({ id: p.id, name: e.target.value })} aria-label="Nom de la clé d’accès" />
                  <Button size="sm" onClick={() => void saveName()} disabled={busy !== null}>Enregistrer</Button>
                </div>
              ) : (
                <p className="text-sm font-medium truncate">{p.name}</p>
              )}
              <p className="text-xs text-[color:var(--text-muted)]">
                Ajoutée le {dateFr(p.createdAt)} · {p.lastUsedAt ? `utilisée le ${dateFr(p.lastUsedAt)}` : 'jamais utilisée'}{p.synced ? ' · synchronisée' : ''}
              </p>
            </div>
            <div className="flex gap-2 shrink-0">
              <Button size="sm" variant="ghost" onClick={() => setRenaming({ id: p.id, name: p.name })} disabled={busy !== null} aria-label={`Renommer ${p.name}`}><Pencil className="w-4 h-4" /></Button>
              <Button size="sm" variant="ghost" onClick={() => void removePasskey(p.id)} disabled={busy !== null || strongCount <= 1}
                title={strongCount <= 1 ? 'Ajoutez une autre méthode avant de retirer la dernière.' : undefined} aria-label={`Supprimer ${p.name}`}>
                {busy === `pk-${p.id}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              </Button>
            </div>
          </Row>
        ))}
        {canAddPasskey
          ? <Button size="sm" variant="outline" onClick={() => void addPasskey()} disabled={busy !== null}>{busy === 'passkey-add' && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Ajouter une clé d’accès</Button>
          : <p className="text-xs text-[color:var(--text-muted)]">Ajout de clé d’accès non disponible sur cet appareil.</p>}
      </div>

      <div className="space-y-1">
        <h4 className="flex items-center gap-2 text-sm font-medium"><Smartphone className="w-4 h-4" />Application d’authentification</h4>
        <Row>
          <p className="text-sm">{data.totp.active ? `Activée le ${dateFr(data.totp.confirmedAt)}` : 'Non configurée'}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void openTotp()} disabled={busy !== null}>{data.totp.active ? 'Remplacer' : 'Activer'}</Button>
            {data.totp.active && (
              <Button size="sm" variant="ghost" onClick={() => void removeTotp()} disabled={busy !== null || strongCount <= 1}
                title={strongCount <= 1 ? 'Ajoutez une autre méthode avant de retirer la dernière.' : undefined}>Retirer</Button>
            )}
          </div>
        </Row>
      </div>

      {data.enrolled && (
        <div className="space-y-1">
          <h4 className="flex items-center gap-2 text-sm font-medium"><ShieldCheck className="w-4 h-4" />Codes de récupération</h4>
          <Row>
            <p className="text-sm">{data.recoveryCodes.remaining} code{data.recoveryCodes.remaining > 1 ? 's' : ''} restant{data.recoveryCodes.remaining > 1 ? 's' : ''} sur {data.recoveryCodes.total || 10}</p>
            <Button size="sm" variant="outline" onClick={() => void regenerate()} disabled={busy !== null}>
              {busy === 'codes' ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1" />}Créer de nouveaux codes
            </Button>
          </Row>
          {(data.recoveryCodes.remaining <= 3 || !data.recoveryCodes.confirmed) && (
            <p className="text-xs text-[color:var(--text-warning-soft)]">Créez de nouveaux codes et conservez-les en lieu sûr : ils sont votre seul recours si vous perdez vos méthodes de sécurité.</p>
          )}
          <p className="text-xs text-[color:var(--text-muted)]">L’assistance Verebona ne peut pas réinitialiser votre double authentification.</p>
        </div>
      )}

      <Dialog open={totpOpen} onOpenChange={setTotpOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{data.totp.active ? 'Remplacer l’application d’authentification' : 'Activer une application d’authentification'}</DialogTitle>
            <DialogDescription>{data.totp.active ? 'L’ancienne application ne fonctionnera plus dès que la nouvelle sera activée.' : 'Un code à 6 chiffres complétera vos connexions par mot de passe.'}</DialogDescription>
          </DialogHeader>
          {totpOpen && <TotpSetup start={startTotp} confirm={confirmTotp} onCancel={() => setTotpOpen(false)} />}
        </DialogContent>
      </Dialog>

      <Dialog open={codes !== null} onOpenChange={() => { /* fermeture par la confirmation seulement */ }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Vos codes de récupération</DialogTitle>
            <DialogDescription>Ils ne seront plus affichés. Les anciens codes ne fonctionnent plus.</DialogDescription>
          </DialogHeader>
          {codes && <RecoveryCodesView codes={codes} onConfirm={confirmCodes} confirmLabel="J’ai conservé mes codes" />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
