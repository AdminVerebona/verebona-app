"use client"

import { useState, useEffect, useRef, useCallback } from 'react';
import { Bell, X, CheckCheck, Info, ArrowRightLeft, Trash2, UserPlus, Cpu, SendHorizonal, AlertTriangle, CreditCard, Loader2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';
import { createPortal } from 'react-dom';
import { apiClient } from '@/lib/api-client';
import { drawerHref, openDrawer } from '@/lib/drawers';
import { lotNotificationText } from '@/services/ai/source-analysis/lot-notification-text';
import { toast } from 'sonner';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  isSubscriptionNotification,
  subscriptionNotificationText,
  type SubscriptionNotificationPayload,
} from '@/lib/notifications/subscription-messages';

/**
 * Types retirés de l'affichage : les notifications « Analyse impossible ».
 *
 * Elles ne sont plus émises, mais des lignes existent déjà en base. Les
 * masquer ici évite qu'elles réapparaissent dans la cloche ou en bandeau.
 */
const TYPES_MASQUES = new Set([
  'DOCUMENT_BATCH_FAILED',
  'DOCUMENT_BATCH_PARTIALLY_FAILED',
  'ANALYSIS_FAILED_PERSISTENT',
]);

interface NotificationPayload extends SubscriptionNotificationPayload {
  initiatorName?: string;
  assetLabel?: string;
  inviterName?: string;
  accountName?: string;
  analysedCount?: number;
  failedCount?: number;
  errorReason?: string;
  documentTitle?: string;
  /** Fin de lot : documents analysés, nommés (lot-notification-text). */
  documents?: Array<{ assetFileId: number; title: string }>;
  inviteToken?: string;
  lotId?: number;
  assetFileId?: number;
  // Rétractation et remboursement (CDC 6). Ces champs étaient émis mais
  // absents du contrat : aucun libellé ne pouvait les exploiter.
  amount?: number;
  status?: string;
  refundId?: string;
  scheduledAt?: string;
  // Duo
  duoId?: number;
  requestId?: number;
  // Transmission
  senderName?: string;
  assetName?: string;
  transmissionToken?: string;
  recipientName?: string;
  // Quota / parrainage
  threshold?: number;
  cta?: string;
  referralEventId?: number;
}

interface Notification {
  id: number;
  type: string;
  payload: NotificationPayload | null;
  createdAt: string;
  readAt: string | null;
  mustDeliver?: boolean;
  /** Contenu rendu par le serveur à l'émission (catalogue). */
  title?: string | null;
  body?: string | null;
}

interface NotificationsResponse {
  notifications: Notification[];
  unreadCount: number;
}

