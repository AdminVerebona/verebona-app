"use client";

/**
 * Export diagnostic des exécutions IA — lot 84D (EXP-01 à EXP-05, R27, R28,
 * R63, R64 ; décision PO 15) et carte #802 : « un seul ZIP complet et
 * vérifiable, ou un blocage explicite demandant de réduire la sélection ».
 *
 *   · « Exporter le diagnostic complet (ZIP) » : PRÉCONTRÔLE côté serveur des
 *     filtres ACTIFS de l'écran (journal des exécutions ou onglet « Appels
 *     modèles ») — nombre attendu, taille estimée, limite, annonces
 *     (historique, appels techniques autonomes). Un filtre sans traduction ou
 *     une sélection trop volumineuse BLOQUE ici : rien n'est lancé, les
 *     filtres de l'écran sont conservés ;
 *   · « Confirmer et générer le ZIP » : génération EN TÂCHE DE FOND (le BO
 *     reste utilisable), suivie ; une génération interrompue se REPREND à son
 *     dernier point de reprise ; option « avec contenus des échanges »
 *     proposée seulement à un administrateur habilité
 *     (`AI_MODEL_OUTPUT_ADMIN_IDS`, revérifié côté serveur) ;
 *   · une fois l'archive assemblée, relue et vérifiée : UN SEUL lien
 *     « Télécharger le ZIP complet ». Règle remplacée (carte #802) : plus de
 *     volumes ZIP ni de fichiers JSONL téléchargeables un par un ; un export
 *     arrêté (limite, complétude) n'offre aucun téléchargement.
 * Ordinateur et mobile : lignes qui s'enroulent, boutons qui passent à la
 * ligne, cibles tactiles ≥ 44 px sur mobile, couleurs de la charte Sérénité.
 */
import { useCallback, useEffect, useState } from 'react';
import { Download, Loader2, PackageCheck, Play, RotateCcw, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client';
import type { ExecutionsManifest, ExportFailure } from '@/services/ai/business-execution/export-model';
import { formatBytes, formatDuration, type ExecutionsExportLimits } from '@/services/ai/business-execution/export-settings';

export interface ExportGeneration {
  id: string;
  status: 'RUNNING' | 'COMPLETE' | 'PARTIAL' | 'FAILED';
  interrupted: boolean;
  rowsExpected: number | null;
  rowsExported: number | null;
  files: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  heartbeatAt: string | null;
  perimeter: Record<string, unknown>;
}

export interface ExportDetail {
  manifest: ExecutionsManifest | null;
  /** Archive unique vérifiée ; null : rien à télécharger. */
  archive: { fileName: string; bytes: number; sha256: string; entries: number; zip64: boolean; verifiedAt: string } | null;
  failure: ExportFailure | null;
  resumable: boolean;
  resume: { cursorAt: string; partsWritten: number; executionsWritten: number; done: boolean; resumes: number } | null;
}

/** Résultat du précontrôle (forme de la route ; champs utiles à l'affichage). */
export interface ExportPrecheckView {
  ok: boolean;
  scope: 'executions' | 'calls';
  sensitiveContent: boolean;
  executions: number;
  calls: number;
  autonomousCalls: number;
  autonomous: { included: boolean; reason: string };
  estimatedRawBytes: number;
  limits: ExecutionsExportLimits;
  refusal: { code: string; message: string; cause: string } | null;
  notices: string[];
}

const STATUS: Record<string, string> = { RUNNING: 'en cours', COMPLETE: 'complet', PARTIAL: 'partiel (ancien format)', FAILED: 'en échec' };
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }) : '—');
const base = (id: string) => `/api/admin/ai/business-executions/exports/${id}`;
const nb = (n: number) => n.toLocaleString('fr-FR');
const TOUCH = 'min-h-[44px] sm:min-h-0';

/** Onglets sans traduction dans l'export : le blocage est dit avant tout clic. */
export const UNSUPPORTED_EXPORT_TABS: Readonly<Record<string, string>> = {
  t2: 'Requêtes T2', reports: 'Rapports', completeness: 'Complétude T1', qualification: 'Qualification', schemas: 'Schémas', archives: 'Archives',
};

