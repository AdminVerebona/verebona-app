"use client";

/**
 * BO › Communications › Fin d'essai — lot 100G (décision PO « Questions PO 3 »,
 * E, E1, E2, F).
 *
 * SYNTHÈSE d'abord : état global (OK / À surveiller / Incident) et ses causes,
 * totaux de la période, une carte par jalon (J−2, J0 : service ; J+3 → J+60 :
 * campagne commerciale ; J+80 : bloqué tant que la conservation n'est pas
 * fixée). Puis les RÉGLAGES (coupures, campagne commerciale désactivée par
 * défaut, base légale, jours, fenêtres, heures, lien « offres ») et le DÉTAIL
 * (journal filtrable : envois, échecs, non-envois motivés, conversions,
 * désinscriptions). Desktop et mobile : une colonne puis plusieurs, tableau
 * remplacé par des cartes sur petit écran, cibles ≥ 40 px.
 */
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ArrowLeft, ChevronDown, ChevronUp, Loader2, Lock, PenLine, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { EcranEnErreur } from '@/components/admin/EcranEnErreur';
import { formatDateTime } from '@/lib/admin/format';

type Health = 'OK' | 'WATCH' | 'INCIDENT';
type Code = 'J_MINUS_2' | 'J0' | 'J3' | 'J10' | 'J30' | 'J60' | 'J80';
interface Settings {
  serviceEnabled: boolean; commercialEnabled: boolean; legalBasis: 'consent' | 'soft_opt_in';
  softOptInDeclaration: { declaredAt: string; declaredBy: string } | null;
  commercialOffsets: { J3: number; J10: number; J30: number; J60: number };
  catchUpHours: Record<Code, number>; sendHours: { from: number; to: number };
  offers: { target: 'app_offers' | 'public_pricing'; pricingAnchor: string };
}
interface Counts { sent: number; failed: number; skipped: number; waiting: number; blocked: number; conversions: number }
interface MilestoneView {
  code: Code; label: string; nature: 'service' | 'commercial' | 'conditional'; templateCode: string; offsetDays: number; catchUpHours: number;
  state: { active: boolean; label: string }; template: { exists: boolean; version: number | null; customized: boolean; newerShipped: boolean };
  counts: Counts; topReasons: Array<{ reason: string; label: string; count: number }>;
}
interface Summary {
  health: Health; healthLabel: string; reasons: string[]; periodDays: number; settings: Settings;
  settingsUpdatedAt: string | null; settingsUpdatedBy: string | null;
  env: { allOff: boolean; commercialOff: boolean; unsubscribeAvailable: boolean; appUrl: boolean; offersUrl: string | null };
  retention: { locked: boolean; label: string };
  task: { status: string | null; lastSuccessAt: string | null; lastError: string | null; suspended: boolean } | null;
  obsoleteTemplates: string[]; totals: Counts & { unsubscribes: number }; milestones: MilestoneView[];
}
interface JournalRow {
  id: number; at: string; eventType: string; milestone: string | null; accountId: number | null; templateCode: string | null;
  templateVersion: number | null; reason: string | null; reasonLabel: string; actor: string; detail: Record<string, unknown>;
}

const HEALTH_TONE: Record<Health, string> = {
  OK: 'bg-[color:var(--bg-success)] text-[color:var(--text-success)] border-[color:var(--border-success)]',
  WATCH: 'bg-[color:var(--bg-warning)] text-[color:var(--text-warning-soft)] border-[color:var(--border-warning)]',
  INCIDENT: 'bg-[color:var(--bg-danger)] text-[color:var(--text-danger)] border-[color:var(--border-danger)]',
};
const NATURE_LABEL = { service: 'Service', commercial: 'Commercial', conditional: 'Conditionnel' } as const;
const EVENT_LABEL: Record<string, string> = {
  sent: 'Envoyé', failed: 'Échec', not_sent: 'Non envoyé', deferred: 'En attente', blocked: 'Bloqué',
  conversion: 'Conversion', unsubscribe: 'Désinscription', settings_changed: 'Réglages modifiés',
};
const MILESTONE_SHORT: Record<string, string> = { J_MINUS_2: 'J−2', J0: 'J0', J3: 'J+3', J10: 'J+10', J30: 'J+30', J60: 'J+60', J80: 'J+80' };
const n = (x: number, un: string, plusieurs = `${un}s`) => `${x.toLocaleString('fr-FR')} ${x > 1 ? plusieurs : un}`;
const input = 'min-h-[40px] w-full rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] px-3 text-sm';

