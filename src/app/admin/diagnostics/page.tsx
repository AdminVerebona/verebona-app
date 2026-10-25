"use client";

/**
 * Diagnostics techniques — BO, lot 77C (ticket P2 « Export de diagnostics
 * techniques et traçabilité des traitements »).
 *
 * NAVIGATION : la Supervision est un sous-onglet du Dashboard (CDC BO
 * DASH-002) et la barre latérale porte exactement les 15 entrées du CDC
 * (`admin-sidebar.test.ts`) : aucun menu n'est ajouté. Comme « Exploitation »
 * et « Opérations », la page est atteinte depuis Dashboard › Supervision
 * (lien « Diagnostics techniques »). Garde : layout `/admin` + `requireAdmin`
 * sur la route API.
 *
 * Générer (périmètre, identifiant, période, traitements, option renforcée)
 * → rapport synthétique consulté et copiable → archive ZIP (rapport TXT,
 * manifeste et données JSON) générée côté serveur. Chaque génération et
 * chaque téléchargement sont journalisés. Desktop et mobile : formulaire en
 * grille responsive, rapport défilant, boutons pleine largeur sur mobile.
 *
 * Préremplissage par l'URL (`?scope=asset&id=12`) : lien profond depuis
 * d'autres écrans du BO.
 *
 * Lot 88A : périmètre « Un compte — diagnostic global » (toutes les tables
 * du compte, fermeture transitive, auto-contrôle, traçabilité par propriété
 * et projection API → écran, guide d'analyse dans l'archive) ; statut PAR
 * SECTION (COMPLETE / PARTIAL / NOT_APPLICABLE / ERROR) affiché sous le
 * statut global — desktop : tableau ; mobile : statut et motif empilés.
 *
 * Lot 81C : aucune borne de période (option « Tout l'historique
 * disponible ») ; statut COMPLETE / PARTIAL / FAILED de la génération et de
 * chaque fichier (attendu / exporté) ; suivi des générations d'export
 * (diagnostics et « Données du compte ») avec leurs échecs.
 */
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertTriangle, ArrowLeft, Check, Copy, Download, FileArchive, History, ListChecks, Loader2, RefreshCw, Stethoscope } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EcranEnErreur } from '@/components/admin/EcranEnErreur';
import { copyText } from '../ai-executions/_components/CopyJson';
import type { DiagManifest, DiagScope, DiagTreatment } from '@/services/admin/diagnostics-export/model';
import type { GenerationRow } from '@/services/admin/export-generations';

const SCOPES: ReadonlyArray<{ key: DiagScope; label: string; idLabel: string | null }> = [
  { key: 'global', label: 'Ensemble de l’application', idLabel: null },
  { key: 'account', label: 'Un compte — diagnostic global', idLabel: 'Identifiant du compte' },
  { key: 'user', label: 'Un utilisateur', idLabel: 'Identifiant de l’utilisateur' },
  { key: 'asset', label: 'Un bien et ses équipements', idLabel: 'Identifiant du bien' },
  { key: 'document', label: 'Un document', idLabel: 'Identifiant du document' },
  { key: 'operation', label: 'Une Opération', idLabel: 'Identifiant de l’Opération' },
];
const TREATMENTS: ReadonlyArray<{ key: DiagTreatment; label: string }> = [
  { key: 'T1', label: 'T1 — analyse des documents' },
  { key: 'T2', label: 'T2 — assistant' },
  { key: 'T3', label: 'T3 — consolidation' },
  { key: 'T4', label: 'T4 — agenda' },
  { key: 'T6', label: 'T6 — mascotte' },
];

