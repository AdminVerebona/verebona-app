"use client";

/**
 * Diagnostics — BO › Dashboard › Supervision (lots 77C, 81C, 88A, 91A, 107G).
 *
 * Lot 91A : UN diagnostic, UN moteur. « Ensemble de l’application » (défaut)
 * est le niveau maximal : toutes les données fonctionnelles de TOUS les
 * comptes et toutes les données techniques et transversales, dans un seul
 * ZIP. Compte / Utilisateur / Bien / Document / Opération sont de simples
 * FILTRES du même moteur (volume réduit).
 *
 * Lot 107G (incident du 02/11/2026) : le diagnostic n'est PLUS produit dans
 * la requête HTTP. « Générer le diagnostic » enregistre une demande DURABLE
 * (identifiant rendu tout de suite, double clic sans doublon) ; un worker la
 * produit en arrière-plan (bail, reprise après redémarrage ou déploiement,
 * tentatives bornées, validation avant publication). Fermer la page n'arrête
 * rien : l'archive se télécharge plus tard depuis l'historique. L'historique
 * est léger et paginé ; « Santé du moteur » explique une panne sans générer
 * de diagnostic.
 *
 * Lot 111C : la dernière demande GLOBALE est prioritaire — une nouvelle
 * demande globale remplace les demandes globales encore actives (« Annulé —
 * remplacé par … », « Annulation demandée ») ; la nouvelle est sélectionnée.
 * Une demande en attente dit POURQUOI (« En attente — worker désactivé
 * (DIAG_JOB_WORKER_DISABLED) », « — worker indisponible », « — autre
 * diagnostic »…) avec l'action à mener ; « Santé du moteur » montre le
 * battement de chaque processus (pas seulement l'instance qui répond).
 *
 * Lot 111Q : catégorie d'état commune (« Attente de ressource », « Worker
 * indisponible », « Génération en cours », « Échec », « Terminé », « Annulé »),
 * temps en file / exécution / total SÉPARÉS, démarrage réel, dernière
 * activité, dernier battement du worker, durées par étape. Toutes les
 * lectures passent par `apiClient` (renouvellement du jeton d'accès de
 * 15 min) : fin du « Détail non chargé : Unauthorized (MISSING_TOKEN) » après
 * un quart d'heure de suivi ; session réellement expirée → message français,
 * « Se reconnecter », âge de la dernière lecture réussie (jamais un état
 * périmé présenté comme frais).
 *
 * NAVIGATION : page atteinte depuis Dashboard › Supervision (lien
 * « Diagnostics ») ; « Données du compte » n'y ajoute qu'un RACCOURCI (filtre
 * compte prérempli : `?scope=account&id=12`). Aucune entrée de barre latérale.
 *
 * Desktop et mobile (charte Sérénité) : formulaire en grille responsive,
 * boutons pleine largeur sur mobile ; historique en tableau (desktop) ou
 * colonnes réduites (mobile).
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Activity, AlertTriangle, ArrowLeft, Ban, Check, Copy, Download, Filter, Globe2, History, ListChecks, Loader2, RefreshCw, RotateCcw, Stethoscope } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EcranEnErreur } from '@/components/admin/EcranEnErreur';
import { copyText } from '../ai-executions/_components/CopyJson';
import { boGet, boPost, ensureFreshSession, freshnessLabel, reconnectHref, stopsPolling, type ReadFailure } from './_lib/bo-read';
import { workerHeadline } from '@/services/admin/diagnostic-jobs/wait';
import { DIAG_PROFILE_PHASE_LABELS, formatDuration, type DiagMetrics, type DiagTimings } from '@/services/admin/diagnostic-jobs/metrics';
import type { DiagScope } from '@/services/admin/diagnostics-export/model';
import type { GenerationRow } from '@/services/admin/export-generations';

const SCOPES: ReadonlyArray<{ key: DiagScope; label: string; idLabel: string | null }> = [
  { key: 'global', label: 'Ensemble de l’application (complet)', idLabel: null },
  { key: 'account', label: 'Filtre : un compte', idLabel: 'Identifiant du compte' },
  { key: 'user', label: 'Filtre : un utilisateur', idLabel: 'Identifiant de l’utilisateur' },
  { key: 'asset', label: 'Filtre : un bien et ses équipements', idLabel: 'Identifiant du bien' },
  { key: 'document', label: 'Filtre : un document', idLabel: 'Identifiant du document' },
  { key: 'operation', label: 'Filtre : un événement de référence (Opération)', idLabel: 'Identifiant de l’Opération' },
];

const STATUS_LABELS: Record<string, string> = {
  QUEUED: 'EN FILE', RUNNING: 'EN COURS', COMPLETE: 'COMPLETE', PARTIAL: 'PARTIAL', FAILED: 'FAILED', CANCELLED: 'ANNULÉ',
};
const ACTIVE = new Set(['QUEUED', 'RUNNING']);

const kib = (n: number) => (n < 1024 ? `${n} o` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} Kio` : `${(n / 1024 / 1024).toFixed(1)} Mio`);
const dateFr = (s: string | null | undefined) => (s ? new Date(s).toLocaleString('fr-FR') : '—');
function duree(a: string | null | undefined, b: string | null | undefined): string {
  if (!a) return '—';
  const ms = (b ? Date.parse(b) : Date.now()) - Date.parse(a);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}
function newKey(): string {
  try { return crypto.randomUUID(); } catch { return `k-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }
}

interface WaitView { reason: string; label: string; detail: string | null; action: string; blockingJobId: string | null; waitedSeconds?: number; alert?: boolean }
interface ReplacedView { id: string; previousStatus: 'QUEUED' | 'RUNNING'; outcome: 'CANCELLED' | 'CANCEL_REQUESTED' }

interface WorkerViewDto { instance: string; state: string; disabledReason?: string | null; alive: boolean; seenAt: string; lastTickAt: string | null; lastClaimAt: string | null; lane: 'main' | 'targeted' | null; waitReason: string | null; laneWaitReason: string | null; commit: string | null; version: string | null; aliveWorkers: number }

interface JobView {
  job: GenerationRow;
  /** Lot 111Q : lecture serveur, métriques séparées, catégorie, profilage, worker. */
  readAt?: string;
  metrics?: DiagMetrics;
  category?: { code: string; label: string };
  firstRunStartedAt?: string | null;
  lane?: string | null;
  timings?: DiagTimings | null;
  workerView?: WorkerViewDto | null;
  /** Lot 111C : statut explicite et raison d'attente. */
  statusLabel?: string;
  wait?: WaitView | null;
  downloadable: boolean;
  phaseLabel: string | null;
  errorLabel: string | null;
  progressPercent: number | null;
  report?: string | null;
  reportError?: string;
  /** Lot 113Q : relance automatique prévue ou non (et pourquoi) ; archive ZIP définitive. */
  retry?: { state: 'SCHEDULED' | 'NOT_TRANSIENT' | 'EXHAUSTED' | 'NOT_APPLICABLE'; label: string } | null;
  archive?: { bytes: number; sha256: string | null; entries: number | null; zip64: boolean; verifiedAt: string | null } | null;
}