/** Rendu pur du précontrôle : attendu, taille estimée, limite, annonces — ou le blocage et sa cause. */
export function ExportPrecheckPanel({ p, onConfirm, onCancel, busy }: { p: ExportPrecheckView; onConfirm?: () => void; onCancel?: () => void; busy?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 space-y-2 text-sm min-w-0 ${p.ok ? 'border-[color:var(--border-subtle)] bg-[color:var(--bg-subtle)]' : 'border-[color:var(--border-danger)] bg-[color:var(--bg-danger)]'}`}
      data-testid="export-precheck" data-ok={p.ok ? '1' : '0'} role={p.ok ? 'status' : 'alert'}>
      {p.refusal && (
        <div className="space-y-1" data-testid="export-refusal">
          <p className="font-medium text-[color:var(--text-danger)] break-words">{p.refusal.message}</p>
          <p className="text-xs text-[color:var(--text-secondary)] break-words">Aucun export n’a été lancé. Vos filtres sont conservés : réduisez la période ou affinez-les, puis recommencez.</p>
        </div>
      )}
      <p className="text-[color:var(--text-primary)] break-words" data-testid="export-precheck-counts">
        Sélection : <strong>{nb(p.executions)}</strong> exécution{p.executions > 1 ? 's' : ''} · {nb(p.calls)} appel{p.calls > 1 ? 's' : ''} IA
        {' · '}{nb(p.autonomousCalls)} appel{p.autonomousCalls > 1 ? 's' : ''} technique{p.autonomousCalls > 1 ? 's' : ''} autonome{p.autonomousCalls > 1 ? 's' : ''}
        {p.scope === 'calls' ? ' (onglet « Appels modèles » : appels filtrés, regroupés par exécution)' : ''}
      </p>
      <p className="text-xs text-[color:var(--text-secondary)] break-words" data-testid="export-precheck-size">
        Taille estimée avant compression : {formatBytes(p.estimatedRawBytes)} (limite {formatBytes(p.limits.maxRawBytes)}) · ZIP limité à {formatBytes(p.limits.maxZipBytes)}
        {' · '}durée limitée à {formatDuration(p.limits.maxDurationMs)} · contenus des échanges {p.sensitiveContent ? 'inclus' : 'masqués'}
      </p>
      {!p.autonomous.included && p.scope === 'executions' && (
        <p className="text-xs text-[color:var(--text-muted)] break-words">Appels techniques autonomes (sondes, qualification, tests) non inclus : {p.autonomous.reason}.</p>
      )}
      {p.notices.length > 0 && (
        <ul className="text-xs text-[color:var(--text-warning-soft)] space-y-0.5 break-words" data-testid="export-precheck-notices">
          {p.notices.map((x) => <li key={x}>{x}</li>)}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {p.ok && onConfirm && (
          <Button size="sm" onClick={onConfirm} disabled={busy} className={TOUCH} data-testid="export-confirm">
            {busy ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Play className="w-3.5 h-3.5 mr-1.5" />} Confirmer et générer le ZIP
          </Button>
        )}
        {onCancel && (
          <Button size="sm" variant="outline" onClick={onCancel} disabled={busy} className={TOUCH} data-testid="export-precheck-close">
            <X className="w-3.5 h-3.5 mr-1.5" /> {p.ok ? 'Annuler' : 'Fermer'}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Rendu pur d'une génération (suivi, reprise, lien unique de téléchargement). */
export function ExportGenerationView({ g, detail, onResume, busy }: { g: ExportGeneration; detail: ExportDetail | null; onResume?: () => void; busy?: boolean }) {
  const label = g.interrupted ? 'interrompue' : STATUS[g.status] ?? g.status;
  const tone = g.status === 'COMPLETE' ? 'text-[color:var(--text-success)]' : g.status === 'RUNNING' && !g.interrupted ? 'text-[color:var(--text-secondary)]'
    : g.status === 'PARTIAL' ? 'text-[color:var(--text-warning-soft)]' : 'text-[color:var(--text-danger)]';
  const m = detail?.manifest ?? null;
  const a = detail?.archive ?? null;
  const auto = m?.totals.autonomousCalls ?? { expected: 0, exported: 0 };
  return (
    <li className="p-3 space-y-1.5 text-xs min-w-0" data-testid="export-generation">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className={`font-medium ${tone}`} data-testid="export-status">{label}</span>
        <span className="text-[color:var(--text-secondary)]">lancé le {fmt(g.startedAt)}</span>
        <span className="text-[color:var(--text-muted)]">{nb(g.rowsExported ?? 0)} exécution(s) écrite(s){g.rowsExpected !== null ? ` sur ${nb(g.rowsExpected)}` : ''}</span>
        <span className="text-[color:var(--text-muted)] break-all">{Object.entries(g.perimeter).map(([k, v]) => `${k}=${String(v)}`).join(' · ')}</span>
      </p>
      {g.status === 'RUNNING' && !g.interrupted && (
        <p className="flex items-center gap-1.5 text-[color:var(--text-secondary)]" data-testid="export-progress">
          <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" aria-hidden /> Génération en tâche de fond — dernier signe de vie {fmt(g.heartbeatAt)}. Le ZIP sera proposé une fois complet et vérifié.
        </p>
      )}
      {(detail?.failure?.message ?? g.error) && (
        <p className="text-[color:var(--text-danger)] break-words" data-testid="export-error">{detail?.failure?.message ?? g.error}</p>
      )}
      {detail?.failure && <p className="text-[color:var(--text-muted)] break-words">Aucun ZIP n’a été produit ; les fichiers intermédiaires ont été supprimés.</p>}
      {detail?.resumable && onResume && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={onResume} disabled={busy} className={TOUCH} data-testid="export-resume">
            <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Reprendre la génération
          </Button>
          {detail.resume && (
            <span className="text-[color:var(--text-muted)]">
              reprise après {detail.resume.partsWritten} partie(s) écrite(s), à partir du {fmt(detail.resume.cursorAt)} — sans doublon ni perte
            </span>
          )}
        </div>
      )}
      {m && a && (
        <div className="space-y-1.5" data-testid="export-downloads">
          <p className="text-[color:var(--text-secondary)] break-words">
            Manifeste : {m.status} · {m.totals.executions.exported} / {m.totals.executions.expected} exécution(s) · {m.totals.calls.exported} / {m.totals.calls.expected} appel(s)
            {' · '}{auto.exported} / {auto.expected} appel(s) technique(s) autonome(s)
            {' · '}cartes : {m.totals.cards.failed} échec(s), {m.totals.cards.incomplete} incomplète(s){m.resumes.length ? ` · ${m.resumes.length} reprise(s)` : ''}
          </p>
          <a href={`${base(g.id)}/download`} data-testid="export-download"
            className="inline-flex items-center gap-1.5 min-h-[44px] sm:min-h-[36px] px-3 rounded-lg border border-[color:var(--accent)] text-sm font-medium text-[color:var(--accent)] hover:bg-[color:var(--bg-hover)]">
            <Download className="w-4 h-4" aria-hidden /> Télécharger le ZIP complet
          </a>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[color:var(--text-muted)]">
            <PackageCheck className="w-3.5 h-3.5 shrink-0" aria-hidden />
            <span>{formatBytes(a.bytes)} · {a.entries} fichier(s) · vérifié le {fmt(a.verifiedAt)}</span>
            <span className="break-all font-mono">SHA-256 {a.sha256}</span>
          </p>
          {m.omissions.length > 0 && (
            <details>
              <summary className="cursor-pointer text-[color:var(--text-muted)] min-h-[32px]">Omissions motivées ({m.omissions.length})</summary>
              <ul className="mt-1 space-y-0.5 text-[color:var(--text-secondary)] break-words">
                {m.omissions.map((o) => <li key={`${o.what}${o.reason}`}>[{o.status}] {o.what}{o.count !== null && o.count !== undefined ? ` (${o.count})` : ''} : {o.reason}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}
      {g.status !== 'RUNNING' && !g.interrupted && !detail?.resumable && !a && !detail?.failure && detail && (
        <p className="text-[color:var(--text-muted)] break-words" data-testid="export-no-archive">
          Aucun ZIP complet pour cette génération (ancien format ou archive purgée après 30 jours) : relancez l’export.
        </p>
      )}
    </li>
  );
}

/**
 * Lancement et suivi de l'export diagnostic. `scope` : périmètre de l'écran
 * (`executions` : vue métier et onglet « Exécutions techniques » ; `calls` :
 * onglet « Appels modèles » ; tout autre onglet : export bloqué, dit en
 * clair). `params` : filtres ACTIFS de ce périmètre.
 */
export function ExecutionExportsPanel({ scope, params, summary }: { scope: string; params: URLSearchParams; summary: string }) {
  const [gens, setGens] = useState<ExportGeneration[] | null>(null);
  const [canSensitive, setCanSensitive] = useState(false);
  const [sensitive, setSensitive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState<Record<string, ExportDetail>>({});
  const [precheck, setPrecheck] = useState<ExportPrecheckView | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const unsupportedTab = UNSUPPORTED_EXPORT_TABS[scope] ?? null;
  const key = `${scope}?${params.toString()}#${sensitive ? 1 : 0}`;

  const load = useCallback(async () => {
    try {
      const r = await apiClient.get<{ items: ExportGeneration[]; canIncludeSensitiveContent: boolean }>('/api/admin/ai/business-executions/exports?pageSize=5');
      setGens(r.items);
      setCanSensitive(r.canIncludeSensitiveContent);
      const ds = await Promise.all(r.items.map((g) => apiClient.get<ExportDetail>(base(g.id)).then((d) => [g.id, d] as const).catch(() => null)));
      setDetails(Object.fromEntries(ds.filter((x): x is readonly [string, ExportDetail] => x !== null)));
    } catch {
      setGens([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  // Suivi d'une génération en cours, sans bloquer l'écran.
  useEffect(() => {
    if (!gens?.some((g) => g.status === 'RUNNING' && !g.interrupted)) return;
    const t = setInterval(() => { void load(); }, 5_000);
    return () => clearInterval(t);
  }, [gens, load]);
  // Un précontrôle ne vaut que pour les filtres sur lesquels il a porté.
  useEffect(() => { setPrecheck(null); setBlocked(null); }, [key]);

  const body = () => ({ ...Object.fromEntries(params), scope, contenusSensibles: sensitive });
  const controler = async () => {
    setBusy(true);
    setBlocked(null);
    setPrecheck(null);
    try {
      const r = await apiClient.post<{ precheck: ExportPrecheckView }>('/api/admin/ai/business-executions/exports', { ...body(), action: 'precheck' });
      setPrecheck(r.precheck);
    } catch (e) {
      setBlocked((e as Error).message || 'Précontrôle impossible.');
    } finally { setBusy(false); }
  };
  const lancer = async () => {
    setBusy(true);
    try {
      await apiClient.post('/api/admin/ai/business-executions/exports', body());
      toast.success('Génération du ZIP lancée en tâche de fond.');
      setPrecheck(null);
      await load();
    } catch (e) {
      // Refus côté serveur (précontrôle refait au lancement, export déjà en cours…) : rien n'a été lancé, les filtres restent en place.
      setPrecheck(null);
      setBlocked((e as Error).message || 'Export impossible.');
    } finally { setBusy(false); }
  };
  const reprendre = async (id: string) => {
    setBusy(true);
    try {
      await apiClient.post(base(id), { action: 'resume' });
      toast.success('Génération reprise à son dernier point de reprise.');
      await load();
    } catch (e) {
      toast.error((e as Error).message || 'Reprise impossible.');
    } finally { setBusy(false); }
  };

  return (
    <section className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3 min-w-0" data-testid="execution-exports">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="vb-app-section mr-auto">Export diagnostic</h2>
        {canSensitive && !unsupportedTab && (
          <label className={`flex items-center gap-2 text-sm text-[color:var(--text-secondary)] ${TOUCH}`}>
            <input type="checkbox" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} data-testid="export-sensitive" />
            avec contenus des échanges
          </label>
        )}
        <Button size="sm" onClick={() => void controler()} disabled={busy || !!unsupportedTab} className={TOUCH} data-testid="export-launch">
          {busy ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Download className="w-3.5 h-3.5 mr-1.5" />} Exporter le diagnostic complet (ZIP)
        </Button>
      </div>
      {unsupportedTab ? (
        <p className="text-sm text-[color:var(--text-warning-soft)] break-words" data-testid="export-unsupported-tab" role="status">
          L’onglet « {unsupportedTab} » n’a pas de traduction dans l’export diagnostic : aucun export n’est lancé d’ici. Utilisez la vue métier, l’onglet
          « Exécutions techniques » ou l’onglet « Appels modèles », avec vos filtres.
        </p>
      ) : (
        <p className="text-xs text-[color:var(--text-muted)] break-words">
          Périmètre : {summary}. Toutes les exécutions correspondant aux filtres actifs (pas seulement la page affichée), leurs appels, travaux, rapports et
          écritures, dans un seul ZIP vérifié (index CSV, manifeste, SHA-256) — ou un blocage explicite si la sélection est trop volumineuse.
        </p>
      )}
      {blocked && (
        <div className="rounded-lg border border-[color:var(--border-danger)] bg-[color:var(--bg-danger)] p-3 space-y-1 text-sm" role="alert" data-testid="export-blocked">
          <p className="font-medium text-[color:var(--text-danger)] break-words">{blocked}</p>
          <p className="text-xs text-[color:var(--text-secondary)]">Aucun export n’a été lancé. Vos filtres sont conservés.</p>
        </div>
      )}
      {precheck && <ExportPrecheckPanel p={precheck} onConfirm={() => void lancer()} onCancel={() => setPrecheck(null)} busy={busy} />}
      {gens === null
        ? <p className="text-sm text-[color:var(--text-muted)]">Chargement…</p>
        : gens.length === 0
          ? <p className="text-sm text-[color:var(--text-muted)]">Aucun export récent.</p>
          : (
            <ul className="divide-y divide-[color:var(--border-subtle)] rounded-lg border border-[color:var(--border-subtle)]">
              {gens.map((g) => <ExportGenerationView key={g.id} g={g} detail={details[g.id] ?? null} onResume={() => void reprendre(g.id)} busy={busy} />)}
            </ul>
          )}
    </section>
  );
}