interface Result {
  manifest: DiagManifest;
  report: string;
  files: Array<{ path: string; bytes: number }>;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const kib = (n: number) => (n < 1024 ? `${n} o` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} Kio` : `${(n / 1024 / 1024).toFixed(1)} Mio`);

function Diagnostics() {
  const router = useRouter();
  const sp = useSearchParams();
  const initialScope = (SCOPES.some((s) => s.key === sp.get('scope')) ? sp.get('scope') : 'global') as DiagScope;
  const [scope, setScope] = useState<DiagScope>(initialScope);
  const [id, setId] = useState(sp.get('id') ?? '');
  const [to, setTo] = useState(() => day(new Date()));
  const [from, setFrom] = useState(() => day(new Date(Date.now() - 29 * 86_400_000)));
  const [allHistory, setAllHistory] = useState(sp.get('period') === 'all');
  const [treatments, setTreatments] = useState<DiagTreatment[]>([]);
  const [reinforced, setReinforced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [copied, setCopied] = useState(false);
  /** Suivi des générations : rafraîchi après une génération ou un téléchargement. */
  const [tick, setTick] = useState(0);

  const def = SCOPES.find((s) => s.key === scope)!;
  const idValid = !def.idLabel || /^\d{1,9}$/.test(id.trim());
  const query = useMemo(() => {
    const p = new URLSearchParams(allHistory ? { scope, period: 'all', to } : { scope, from, to });
    if (def.idLabel) p.set('id', id.trim());
    if (treatments.length) p.set('treatments', treatments.join(','));
    if (reinforced) p.set('reinforced', '1');
    return p.toString();
  }, [scope, id, from, to, allHistory, treatments, reinforced, def.idLabel]);
  // L'archive correspond aux paramètres de la génération affichée.
  const [generatedQuery, setGeneratedQuery] = useState<string | null>(null);

  const generate = async () => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const res = await fetch(`/api/admin/diagnostics?${query}`, { credentials: 'include' });
      if (res.status === 401 || res.status === 403) { router.push('/login?returnUrl=/admin/diagnostics'); return; }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error || `Erreur ${res.status}`); setResult(null); return; }
      setResult(body as Result);
      setGeneratedQuery(query);
    } catch {
      setError('Erreur réseau — diagnostic non généré.');
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!result) return;
    setCopied(await copyText(result.report));
    setTimeout(() => setCopied(false), 2500);
  };

  const m = result?.manifest;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin?tab=supervision" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3 w-3" /> Dashboard › Supervision
        </Link>
        <h1 className="vb-app-title flex items-center gap-2 mt-1">
          <Stethoscope className="h-6 w-6" />
          Diagnostics techniques
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Rapport et archive ZIP (TXT + JSON) pour analyser une anomalie : traitements, IA, données métier et traçabilité de chaque montant TCO jusqu’à sa source. Le périmètre « Un compte » produit le diagnostic global : toutes les données du compte, la chaîne de chaque propriété jusqu’à l’écran et un guide d’analyse. Lecture seule ; chaque demande est journalisée.
        </p>
      </div>

      <section className="rounded-xl border bg-card p-4 space-y-4" aria-label="Paramètres du diagnostic">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="diag-scope">Périmètre</Label>
            <Select value={scope} onValueChange={(v) => { setScope(v as DiagScope); setResult(null); }}>
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
          <div className="space-y-1.5">
            <Label htmlFor="diag-from">Du</Label>
            <Input id="diag-from" type="date" value={from} max={to} disabled={allHistory} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="diag-to">Au</Label>
            <Input id="diag-to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox className="mt-0.5" checked={allHistory} onCheckedChange={(c) => setAllHistory(c === true)} />
          <span>
            Tout l’historique disponible
            <span className="block text-xs text-muted-foreground">Aucune date de début : toutes les traces conservées jusqu’à la date de fin. Aucune limite de durée ni de volume (archive générée en flux).</span>
          </span>
        </label>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Traitements <span className="text-muted-foreground font-normal">(aucun coché : tous)</span></legend>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {TREATMENTS.map((t) => (
              <label key={t.key} className="inline-flex items-center gap-2 text-sm">
                <Checkbox checked={treatments.includes(t.key)}
                  onCheckedChange={(c) => setTreatments((cur) => (c ? [...cur, t.key] : cur.filter((x) => x !== t.key)))} />
                {t.label}
              </label>
            ))}
          </div>
        </fieldset>
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
          <Button onClick={generate} disabled={busy || !idValid || (!allHistory && !from) || !to} className="w-full sm:w-auto">
            {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Stethoscope className="h-4 w-4 mr-1.5" />}
            Générer le diagnostic
          </Button>
          {result && generatedQuery && (
            <>
              <Button variant="outline" onClick={copy} className="w-full sm:w-auto">
                {copied ? <Check className="h-4 w-4 mr-1.5" /> : <Copy className="h-4 w-4 mr-1.5" />}
                {copied ? 'Rapport copié' : 'Copier le rapport'}
              </Button>
              <Button asChild variant="outline" className="w-full sm:w-auto">
                <a href={`/api/admin/diagnostics?${generatedQuery}&format=zip`} download onClick={() => setTimeout(() => setTick((t) => t + 1), 1500)}>
                  <Download className="h-4 w-4 mr-1.5" />Télécharger le ZIP
                </a>
              </Button>
            </>
          )}
        </div>
        {!idValid && <p className="text-xs text-destructive">Identifiant attendu : nombre entier.</p>}
      </section>

      {error && <EcranEnErreur titre="Diagnostic non généré" message={error} onRetry={generate} />}

      {m && result && (
        <section className="space-y-4" aria-label="Résultat du diagnostic">
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <Stat label="Statut de la génération" value={m.status ?? '—'} warn={!!m.status && m.status !== 'COMPLETE'} />
            <Stat label="Environnement" value={m.environment} />
            <Stat label="Version" value={`${m.build.version}${m.build.commit ? ` · ${m.build.commit.slice(0, 10)}` : ''}`} />
            <Stat label="Avertissements" value={String(m.warnings.length)} warn={m.warnings.length > 0} />
            <Stat label="Informations non disponibles" value={String(m.unavailable.length)} warn={m.unavailable.length > 0} />
          </div>
          <p className="text-xs text-muted-foreground">
            Généré le {new Date(m.generatedAt).toLocaleString('fr-FR')} · {m.target.label} · {m.request.from ? `période du ${m.request.from} au ${m.request.to}` : `tout l’historique jusqu’au ${m.request.to}`} · génération {m.generationId.slice(0, 8)}
            {m.snapshot ? ` · instantané ${m.snapshot.at}` : ''}
          </p>
          {m.sections && m.sections.length > 0 && (
            <div className="rounded-xl border bg-card overflow-x-auto" data-diag-sections>
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
                  {m.sections.map((x) => (
                    <tr key={x.code} className="border-b last:border-b-0 align-top">
                      <td className="px-3 py-2 text-xs">
                        {x.label}
                        <span className="block text-[11px] text-muted-foreground">{x.files.length} fichier(s)</span>
                        {x.motif && <span className="block md:hidden text-[11px] text-muted-foreground break-words">{x.motif}</span>}
                      </td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap">
                        <span className={x.status === 'PARTIAL' || x.status === 'ERROR' ? 'text-destructive font-medium' : x.status === 'NOT_APPLICABLE' ? 'text-muted-foreground' : ''}>{x.status}</span>
                      </td>
                      <td className="px-3 py-2 text-xs text-right tabular-nums hidden sm:table-cell">{x.files.length ? `${x.exported} / ${x.expected}` : '—'}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground hidden md:table-cell break-words">{x.motif ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {m.autoControle && <p className="px-4 py-2 text-xs text-muted-foreground border-t">Auto-contrôle : {m.autoControle.conclusion}</p>}
            </div>
          )}
          {m.unavailable.length > 0 && (
            <div className="rounded-xl border bg-card p-4 space-y-1">
              <p className="text-sm font-medium flex items-center gap-1.5"><AlertTriangle className="h-4 w-4" />Limites du diagnostic</p>
              <ul className="text-xs text-muted-foreground list-disc pl-5 space-y-0.5">
                {m.unavailable.map((u, i) => <li key={i}><span className="text-foreground">{u.element}</span> : {u.motif}</li>)}
              </ul>
            </div>
          )}
          <div className="rounded-xl border bg-card">
            <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
              <h2 className="vb-app-section">Rapport synthétique</h2>
            </div>
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words p-4 text-xs leading-relaxed font-mono">{result.report}</pre>
          </div>
          <div className="rounded-xl border bg-card overflow-x-auto">
            <div className="flex items-center gap-1.5 border-b px-4 py-2 text-sm font-medium"><FileArchive className="h-4 w-4" />Contenu de l’archive</div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="px-3 py-2 font-medium">Fichier</th>
                  <th className="px-3 py-2 font-medium hidden sm:table-cell">Contenu</th>
                  <th className="px-3 py-2 font-medium">Statut</th>
                  <th className="px-3 py-2 font-medium text-right">Taille</th>
                </tr>
              </thead>
              <tbody>
                {result.files.map((f) => {
                  const info = m.files.find((x) => x.path === f.path);
                  return (
                    <tr key={f.path} className="border-b last:border-b-0">
                      <td className="px-3 py-2 font-mono text-xs break-all">{f.path}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground hidden sm:table-cell">{info?.description}{info?.count !== undefined ? ` — ${info.count}${info.expected !== undefined && info.expected !== null ? ` / ${info.expected} attendu(s)` : ''}` : ''}</td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap">
                        <span className={info?.status && info.status !== 'COMPLETE' ? 'text-destructive font-medium' : ''}>{info?.status ?? (info?.complete === false ? 'INCOMPLET' : '—')}</span>
                        {info?.error && <span className="block text-[11px] text-destructive whitespace-normal break-words">{info.error}</span>}
                      </td>
                      <td className="px-3 py-2 text-xs text-right tabular-nums whitespace-nowrap">{kib(f.bytes)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <Generations refreshKey={`${generatedQuery ?? ''}#${tick}`} />
    </div>
  );
}

