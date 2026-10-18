'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, UserPlus, Copy, RefreshCw, Trash2, Check, Clock, UserCheck, UserMinus } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';

type InvitationStatus = 'NONE' | 'PENDING' | 'EXPIRED' | 'ACTIVE_MEMBER';

/** Lot 57A : expédition et livraison de l'e-mail d'invitation (GET /api/duo/invitation). */
interface InvitationEmailState {
  state: 'queued' | 'accepted' | 'delivered' | 'delayed' | 'failed';
  acceptedAt: string | null;
  deliveredAt: string | null;
  nextAttemptAt: string | null;
  reason: string | null;
}

interface InvitationData {
  status: InvitationStatus;
  inviteEmail?: string;
  sentAt?: string | null;
  email?: InvitationEmailState | null;
  inviteLink?: string | null;
  memberEmail?: string | null;
  memberName?: string | null;
}

/** Ancre de « Mon compte » ouvrant le tiroir « Mon abonnement » (lot 54F). */
export const DUO_INVITATION_ANCHOR = 'duo-invitation';
/** Bloc « 2e utilisateur Duo » (identifiant distinct de l'ancre du tiroir). */
export const DUO_INVITATION_PANEL_ID = 'duo-invitation-panel';

interface SendResponse { success?: boolean; emailStatus?: 'accepted' | 'queued' | 'failed' }

/**
 * Lot 57A (P0-C) : l'invitation est toujours ENREGISTRÉE (lien copiable) ;
 * le message dit ce qu'il en est de l'e-mail — jamais « envoyée » après un
 * échec.
 */
function announce(res: SendResponse | undefined, okMessage: string) {
  const status = res?.emailStatus ?? 'accepted';
  if (status === 'accepted') toast.success(okMessage);
  else if (status === 'queued') {
    toast.warning('Invitation créée. L’e-mail n’a pas encore pu être expédié : une nouvelle tentative est programmée. Vous pouvez aussi copier le lien.');
  } else {
    toast.error('Invitation créée, mais l’e-mail n’a pas pu être expédié. Copiez le lien pour le transmettre vous-même, ou réessayez.');
  }
}

const dateFr = (iso: string) => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

/** Invitation créée / expédition acceptée / livraison connue / échec (lot 57A, E). */
function InvitationEmailLine({ email, sentAt }: { email: InvitationEmailState | null; sentAt: string | null }) {
  if (!email) {
    // Invitation antérieure au suivi : seule la date d'envoi connue est affichée.
    return sentAt ? <p className="text-xs text-[color:var(--text-muted)]">Envoyée le {dateFr(sentAt)}</p> : null;
  }
  const muted = 'text-xs text-[color:var(--text-muted)]';
  switch (email.state) {
    case 'queued':
      return <p className="text-xs text-[color:var(--attention-on-soft)]" data-testid="duo-invite-email-state">Invitation créée — e-mail pas encore expédié, nouvelle tentative automatique en cours.</p>;
    case 'accepted':
      return <p className={muted} data-testid="duo-invite-email-state">E-mail expédié le {dateFr(email.acceptedAt ?? sentAt ?? new Date().toISOString())} (livraison non encore confirmée).</p>;
    case 'delayed':
      return <p className="text-xs text-[color:var(--attention-on-soft)]" data-testid="duo-invite-email-state">E-mail expédié ; livraison retardée par la messagerie du destinataire.</p>;
    case 'delivered':
      return <p className={muted} data-testid="duo-invite-email-state">E-mail remis à la messagerie du destinataire le {dateFr(email.deliveredAt ?? email.acceptedAt ?? new Date().toISOString())}.</p>;
    default:
      return (
        <p className="text-xs text-destructive" data-testid="duo-invite-email-state">
          E-mail non remis{email.reason ? ` : ${email.reason}` : '.'} Copiez le lien pour le transmettre vous-même, ou renvoyez l’invitation.
        </p>
      );
  }
}