function getNotificationText(
  type: string,
  payload: NotificationPayload | null,
  stored?: { title?: string | null; body?: string | null },
): string {
  const p = payload ?? {};
  // Abonnement : « Votre offre a été modifiée. Nouvelle offre : Premium »…
  // Recalculé depuis le payload, donc juste aussi pour les lignes anciennes.
  const abonnement = subscriptionNotificationText(type, payload);
  if (abonnement) return abonnement;
  switch (type) {
    case 'DUO_MOVE_REQUEST':
      return `${p.initiatorName ?? 'Quelqu\'un'} souhaite transférer ${p.assetLabel ?? 'un bien'} vers son compte`;
    case 'DUO_DELETE_REQUEST':
      return `${p.initiatorName ?? 'Quelqu\'un'} souhaite supprimer ${p.assetLabel ?? 'un bien'}`;
    case 'DUO_MOVE_ACCEPTED':
      return `Votre demande de transfert de ${p.assetLabel ?? 'votre bien'} a été acceptée`;
    case 'DUO_MOVE_REFUSED':
      return `Votre demande de transfert de ${p.assetLabel ?? 'votre bien'} a été refusée`;
    case 'DUO_DELETE_ACCEPTED':
      return `Votre demande de suppression de ${p.assetLabel ?? 'votre bien'} a été acceptée`;
    case 'DUO_DELETE_REFUSED':
      return `Votre demande de suppression de ${p.assetLabel ?? 'votre bien'} a été refusée`;
    case 'DUO_INVITATION_RECEIVED':
      return `${p.initiatorName ?? 'Quelqu\'un'} vous invite à rejoindre son compte Duo`;
    case 'ACCOUNT_INVITATION':
      return `${p.inviterName ?? 'Quelqu\'un'} vous a invité(e) à rejoindre ${p.accountName ?? 'un compte'}`;
    // ── Documents : une notification par lot (cf. CDC §7.2) ──────────────────
    case 'DOCUMENT_BATCH_COMPLETED':
      return lotNotificationText(p);
    case 'DOCUMENT_BATCH_PARTIALLY_FAILED':
      return `Analyse terminée avec une anomalie : ${p.analysedCount ?? 0} document(s) analysé(s), ${p.failedCount ?? 0} à vérifier`;
    case 'DOCUMENT_BATCH_FAILED':
      return `Analyse impossible — notre équipe en est informée`;
    // DOCUMENT_ANALYZED : conservé pour les lignes historiques (cf. CDC §22.1).
    case 'DOCUMENT_ANALYZED':
      if (p.failedCount && !p.analysedCount) {
        return `Analyse échouée${p.documentTitle ? ` : ${p.documentTitle}` : ''}`;
      }
      return p.documentTitle
        ? lotNotificationText({ analysedCount: 1, documentTitle: p.documentTitle })
        : `Analyse terminée : ${p.analysedCount ?? 0} document(s) traité(s)${p.failedCount ? `, ${p.failedCount} échoué(s)` : ''}`;
    case 'ANALYSIS_QUOTA_90':
      return `Vous avez utilisé 90 % de votre quota d'analyses ce mois-ci`;
    case 'ANALYSIS_QUOTA_100':
      return `Vous avez atteint votre quota d'analyses ce mois-ci`;
    case 'REFERRAL_REWARD_GRANTED':
      return `Votre récompense de parrainage a été créditée`;
    case 'ANALYSIS_FAILED_PERSISTENT': {
      const title = p.documentTitle ? ` : ${p.documentTitle}` : '';
      const reason = p.errorReason ? ` (${p.errorReason})` : '';
      return `Analyse impossible${title}${reason} — notre équipe en est informée`;
    }
    case 'TRANSMISSION_RECEIVED':
      return `${p.senderName ?? 'Quelqu\'un'} vous a transmis le bien "${p.assetName ?? 'un bien'}"`;
    case 'TRANSMISSION_ACCEPTED':
      return `${p.recipientName ?? 'Le destinataire'} a accepté la transmission de "${p.assetName ?? 'votre bien'}"`;
    case 'TRANSMISSION_REFUSED':
      return `${p.recipientName ?? 'Le destinataire'} a refusé la transmission de "${p.assetName ?? 'votre bien'}"`;
    // ══════════════════════════════════════════════════════════════════
    // RÉTRACTATION ET REMBOURSEMENT — CDC 6
    //
    // Ces neuf types étaient émis sans libellé et tombaient tous sur
    // « Nouvelle notification ». L'utilisateur voyait une pastille, ouvrait,
    // et n'apprenait rien.
    //
    // Ce sont pourtant les plus sensibles : une demande de rétractation, un
    // remboursement, une suppression de compte programmée. Les laisser muets
    // obligeait à chercher ailleurs ce qui venait de se produire.
    // ══════════════════════════════════════════════════════════════════
    case 'DECLARATION_RECEIVED':
      return 'Votre demande de rétractation a bien été reçue';
    case 'RECEIPT_SENT':
      return 'Accusé de réception de votre rétractation envoyé';
    case 'REFUND_REQUESTED':
      return p.amount
        ? `Remboursement de ${formatMontant(p.amount)} demandé`
        : 'Votre remboursement a été demandé';
    case 'REFUND_STATUS_CHANGED': {
      // Le statut brut du fournisseur ne veut rien dire pour l'utilisateur.
      const etats: Record<string, string> = {
        succeeded: 'effectué',
        pending: 'en cours de traitement',
        failed: 'refusé par votre banque',
        canceled: 'annulé',
      };
      const etat = p.status ? etats[String(p.status)] : undefined;
      return etat
        ? `Remboursement ${etat}${p.amount ? ` — ${formatMontant(p.amount)}` : ''}`
        : 'Le statut de votre remboursement a changé';
    }
    case 'PAYMENTS_IDENTIFIED':
      return 'Vos paiements ont été identifiés pour le remboursement';
    case 'SUBSCRIPTION_CANCELLED':
      return 'Votre abonnement a été résilié';
    case 'SUBSCRIPTION_CANCEL_FAILED':
      // Ne pas dramatiser : l'utilisateur n'a rien à faire, l'équipe agit.
      return "La résiliation demande une vérification — notre équipe s'en charge";
    case 'EXPORT_ONLY_ENTERED':
      return 'Votre compte est passé en consultation seule';
    case 'DELETION_SCHEDULED':
      return p.scheduledAt
        ? `Suppression de votre compte prévue le ${formatDate(p.scheduledAt)}`
        : 'La suppression de votre compte est programmée';

    default:
      // ⚠️ Repli conservé, mais il ne doit plus jamais s'afficher : un type
      // émis sans libellé est un défaut, pas un cas normal. Le signaler en
      // console permet de le voir en recette plutôt qu'en production.
      // ══════════════════════════════════════════════════════════════════
      // L'AVERTISSEMENT NE DOIT PAS DÉPENDRE DE `NODE_ENV`
      //
      // Il était conditionné à `!== 'production'`. Or Scalingo pose
      // `NODE_ENV=production` sur la préproduction : le seul endroit où ce
      // défaut se constate est précisément celui où le diagnostic se taisait.
      //
      // Un `console.warn` en production ne coûte rien et ne se voit que dans
      // la console — contrairement au « Nouvelle notification » que
      // l'utilisateur, lui, voit sans comprendre.
      // ══════════════════════════════════════════════════════════════════
      console.warn(`[notifications] type sans libellé : ${type}`, p);
      // Contenu rendu par le catalogue serveur, s'il existe.
      return stored?.body || stored?.title || 'Nouvelle notification';
  }
}

