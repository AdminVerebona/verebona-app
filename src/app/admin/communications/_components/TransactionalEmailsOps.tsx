'use client';

/**
 * E-mails transactionnels — suivi des envois (lot 57A, ticket P0 e-mails,
 * volet E « Back-Office »).
 *
 * Recherche par type de message et destinataire ; pour chaque tentative :
 * statut d'envoi, livraison connue (webhooks Resend), cause technique,
 * identifiant Resend, demande durable (tentatives, prochaine reprise). Les
 * demandes enregistrées pas encore tentées sont listées à part. Aucun jeton
 * n'est servi par l'API. Composants existants de la page (tableau défilant
 * horizontalement sur mobile).
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { apiClient } from '@/lib/api-client';
import { formatDateTime } from '@/lib/admin/format';

interface LogRow {
  id: number; at: string | null; templateCode: string; recipientEmail: string; recipientUserId: number | null;
  triggeredByUserId: number | null; status: string; errorMessage: string | null; providerMessageId: string | null;
  deliveryStatus: string | null; deliveryStatusAt: string | null; deliveredAt: string | null; deliveryError: string | null;
  job: { id: number; status: string; attempts: number; maxAttempts: number; nextAttemptAt: string | null } | null;
}
interface ClosedRow {
  jobId: number; kind: string; recipientEmail: string; status: 'failed' | 'cancelled'; attempts: number; reason: string | null; updatedAt: string | null;
}
interface AnnualRenewal {
  coverageFrom: string | null; jobs: Record<string, number>; checksToday: Array<{ outcome: string; reason: string | null; count: number }>;
}
interface PendingRow {
  jobId: number; kind: string; recipientEmail: string; status: string; attempts: number; maxAttempts: number;
  nextAttemptAt: string | null; lastError: string | null; createdAt: string | null;
}

/** Statut d'envoi (`email_logs.status`, sens inchangé). */
export const SEND_STATUS_LABELS: Record<string, string> = {
  sent: 'Accepté par Resend', failed: 'Échec d’envoi', skipped: 'Non envoyé (canal désactivé)', pending: 'En cours',
};
/** Livraison (webhooks Resend). */
export const DELIVERY_STATUS_LABELS: Record<string, string> = {
  accepted: 'Livraison non confirmée', delivery_delayed: 'Livraison retardée', delivered: 'Remis au serveur destinataire',
  complained: 'Signalé comme indésirable', bounced: 'Rejeté par le serveur destinataire', failed: 'Échec de livraison',
  suppressed: 'Bloqué par Resend (liste de suppression)',
};

interface Config {
  source: 'base' | 'defaut'; emailsEnabled: boolean; senderName: string; senderEmail: string; senderDomain: string;
  replyToEmail: string; apiKeyConfigured: boolean; webhookSecretConfigured: boolean; templates: Record<string, boolean>;
  lastWebhookAt: string | null;
}

const ok = (v: boolean) => (v ? 'text-[color:var(--text-success)]' : 'text-[color:var(--text-danger)]');

/** Configuration d'envoi effective : ce que le diagnostic doit vérifier (docs/exploitation/emails-delivrabilite.md). */
function ConfigBlock({ c }: { c: Config }) {
  return (
    <div className="text-xs space-y-1" data-testid="transactional-emails-config">
      <p>
        Expéditeur : <span className="font-medium">{c.senderName} &lt;{c.senderEmail}&gt;</span>
        {' '}— domaine <span className="font-mono">{c.senderDomain}</span> (doit être « Verified » chez Resend)
        {c.source === 'defaut' ? <span className="text-[color:var(--text-warning-soft)]"> · valeurs par défaut du code (aucun réglage en base)</span> : null}
      </p>
      <p>
        Réponse à : {c.replyToEmail} · <span className={ok(c.emailsEnabled)}>{c.emailsEnabled ? 'e-mails activés' : 'e-mails DÉSACTIVÉS'}</span>
        {' '}· <span className={ok(c.apiKeyConfigured)}>clé Resend {c.apiKeyConfigured ? 'présente' : 'ABSENTE'}</span>
        {' '}· <span className={ok(c.webhookSecretConfigured)}>secret de webhook {c.webhookSecretConfigured ? 'présent' : 'absent'}</span>
        {' '}· dernier webhook : {c.lastWebhookAt ? formatDateTime(c.lastWebhookAt) : 'jamais'}
      </p>
      <p>
        Gabarits :{' '}
        {Object.entries(c.templates).map(([t, p]) => <span key={t} className={`mr-2 ${ok(p)}`}>{t} {p ? '✓' : 'absent'}</span>)}
      </p>
    </div>
  );
}