export function DuoInvitationPanel() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<InvitationData>({ status: 'NONE' });
  const [emailInput, setEmailInput] = useState('');
  const [sending, setSending] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showRemoveDialog, setShowRemoveDialog] = useState(false);
  const [removing, setRemoving] = useState(false);

  const fetchStatus = async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<InvitationData>('/api/duo/invitation');
      setData(res);
    } catch {
      // Duo account may not exist yet
      setData({ status: 'NONE' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  // Lot 49A (ticket 13) / 54F : arrivée depuis « Inviter quelqu'un » (mascotte,
  // `/mon-compte#duo-invitation`). Le tiroir « Mon abonnement » porte l'ancre
  // et s'est ouvert (CollapsibleCard anchorId) — ce panneau n'est monté
  // qu'ouvert. Une fois l'état lu : bloc « 2e utilisateur Duo » amené à
  // l'écran APRÈS le défilement de la carte (100 ms), puis focus sur le champ
  // e-mail s'il est affiché. Même composant sur ordinateur et mobile.
  useEffect(() => {
    if (loading || typeof window === 'undefined' || window.location.hash !== `#${DUO_INVITATION_ANCHOR}`) return;
    const t = window.setTimeout(() => {
      document.getElementById(DUO_INVITATION_PANEL_ID)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      document.getElementById('invite-email')?.focus({ preventScroll: true });
    }, 150);
    return () => window.clearTimeout(t);
  }, [loading, data.status]);

  const handleSend = async () => {
    if (!emailInput.trim()) return;
    setSending(true);
    try {
      const res = await apiClient.post<SendResponse>('/api/duo/invitation', { email: emailInput.trim() });
      announce(res, 'Invitation envoyée.');
      setEmailInput('');
      await fetchStatus();
    } catch (error: any) {
      if (error?.message?.includes('SLOT_ALREADY_TAKEN')) {
        toast.error('Un 2e utilisateur est déjà actif sur ce compte Duo.');
      } else {
        toast.error(error?.message || 'Une erreur est survenue.');
      }
    } finally {
      setSending(false);
    }
  };

  const handleResend = async () => {
    if (!data.inviteEmail) return;
    setSending(true);
    try {
      const res = await apiClient.post<SendResponse>('/api/duo/invitation', { email: data.inviteEmail, resend: true });
      announce(res, 'Invitation renvoyée.');
      await fetchStatus();
    } catch (error: any) {
      toast.error(error?.message || 'Une erreur est survenue.');
    } finally {
      setSending(false);
    }
  };

  const handleCopyLink = () => {
    if (!data.inviteLink) return;
    navigator.clipboard.writeText(data.inviteLink).then(() => {
      setCopied(true);
      toast.success('Lien copié dans le presse-papiers.');
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleCancel = async () => {
    setCancelling(true);
    try {
      await apiClient.delete('/api/duo/invitation');
      toast.success('Invitation annulée.');
      setShowCancelDialog(false);
      await fetchStatus();
    } catch (error: any) {
      toast.error(error?.message || 'Une erreur est survenue.');
    } finally {
      setCancelling(false);
    }
  };

  // Retrait du second utilisateur (AID-DUO-006, GAP-13) : son accès cesse,
  // aucun bien n'est supprimé, la place redevient libre pour une invitation.
  const handleRemove = async () => {
    setRemoving(true);
    try {
      await apiClient.delete('/api/duo/member');
      toast.success('Le second utilisateur a été retiré du Duo.');
      setShowRemoveDialog(false);
      await fetchStatus();
    } catch (error: any) {
      toast.error(error?.message || 'Une erreur est survenue.');
    } finally {
      setRemoving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-[color:var(--text-muted)]">
        <Loader2 className="w-4 h-4 animate-spin" />
        Chargement...
      </div>
    );
  }

  // Slot already active
  if (data.status === 'ACTIVE_MEMBER') {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-3 bg-[color:var(--bg-success)] border border-[color:var(--border-success)] rounded-lg px-4 py-3">
          <UserCheck className="w-4 h-4 text-[color:var(--text-success)] flex-shrink-0" />
          <div className="text-sm flex-1 min-w-0">
            <p className="text-[color:var(--text-success)] font-medium">2e utilisateur actif</p>
            {data.memberEmail && (
              <p className="text-[color:var(--text-muted)] text-xs mt-0.5">{data.memberEmail}</p>
            )}
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowRemoveDialog(true)}
            className="gap-1 text-destructive hover:text-destructive flex-shrink-0"
          >
            <UserMinus className="w-3.5 h-3.5" />
            Retirer
          </Button>
        </div>

        <AlertDialog open={showRemoveDialog} onOpenChange={setShowRemoveDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Retirer le second utilisateur ?</AlertDialogTitle>
              <AlertDialogDescription>
                {data.memberName || data.memberEmail || 'Cette personne'} n&apos;aura plus accès à votre espace
                partagé. Vos biens, documents et échéances ne sont pas supprimés. Ses demandes de déplacement ou de
                suppression en attente sont annulées. Vous pourrez inviter une personne à nouveau.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={removing}>Annuler</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => { e.preventDefault(); void handleRemove(); }}
                disabled={removing}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {removing ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
                Retirer
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  }

  // Pending or expired invitation
  if (data.status === 'PENDING' || data.status === 'EXPIRED') {
    return (
      <div className="space-y-3">
        <div className="border border-border rounded-lg p-4 space-y-2 bg-[color:var(--bg-card)]">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-[color:var(--text-muted)]" />
            <p className="text-sm font-medium text-[color:var(--text-primary)]">
              Invitation {data.status === 'EXPIRED' ? 'expirée' : 'en attente'}
            </p>
          </div>
          <p className="text-sm text-[color:var(--text-muted)]">{data.inviteEmail}</p>
          <InvitationEmailLine email={data.email ?? null} sentAt={data.sentAt ?? null} />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={handleResend}
            disabled={sending}
            className="gap-1"
          >
            {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Renvoyer
          </Button>

          {data.inviteLink && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleCopyLink}
              className="gap-1"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-[color:var(--text-success)]" /> : <Copy className="w-3.5 h-3.5" />}
              Copier le lien
            </Button>
          )}

          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowCancelDialog(true)}
            className="gap-1 text-destructive hover:text-destructive"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Annuler l'invitation
          </Button>
        </div>

        <AlertDialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Annuler l'invitation ?</AlertDialogTitle>
              <AlertDialogDescription>
                Le lien d'invitation sera invalidé. Vous pourrez en envoyer un nouveau à tout moment.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={cancelling}>Retour</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleCancel}
                disabled={cancelling}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {cancelling ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
                Annuler l'invitation
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  }

  // No invitation
  return (
    <div className="space-y-3">
      <p className="text-sm text-[color:var(--text-muted)]">
        Invitez une 2e personne à rejoindre votre espace Premium Duo.
      </p>
      <div className="flex gap-2">
        <div className="flex-1 space-y-1">
          <Label htmlFor="invite-email" className="text-xs text-[color:var(--text-muted)]">
            Email de la personne à inviter
          </Label>
          <Input
            id="invite-email"
            type="email"
            placeholder="prénom@exemple.fr"
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            disabled={sending}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSend(); }}
          />
        </div>
        <div className="flex items-end">
          <Button
            onClick={handleSend}
            disabled={sending || !emailInput.trim()}
            className="gap-1"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
            Inviter
          </Button>
        </div>
      </div>
    </div>
  );
}