/** Montant en centimes → « 12,90 € ». */
function formatMontant(centimes: unknown): string {
  const n = Number(centimes);
  if (!Number.isFinite(n)) return '';
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' })
    .format(n / 100);
}

/** Date ISO → « 14 mars 2026 ». */
function formatDate(iso: unknown): string {
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

function getNotificationHref(type: string, payload: NotificationPayload | null): string | null {
  const p = payload ?? {};
  if ((type === 'ACCOUNT_INVITATION' || type === 'DUO_INVITATION_RECEIVED') && p.inviteToken) {
    return `/mon-compte/partage?inviteToken=${p.inviteToken}`;
  }
  // Demande Duo → boîte de réception des demandes du Duo concerné (cf. CDC §17).
  // La page réelle est /duos/{duoId}/requests (l'ancien lien /duo était mort).
  if (type === 'DUO_MOVE_REQUEST' || type === 'DUO_DELETE_REQUEST') {
    if (p.duoId) {
      return `/duos/${p.duoId}/requests${p.requestId ? `?request=${p.requestId}` : ''}`;
    }
    return null;
  }
  if (type === 'TRANSMISSION_RECEIVED' && p.transmissionToken) {
    return `/transmission/${p.transmissionToken}`;
  }
  // Documents : vue du document concerné, ou liste des documents pour un lot.
  if ((type === 'DOCUMENT_BATCH_COMPLETED' || type === 'DOCUMENT_ANALYZED') && p.assetFileId) {
    return drawerHref({ kind: 'document', id: p.assetFileId }, '/documents');
  }
  if (type === 'DOCUMENT_BATCH_COMPLETED' || type === 'DOCUMENT_BATCH_PARTIALLY_FAILED' || type === 'DOCUMENT_BATCH_FAILED' || type === 'DOCUMENT_ANALYZED') {
    return '/documents';
  }
  if (type === 'ANALYSIS_FAILED_PERSISTENT' && p.assetFileId) {
    return drawerHref({ kind: 'document', id: p.assetFileId }, '/documents');
  }
  // Abonnement : information seule, non cliquable — le clic marque la
  // notification comme lue, sans navigation.
  if (isSubscriptionNotification(type)) return null;
  // Quota / parrainage → offres (cf. CDC §17).
  if (type === 'ANALYSIS_QUOTA_90' || type === 'ANALYSIS_QUOTA_100' || type === 'REFERRAL_REWARD_GRANTED') {
    return '/mon-compte/offres';
  }
  return null;
}

function getNotificationIcon(type: string) {
  switch (type) {
    case 'DUO_MOVE_REQUEST':
    case 'DUO_MOVE_ACCEPTED':
    case 'DUO_MOVE_REFUSED':
      return <ArrowRightLeft className="w-4 h-4 flex-shrink-0" />;
    case 'DUO_DELETE_REQUEST':
    case 'DUO_DELETE_ACCEPTED':
    case 'DUO_DELETE_REFUSED':
      return <Trash2 className="w-4 h-4 flex-shrink-0" />;
    case 'ACCOUNT_INVITATION':
      return <UserPlus className="w-4 h-4 flex-shrink-0" />;
    case 'DOCUMENT_ANALYZED':
    case 'DOCUMENT_BATCH_COMPLETED':
      return <Cpu className="w-4 h-4 flex-shrink-0" />;
    case 'ANALYSIS_FAILED_PERSISTENT':
      return <AlertTriangle className="w-4 h-4 flex-shrink-0 text-destructive" />;
    case 'TRANSMISSION_RECEIVED':
    case 'TRANSMISSION_ACCEPTED':
    case 'TRANSMISSION_REFUSED':
      return <SendHorizonal className="w-4 h-4 flex-shrink-0" />;
    case 'SUBSCRIPTION_ACTIVATED':
    case 'SUBSCRIPTION_CHANGED':
    case 'SUBSCRIPTION_CHANGE_SCHEDULED':
    case 'SUBSCRIPTION_RENEWED':
    case 'SUBSCRIPTION_CANCELLATION_SCHEDULED':
    case 'SUBSCRIPTION_CANCELLED':
      return <CreditCard className="w-4 h-4 flex-shrink-0" />;
    default:
      return <Info className="w-4 h-4 flex-shrink-0" />;
  }
}

export function NotificationBell() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  /** Premier chargement terminé : avant, « Aucune notification » serait faux. */
  const [loaded, setLoaded] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const isMobile = useIsMobile();
  const seenIdsRef = useRef<Set<number>>(new Set());

  const fetchNotifications = useCallback(async () => {
    try {
      const data = await apiClient.get<NotificationsResponse>('/api/notifications?limit=20');
      const visibles = data.notifications.filter(n => !TYPES_MASQUES.has(n.type));
      const masquesNonLus = data.notifications.filter(n => TYPES_MASQUES.has(n.type) && !n.readAt).length;
      setNotifications(visibles);
      setUnreadCount(Math.max(0, Number(data.unreadCount) - masquesNonLus));
      // Les anciennes notifications masquées non lues sont marquées lues :
      // sinon le point rouge resterait allumé sans rien à montrer.
      if (masquesNonLus > 0) {
        const ids = data.notifications.filter(n => TYPES_MASQUES.has(n.type) && !n.readAt).map(n => n.id);
        apiClient.patch('/api/notifications', { notificationIds: ids }).catch(() => {});
      }
      // Process new notifications (not yet seen)
      const newNotifs = visibles.filter(n => !seenIdsRef.current.has(n.id));
      newNotifs.forEach(n => {
        // Toast for mustDeliver (excluant DOCUMENT_ANALYZED)
        if (n.mustDeliver && !n.readAt && n.type !== 'DOCUMENT_ANALYZED') {
          toast(getNotificationText(n.type, n.payload, n), { duration: 6000 });
        }
        // Signal banner dismissal when analysis completes (analyze-silent path)
        if (n.type === 'DOCUMENT_ANALYZED') {
          window.dispatchEvent(new CustomEvent('document-analysis-complete', {
            detail: { fileId: n.payload?.assetFileId },
          }));
        }
        seenIdsRef.current.add(n.id);
      });
    } catch {
      // Silently fail polling
    } finally {
      setLoaded(true);
    }
  }, []);

  // ══════════════════════════════════════════════════════════════════════
  // PREMIER CHARGEMENT IMMÉDIAT
  //
  // Le premier appel était différé de 5 s « pour ne pas concurrencer les
  // requêtes critiques ». Conséquence visible : ouvrir la cloche peu après
  // l'arrivée sur une page montrait « Aucune notification » pendant plusieurs
  // secondes, puis la liste. La requête est légère (index composites,
  // migration 0165) : elle part désormais tout de suite, puis toutes les 30 s.
  // Le sondage s'arrête quand l'onglet est masqué (Visibility API).
  // ══════════════════════════════════════════════════════════════════════
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;

    function startPolling() {
      if (interval) return;
      interval = setInterval(fetchNotifications, 30_000);
    }

    function stopPolling() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    }

    function handleVisibilityChange() {
      if (document.hidden) {
        stopPolling();
      } else {
        fetchNotifications(); // fetch immédiat au retour sur l'onglet
        startPolling();
      }
    }

    if (!document.hidden) {
      fetchNotifications();
      startPolling();
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [fetchNotifications]);

  // Refresh when analysis completes (dispatched by DocumentDrawer)
  useEffect(() => {
    const handler = () => fetchNotifications();
    window.addEventListener('notifications-refresh', handler);
    return () => window.removeEventListener('notifications-refresh', handler);
  }, [fetchNotifications]);

  // Polling rapide (5s) quand une analyse est en cours en fire-and-forget
  // (pipeline unifié après upload — pas de SSE côté client)
  useEffect(() => {
    let fastInterval: ReturnType<typeof setInterval> | null = null;

    const onStart = () => {
      if (fastInterval) return; // déjà actif
      fastInterval = setInterval(fetchNotifications, 5_000);
    };

    const onComplete = () => {
      if (fastInterval) {
        clearInterval(fastInterval);
        fastInterval = null;
      }
    };

    window.addEventListener('document-analysis-start', onStart);
    window.addEventListener('document-analysis-complete', onComplete);
    return () => {
      window.removeEventListener('document-analysis-start', onStart);
      window.removeEventListener('document-analysis-complete', onComplete);
      if (fastInterval) clearInterval(fastInterval);
    };
  }, [fetchNotifications]);

  // Ouverture du panneau : la liste affichée est relue, sans attendre le sondage.
  useEffect(() => {
    if (open) void fetchNotifications();
  }, [open, fetchNotifications]);

  // Close panel on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  async function markAllRead() {
    try {
      setLoading(true);
      await apiClient.patch('/api/notifications', { markAllRead: true });
      setNotifications(prev => prev.map(n => ({ ...n, readAt: new Date().toISOString() })));
      setUnreadCount(0);
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  }

  async function markOneRead(id: number) {
    try {
      await apiClient.patch('/api/notifications', { notificationIds: [id] });
      setNotifications(prev =>
        prev.map(n => n.id === id ? { ...n, readAt: new Date().toISOString() } : n)
      );
      setUnreadCount(prev => Math.max(0, prev - 1));
    } catch {
      // Ignore
    }
  }

  async function handleNotificationClick(notif: Notification) {
    if (!notif.readAt) {
      await markOneRead(notif.id);
    }
    // Analyse terminée : le document s'ouvre en tiroir, sur ses résultats,
    // sur l'écran courant — plus de rechargement vers la liste des documents.
    if (notif.type === 'DOCUMENT_ANALYZED' || notif.type === 'DOCUMENT_BATCH_COMPLETED') {
      const p = notif.payload ?? {};
      const docId = p.assetFileId ?? (p.documents?.length === 1 ? p.documents[0].assetFileId : undefined);
      if (docId) {
        setOpen(false);
        openDrawer({ kind: 'document', id: docId, showAnalysisResults: true });
        return;
      }
      if (p.lotId) {
        setOpen(false);
        window.dispatchEvent(new CustomEvent('open-analysis-review', { detail: { lotId: p.lotId, showAnalysisResults: true } }));
        return;
      }
    }
    const href = getNotificationHref(notif.type, notif.payload);
    if (href) {
      setOpen(false);
      window.location.href = href;
    }
  }

  const contenuPanneau = (
    <>

          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-[color:var(--border-subtle)]">
            <span className="text-sm font-semibold text-[color:var(--text-primary)]">
              Notifications {unreadCount > 0 && <span className="text-red-500">({unreadCount})</span>}
            </span>
            <div className="flex items-center gap-2">
              {unreadCount > 0 && (
                <button
                  onClick={markAllRead}
                  disabled={loading}
                  className="flex items-center gap-1 text-xs text-[color:var(--accent)] hover:underline disabled:opacity-50"
                  title="Tout marquer comme lu"
                >
                  <CheckCheck className="w-3.5 h-3.5" />
                  Tout lu
                </button>
              )}
              <button
                onClick={() => setOpen(false)}
                className="p-1 rounded-lg hover:bg-[color:var(--accent-soft)] transition-colors"
              >
                <X className="w-4 h-4 text-[color:var(--text-muted)]" />
              </button>
            </div>
          </div>

          {/* List */}
          <div className="overflow-y-auto flex-1">
            {!loaded && notifications.length === 0 ? (
              <div className="flex items-center justify-center py-10 text-[color:var(--text-muted)] text-sm gap-2" role="status">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Chargement…</span>
              </div>
            ) : notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-[color:var(--text-muted)] text-sm gap-2">
                <Bell className="w-8 h-8 opacity-30" />
                <span>Aucune notification</span>
              </div>
            ) : (
              notifications.map(notif => {
                const isUnread = !notif.readAt;
                const href = getNotificationHref(notif.type, notif.payload);
                return (
                  <button
                    key={notif.id}
                    onClick={() => handleNotificationClick(notif)}
                    className={`w-full flex items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-[color:var(--accent-soft)] border-b border-[color:var(--border-subtle)] last:border-b-0 ${isUnread ? 'bg-[color:var(--accent-soft)]/40' : ''}`}
                  >
                    <span className={`mt-0.5 ${isUnread ? 'text-[color:var(--accent)]' : 'text-[color:var(--text-muted)]'}`}>
                      {getNotificationIcon(notif.type)}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm leading-snug ${isUnread ? 'font-medium text-[color:var(--text-primary)]' : 'text-[color:var(--text-secondary)]'}`}>
                        {getNotificationText(notif.type, notif.payload, notif)}
                      </p>
                      <p className="text-[11px] text-[color:var(--text-muted)] mt-0.5">
                        {formatDistanceToNow(new Date(notif.createdAt), { addSuffix: true, locale: fr })}
                        {href && <span className="ml-1 text-[color:var(--accent)]">→</span>}
                      </p>
                    </div>
                    {isUnread && (
                      <span className="w-2 h-2 rounded-full bg-[color:var(--accent)] flex-shrink-0 mt-1.5" />
                    )}
                  </button>
                );
              })
            )}
          </div>
    </>
  );

  return (
    <div className="relative">
      {/* Bell button */}
      <button
        ref={buttonRef}
        onClick={() => setOpen(prev => !prev)}
        className="relative p-2 rounded-xl hover:bg-[color:var(--accent-soft)] transition-all"
        aria-label="Notifications"
      >
        <Bell className="w-5 h-5 text-[color:var(--text-primary)]" />
        {unreadCount > 0 && (
          <span className="absolute top-1.5 right-1.5 w-[7px] h-[7px] rounded-full bg-red-500 shadow" />
        )}
      </button>

      {/* ══════════════════════════════════════════════════════════════════
          PANNEAU LISIBLE SUR MOBILE
          Aligné à droite du bouton (`right-0`, 320 px), il s'ouvrait vers la
          GAUCHE alors que la cloche est elle-même à gauche de l'en-tête
          mobile : les deux tiers du panneau sortaient de l'écran.

          Sur mobile, il occupe désormais toute la largeur sous l'en-tête. Il
          est rendu dans `body` : l'en-tête mobile a un `backdrop-filter`,
          qui ferait de lui le repère d'un élément `fixed` et le rognerait.
          ══════════════════════════════════════════════════════════════════ */}
      {open && isMobile && typeof document !== 'undefined' && createPortal(
        <>
          <div className="fixed inset-0 z-[60] bg-black/40" aria-hidden="true" onClick={() => setOpen(false)} />
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Notifications"
            className="fixed left-3 right-3 z-[61] bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] rounded-2xl shadow-relief-lg flex flex-col overflow-hidden"
            style={{
              top: 'calc(env(safe-area-inset-top, 0px) + 4.5rem)',
              maxHeight: 'calc(100dvh - env(safe-area-inset-top, 0px) - 4.5rem - 6.5rem)',
            }}
          >
            {contenuPanneau}
          </div>
        </>,
        document.body,
      )}

      {open && !isMobile && (
        <div
          ref={panelRef}
          className="absolute right-0 top-full mt-2 w-80 bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] rounded-2xl shadow-relief-lg z-50 flex flex-col overflow-hidden"
          style={{ maxHeight: '420px' }}
        >
          {contenuPanneau}
        </div>
      )}
    </div>
  );
}