/**
 * Lot 81C — suivi des générations d'export (diagnostics et « Données du
 * compte ») : statut, attendu / exporté, erreur. Rafraîchi tant qu'une
 * génération est en cours. Desktop : tableau ; mobile : colonnes réduites.
 */
function Generations({ refreshKey }: { refreshKey: string }) {
  const [rows, setRows] = useState<GenerationRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [err, setErr] = useState<string | null>(null);
  const pageSize = 10;
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/diagnostics/generations?page=${page}&pageSize=${pageSize}`, { credentials: 'include', cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(body.error || `Erreur ${res.status}`); return; }
      setErr(null);
      setRows(body.items as GenerationRow[]);
      setTotal(Number(body.total) || 0);
    } catch {
      setErr('Erreur réseau.');
    }
  }, [page]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  const runningNow = rows?.some((r) => r.status === 'RUNNING') ?? false;
  useEffect(() => {
    if (!runningNow) return undefined;
    const t = setInterval(() => { void load(); }, 4000);
    return () => clearInterval(t);
  }, [runningNow, load]);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <section className="rounded-xl border bg-card overflow-x-auto" aria-label="Générations d’export">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
        <h2 className="vb-app-section flex items-center gap-1.5"><History className="h-4 w-4" />Générations d’export</h2>
        <Button variant="outline" size="sm" onClick={() => void load()} className="gap-1.5"><RefreshCw className="h-3.5 w-3.5" />Actualiser</Button>
      </div>
      {err && <p className="px-4 py-2 text-xs text-destructive">{err}</p>}
      {rows && !rows.length && <p className="px-4 py-3 text-xs text-muted-foreground">Aucune génération enregistrée.</p>}
      {rows && rows.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground border-b">
              <th className="px-3 py-2 font-medium">Début</th>
              <th className="px-3 py-2 font-medium">Export</th>
              <th className="px-3 py-2 font-medium">Statut</th>
              <th className="px-3 py-2 font-medium hidden sm:table-cell text-right">Lignes (exportées / attendues)</th>
              <th className="px-3 py-2 font-medium hidden md:table-cell text-right">Taille</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b last:border-b-0 align-top">
                <td className="px-3 py-2 text-xs whitespace-nowrap">{new Date(r.startedAt).toLocaleString('fr-FR')}</td>
                <td className="px-3 py-2 text-xs">
                  {r.kind === 'TECH_DIAGNOSTIC' ? 'Diagnostic' : r.kind === 'RECETTE_EXPORT' ? 'Export de recette' : 'Données du compte'} · {r.mode}{r.targetType ? ` · ${r.targetType}${r.targetId ? ` #${r.targetId}` : ''}` : ''}
                  {r.targetAccountId ? <span className="text-muted-foreground"> · compte #{r.targetAccountId}</span> : null}
                  <span className="block font-mono text-[10px] text-muted-foreground">{r.id.slice(0, 8)}{r.fileName ? ` · ${r.fileName}` : ''}</span>
                </td>
                <td className="px-3 py-2 text-xs">
                  <span className={r.status === 'COMPLETE' ? '' : r.status === 'RUNNING' ? 'text-muted-foreground' : 'text-destructive font-medium'}>
                    {r.status === 'RUNNING' ? <span className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" />EN COURS</span> : r.status}
                  </span>
                  {r.error && <span className="block text-[11px] text-destructive break-words">{r.error}</span>}
                </td>
                <td className="px-3 py-2 text-xs text-right tabular-nums hidden sm:table-cell">{r.rowsExported ?? '—'} / {r.rowsExpected ?? '—'}{r.batches ? ` · ${r.batches} lot(s)` : ''}</td>
                <td className="px-3 py-2 text-xs text-right tabular-nums hidden md:table-cell">{r.bytes != null ? kib(r.bytes) : '—'}</td>
              </tr>
            ))}
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

function Stat({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-xl border bg-card p-3">
      <p className={`text-sm font-semibold break-words ${warn ? '' : 'text-foreground'}`}>{value}</p>
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
