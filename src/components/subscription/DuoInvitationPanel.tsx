'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, UserPlus, Copy, RefreshCw, Trash2, Check, Clock, UserCheck } from 'lucide-react';
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

interface InvitationData {
  status: InvitationStatus;
  inviteEmail?: string;
  sentAt?: string | null;
  inviteLink?: string | null;
  memberEmail?: string | null;
  memberName?: string | null;
}

export function DuoInvitationPanel() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<InvitationData>({ status: 'NONE' });
  const [emailInput, setEmailInput] = useState('');
  const [sending, setSending] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [copied, setCopied] = useState(false);

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

  const handleSend = async () => {
    if (!emailInput.trim()) return;
    setSending(true);
    try {
      await apiClient.post('/api/duo/invitation', { email: emailInput.trim() });
      toast.success('Invitation envoyée.');
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
      await apiClient.post('/api/duo/invitation', { email: data.inviteEmail, resend: true });
      toast.success('Invitation renvoyée.');
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
      <div className="flex items-center gap-3 bg-green-950/30 border border-green-500/30 rounded-lg px-4 py-3">
        <UserCheck className="w-4 h-4 text-green-400 flex-shrink-0" />
        <div className="text-sm">
          <p className="text-green-300 font-medium">2e utilisateur actif</p>
          {data.memberEmail && (
            <p className="text-[color:var(--text-muted)] text-xs mt-0.5">{data.memberEmail}</p>
          )}
        </div>
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
          {data.sentAt && (
            <p className="text-xs text-[color:var(--text-muted)]">
              Envoyée le {new Date(data.sentAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}
            </p>
          )}
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
              {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
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