export default function TrialLifecyclePage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [declare, setDeclare] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [journalOpen, setJournalOpen] = useState(false);
  const [filters, setFilters] = useState<{ jalon: string; type: string; motif: string; compte: string }>({ jalon: '', type: '', motif: '', compte: '' });
  const [page, setPage] = useState(1);
  const [journal, setJournal] = useState<{ rows: JournalRow[]; total: number; pageSize: number } | null>(null);
  const [journalError, setJournalError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/communications/fin-essai?jours=${days}`, { credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `Erreur ${res.status}`);
      setSummary(data);
      setDraft(structuredClone(data.settings));
      setDeclare(null);
    } catch (e) {
      setSummary(null);
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
    } finally {
      setLoading(false);
    }
  }, [days]);
  useEffect(() => { void load(); }, [load]);

  const loadJournal = useCallback(async () => {
    setJournalError(null);
    try {
      const qs = new URLSearchParams({ page: String(page) });
      for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
      const res = await fetch(`/api/admin/communications/fin-essai/journal?${qs}`, { credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `Erreur ${res.status}`);
      setJournal(data);
    } catch (e) {
      setJournalError(e instanceof Error ? e.message : 'Erreur inconnue');
    }
  }, [filters, page]);
  useEffect(() => { if (journalOpen) void loadJournal(); }, [journalOpen, loadJournal]);

  const openFiltered = (f: Partial<typeof filters>) => {
    setFilters({ jalon: '', type: '', motif: '', compte: '', ...f });
    setPage(1);
    setJournalOpen(true);
  };

  const save = async (confirmed: boolean) => {
    if (!draft || !summary) return;
    const before = summary.settings;
    const patch: Record<string, unknown> = {};
    for (const k of ['serviceEnabled', 'commercialEnabled', 'legalBasis', 'commercialOffsets', 'catchUpHours', 'sendHours', 'offers'] as const) {
      if (JSON.stringify(draft[k]) !== JSON.stringify(before[k])) patch[k] = draft[k];
    }
    if (declare !== null) patch.softOptInDeclared = declare;
    if (!Object.keys(patch).length) { toast.message('Aucun changement.'); return; }
    const needsConfirm = (patch.commercialEnabled === true || patch.softOptInDeclared === true);
    if (needsConfirm && !confirmed) { setConfirmOpen(true); return; }
    setSaving(true);
    try {
      const res = await fetch('/api/admin/communications/fin-essai/settings', {
        method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: patch, confirmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `Erreur ${res.status}`);
      toast.success('Réglages enregistrés');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Erreur inconnue');
    } finally {
      setSaving(false);
      setConfirmOpen(false);
      void load();
    }
  };

  const setNum = (path: (s: Settings, v: number) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!draft) return;
    const next = structuredClone(draft);
    path(next, Number(e.target.value));
    setDraft(next);
  };

  return (
    <div className="space-y-6 min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href="/admin/communications" className="inline-flex items-center gap-1 text-xs text-[color:var(--text-muted)] hover:underline min-h-[32px]">
            <ArrowLeft className="w-3.5 h-3.5" aria-hidden /> Communications
          </Link>
          <h1 className="vb-app-title">E-mails de fin d’essai</h1>
          <p className="text-sm text-[color:var(--text-secondary)] mt-0.5 break-words">
            Essai de 7 jours sans prélèvement. J−2 et J0 : notifications de service. J+3 à J+60 : campagne commerciale distincte (consentement, désinscription), arrêt après J+60. J+80 : bloqué tant que la conservation des données n’est pas fixée.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select aria-label="Période" className="min-h-[40px] rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] px-2 text-sm" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>7 jours</option><option value={30}>30 jours</option><option value={90}>90 jours</option>
          </select>
          <Button variant="outline" size="sm" className="min-h-[40px]" onClick={() => load()} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> Actualiser
          </Button>
        </div>
      </div>

      {loading && !summary ? (
        <div className="flex justify-center py-12"><Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /></div>
      ) : error || !summary ? (
        <EcranEnErreur titre="Impossible de charger la séquence de fin d’essai" message={error ?? 'Erreur inconnue'} onRetry={() => load()} />
      ) : (
        <>
          {/* ── Synthèse ─────────────────────────────────────────────── */}
          <section className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3 min-w-0" data-testid="fin-essai-synthese">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center text-sm px-2.5 py-1 rounded-full border font-medium whitespace-nowrap ${HEALTH_TONE[summary.health]}`} data-testid="fin-essai-etat" data-health={summary.health}>
                État : {summary.healthLabel}
              </span>
              <span className="text-sm text-[color:var(--text-secondary)]">{summary.periodDays} derniers jours</span>
            </div>
            {summary.reasons.length > 0 && (
              <ul className="text-xs text-[color:var(--text-secondary)] space-y-0.5 break-words list-disc pl-4">
                {summary.reasons.map((r) => <li key={r}>{r}</li>)}
              </ul>
            )}
            <dl className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 text-sm">
              {([
                ['Envoyés', summary.totals.sent, { type: 'sent' }], ['En échec', summary.totals.failed, { type: 'failed' }],
                ['Non envoyés', summary.totals.skipped, { type: 'not_sent' }], ['En attente', summary.totals.waiting, { type: 'deferred' }],
                ['Bloqués', summary.totals.blocked, { type: 'blocked' }], ['Conversions', summary.totals.conversions, { type: 'conversion' }],
                ['Désinscriptions', summary.totals.unsubscribes, { type: 'unsubscribe' }],
              ] as const).map(([label, value, f]) => (
                <button key={label} type="button" onClick={() => openFiltered(f)} className="rounded-lg border border-[color:var(--border-subtle)] p-2 text-left min-h-[56px] hover:bg-[color:var(--bg-hover)]">
                  <dt className="text-xs text-[color:var(--text-muted)]">{label}</dt>
                  <dd className="font-semibold tabular-nums">{value.toLocaleString('fr-FR')}</dd>
                </button>
              ))}
            </dl>
            <p className="text-xs text-[color:var(--text-muted)] break-words">
              Tâche « trial-lifecycle-emails » : {summary.task ? `${summary.task.suspended ? 'suspendue — ' : ''}dernier succès ${summary.task.lastSuccessAt ? formatDateTime(summary.task.lastSuccessAt) : 'jamais'}` : 'pas encore exécutée'}
              {' · '}Lien « offres » : {summary.env.offersUrl ?? 'indisponible'}
            </p>
          </section>

          {/* ── Jalons ───────────────────────────────────────────────── */}
          <section className="space-y-3">
            <h2 className="vb-app-section">Jalons</h2>
            <ul className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3" data-testid="fin-essai-jalons">
              {summary.milestones.map((m) => (
                <li key={m.code} className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-2 min-w-0" data-testid={`jalon-${m.code}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-sm">{m.label}</span>
                    <span className="text-[11px] px-2 py-0.5 rounded-full border border-[color:var(--border-subtle)] text-[color:var(--text-secondary)]">{NATURE_LABEL[m.nature]}</span>
                  </div>
                  <p className={`text-xs inline-flex items-center gap-1 ${m.state.active ? 'text-[color:var(--text-success)]' : 'text-[color:var(--text-muted)]'}`} data-testid={`jalon-etat-${m.code}`}>
                    {!m.state.active && m.nature === 'conditional' && <Lock className="w-3 h-3" aria-hidden />} {m.state.label}
                  </p>
                  <p className="text-xs text-[color:var(--text-secondary)]">
                    {m.offsetDays === 0 ? 'Le jour de la fin d’essai' : m.offsetDays < 0 ? `${-m.offsetDays} jours avant la fin` : `${m.offsetDays} jours après la fin`} · rattrapage {m.catchUpHours} h
                  </p>
                  <p className="text-xs text-[color:var(--text-secondary)] break-words">
                    Modèle {m.templateCode}{m.template.version ? ` (version ${m.template.version})` : ''}{!m.template.exists ? ' — ABSENT' : ''}{m.template.newerShipped ? ' — texte livré plus récent disponible' : ''}
                  </p>
                  <p className="text-xs flex flex-wrap gap-x-3 gap-y-1">
                    <button type="button" className="min-h-[32px] hover:underline" onClick={() => openFiltered({ jalon: m.code, type: 'sent' })}>{n(m.counts.sent, 'envoyé')}</button>
                    {m.counts.failed > 0 && <button type="button" className="min-h-[32px] text-[color:var(--text-danger)] hover:underline" onClick={() => openFiltered({ jalon: m.code, type: 'failed' })}>{n(m.counts.failed, 'échec')}</button>}
                    {m.counts.skipped > 0 && <button type="button" className="min-h-[32px] hover:underline" onClick={() => openFiltered({ jalon: m.code, type: 'not_sent' })}>{n(m.counts.skipped, 'non envoyé', 'non envoyés')}</button>}
                    {m.counts.waiting > 0 && <span className="text-[color:var(--text-muted)]">{m.counts.waiting} en attente</span>}
                    {m.counts.blocked > 0 && <span className="text-[color:var(--text-warning-soft)]">{n(m.counts.blocked, 'bloqué')}</span>}
                    {m.counts.conversions > 0 && <span className="text-[color:var(--text-success)]">{n(m.counts.conversions, 'conversion')}</span>}
                  </p>
                  {m.topReasons.length > 0 && (
                    <ul className="text-[11px] text-[color:var(--text-muted)] space-y-0.5">
                      {m.topReasons.map((r) => (
                        <li key={r.reason}><button type="button" className="hover:underline text-left min-h-[28px]" onClick={() => openFiltered({ jalon: m.code, motif: r.reason })}>{r.label} : {r.count}</button></li>
                      ))}
                    </ul>
                  )}
                  <Button size="sm" variant="outline" className="min-h-[40px]" asChild>
                    <Link href={`/admin/communications/emails/${encodeURIComponent(m.templateCode)}${m.nature === 'service' ? `?evenement=${m.code === 'J0' ? 'TRIAL_ENDED' : 'TRIAL_ENDING'}` : ''}`}>
                      <PenLine className="h-3.5 w-3.5 mr-1.5" /> Modifier le texte
                    </Link>
                  </Button>
                </li>
              ))}
            </ul>
          </section>

          {/* ── Réglages ─────────────────────────────────────────────── */}
          <section className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-4 min-w-0" data-testid="fin-essai-reglages">
            <button type="button" onClick={() => setSettingsOpen((o) => !o)} aria-expanded={settingsOpen} className="w-full flex items-center justify-between min-h-[40px] text-left">
              <span className="vb-app-section">Réglages</span>
              {settingsOpen ? <ChevronUp className="w-4 h-4" aria-hidden /> : <ChevronDown className="w-4 h-4" aria-hidden />}
            </button>
            {settingsOpen && draft && (
              <div className="space-y-4">
                {(summary.env.allOff || summary.env.commercialOff) && (
                  <p className="text-xs rounded border border-[color:var(--border-warning)] bg-[color:var(--bg-warning)] px-3 py-2 text-[color:var(--text-warning-soft)]">
                    {summary.env.allOff ? 'Toute la séquence est coupée par la variable TRIAL_LIFECYCLE_EMAILS=off.' : 'Les relances commerciales sont coupées par la variable TRIAL_COMMERCIAL_EMAILS=off.'}
                  </p>
                )}
                <label className="flex items-center justify-between gap-3 min-h-[40px]">
                  <span className="text-sm">Notifications de service J−2 et J0</span>
                  <Switch checked={draft.serviceEnabled} onCheckedChange={(v) => setDraft({ ...draft, serviceEnabled: v })} aria-label="Notifications de service" />
                </label>
                <label className="flex items-center justify-between gap-3 min-h-[40px]">
                  <span className="text-sm">Campagne commerciale J+3 → J+60 <span className="block text-xs text-[color:var(--text-muted)]">Désactivée par défaut : à activer seulement si la base légale est établie.</span></span>
                  <Switch checked={draft.commercialEnabled} onCheckedChange={(v) => setDraft({ ...draft, commercialEnabled: v })} aria-label="Campagne commerciale" data-testid="reglage-commercial" />
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-sm space-y-1">
                    <span>Base légale des relances</span>
                    <select className={input} value={draft.legalBasis} onChange={(e) => setDraft({ ...draft, legalBasis: e.target.value as Settings['legalBasis'] })}>
                      <option value="consent">Consentement aux communications commerciales (prudent)</option>
                      <option value="soft_opt_in">Client existant (information et opposition à l’inscription)</option>
                    </select>
                  </label>
                  {draft.legalBasis === 'soft_opt_in' && (
                    <label className="text-sm flex items-start gap-2 min-h-[40px]">
                      <input type="checkbox" className="mt-1 h-4 w-4" checked={declare ?? !!summary.settings.softOptInDeclaration} onChange={(e) => setDeclare(e.target.checked)} />
                      <span>Je déclare avoir vérifié que l’inscription informe clairement de ces relances et permet de s’y opposer simplement.
                        {summary.settings.softOptInDeclaration && <span className="block text-xs text-[color:var(--text-muted)]">Déclaré par {summary.settings.softOptInDeclaration.declaredBy} le {formatDateTime(summary.settings.softOptInDeclaration.declaredAt)}.</span>}
                      </span>
                    </label>
                  )}
                </div>
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">Jours des relances (après la fin de l’essai, J+60 au plus tard)</legend>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {(['J3', 'J10', 'J30', 'J60'] as const).map((k) => (
                      <label key={k} className="text-xs space-y-1"><span>{MILESTONE_SHORT[k]}</span>
                        <input type="number" min={1} max={60} className={input} value={draft.commercialOffsets[k]} onChange={setNum((s, v) => { s.commercialOffsets[k] = v; })} />
                      </label>
                    ))}
                  </div>
                </fieldset>
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">Fenêtre de rattrapage (heures) — au-delà, jamais d’envoi</legend>
                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
                    {(Object.keys(MILESTONE_SHORT) as Code[]).map((k) => (
                      <label key={k} className="text-xs space-y-1"><span>{MILESTONE_SHORT[k]}</span>
                        <input type="number" min={1} max={336} className={input} value={draft.catchUpHours[k]} onChange={setNum((s, v) => { s.catchUpHours[k] = v; })} />
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="grid gap-3 sm:grid-cols-4">
                  <label className="text-xs space-y-1"><span>Envoi à partir de (h, Paris)</span>
                    <input type="number" min={7} max={21} className={input} value={draft.sendHours.from} onChange={setNum((s, v) => { s.sendHours.from = v; })} />
                  </label>
                  <label className="text-xs space-y-1"><span>Envoi jusqu’à (h, Paris)</span>
                    <input type="number" min={7} max={21} className={input} value={draft.sendHours.to} onChange={setNum((s, v) => { s.sendHours.to = v; })} />
                  </label>
                  <label className="text-xs space-y-1"><span>Lien « offres »</span>
                    <select className={input} value={draft.offers.target} onChange={(e) => setDraft({ ...draft, offers: { ...draft.offers, target: e.target.value as Settings['offers']['target'] } })}>
                      <option value="app_offers">Page Offres de l’application (recommandé)</option>
                      <option value="public_pricing">Section Tarifs du site public</option>
                    </select>
                  </label>
                  <label className="text-xs space-y-1"><span>Ancre de la section Tarifs</span>
                    <input type="text" className={input} value={draft.offers.pricingAnchor} onChange={(e) => setDraft({ ...draft, offers: { ...draft.offers, pricingAnchor: e.target.value } })} />
                  </label>
                </div>
                <p className="text-xs text-[color:var(--text-muted)] inline-flex items-start gap-1">
                  <Lock className="w-3 h-3 mt-0.5 shrink-0" aria-hidden /> J+80 : {summary.retention.label}. Aucun réglage ne le débloque (verrou serveur).
                </p>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-[color:var(--text-muted)]">
                    {summary.settingsUpdatedAt ? `Modifié le ${formatDateTime(summary.settingsUpdatedAt)} par ${summary.settingsUpdatedBy ?? '—'}` : 'Réglages par défaut'}
                  </span>
                  <Button className="min-h-[40px]" onClick={() => save(false)} disabled={saving} data-testid="reglages-enregistrer">
                    {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />} Enregistrer
                  </Button>
                </div>
              </div>
            )}
          </section>

          {/* ── Détail ───────────────────────────────────────────────── */}
          <section className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3 min-w-0" data-testid="fin-essai-detail">
            <button type="button" onClick={() => setJournalOpen((o) => !o)} aria-expanded={journalOpen} className="w-full flex items-center justify-between min-h-[40px] text-left">
              <span className="vb-app-section">Détail du journal</span>
              {journalOpen ? <ChevronUp className="w-4 h-4" aria-hidden /> : <ChevronDown className="w-4 h-4" aria-hidden />}
            </button>
            {journalOpen && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                  <select aria-label="Jalon" className={input} value={filters.jalon} onChange={(e) => { setFilters({ ...filters, jalon: e.target.value }); setPage(1); }}>
                    <option value="">Tous les jalons</option>
                    {Object.entries(MILESTONE_SHORT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                  <select aria-label="Type" className={input} value={filters.type} onChange={(e) => { setFilters({ ...filters, type: e.target.value }); setPage(1); }}>
                    <option value="">Tous les événements</option>
                    {Object.entries(EVENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                  <input aria-label="Motif" placeholder="Motif (ex. opposition)" className={input} value={filters.motif} onChange={(e) => { setFilters({ ...filters, motif: e.target.value.trim() }); setPage(1); }} />
                  <input aria-label="Compte" placeholder="N° de compte" inputMode="numeric" className={input} value={filters.compte} onChange={(e) => { setFilters({ ...filters, compte: e.target.value.replace(/\D/g, '') }); setPage(1); }} />
                </div>
                {journalError && <p className="text-xs text-[color:var(--text-danger)]">{journalError}</p>}
                {!journal ? (
                  <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
                ) : journal.rows.length === 0 ? (
                  <p className="text-sm text-[color:var(--text-muted)]">Aucun événement pour ces critères.</p>
                ) : (
                  <>
                    <div className="hidden md:block overflow-x-auto">
                      <table className="w-full text-sm" data-testid="fin-essai-journal">
                        <thead><tr className="text-left text-xs text-[color:var(--text-muted)]">
                          <th className="px-2 py-2 font-medium">Date</th><th className="px-2 py-2 font-medium">Jalon</th><th className="px-2 py-2 font-medium">Événement</th>
                          <th className="px-2 py-2 font-medium">Compte</th><th className="px-2 py-2 font-medium">Modèle</th><th className="px-2 py-2 font-medium">Motif</th>
                        </tr></thead>
                        <tbody>
                          {journal.rows.map((r) => (
                            <tr key={r.id} className="border-t border-[color:var(--border-subtle)] align-top">
                              <td className="px-2 py-2 text-xs whitespace-nowrap">{formatDateTime(r.at)}</td>
                              <td className="px-2 py-2">{r.milestone ? MILESTONE_SHORT[r.milestone] ?? r.milestone : '—'}</td>
                              <td className="px-2 py-2">{EVENT_LABEL[r.eventType] ?? r.eventType}</td>
                              <td className="px-2 py-2">{r.accountId ? <Link className="hover:underline" href={`/admin/accounts/${r.accountId}`}>#{r.accountId}</Link> : '—'}</td>
                              <td className="px-2 py-2 text-xs break-all">{r.templateCode ? `${r.templateCode}${r.templateVersion ? ` v${r.templateVersion}` : ''}` : '—'}</td>
                              <td className="px-2 py-2 text-xs">{r.reasonLabel || (r.eventType === 'settings_changed' ? String(r.detail.adminEmail ?? '') : '—')}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <ul className="md:hidden space-y-2">
                      {journal.rows.map((r) => (
                        <li key={r.id} className="rounded-lg border border-[color:var(--border-subtle)] p-3 text-sm space-y-1">
                          <p className="flex flex-wrap gap-x-2"><span className="font-medium">{EVENT_LABEL[r.eventType] ?? r.eventType}</span>{r.milestone && <span>{MILESTONE_SHORT[r.milestone]}</span>}<span className="text-xs text-[color:var(--text-muted)]">{formatDateTime(r.at)}</span></p>
                          {r.accountId && <p className="text-xs">Compte <Link className="underline" href={`/admin/accounts/${r.accountId}`}>#{r.accountId}</Link></p>}
                          {r.templateCode && <p className="text-xs break-all">{r.templateCode}{r.templateVersion ? ` v${r.templateVersion}` : ''}</p>}
                          {r.reasonLabel && <p className="text-xs text-[color:var(--text-secondary)]">{r.reasonLabel}</p>}
                        </li>
                      ))}
                    </ul>
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span>{journal.total.toLocaleString('fr-FR')} événement(s)</span>
                      <span className="flex gap-2">
                        <Button size="sm" variant="outline" className="min-h-[40px]" disabled={page <= 1} onClick={() => setPage(page - 1)}>Précédent</Button>
                        <Button size="sm" variant="outline" className="min-h-[40px]" disabled={page * journal.pageSize >= journal.total} onClick={() => setPage(page + 1)}>Suivant</Button>
                      </span>
                    </div>
                  </>
                )}
              </>
            )}
          </section>
        </>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={(o) => { if (!o && !saving) setConfirmOpen(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Activer les relances commerciales ?</AlertDialogTitle>
            <AlertDialogDescription>
              Les relances J+3, J+10, J+30 et J+60 partiront aux destinataires éligibles selon la base légale choisie ({draft?.legalBasis === 'consent' ? 'consentement aux communications commerciales' : 'client existant déclaré'}), jamais après une désinscription. Action journalisée.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Annuler</AlertDialogCancel>
            <AlertDialogAction onClick={() => save(true)} disabled={saving}>Confirmer</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