/**
 * Lot 61B — correction de l'expéditeur SANS SQL (§3-A du ticket P0 e-mails :
 * « corriger la cause établie »), quand le domaine affiché n'est pas celui
 * vérifié chez Resend. Administrateurs ; journalisé ; mêmes composants.
 */
function SenderForm({ c, onSaved }: { c: Config; onSaved: (c: Config) => void }) {
  const [open, setOpen] = useState(false);
  const [senderName, setSenderName] = useState(c.senderName);
  const [senderEmail, setSenderEmail] = useState(c.senderEmail);
  const [replyToEmail, setReplyToEmail] = useState(c.replyToEmail);
  const [emailsEnabled, setEmailsEnabled] = useState(c.emailsEnabled);
  const [saving, setSaving] = useState(false);

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="email-sender-edit">
        Modifier l’expéditeur
      </Button>
    );
  }
  const enregistrer = async () => {
    setSaving(true);
    try {
      const r = await apiClient.patch<{ config: Config }>('/api/admin/communications/email-settings', { senderName, senderEmail, replyToEmail, emailsEnabled });
      onSaved(r.config);
      setOpen(false);
      toast.success('Expéditeur enregistré. Les demandes en attente repartiront à la prochaine reprise automatique.');
    } catch {
      toast.error('Réglage refusé : vérifiez les adresses (format) et le nom (sans retour à la ligne).');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex flex-wrap items-end gap-2" data-testid="email-sender-form">
      <Input className="w-full sm:w-40" aria-label="Nom de l’expéditeur" value={senderName} onChange={(e) => setSenderName(e.target.value)} />
      <Input className="w-full sm:w-64" type="email" aria-label="Adresse d’expédition (domaine vérifié chez Resend)" value={senderEmail} onChange={(e) => setSenderEmail(e.target.value)} />
      <Input className="w-full sm:w-56" type="email" aria-label="Adresse de réponse" value={replyToEmail} onChange={(e) => setReplyToEmail(e.target.value)} />
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Switch checked={emailsEnabled} onCheckedChange={setEmailsEnabled} aria-label="E-mails activés" />
        E-mails activés
      </label>
      <Button size="sm" onClick={() => void enregistrer()} disabled={saving}>
        {saving ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null} Enregistrer
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={saving}>Annuler</Button>
      <span className="text-xs text-muted-foreground w-full">Action journalisée. Le domaine de l’adresse d’expédition doit être « Verified » chez Resend.</span>
    </div>
  );
}

