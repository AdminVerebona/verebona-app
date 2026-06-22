'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import {
  Gift,
  Copy,
  Send,
  Users,
  Sparkles,
  Loader2,
  CheckCheck,
} from 'lucide-react';
import { apiClient } from '@/lib/api-client';

// ─── Composant principal ─────────────────────────────────────────────────────

export function ReferralBlock() {
  const [data, setData] = useState<{
    eligible: boolean;
    link: { code: string; url: string; id: number } | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [creatingLink, setCreatingLink] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [email, setEmail] = useState('');
  const [sendingEmail, setSendingEmail] = useState(false);
  const [stats, setStats] = useState<{ validatedCount: number; creditsEarned: number } | null>(null);

  useEffect(() => {
    loadReferralData();
  }, []);

  const loadReferralData = async () => {
    try {
      setLoading(true);
      const result = await apiClient.get<any>('/api/referral/me');
      setData({
        eligible: result.eligible,
        link: result.link ? { code: result.link.code, url: result.link.url, id: result.link.id } : null,
      });
      if (result.stats) {
        setStats({
          validatedCount: result.stats.validatedCount || 0,
          creditsEarned: result.stats.creditsEarned || 0,
        });
      }
    } catch (err) {
      console.error('[ReferralBlock] load error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateLink = async () => {
    try {
      setCreatingLink(true);
      await apiClient.post('/api/referral/me', {});
      toast.success('Votre lien de parrainage a été créé !');
      await loadReferralData();
    } catch (err) {
      console.error('[ReferralBlock] create error:', err);
      toast.error('Impossible de créer votre lien de parrainage.');
    } finally {
      setCreatingLink(false);
    }
  };

  const handleCopyCode = async () => {
    if (!data?.link?.code) return;
    try {
      await navigator.clipboard.writeText(data.link.code);
      setCodeCopied(true);
      toast.success('Code copié');
      setTimeout(() => setCodeCopied(false), 2000);
    } catch {
      toast.error('Impossible de copier le code');
    }
  };

  const handleCopyLink = async () => {
    if (!data?.link?.url) return;
    try {
      await navigator.clipboard.writeText(data.link.url);
      setLinkCopied(true);
      toast.success('Lien copié');
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      toast.error('Impossible de copier le lien');
    }
  };

  const handleSendInvitation = async () => {
    if (!email.trim() || sendingEmail) return;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      toast.error('L\'adresse email n\'est pas valide.');
      return;
    }

    try {
      setSendingEmail(true);
      const result = await apiClient.post<{ success: boolean; message: string }>(
        '/api/account/referral/invitations',
        { email: email.trim() }
      );
      if (result.success) {
        toast.success('Invitation envoyée.');
        setEmail('');
      } else {
        toast.error(result.message || 'L\'invitation n\'a pas pu être envoyée. Réessayez.');
      }
    } catch {
      toast.error('L\'invitation n\'a pas pu être envoyée. Réessayez.');
    } finally {
      setSendingEmail(false);
    }
  };

  // ── Loading ──
  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  // ── État 1 : non éligible ──
  if (!data?.eligible) {
    return (
      <div className="border border-dashed border-[color:var(--border-subtle)] rounded-lg p-4 space-y-2">
        <h4 className="text-sm font-medium flex items-center gap-2">
          <Gift className="w-4 h-4 text-muted-foreground" />
          Parrainage
        </h4>
        <p className="text-xs text-muted-foreground">
          Disponible après votre première facturation sur les offres Premium ou Premium Duo.
        </p>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Users className="w-3.5 h-3.5 flex-shrink-0" />
          <span>Parrainez vos proches et gagnez <strong>10 analyses IA</strong> par parrainage validé.</span>
        </div>
      </div>
    );
  }

  // ── État 2 : éligible, pas encore de lien ──
  if (!data.link) {
    return (
      <div className="space-y-3">
        <h4 className="text-sm font-medium flex items-center gap-2">
          <Gift className="w-4 h-4 text-primary" />
          Parrainage
        </h4>
        <p className="text-xs text-muted-foreground">
          Parrainez vos proches et gagnez <strong>+10 analyses IA</strong> pour chaque filleul qui souscrit un abonnement.
          Votre filleul bénéficie de <strong>3 mois d'essai</strong> au lieu de 2.
        </p>
        <Button onClick={handleCreateLink} disabled={creatingLink} size="sm">
          {creatingLink ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Gift className="w-4 h-4 mr-2" />
          )}
          Créer mon lien de parrainage
        </Button>
      </div>
    );
  }

  // ── État 3 : lien créé — Wireframe CDC §6.4 ──
  return (
    <div className="space-y-4">
      {/* Titre + message récompense */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <h4 className="text-sm font-medium flex items-center gap-2">
            <Gift className="w-4 h-4 text-primary" />
            Parrainage
          </h4>
          <p className="text-xs text-muted-foreground mt-0.5">
            Invitez vos proches à découvrir Verebona.
          </p>
          <p className="text-xs text-muted-foreground">
            Votre récompense est déclenchée lorsque votre filleul devient client payant.
          </p>
        </div>
        {(stats?.validatedCount ?? 0) > 0 && (
          <Badge variant="secondary" className="flex-shrink-0 text-xs gap-1">
            <Sparkles className="w-3 h-3" />
            {stats!.creditsEarned} crédits
          </Badge>
        )}
      </div>

      {/* Stats */}
      {stats && stats.validatedCount > 0 && (
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border bg-muted/30 px-3 py-2 text-center">
            <div className="text-lg font-bold text-foreground">{stats.validatedCount}</div>
            <div className="text-xs text-muted-foreground">parrainage{stats.validatedCount > 1 ? 's' : ''} validé{stats.validatedCount > 1 ? 's' : ''}</div>
          </div>
          <div className="rounded-lg border bg-muted/30 px-3 py-2 text-center">
            <div className="text-lg font-bold text-primary">{stats.creditsEarned}</div>
            <div className="text-xs text-muted-foreground">analyses IA gagnées</div>
          </div>
        </div>
      )}

      {/* Votre code — CDC §6.4 */}
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-[color:var(--text-secondary)]">Votre code</p>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-sm font-mono font-semibold text-primary bg-muted/50 rounded-md px-3 py-2 select-all">
            {data.link.code}
          </code>
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopyCode}
            className="flex-shrink-0 gap-1.5"
          >
            {codeCopied ? (
              <CheckCheck className="w-3.5 h-3.5 text-green-600" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
            {codeCopied ? 'Copié' : 'Copier le code'}
          </Button>
        </div>
      </div>

      {/* Votre lien — CDC §6.4 */}
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-[color:var(--text-secondary)]">Votre lien</p>
        <div className="flex items-center gap-2">
          <Input
            readOnly
            value={data.link.url}
            className="font-mono text-xs bg-muted/50"
            onFocus={(e) => e.target.select()}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopyLink}
            className="flex-shrink-0 gap-1.5"
          >
            {linkCopied ? (
              <CheckCheck className="w-3.5 h-3.5 text-green-600" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
            {linkCopied ? 'Copié' : 'Copier le lien'}
          </Button>
        </div>
      </div>

      {/* Inviter par email — CDC §6.4 */}
      <div className="space-y-2 pt-1 border-t border-[color:var(--border-subtle)]">
        <p className="text-xs font-medium text-[color:var(--text-secondary)]">Inviter par email</p>
        <div className="flex gap-2">
          <Input
            type="email"
            placeholder="Adresse email du filleul"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={sendingEmail}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSendInvitation();
              }
            }}
          />
          <Button
            size="sm"
            onClick={handleSendInvitation}
            disabled={!email.trim() || sendingEmail}
            className="flex-shrink-0 gap-1.5"
          >
            {sendingEmail ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
            Envoyer l'invitation
          </Button>
        </div>
      </div>
    </div>
  );
}