function Diagnostics() {
  const sp = useSearchParams();
  const initialScope = (SCOPES.some((s) => s.key === sp.get('scope')) ? sp.get('scope') : 'global') as DiagScope;
  const [scope, setScope] = useState<DiagScope>(initialScope);
  const [id, setId] = useState(sp.get('id') ?? '');
  const [reinforced, setReinforced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(sp.get('job'));
  /** Clé d'idempotence de la demande en cours de saisie : un double clic ou un rejeu réseau rend le même travail. */
  const idemKey = useRef<string>(newKey());
  const [tick, setTick] = useState(0);
  const [needLogin, setNeedLogin] = useState(false);

  const def = SCOPES.find((s) => s.key === scope)!;
  const idValid = !def.idLabel || /^\d{1,9}$/.test(id.trim());
  const body = useMemo(() => ({ scope, ...(def.idLabel ? { id: id.trim() } : {}), reinforced }), [scope, id, reinforced, def.idLabel]);
  useEffect(() => { idemKey.current = newKey(); }, [body]);

  const generate = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const out = await boPost<Record<string, any>>('/api/admin/diagnostics/jobs', body, { 'Idempotency-Key': idemKey.current });
      if (!out.ok) {
        const f = out.failure;
        if (f.kind === 'SESSION_EXPIRED' || f.kind === 'MFA_REQUIRED') { setError(`${f.message} Votre demande n’a pas été enregistrée.`); setNeedLogin(true); return; }
        setError(`${out.serverMessage ?? f.message}${f.requestId ? ` — demande ${f.requestId.slice(0, 8)}` : ''}`);
        return;
      }
      const r = out.data;
      setNeedLogin(false);
      setSelected(String(r.jobId));
      const replaced = (r.replaced ?? []) as ReplacedView[];
      const wait = r.wait as WaitView | null | undefined;
      setNotice(r.duplicate
        ? `Une demande identique est déjà enregistrée : diagnostic ${String(r.jobId).slice(0, 8)} (aucun doublon créé).`
        : [
          `Diagnostic demandé : ${String(r.jobId).slice(0, 8)}. Il est produit en arrière-plan ; vous pouvez quitter la page et revenir le télécharger.`,
          replaced.length ? `Remplace ${replaced.map((x) => `${x.id.slice(0, 8)} (${x.outcome === 'CANCELLED' ? 'annulé' : 'annulation demandée'})`).join(', ')}.` : '',
          wait && wait.reason !== 'PICKUP_PENDING' ? `${wait.label}.` : '',
        ].filter(Boolean).join(' '));
      idemKey.current = newKey();
      setTick((t) => t + 1);
    } catch {
      setError('Erreur réseau — la demande n’a peut-être pas été enregistrée : « Réessayer » rejoue la MÊME demande (aucun doublon) ; consultez l’historique avant toute nouvelle demande.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin?tab=supervision" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3 w-3" /> Dashboard › Supervision
        </Link>
        <h1 className="vb-app-title flex items-center gap-2 mt-1">
          <Stethoscope className="h-6 w-6" />
          Diagnostics
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Un seul diagnostic, un seul ZIP pour toute analyse fonctionnelle ou technique : « Ensemble de l’application » contient toutes les données de tous les comptes et toutes les données techniques et transversales. Les filtres ne font que réduire le volume. La génération se fait en arrière-plan (elle continue si vous fermez la page) ; lecture seule ; chaque demande est journalisée.
        </p>
      </div>

      <section className="rounded-xl border bg-card p-4 space-y-4" aria-label="Paramètres du diagnostic">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <div className="space-y-1.5 sm:col-span-1 lg:col-span-2">
            <Label htmlFor="diag-scope">Périmètre</Label>
            <Select value={scope} onValueChange={(v) => setScope(v as DiagScope)}>
              <SelectTrigger id="diag-scope"><SelectValue /></SelectTrigger>
              <SelectContent>
                {SCOPES.map((s) => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {def.idLabel && (
            <div className="space-y-1.5">
              <Label htmlFor="diag-id">{def.idLabel}</Label>
              <Input id="diag-id" inputMode="numeric" value={id} onChange={(e) => setId(e.target.value)} placeholder="ex. 1234" aria-invalid={!idValid} />
            </div>
          )}
        </div>
        <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground flex items-start gap-2" data-diag-scope-note>
          {scope === 'global'
            ? <><Globe2 className="h-4 w-4 mt-0.5 shrink-0" /><span><span className="text-foreground font-medium">Niveau maximal.</span> Toutes les tables de tous les comptes et les tables transversales, tout l’historique, sans plafond (fichiers découpés en parties). Seuls les secrets et le contenu des conversations de l’assistant sont exclus (motifs dans le manifeste). <span className="text-foreground">La dernière demande globale est prioritaire :</span> elle remplace toute demande globale encore en attente ou en cours (les diagnostics filtrés ne sont pas touchés).</span></>
            : <><Filter className="h-4 w-4 mt-0.5 shrink-0" /><span><span className="text-foreground font-medium">Filtre du même moteur.</span> Volume réduit aux lignes liées à l’objet (et à celles qu’elles citent) ; aucune information absente de « Ensemble de l’application ». Les tables transversales (multi-comptes) n’y figurent pas.</span></>}
        </div>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox className="mt-0.5" checked={reinforced} onCheckedChange={(c) => setReinforced(c === true)} />
          <span>
            Diagnostic renforcé
            <span className="block text-xs text-muted-foreground">
              Joint les sorties du modèle IA encore conservées pour les traces du périmètre (rétention des diagnostics IA). Accès réservé
              (AI_MODEL_OUTPUT_ADMIN_IDS) et journalisé ; n’active aucune journalisation supplémentaire des échanges IA.
            </span>
          </span>
        </label>
        <div className="flex flex-col sm:flex-row gap-2">
          <Button onClick={generate} disabled={busy || !idValid} className="w-full sm:w-auto" data-diag-generate>
            {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Stethoscope className="h-4 w-4 mr-1.5" />}
            Générer le diagnostic
          </Button>
        </div>
        {!idValid && <p className="text-xs text-destructive">Identifiant attendu : nombre entier.</p>}
        {notice && <p className="text-xs text-muted-foreground" role="status">{notice}</p>}
      </section>

      {error && <EcranEnErreur titre="Diagnostic non demandé" message={error} onRetry={generate} />}
      {needLogin && <p className="text-xs"><Link className="underline" href={reconnectHref(selected)}>Se reconnecter</Link></p>}

      {selected && <JobPanel id={selected} onSelect={(x) => { setSelected(x); setTick((t) => t + 1); }} onChange={() => setTick((t) => t + 1)} />}

      <Generations refreshKey={tick} selected={selected} onSelect={setSelected} />

      <EngineHealth />
    </div>
  );
}

/** Identifiant complet, copiable. */
function CopyId({ value, label = 'ID' }: { value: string; label?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button type="button" className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground break-all text-left"
      onClick={async () => { setOk(await copyText(value)); setTimeout(() => setOk(false), 2000); }} title={`Copier ${label}`} aria-label={`Copier ${label} ${value}`}>
      {ok ? <Check className="h-3 w-3 shrink-0" /> : <Copy className="h-3 w-3 shrink-0" />}{value}
    </button>
  );
}

/**
 * Lot 107G — un diagnostic : statut, étape, progression réelle, tentatives,
 * dernière erreur (code stable), bilan par section, archive, relance.
 * Rafraîchi tant qu'il est en file ou en cours.
 */
function JobPanel({ id, onSelect, onChange }: { id: string; onSelect: (id: string) => void; onChange: () => void }) {
  const [v, setV] = useState<JobView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** Lot 111Q : dernier échec de LECTURE (session, réseau) — distinct de l'état du diagnostic. */
  const [failure, setFailure] = useState<ReadFailure | null>(null);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const load = useCallback(async () => {
    const r = await boGet<JobView>(`/api/admin/diagnostics/jobs/${id}`);
    if (!r.ok) { setFailure(r.failure); return; }
    setFailure(null);
    setErr(null);
    setLastOkAt(Date.now());
    setV(r.data);
  }, [id]);
  useEffect(() => { setV(null); setLastOkAt(null); setFailure(null); void load(); }, [load]);
  const active = v ? ACTIVE.has(v.job.status) : true;
  // Suivi : arrêté tant que l'administrateur doit agir (session expirée, droits) — jamais de boucle de 401.
  const blocked = failure ? stopsPolling(failure) : false;
  useEffect(() => {
    if (!active || blocked) return undefined;
    const t = setInterval(() => { void load(); }, 3000);
    return () => clearInterval(t);
  }, [active, blocked, load]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const copyReport = async () => {
    const r = await boGet<JobView>(`/api/admin/diagnostics/jobs/${id}?report=1`);
    if (!r.ok) { setCopied(r.failure.message); return; }
    if (!r.data.report) { setCopied(r.data.reportError ?? 'Rapport indisponible.'); return; }
    setCopied((await copyText(r.data.report)) ? 'Rapport synthétique copié (les données complètes sont dans le ZIP).' : 'Copie impossible.');
    setTimeout(() => setCopied(null), 4000);
  };
  const act = async (what: 'retry' | 'cancel') => {
    if (acting) return;
    setActing(true);
    try {
      const r = await boPost<{ jobId?: string }>(`/api/admin/diagnostics/jobs/${id}/${what}`);
      if (!r.ok) {
        if (stopsPolling(r.failure)) setFailure(r.failure);
        setErr(`${what === 'retry' ? 'Relance' : 'Annulation'} refusée : ${r.serverMessage ?? r.failure.message}`);
        return;
      }
      if (what === 'retry' && r.data.jobId) onSelect(String(r.data.jobId)); else { void load(); onChange(); }
    } finally {
      setActing(false);
    }
  };
  const download = async (href: string) => {
    // Lien direct (hors apiClient) : session renouvelée juste avant — sinon « MISSING_TOKEN » après 15 min.
    await ensureFreshSession();
    window.location.assign(href);
  };

  const readBanner = failure && (
    <div className="rounded-lg border px-3 py-2 text-xs space-y-1" role="alert" data-diag-read-failure={failure.kind}>
      <p className="font-medium flex items-center gap-1.5 text-destructive"><AlertTriangle className="h-3.5 w-3.5" />{failure.message}</p>
      <p className="text-muted-foreground">
        Dernière lecture réussie : {freshnessLabel(lastOkAt, now)}{lastOkAt ? ' — les informations ci-dessous datent de cette lecture.' : '.'}
        {failure.code ? <span className="ml-1 font-mono text-[10px] opacity-70">({failure.code}{failure.requestId ? ` · ${failure.requestId.slice(0, 8)}` : ''})</span> : null}
      </p>
      <div className="flex flex-wrap gap-2">
        {(failure.kind === 'SESSION_EXPIRED' || failure.kind === 'MFA_REQUIRED') && <Button asChild size="sm" variant="outline"><Link href={reconnectHref(id)}>Se reconnecter</Link></Button>}
        <Button size="sm" variant="outline" onClick={() => void load()}><RefreshCw className="h-3.5 w-3.5 mr-1.5" />Réessayer</Button>
      </div>
    </div>
  );

  if (!v) return <section className="rounded-xl border bg-card p-4 text-xs text-muted-foreground space-y-2" aria-label="Diagnostic sélectionné">{readBanner || err || <span className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" />Chargement du diagnostic…</span>}</section>;
  const j = v.job;
  const isJob = j.mode === 'job';
  const p = (j.progress ?? {}) as { filesDone?: number; filesPlanned?: number | null; current?: string | null; rssMb?: number | null; peakRssMb?: number | null; compressedBytes?: number };
  const attempts = (j.attemptsLog ?? []) as Array<{ attempt: number; worker: string; commit: string | null; startedAt: string; endedAt: string | null; outcome: string | null; errorCode: string | null; phase: string | null; lastProgress?: { current?: string | null; rssMb?: number | null; peakRssMb?: number | null } | null }>;
  const headline = v.workerView ? workerHeadline(v.workerView, j.status) : null;
  const sections = (j.sections ?? []) as Array<{ code: string; label: string; status: string; motif: string | null; expected: number; exported: number; files: number }>;
  return (
    <section className="rounded-xl border bg-card p-4 space-y-4" aria-label="Diagnostic sélectionné" data-diag-job={j.id}>
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
        <div className="min-w-0">
          <h2 className="vb-app-section">Diagnostic {j.targetType ?? 'global'}{j.targetId ? ` #${j.targetId}` : ''}{(j.perimeter as { reinforced?: boolean }).reinforced ? ' · renforcé' : ''}</h2>
          <CopyId value={j.id} label="l’identifiant du diagnostic" />
          {j.parentId && <p className="text-[11px] text-muted-foreground">Relance de <button type="button" className="underline" onClick={() => onSelect(j.parentId!)}>{j.parentId.slice(0, 8)}</button></p>}
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          {v.downloadable && (
            <Button asChild variant="outline" className="w-full sm:w-auto">
              <a href={`/api/admin/diagnostics/jobs/${j.id}/download`} download onClick={(e) => { e.preventDefault(); void download(`/api/admin/diagnostics/jobs/${j.id}/download`); }}><Download className="h-4 w-4 mr-1.5" />Télécharger le ZIP</a>
            </Button>
          )}
          {v.downloadable && <Button variant="outline" onClick={copyReport} className="w-full sm:w-auto"><Copy className="h-4 w-4 mr-1.5" />Copier le rapport synthétique</Button>}
          {isJob && !ACTIVE.has(j.status) && <Button variant="outline" onClick={() => act('retry')} disabled={acting} className="w-full sm:w-auto"><RotateCcw className="h-4 w-4 mr-1.5" />Relancer</Button>}
          {isJob && ACTIVE.has(j.status) && !j.cancelRequested && <Button variant="outline" onClick={() => act('cancel')} disabled={acting} className="w-full sm:w-auto"><Ban className="h-4 w-4 mr-1.5" />Annuler</Button>}
        </div>
      </div>
      {copied && <p className="text-xs text-muted-foreground" role="status">{copied}</p>}
      {readBanner}
      {err && <p className="text-xs text-destructive">{err}</p>}
      {v.wait && (
        <div className="rounded-lg border px-3 py-2 text-xs space-y-0.5" data-diag-wait={v.wait.reason} role="status">
          <p className={`font-medium flex items-center gap-1.5 ${v.wait.alert ? 'text-destructive' : ''}`}>{v.wait.alert ? <AlertTriangle className="h-3.5 w-3.5" /> : <Loader2 className="h-3.5 w-3.5 animate-spin" />}{v.wait.label}{v.wait.waitedSeconds != null ? ` · depuis ${duree(new Date(Date.now() - v.wait.waitedSeconds * 1000).toISOString(), null)}` : ''}</p>
          {v.wait.detail && v.wait.reason !== 'RETRY_SCHEDULED' && <p className="text-muted-foreground break-words">{v.wait.detail}</p>}
          <p className="text-muted-foreground">{v.wait.action}</p>
          {v.wait.blockingJobId && <p><button type="button" className="underline" onClick={() => onSelect(v.wait!.blockingJobId!)}>Voir le diagnostic {v.wait.blockingJobId.slice(0, 8)}</button></p>}
        </div>
      )}
      {j.replacedBy && (
        <p className="text-xs" data-diag-replaced-by={j.replacedBy}>
          {j.status === 'CANCELLED' ? 'Annulé — remplacé par la demande ' : 'Annulation demandée — remplacé par la demande '}
          <button type="button" className="underline font-mono" onClick={() => onSelect(j.replacedBy!)}>{j.replacedBy.slice(0, 8)}</button>
          {j.cancelRequestedAt ? ` (${dateFr(j.cancelRequestedAt)})` : ''}
        </p>
      )}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label={v.category ? `État : ${v.category.label}` : 'Statut'} value={v.statusLabel ?? `${STATUS_LABELS[j.status] ?? j.status}${j.leaseExpired ? ' (sans signe de vie)' : ''}`} warn={!['COMPLETE', 'QUEUED', 'RUNNING'].includes(j.status) || j.leaseExpired || !!v.wait?.alert || j.cancelRequested} data={v.category?.code} />
        <Stat label={ACTIVE.has(j.status) ? 'Étape' : 'Étape (arrêtée)'} value={!ACTIVE.has(j.status) && j.errorPhase ? `Arrêt à l’étape ${j.errorPhase}` : v.phaseLabel ?? '—'} />
        <Stat label="Progression" value={v.progressPercent == null ? '—' : `${v.progressPercent} % (${p.filesDone ?? 0} / ${p.filesPlanned ?? '?'} fichiers)`} />
        <Stat label={isJob && j.status === 'RUNNING' ? 'Tentative en cours' : 'Tentatives'} value={isJob ? (v.retry && (v.retry.state === 'NOT_TRANSIENT' || v.retry.state === 'EXHAUSTED') ? `${j.attempt} (sans relance automatique)` : `${j.attempt} / ${j.maxAttempts ?? '?'}`) : '—'} warn={v.retry?.state === 'NOT_TRANSIENT' || v.retry?.state === 'EXHAUSTED'} />
      </div>
      {/* Lot 113Q : relance automatique dite explicitement — « 1 / 3 » ne laisse plus croire qu'une relance est prévue. */}
      {v.retry && v.retry.state !== 'NOT_APPLICABLE' && (
        <p className={`text-xs ${v.retry.state === 'SCHEDULED' ? 'text-muted-foreground' : 'text-destructive'}`} data-diag-retry={v.retry.state} role="status">{v.retry.label}</p>
      )}
      {v.archive && (
        <p className="text-xs text-muted-foreground" data-diag-archive>
          Archive ZIP prête : {kib(v.archive.bytes)} · {v.archive.entries ?? '?'} fichier(s){v.archive.zip64 ? ' · format ZIP64' : ''} · vérifiée le {dateFr(v.archive.verifiedAt)}{v.archive.sha256 ? <> · SHA-256 <span className="font-mono break-all">{v.archive.sha256.slice(0, 16)}…</span></> : null}
        </p>
      )}
      {/* Lot 111Q : trois mesures distinctes — l'attente en file n'est jamais une durée de génération. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3" data-diag-metrics>
        <Stat label={v.metrics?.started ? 'Temps en file (avant démarrage)' : 'Temps en file (non démarré)'} value={v.metrics ? formatDuration(v.metrics.queueWaitMs) : '—'} warn={!v.metrics?.started && !!v.wait?.alert} />
        <Stat label="Temps d’exécution (génération)" value={v.metrics?.started ? formatDuration(v.metrics.executionMs) : 'non démarrée'} />
        <Stat label="Temps total depuis la demande" value={v.metrics ? formatDuration(v.metrics.totalElapsedMs) : duree(j.startedAt, j.finishedAt)} />
      </div>
      {v.progressPercent != null && ACTIVE.has(j.status) && (
        <div className="h-2 w-full rounded-full bg-muted overflow-hidden" role="progressbar" aria-valuenow={v.progressPercent} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-primary transition-all" style={{ width: `${v.progressPercent}%` }} />
        </div>
      )}
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-xs">
        <div><dt className="inline text-muted-foreground">Demandé le : </dt><dd className="inline">{dateFr(j.startedAt)}</dd></div>
        <div><dt className="inline text-muted-foreground">Démarrage réel : </dt><dd className="inline">{v.firstRunStartedAt ? dateFr(v.firstRunStartedAt) : 'pas encore démarré'}{v.lane ? ` · voie ${v.lane === 'targeted' ? 'réservée aux ciblés' : 'commune'}` : ''}</dd></div>
        <div><dt className="inline text-muted-foreground">Dernière activité : </dt><dd className="inline">{dateFr(j.heartbeatAt)}</dd></div>
        <div><dt className="inline text-muted-foreground">Terminé le : </dt><dd className="inline">{dateFr(j.finishedAt)}</dd></div>
        {v.workerView && (
          <div className="sm:col-span-2" data-diag-worker-view>
            {/* Lot 113K (#699) : « Worker disponible » seulement si démarré, vivant et au moins un worker vivant ; sinon l'état réel. */}
            <dt className={`inline ${headline!.problem ? 'text-destructive font-medium' : 'text-muted-foreground'}`} data-diag-worker-headline={headline!.code}>{headline!.label} : </dt>
            <dd className="inline font-mono">{v.workerView.instance}{v.workerView.commit ? ` · ${v.workerView.commit.slice(0, 10)}` : ''}</dd>
            <dd className={`inline ${v.workerView.alive ? '' : 'text-destructive'}`}> — battement {dateFr(v.workerView.seenAt)}{v.workerView.alive ? '' : ' (sans signe de vie)'} · dernier tour {dateFr(v.workerView.lastTickAt)} · dernier prélèvement {dateFr(v.workerView.lastClaimAt)} · workers vivants : {v.workerView.aliveWorkers}</dd>
          </div>
        )}
        {v.readAt && <div className="sm:col-span-2 text-muted-foreground">Lu sur le serveur {freshnessLabel(Date.parse(v.readAt), now)} ({dateFr(v.readAt)})</div>}
        <div><dt className="inline text-muted-foreground">Initiateur : </dt><dd className="inline">administrateur #{j.adminUserId ?? '?'}</dd></div>
        <div><dt className="inline text-muted-foreground">{ACTIVE.has(j.status) ? 'Fichier en cours : ' : 'Dernier fichier traité : '}</dt><dd className="inline font-mono break-all">{p.current ?? '—'}</dd></div>
        <div><dt className="inline text-muted-foreground">Volume : </dt><dd className="inline">{j.bytes != null ? kib(j.bytes) : p.compressedBytes ? `${kib(p.compressedBytes)} compressés` : '—'}{j.rowsExported != null ? ` · ${j.rowsExported} / ${j.rowsExpected ?? '?'} lignes` : ''}</dd></div>
        <div><dt className="inline text-muted-foreground">Mémoire du worker : </dt><dd className="inline">{p.rssMb != null ? `${p.rssMb} Mo (pic ${p.peakRssMb ?? '?'} Mo)` : '—'}</dd></div>
        <div><dt className="inline text-muted-foreground">Worker / version : </dt><dd className="inline font-mono">{j.worker ?? '—'}{j.buildCommit ? ` · ${j.buildCommit.slice(0, 10)}` : ''}</dd></div>
        <div><dt className="inline text-muted-foreground">Instantané : </dt><dd className="inline">{j.snapshotAt ?? '—'}</dd></div>
        {j.requestId && <div><dt className="inline text-muted-foreground">Demande : </dt><dd className="inline"><CopyId value={j.requestId} label="l’identifiant de la demande" /></dd></div>}
        {j.nextAttemptAt && j.status === 'QUEUED' && <div><dt className="inline text-muted-foreground">Nouvelle tentative : </dt><dd className="inline">{dateFr(j.nextAttemptAt)}</dd></div>}
        {j.expiresAt && <div><dt className="inline text-muted-foreground">Archive conservée jusqu’au : </dt><dd className="inline">{j.purgedAt ? `purgée le ${dateFr(j.purgedAt)}` : dateFr(j.expiresAt)}</dd></div>}
      </dl>
      {v.timings && Object.keys(v.timings.phases ?? {}).length > 0 && (
        <div className="overflow-x-auto" data-diag-timings>
          {/* Lot 113Q : « en cours » seulement pour une génération ACTIVE ; une tentative arrêtée a des durées figées. */}
          <p className="text-xs font-medium mb-1">Durées par étape (tentative {v.timings.attempt}{timingsState(v.timings, ACTIVE.has(j.status))})</p>
          <table className="w-full text-xs">
            <tbody>
              {Object.entries(v.timings.phases).filter(([, ms]) => (ms ?? 0) > 0 || v.timings?.current?.phase).map(([ph, ms]) => {
                const live = ACTIVE.has(j.status) && !v.timings?.ended && v.timings?.current?.phase === ph;
                const stopped = !ACTIVE.has(j.status) && (v.timings?.ended?.phase === ph || (!v.timings?.ended && !v.timings?.final && v.timings?.current?.phase === ph));
                const mem = v.timings?.memory?.byPhase?.[ph];
                return (
                  <tr key={ph} className="border-b last:border-b-0"><td className="px-2 py-1">{DIAG_PROFILE_PHASE_LABELS[ph] ?? ph}{live ? ' (en cours)' : stopped ? ' (arrêt ici)' : ''}</td><td className="px-2 py-1 text-right tabular-nums">{formatDuration(ms ?? 0)}</td><td className="px-2 py-1 text-right tabular-nums text-muted-foreground hidden sm:table-cell">{mem ? `pic ${mem.rssMb} Mo` : ''}</td></tr>
                );
              })}
            </tbody>
          </table>
          {v.timings.memory && <MemoryProfile m={v.timings.memory} q={v.timings.queries ?? null} />}
          {v.timings.slowestFiles.length > 0 && (
            <details className="mt-1 text-xs"><summary className="cursor-pointer text-muted-foreground">Fichiers les plus longs à produire</summary>
              <ul className="mt-1 space-y-0.5">{v.timings.slowestFiles.map((f) => <li key={f.path} className="font-mono break-all">{f.path} — {formatDuration(f.ms)} · {kib(f.bytes)}</li>)}</ul>
            </details>
          )}
        </div>
      )}
      {(j.errorCode || j.error) && (
        <div className="rounded-lg border px-3 py-2 text-xs space-y-0.5" data-diag-last-error>
          <p className="font-medium flex items-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5" />Dernière erreur{j.errorCode ? ` — ${j.errorCode}` : ''}{j.errorPhase ? ` (étape ${j.errorPhase})` : ''}{j.errorAt ? ` · ${dateFr(j.errorAt)}` : ''}</p>
          {v.errorLabel && <p className="text-muted-foreground">{v.errorLabel}</p>}
          {j.error && <p className="text-destructive break-words">{j.error}</p>}
        </div>
      )}
      {attempts.length > 0 && (
        <div className="overflow-x-auto">
          <p className="text-xs font-medium mb-1">Historique des tentatives</p>
          <table className="w-full text-xs">
            <thead><tr className="text-left text-muted-foreground border-b"><th className="px-2 py-1 font-medium">#</th><th className="px-2 py-1 font-medium">Début</th><th className="px-2 py-1 font-medium">Issue</th><th className="px-2 py-1 font-medium hidden sm:table-cell">Étape</th><th className="px-2 py-1 font-medium hidden md:table-cell">Worker</th><th className="px-2 py-1 font-medium hidden md:table-cell">Dernier signe</th></tr></thead>
            <tbody>
              {attempts.map((a) => (
                <tr key={a.attempt} className="border-b last:border-b-0 align-top">
                  <td className="px-2 py-1">{a.attempt}</td>
                  <td className="px-2 py-1 whitespace-nowrap">{dateFr(a.startedAt)}</td>
                  <td className="px-2 py-1">{a.outcome ?? (ACTIVE.has(j.status) && a.attempt === j.attempt ? 'en cours' : 'interrompue (sans clôture)')}{a.errorCode ? ` · ${a.errorCode}` : ''}</td>
                  <td className="px-2 py-1 hidden sm:table-cell">{a.phase ?? '—'}</td>
                  <td className="px-2 py-1 hidden md:table-cell font-mono">{String(a.worker).split(':').slice(0, 2).join(':')}{a.commit ? ` · ${a.commit.slice(0, 8)}` : ''}</td>
                  <td className="px-2 py-1 hidden md:table-cell break-all">{a.lastProgress ? `${a.lastProgress.current ?? '—'}${a.lastProgress.rssMb ? ` · ${a.lastProgress.rssMb} Mo (pic ${a.lastProgress.peakRssMb ?? '?'})` : ''}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {sections.length > 0 && (
        <div className="rounded-xl border overflow-x-auto" data-diag-sections>
          <div className="flex items-center gap-1.5 border-b px-4 py-2 text-sm font-medium"><ListChecks className="h-4 w-4" />Sections du diagnostic</div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b">
                <th className="px-3 py-2 font-medium">Section</th>
                <th className="px-3 py-2 font-medium">Statut</th>
                <th className="px-3 py-2 font-medium hidden sm:table-cell text-right">Lignes (exportées / attendues)</th>
                <th className="px-3 py-2 font-medium hidden md:table-cell">Motif</th>
              </tr>
            </thead>
            <tbody>
              {sections.map((x) => (
                <tr key={x.code} className="border-b last:border-b-0 align-top">
                  <td className="px-3 py-2 text-xs">{x.label}<span className="block text-[11px] text-muted-foreground">{x.files} fichier(s)</span>{x.motif && <span className="block md:hidden text-[11px] text-muted-foreground break-words">{x.motif}</span>}</td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap"><span className={x.status === 'PARTIAL' || x.status === 'ERROR' ? 'text-destructive font-medium' : x.status === 'NOT_APPLICABLE' ? 'text-muted-foreground' : ''}>{x.status}</span></td>
                  <td className="px-3 py-2 text-xs text-right tabular-nums hidden sm:table-cell">{x.files ? `${x.exported} / ${x.expected}` : '—'}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground hidden md:table-cell break-words">{x.motif ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Lot 113Q : état du profilage d'une tentative (jamais « en cours » après l'arrêt). */
function timingsState(t: DiagTimings, active: boolean): string {
  if (t.final) return ', terminée';
  if (t.ended) return `, arrêtée${t.ended.code ? ` (${t.ended.code}` : ''}${t.ended.phase ? `${t.ended.code ? ', ' : ' ('}étape ${t.ended.phase}` : ''}${t.ended.code || t.ended.phase ? ')' : ''}`;
  return active ? ', en cours' : ', interrompue';
}

/**
 * Lot 113Q — mesures mémoire d'une tentative (BO, lisibles sans accès
 * serveur) : au démarrage, au pic (RSS du processus, tas V8, mémoire native,
 * ArrayBuffer, conteneur), fichiers au pic le plus haut et à la plus forte
 * croissance ; requêtes de lecture (nombre, durée, grosses lignes).
 */
function MemoryProfile({ m, q }: { m: NonNullable<DiagTimings['memory']>; q: DiagTimings['queries'] | null }) {
  const pt = (p: { rssMb: number; heapUsedMb: number; externalMb: number; arrayBuffersMb: number; containerUsedMb?: number | null } | null) =>
    (p ? `${p.rssMb} Mo (tas ${p.heapUsedMb} · natif ${p.externalMb} · tampons ${p.arrayBuffersMb}${p.containerUsedMb != null ? ` · conteneur ${p.containerUsedMb}` : ''})` : '—');
  return (
    <details className="mt-1 text-xs" data-diag-memory open>
      <summary className="cursor-pointer text-muted-foreground">Mémoire mesurée (processus entier)</summary>
      <dl className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-0.5">
        <div><dt className="inline text-muted-foreground">Au démarrage : </dt><dd className="inline tabular-nums">{pt(m.initial)}</dd></div>
        <div><dt className="inline text-muted-foreground">Pic : </dt><dd className="inline tabular-nums">{pt(m.peak)}</dd></div>
        {q && <div className="sm:col-span-2"><dt className="inline text-muted-foreground">Lectures : </dt><dd className="inline tabular-nums">{q.count} requête(s), {formatDuration(q.ms)} · {q.rows} ligne(s) · {kib(q.bytes)}{q.oversizedRows ? ` · ${q.oversizedRows} très grosse(s) ligne(s) lue(s) seule(s) (max ${kib(q.maxRowBytes)})` : ''}</dd></div>}
      </dl>
      {m.files.length > 0 && (
        <div className="mt-1 overflow-x-auto">
          <p className="text-muted-foreground">Fichiers au pic mémoire le plus haut (début → pic → fin)</p>
          <ul className="space-y-0.5">{m.files.slice(0, 8).map((f) => <li key={`p-${f.path}`} className="font-mono break-all">{f.path} — {f.startRssMb} → {f.peakRssMb} → {f.endRssMb} Mo · {formatDuration(f.ms)}</li>)}</ul>
        </div>
      )}
      {m.growth.length > 0 && (
        <div className="mt-1 overflow-x-auto">
          <p className="text-muted-foreground">Plus forte croissance pendant la production</p>
          <ul className="space-y-0.5">{m.growth.slice(0, 5).map((f) => <li key={`g-${f.path}`} className="font-mono break-all">{f.path} — +{Math.max(0, f.peakRssMb - f.startRssMb)} Mo</li>)}</ul>
        </div>
      )}
    </details>
  );
}

/**
 * Lots 81C, 107G — historique des générations d'export (diagnostics, « Données
 * du compte », recette, exécutions IA) : liste LÉGÈRE et paginée, rafraîchie
 * tant qu'une génération est en file ou en cours. Une erreur de chargement de
 * la liste n'est jamais confondue avec un échec de génération.
 */
function Generations({ refreshKey, selected, onSelect }: { refreshKey: number; selected: string | null; onSelect: (id: string) => void }) {
  const [rows, setRows] = useState<Array<GenerationRow & { statusLabel?: string; category?: { code: string; label: string } }> | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [err, setErr] = useState<string | null>(null);
  const [failure, setFailure] = useState<ReadFailure | null>(null);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const pageSize = 10;
  const load = useCallback(async () => {
    // Lot 111Q : apiClient (renouvellement du jeton d'accès) ; échec de lecture ≠ échec de génération.
    const r = await boGet<{ items: Array<GenerationRow & { statusLabel?: string }>; total: number }>(`/api/admin/diagnostics/generations?page=${page}&pageSize=${pageSize}`);
    if (!r.ok) {
      setFailure(r.failure);
      setErr(`Liste non chargée : ${r.failure.message} Les générations en cours ne sont pas concernées.`);
      return;
    }
    setErr(null);
    setFailure(null);
    setLastOkAt(Date.now());
    setRows(r.data.items);
    setTotal(Number(r.data.total) || 0);
  }, [page]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  const activeNow = rows?.some((r) => ACTIVE.has(r.status)) ?? false;
  const blocked = failure ? stopsPolling(failure) : false;
  useEffect(() => {
    if (!activeNow || blocked) return undefined;
    const t = setInterval(() => { void load(); }, 5000);
    return () => clearInterval(t);
  }, [activeNow, blocked, load]);
  const retry = async (id: string) => {
    const r = await boPost<{ jobId?: string }>(`/api/admin/diagnostics/jobs/${id}/retry`);
    if (r.ok && r.data.jobId) { onSelect(String(r.data.jobId)); void load(); } else if (!r.ok) setErr(`Relance refusée : ${r.serverMessage ?? r.failure.message}`);
  };
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <section className="rounded-xl border bg-card overflow-x-auto" aria-label="Générations d’export">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
        <h2 className="vb-app-section flex items-center gap-1.5"><History className="h-4 w-4" />Générations d’export</h2>
        <Button variant="outline" size="sm" onClick={() => void load()} className="gap-1.5"><RefreshCw className="h-3.5 w-3.5" />Actualiser</Button>
      </div>
      {err && <p className="px-4 py-2 text-xs text-destructive" data-diag-list-error>{err}{rows ? ` Dernière lecture réussie : ${freshnessLabel(lastOkAt, Date.now())}.` : ''}{failure && (failure.kind === 'SESSION_EXPIRED' || failure.kind === 'MFA_REQUIRED') ? <> <Link className="underline" href={reconnectHref(selected)}>Se reconnecter</Link></> : null}</p>}
      {rows && !rows.length && <p className="px-4 py-3 text-xs text-muted-foreground">Aucune génération enregistrée.</p>}
      {rows && rows.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground border-b">
              <th className="px-3 py-2 font-medium">Début</th>
              <th className="px-3 py-2 font-medium">Export</th>
              <th className="px-3 py-2 font-medium">Statut</th>
              <th className="px-3 py-2 font-medium hidden sm:table-cell">Tentatives</th>
              <th className="px-3 py-2 font-medium hidden md:table-cell text-right">Temps total · taille</th>
              <th className="px-3 py-2 font-medium"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const p = (r.progress ?? {}) as { filesDone?: number; filesPlanned?: number | null };
              const isDiagJob = r.kind === 'TECH_DIAGNOSTIC' && r.mode === 'job';
              return (
                <tr key={r.id} className={`border-b last:border-b-0 align-top ${selected === r.id ? 'bg-muted/40' : ''}`}>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">{dateFr(r.startedAt)}</td>
                  <td className="px-3 py-2 text-xs">
                    {r.kind === 'TECH_DIAGNOSTIC' ? 'Diagnostic' : r.kind === 'RECETTE_EXPORT' ? 'Export de recette' : r.kind === 'AI_EXECUTIONS_EXPORT' ? 'Exécutions IA' : 'Données du compte'}
                    {r.mode === 'job' ? '' : ` · ${r.mode}`}{r.targetType ? ` · ${r.targetType}${r.targetId ? ` #${r.targetId}` : ''}` : ''}
                    {r.adminUserId ? <span className="text-muted-foreground"> · admin #{r.adminUserId}</span> : null}
                    <span className="block"><CopyId value={r.id} /></span>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <span className={r.status === 'COMPLETE' ? '' : ACTIVE.has(r.status) ? 'text-muted-foreground' : 'text-destructive font-medium'} data-diag-status-label>
                      {ACTIVE.has(r.status) ? <span className="inline-flex items-center gap-1">{r.status === 'RUNNING' && !r.cancelRequested && <Loader2 className="h-3 w-3 animate-spin" />}{r.statusLabel ?? STATUS_LABELS[r.status]}</span> : r.statusLabel ?? STATUS_LABELS[r.status] ?? r.status}
                    </span>
                    {r.category && <span className="block text-[11px] text-muted-foreground" data-diag-category={r.category.code}>{r.category.label}</span>}
                    {r.phase && ACTIVE.has(r.status) && <span className="block text-[11px] text-muted-foreground">{r.phase}{p.filesPlanned ? ` · ${p.filesDone ?? 0}/${p.filesPlanned}` : ''}{r.leaseExpired ? ' · sans signe de vie' : ''}</span>}
                    {r.errorCode && <span className="block text-[11px] text-destructive">{r.errorCode}{r.errorPhase ? ` (${r.errorPhase})` : ''}</span>}
                    {r.error && <span className="block text-[11px] text-destructive break-words line-clamp-3">{r.error}</span>}
                  </td>
                  <td className="px-3 py-2 text-xs hidden sm:table-cell">{r.mode === 'job' ? `${r.attempt} / ${r.maxAttempts ?? '?'}` : '—'}{r.parentId ? <span className="block text-[11px] text-muted-foreground">relance de {r.parentId.slice(0, 8)}</span> : null}</td>
                  <td className="px-3 py-2 text-xs text-right tabular-nums hidden md:table-cell">{duree(r.startedAt, r.finishedAt)}{r.bytes != null ? ` · ${kib(r.bytes)}` : ''}</td>
                  <td className="px-3 py-2 text-xs">
                    {r.kind === 'TECH_DIAGNOSTIC' && <button type="button" className="underline whitespace-nowrap" onClick={() => onSelect(r.id)}>Voir</button>}
                    {isDiagJob && !ACTIVE.has(r.status) && <button type="button" className="underline whitespace-nowrap block mt-1" onClick={() => void retry(r.id)}>Relancer</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 px-4 py-2 text-xs">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Précédentes</Button>
          <span className="tabular-nums">{page} / {pages}</span>
          <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Suivantes</Button>
        </div>
      )}
    </section>
  );
}

interface Health {
  checkedAt: string;
  build: { version: string; commit: string | null; container: string | null };
  worker: { workerId: string; started: boolean; running: boolean; startedAt: string | null; lastTickAt: string | null; lastTickError: string | null; currentJobId: string | null; disabledReason: string | null; processed: number };
  process: { rssMb: number; heapUsedMb: number; containerLimitMb: number | null; guardMb: number | null; uptimeSeconds: number };
  storageConfigured: boolean;
  workers?: Array<{ instance: string; process: string; placement: string; state: string; disabledReason: string | null; alive: boolean; seenAt: string; lastTickAt: string | null; lastClaimAt: string | null; currentJobId: string | null; waitReason: string | null; lastError: string | null; commit: string | null; rssMb: number | null; containerLimitMb: number | null; laneJobId?: string | null; laneWaitReason?: string | null; laneCapacity?: number | null }>;
  waits?: Array<{ jobId: string; label: string; action: string; alert: boolean; waitedSeconds: number }>;
  queue: null | { migrationApplied: boolean; byStatus?: Record<string, number>; oldestQueuedAgeSeconds?: number | null; running?: Array<{ id: string; phase: string | null; attempt: number; maxAttempts: number; worker: string | null; leaseExpired: boolean; heartbeatAt: string | null }>; recentFailures?: Array<{ id: string; status: string; code: string | null; phase: string | null; at: string | null; message: string | null; attempt: number; maxAttempts: number | null; commit: string | null }> };
  alerts: string[];
}

/**
 * Lot 107G — santé du moteur de diagnostic, SANS générer de diagnostic :
 * worker de l'instance, file, orphelins, dernières erreurs (codes stables),
 * mémoire du processus, version exécutée.
 */
function EngineHealth() {
  const [h, setH] = useState<Health | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await boGet<Health>('/api/admin/diagnostics/jobs/health');
      if (!r.ok) { setErr(`Santé non chargée : ${r.failure.message}`); return; }
      setErr(null);
      setH(r.data);
    } finally {
      setLoading(false);
    }
  }, []);
  return (
    <section className="rounded-xl border bg-card" aria-label="Santé du moteur de diagnostic">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b px-4 py-2">
        <h2 className="vb-app-section flex items-center gap-1.5"><Activity className="h-4 w-4" />Santé du moteur de diagnostic</h2>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={() => { setOpen(true); void load(); }} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}Vérifier
          </Button>
          {h && <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={async () => { setCopied(await copyText(JSON.stringify(h, null, 2))); setTimeout(() => setCopied(false), 2000); }}>
            {copied ? <Check className="h-3.5 w-3.5 mr-1.5" /> : <Copy className="h-3.5 w-3.5 mr-1.5" />}Copier l’état
          </Button>}
        </div>
      </div>
      {!open && <p className="px-4 py-3 text-xs text-muted-foreground">Vérifie le worker, la file, les orphelins et les dernières erreurs sans lancer de diagnostic.</p>}
      {err && <p className="px-4 py-2 text-xs text-destructive">{err}</p>}
      {open && h && (
        <div className="p-4 space-y-3 text-xs" data-diag-health>
          {h.alerts.length > 0
            ? <ul className="space-y-1">{h.alerts.map((a, i) => <li key={i} className="text-destructive flex items-start gap-1.5"><AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /><span className="break-words">{a}</span></li>)}</ul>
            : <p className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5" />Aucune alerte.</p>}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="Worker (instance qui répond)" value={h.worker.disabledReason ? `désactivé (${h.worker.disabledReason})` : h.worker.started ? (h.worker.currentJobId ? `occupé (${h.worker.currentJobId.slice(0, 8)})` : 'prêt') : 'non démarré ici'} warn={!h.worker.started && !(h.workers ?? []).some((w) => w.alive && w.state === 'STARTED')} />
            <Stat label="Dernier tour" value={h.worker.lastTickAt ? dateFr(h.worker.lastTickAt) : '—'} />
            <Stat label="Mémoire du processus" value={`${h.process.rssMb} Mo${h.process.containerLimitMb ? ` / ${h.process.containerLimitMb} Mo` : ''}`} />
            <Stat label="Version" value={`${h.build.version}${h.build.commit ? ` · ${h.build.commit.slice(0, 10)}` : ''}`} />
          </div>
          {h.queue?.byStatus && <p>File : {Object.entries(h.queue.byStatus).map(([k, n]) => `${STATUS_LABELS[k] ?? k} ${n}`).join(' · ') || 'vide'}{h.queue.oldestQueuedAgeSeconds != null ? ` · plus ancien en attente : ${Math.round(h.queue.oldestQueuedAgeSeconds / 60)} min` : ''}</p>}
          {h.workers && (
            <div className="overflow-x-auto" data-diag-workers>
              <p className="font-medium mb-1">Workers de diagnostics (toutes les instances, battements en base)</p>
              {!h.workers.length && <p className="text-destructive">Aucun battement enregistré : aucun processus n’a démarré la supervision du worker (migration 1200 appliquée ? application redémarrée ?).</p>}
              {h.workers.length > 0 && (
                <table className="w-full">
                  <thead><tr className="text-left text-muted-foreground border-b"><th className="px-2 py-1 font-medium">Instance</th><th className="px-2 py-1 font-medium">État</th><th className="px-2 py-1 font-medium hidden sm:table-cell">Dernier tour</th><th className="px-2 py-1 font-medium hidden md:table-cell">Raison d’attente · erreur</th></tr></thead>
                  <tbody>{h.workers.map((w) => (
                    <tr key={w.instance + w.seenAt} className="border-b last:border-b-0 align-top">
                      <td className="px-2 py-1 font-mono break-all">{w.instance}<span className="block text-muted-foreground">{w.process} · traitements de fond : {w.placement}{w.commit ? ` · ${w.commit.slice(0, 8)}` : ''}</span></td>
                      <td className={`px-2 py-1 ${!w.alive || w.state !== 'STARTED' ? 'text-destructive' : ''}`}>
                        {!w.alive ? `sans signe de vie depuis ${dateFr(w.seenAt)}` : w.state === 'STARTED' ? (w.currentJobId ? `occupé (${w.currentJobId.slice(0, 8)})` : 'démarré') : w.state === 'DISABLED' ? `désactivé (${w.disabledReason ?? '?'})` : w.state === 'NOT_THIS_PROCESS' ? 'non porté par ce processus' : w.state}
                      </td>
                      <td className="px-2 py-1 hidden sm:table-cell whitespace-nowrap">{dateFr(w.lastTickAt)}{w.lastClaimAt ? <span className="block text-muted-foreground">prélèvement {dateFr(w.lastClaimAt)}</span> : null}</td>
                      <td className="px-2 py-1 hidden md:table-cell break-words">{w.waitReason ?? '—'}{w.laneCapacity ? <span className="block text-muted-foreground">voie ciblée : {w.laneJobId ? `occupée (${w.laneJobId.slice(0, 8)})` : (w.laneWaitReason ?? 'libre')}</span> : null}{w.lastError ? <span className="block text-destructive">{w.lastError}</span> : null}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
            </div>
          )}
          {(h.queue?.recentFailures?.length ?? 0) > 0 && (
            <div className="overflow-x-auto">
              <p className="font-medium mb-1">Dernières erreurs</p>
              <table className="w-full">
                <thead><tr className="text-left text-muted-foreground border-b"><th className="px-2 py-1 font-medium">Quand</th><th className="px-2 py-1 font-medium">Code</th><th className="px-2 py-1 font-medium hidden sm:table-cell">Étape</th><th className="px-2 py-1 font-medium">Diagnostic</th></tr></thead>
                <tbody>{h.queue!.recentFailures!.map((f) => (
                  <tr key={f.id} className="border-b last:border-b-0 align-top">
                    <td className="px-2 py-1 whitespace-nowrap">{dateFr(f.at)}</td>
                    <td className="px-2 py-1">{f.code}<span className="block text-muted-foreground break-words">{f.message}</span></td>
                    <td className="px-2 py-1 hidden sm:table-cell">{f.phase ?? '—'}</td>
                    <td className="px-2 py-1"><CopyId value={f.id} /><span className="block text-muted-foreground">tentative {f.attempt}/{f.maxAttempts ?? '?'}{f.commit ? ` · ${f.commit.slice(0, 8)}` : ''}</span></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          <p className="text-muted-foreground">Vérifié le {dateFr(h.checkedAt)} · instance {h.worker.workerId} · stockage {h.storageConfigured ? 'configuré' : 'NON configuré'}</p>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, warn = false, data }: { label: string; value: string; warn?: boolean; data?: string }) {
  return (
    <div className="rounded-xl border bg-card p-3" data-diag-state={data}>
      <p className={`text-sm font-semibold break-words ${warn ? 'text-destructive' : 'text-foreground'}`}>{value}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
    </div>
  );
}

export default function DiagnosticsPage() {
  return (
    <Suspense fallback={null}>
      <Diagnostics />
    </Suspense>
  );
}