const TYPES = ['EMAIL_VERIFICATION', 'DUO_INVITATION', 'DUO_MEMBERSHIP_ENDED', 'DUO_MEMBERSHIP_LEFT', 'PASSWORD_RESET', 'WELCOME', 'SIGNUP_EXISTING_ACCOUNT', 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER'];

/** Lot 68C : statut d'une demande (préparé / accepté / échoué / annulé). */
const JOB_STATUS_LABELS: Record<string, string> = {
  pending: 'préparé', sending: 'en cours d’envoi', accepted: 'accepté par Resend', failed: 'échoué', cancelled: 'annulé',
};

/**
 * Lot 68C — rappel J−7 des abonnements annuels : début de couverture, demandes
 * des 30 derniers jours par statut, décisions du jour (motifs d'exclusion).
 * L'état de la tâche (dernier passage, suspension) est dans Exploitation ›
 * Tâches planifiées (`subscription-annual-renewal-reminders`).
 */
function AnnualRenewalBlock({ a }: { a: AnnualRenewal }) {
  const jobs = Object.entries(a.jobs);
  return (
    <div className="text-xs space-y-1" data-testid="annual-renewal-overview">
      <p className="font-medium">Rappel J−7 des abonnements annuels</p>
      <p>
        Couverture depuis le {a.coverageFrom ?? '— (traitement jamais exécuté : à réactiver dans Exploitation › Tâches planifiées)'}
        {' '}· demandes (30 j) : {jobs.length ? jobs.map(([k, n]) => `${JOB_STATUS_LABELS[k] ?? k} ${n}`).join(', ') : 'aucune'}
      </p>
      {a.checksToday.length > 0 && (
        <p>Décisions du jour : {a.checksToday.map((c) => `${c.outcome}${c.reason ? ` (${c.reason})` : ''} ${c.count}`).join(', ')}</p>
      )}
    </div>
  );
}

export function TransactionalEmailsOps() {
  const [type, setType] = useState('');
  const [recipient, setRecipient] = useState('');
  const [problems, setProblems] = useState(false);
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<{ logs: LogRow[]; pendingRequests: PendingRow[]; closedRequests?: ClosedRow[] } | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [annual, setAnnual] = useState<AnnualRenewal | null>(null);

  useEffect(() => {
    apiClient.get<{ config: Config }>('/api/admin/communications/email-logs?config=1')
      .then((r) => setConfig(r.config))
      .catch(() => setConfig(null));
    apiClient.get<{ annualRenewal: AnnualRenewal }>('/api/admin/communications/email-logs?annualRenewal=1')
      .then((r) => setAnnual(r.annualRenewal))
      .catch(() => setAnnual(null));
  }, []);

  const rechercher = async () => {
    setBusy(true);
    try {
      const q = new URLSearchParams({ limit: '100' });
      if (type.trim()) q.set('type', type.trim());
      if (recipient.trim()) q.set('recipient', recipient.trim());
      if (problems) q.set('problems', '1');
      setData(await apiClient.get(`/api/admin/communications/email-logs?${q}`));
    } catch {
      toast.error('Recherche impossible.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3" data-testid="transactional-emails-ops">
      <h2 className="vb-app-section">E-mails transactionnels — envois et livraison</h2>
      <div className="rounded-xl border bg-card p-4 space-y-3">
        {config ? <ConfigBlock c={config} /> : <p className="text-xs text-muted-foreground">Configuration d’envoi indisponible.</p>}
        {annual ? <AnnualRenewalBlock a={annual} /> : null}
        {config ? <SenderForm key={`${config.senderEmail}|${config.senderName}|${config.replyToEmail}|${config.emailsEnabled}`} c={config} onSaved={setConfig} /> : null}
        <div className="flex flex-wrap items-end gap-2">
          <Input className="w-full sm:w-56" list="transactional-email-types" placeholder="Type (ex. EMAIL_VERIFICATION)" aria-label="Type de message" value={type} onChange={(e) => setType(e.target.value)} />
          <datalist id="transactional-email-types">{TYPES.map((t) => <option key={t} value={t} />)}</datalist>
          <Input className="w-full sm:w-64" placeholder="Destinataire (adresse ou partie)" aria-label="Destinataire" value={recipient} onChange={(e) => setRecipient(e.target.value)} />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={problems} onCheckedChange={setProblems} aria-label="Échecs et livraisons problématiques seulement" />
            Échecs seulement
          </label>
          <Button size="sm" variant="outline" onClick={() => void rechercher()} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Search className="h-3.5 w-3.5 mr-1.5" />} Rechercher
          </Button>
          <span className="text-xs text-muted-foreground">Recherche journalisée. Aucun lien d’activation ni d’invitation n’est affiché.</span>
        </div>

        {data && data.pendingRequests.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Demandes d’envoi enregistrées, pas encore acceptées</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="px-2 py-1 font-medium">Créée</th><th className="px-2 py-1 font-medium">Type</th>
                    <th className="px-2 py-1 font-medium">Destinataire</th><th className="px-2 py-1 font-medium">Tentatives</th>
                    <th className="px-2 py-1 font-medium">Prochaine</th><th className="px-2 py-1 font-medium">Dernière erreur</th>
                  </tr>
                </thead>
                <tbody>
                  {data.pendingRequests.map((p) => (
                    <tr key={p.jobId} className="border-t">
                      <td className="px-2 py-1 text-xs">{p.createdAt ? formatDateTime(p.createdAt) : '—'}</td>
                      <td className="px-2 py-1">{p.kind}</td>
                      <td className="px-2 py-1 break-all">{p.recipientEmail}</td>
                      <td className="px-2 py-1 tabular-nums">{p.attempts}/{p.maxAttempts}</td>
                      <td className="px-2 py-1 text-xs">{p.nextAttemptAt ? formatDateTime(p.nextAttemptAt) : '—'}</td>
                      <td className="px-2 py-1 text-xs text-[color:var(--text-danger)]">{p.lastError ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {data && (data.closedRequests?.length ?? 0) > 0 && (
          <div className="space-y-1" data-testid="closed-email-requests">
            <p className="text-xs font-medium text-muted-foreground">Demandes closes sans envoi accepté (30 derniers jours) — jamais comptées comme envoyées</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="px-2 py-1 font-medium">Close</th><th className="px-2 py-1 font-medium">Type</th>
                    <th className="px-2 py-1 font-medium">Destinataire</th><th className="px-2 py-1 font-medium">Statut</th>
                    <th className="px-2 py-1 font-medium">Tentatives</th><th className="px-2 py-1 font-medium">Motif</th>
                  </tr>
                </thead>
                <tbody>
                  {data.closedRequests!.map((c) => (
                    <tr key={c.jobId} className="border-t">
                      <td className="px-2 py-1 text-xs">{c.updatedAt ? formatDateTime(c.updatedAt) : '—'}</td>
                      <td className="px-2 py-1">{c.kind}</td>
                      <td className="px-2 py-1 break-all">{c.recipientEmail}</td>
                      <td className="px-2 py-1">{JOB_STATUS_LABELS[c.status] ?? c.status}</td>
                      <td className="px-2 py-1 tabular-nums">{c.attempts}</td>
                      <td className="px-2 py-1 text-xs text-[color:var(--text-danger)] break-words">{c.reason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {data && (data.logs.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucun envoi.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="px-2 py-1 font-medium">Date</th><th className="px-2 py-1 font-medium">Type</th>
                  <th className="px-2 py-1 font-medium">Destinataire</th><th className="px-2 py-1 font-medium">Envoi</th>
                  <th className="px-2 py-1 font-medium">Livraison</th><th className="px-2 py-1 font-medium">Identifiant Resend</th>
                  <th className="px-2 py-1 font-medium">Demande</th>
                </tr>
              </thead>
              <tbody>
                {data.logs.map((l) => (
                  <tr key={l.id} className="border-t align-top">
                    <td className="px-2 py-1 text-xs">{l.at ? formatDateTime(l.at) : '—'}</td>
                    <td className="px-2 py-1">{l.templateCode}</td>
                    <td className="px-2 py-1 break-all">
                      {l.recipientEmail}
                      <span className="block text-xs text-muted-foreground">
                        {l.recipientUserId ? `utilisateur ${l.recipientUserId}` : 'sans compte'}
                        {l.triggeredByUserId ? ` · à l’initiative de l’utilisateur ${l.triggeredByUserId}` : ''}
                      </span>
                    </td>
                    <td className="px-2 py-1">
                      {SEND_STATUS_LABELS[l.status] ?? l.status}
                      {l.errorMessage ? <span className="block text-xs text-[color:var(--text-danger)] break-words">{l.errorMessage}</span> : null}
                    </td>
                    <td className="px-2 py-1">
                      {l.deliveryStatus ? DELIVERY_STATUS_LABELS[l.deliveryStatus] ?? l.deliveryStatus : '—'}
                      {l.deliveryStatusAt ? <span className="block text-xs text-muted-foreground">{formatDateTime(l.deliveryStatusAt)}</span> : null}
                      {l.deliveryError ? <span className="block text-xs text-[color:var(--text-danger)] break-words">{l.deliveryError}</span> : null}
                    </td>
                    <td className="px-2 py-1 font-mono text-xs break-all">{l.providerMessageId ?? '—'}</td>
                    <td className="px-2 py-1 text-xs">
                      {l.job ? `n° ${l.job.id} · ${l.job.status} · ${l.job.attempts}/${l.job.maxAttempts}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </section>
  );
}
