"use client";

/**
 * Configuration IA — IMPORT de la configuration globale — lot 86B (CDC
 * Pilotage IA V2 P6 ; décision PO 07 : import manuel COMPLET et ATOMIQUE,
 * écarts et modifications locales écrasées présentés AVANT confirmation,
 * tout ou rien, historisé, retour à la configuration antérieure).
 *
 *   · « Importer un fichier » : lecture locale du JSON, prévisualisation par
 *     le serveur (aucune écriture) dans une fenêtre : identité du fichier,
 *     contrôles (bloquants en tête), écarts par traitement, prompts maîtres,
 *     modifications locales écrasées, exclusions / gels levés, promotions
 *     remises à zéro, modèles réautorisés, réglages non importés ;
 *   · « Confirmer l'import » : seulement sans contrôle bloquant ; en
 *     production, saisie de « production » ; base périmée → le serveur
 *     refuse et demande une nouvelle prévisualisation ;
 *   · historique (imports appliqués / refusés, retours arrière) et « Revenir
 *     à la configuration antérieure » sur le dernier import appliqué.
 *
 * Desktop et mobile : fenêtre défilante (zones sûres, lot 81F), actions en
 * colonne sous `sm`, listes en `flex-wrap`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter,
} from '@/components/ui/dialog';
import { Loader2, Upload, Undo2, ShieldAlert, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';

type Category = 'integrity' | 'references' | 'compatibility' | 'access' | 'preview' | 'pair' | 'information';
interface Issue { category: Category; path: string; message: string; blocking: boolean }
interface FieldChange { field: string; label: string; kind: string; before: string | null; after: string | null }
interface Diff { treatments: Array<{ treatment: string; changes: FieldChange[] }>; identical: boolean; changeCount: number }
interface PromptChange { treatment: string; before: string | null; after: string | null; beforeVersion: number | null }
interface Intervention { id: number; kind: 'EXCLUSION' | 'FREEZE'; model: string | null; treatment: string | null; reason: string; createdByEmail: string | null; createdAt: string }
interface Promotion { id: number; operationCode: string; model: string; origin: string; justification: string }

interface ImportPreview {
  ok: boolean;
  file: { signature: string; formatVersion: string; sourceEnvironment: string; exportedAt: string; exportedBy: string | null; version: { number: number | null; name: string | null }; revision: number; appVersion: string | null };
  target: { environment: string; active: { versionId: number; versionNumber: number | null; name: string | null; revisionNumber: number | null } | null };
  base: string;
  alreadyApplied: boolean;
  treatments: string[];
  diff: Diff;
  masterPromptChanges: PromptChange[];
  localChanges: { sinceImportId: number | null; otherVersionActivated: boolean; diff: Diff | null; masterPromptChanges: PromptChange[]; note: string };
  lostExclusions: Intervention[];
  liftedFreezes: Intervention[];
  resetPromotions: Promotion[];
  reauthorizedModels: Array<{ model: string; treatment: string | null; exclusionId: number }>;
  settingsNotImported: string[];
  pairs: { total: number; admissible: number; technicalOnly: number; withoutEvidence: number };
  issues: Issue[];
}

interface ImportRecord {
  id: number; action: 'import' | 'rollback'; status: 'applied' | 'refused'; fileSignature: string | null;
  sourceEnvironment: string | null; sourceVersionNumber: number | null; sourceRevisionNumber: number | null;
  newVersionId: number | null; previousVersionId: number | null; rollbackOf: number | null; rolledBackAt: string | null;
  diagnostics: Issue[]; createdByEmail: string | null; createdAt: string;
}

const CATEGORY_LABELS: Record<Category, string> = {
  integrity: 'Intégrité du fichier', references: 'Références', compatibility: 'Compatibilité avec le code',
  access: 'Accès Gemini de la clé de cet environnement', preview: 'Modèle Preview (exclu en V1)', pair: 'Couple modèle / paramètres', information: 'Information',
};

const dateHeure = (d: string | null | undefined) => (d ? new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const court = (sha: string | null | undefined) => (sha ? `${sha.slice(0, 12)}…` : '—');
const portee = (t: string | null) => (t ? t : 'tous les traitements');

function DiffList({ diff, empty }: { diff: Diff | null; empty: string }) {
  if (!diff || diff.identical) return <p className="text-xs text-[color:var(--text-muted)]">{empty}</p>;
  return (
    <ul className="space-y-1.5">
      {diff.treatments.filter((t) => t.changes.length).map((t) => (
        <li key={t.treatment} className="text-xs">
          <span className="font-semibold text-[color:var(--text-primary)]">{t.treatment}</span>
          <ul className="mt-0.5 space-y-0.5 pl-3">
            {t.changes.map((c, i) => (
              <li key={i} className="text-[color:var(--text-secondary)] break-words">
                {c.label} : <span className="text-[color:var(--text-muted)]">{c.before ?? '—'}</span> → <span>{c.after ?? '—'}</span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function Section({ title, children, tone }: { title: string; children: React.ReactNode; tone?: 'warning' | 'danger' }) {
  const color = tone === 'danger' ? 'text-[color:var(--text-danger)]' : tone === 'warning' ? 'text-[color:var(--text-warning-soft)]' : 'text-[color:var(--text-primary)]';
  return (
    <section className="space-y-1.5 border-t border-[color:var(--border-subtle)] pt-3 first:border-t-0 first:pt-0">
      <h3 className={`text-sm font-semibold ${color}`}>{title}</h3>
      {children}
    </section>
  );
}

export function ConfigImport({ environment, hasUnsaved, onChanged }: {
  environment: string;
  /** Modifications non enregistrées à l'écran : l'import remplacerait la configuration sans elles. */
  hasUnsaved: boolean;
  onChanged: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [refus, setRefus] = useState<null | { message: string; issues: Issue[] }>(null);
  const [saisie, setSaisie] = useState('');
  const [history, setHistory] = useState<{ imports: ImportRecord[]; lastApplied: ImportRecord | null } | null>(null);
  const [rollback, setRollback] = useState<ImportRecord | null>(null);
  const isProduction = environment === 'production';

  const loadHistory = useCallback(async () => {
    try { setHistory(await apiClient.get<{ imports: ImportRecord[]; lastApplied: ImportRecord | null }>('/api/admin/ai/config-imports')); } catch { setHistory(null); }
  }, []);
  useEffect(() => { void loadHistory(); }, [loadHistory]);

  const fermer = () => { setPreview(null); setRefus(null); setContent(null); setSaisie(''); if (fileRef.current) fileRef.current.value = ''; };

  const prevoir = async (texte: string) => {
    setBusy(true);
    try {
      setPreview(await apiClient.post<ImportPreview>('/api/admin/ai/config-imports/preview', { content: texte }));
    } catch (e) {
      const details = (e as { details?: unknown }).details;
      setRefus({ message: (e as Error).message || 'Prévisualisation impossible : rien n’a été modifié.', issues: Array.isArray(details) ? details as Issue[] : [] });
    } finally { setBusy(false); }
  };

  const choisir = async (f: File | undefined) => {
    if (!f) return;
    setFileName(f.name);
    const texte = await f.text();
    setContent(texte);
    await prevoir(texte);
  };

  const confirmer = async () => {
    if (!preview || !content) return;
    setBusy(true);
    try {
      const r = await apiClient.post<{ outcome: 'applied' | 'recognized'; visibleNumber: number | null; liftedInterventions: number; resetPromotions: number }>(
        '/api/admin/ai/config-imports', { content, expectedBase: preview.base, ...(isProduction ? { confirmEnvironment: saisie.trim() } : {}) },
      );
      if (r.outcome === 'recognized') toast.info('Ce fichier est déjà la configuration active : rien n’a été modifié.');
      else toast.success(`Configuration importée et active (v${r.visibleNumber ?? '?'})${r.liftedInterventions ? ` · ${r.liftedInterventions} exclusion(s)/gel(s) levé(s)` : ''}${r.resetPromotions ? ` · ${r.resetPromotions} promotion(s) remise(s) à zéro` : ''}.`);
      fermer();
      await loadHistory();
      onChanged();
    } catch (e) {
      const code = (e as { code?: string }).code;
      const details = (e as { details?: unknown }).details;
      if (code === 'PREVIEW_STALE' && content) {
        toast.warning((e as Error).message, { duration: 10_000 });
        await prevoir(content);
      } else {
        setPreview(null);
        setRefus({ message: (e as Error).message || 'Import refusé : la configuration active est inchangée.', issues: Array.isArray(details) ? details as Issue[] : [] });
        await loadHistory();
      }
    } finally { setBusy(false); }
  };

  const revenir = async () => {
    if (!rollback) return;
    setBusy(true);
    try {
      await apiClient.post(`/api/admin/ai/config-imports/${rollback.id}/rollback`, isProduction ? { confirmEnvironment: saisie.trim() } : {});
      toast.success('Configuration antérieure rétablie.');
      setRollback(null); setSaisie('');
      await loadHistory();
      onChanged();
    } catch (e) {
      toast.error((e as Error).message || 'Retour arrière impossible : rien n’a été modifié.', { duration: 12_000 });
    } finally { setBusy(false); }
  };

  const bloquants = preview?.issues.filter((i) => i.blocking) ?? [];
  const avertissements = preview?.issues.filter((i) => !i.blocking) ?? [];
  const confirmable = Boolean(preview?.ok) && !preview?.alreadyApplied && (!isProduction || saisie.trim() === 'production');
  const dernier = history?.lastApplied ?? null;

  return (
    <section data-testid="config-import" className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1 min-w-0 space-y-1">
          <h2 className="vb-app-section">Importer une configuration</h2>
          <p className="text-xs text-[color:var(--text-muted)]">
            Fichier exporté depuis un autre environnement (format 2.0.0). L’import remplace TOUTE la configuration IA de cet environnement
            (aucune fusion) après prévisualisation des écarts et des modifications locales écrasées ; tout ou rien ; retour à la configuration
            antérieure possible. Les exclusions, gels et promotions en cours sont levés.
          </p>
          {dernier && (
            <p className="text-xs text-[color:var(--text-secondary)] break-words">
              Dernier import : {dateHeure(dernier.createdAt)}{dernier.createdByEmail ? ` par ${dernier.createdByEmail}` : ''}
              {dernier.sourceEnvironment ? ` · depuis ${dernier.sourceEnvironment} v${dernier.sourceVersionNumber ?? '?'} r${dernier.sourceRevisionNumber ?? '?'}` : ''}
              <span className="font-mono text-[color:var(--text-muted)]" title={dernier.fileSignature ?? ''}> · {court(dernier.fileSignature)}</span>
            </p>
          )}
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" data-testid="config-import-file"
            onChange={(e) => void choisir(e.target.files?.[0])} />
          <Button size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Upload className="w-3.5 h-3.5 mr-1.5" />} Importer un fichier
          </Button>
          {dernier && dernier.previousVersionId != null && (
            <Button size="sm" variant="outline" onClick={() => { setSaisie(''); setRollback(dernier); }} disabled={busy}>
              <Undo2 className="w-3.5 h-3.5 mr-1.5" /> Revenir à la configuration antérieure
            </Button>
          )}
        </div>
      </div>
      {hasUnsaved && (
        <p role="status" className="text-xs text-[color:var(--text-warning-soft)]">
          Des modifications ne sont pas enregistrées à l’écran : un import les remplacerait sans les appliquer.
        </p>
      )}
      {(history?.imports.length ?? 0) > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-[color:var(--text-secondary)]">Historique des imports ({history!.imports.length})</summary>
          <ul className="mt-2 space-y-1.5">
            {history!.imports.map((x) => (
              <li key={x.id} className="text-xs text-[color:var(--text-secondary)] flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span>{dateHeure(x.createdAt)}</span>
                <span className={x.status === 'refused' ? 'text-[color:var(--text-danger)]' : x.action === 'rollback' ? 'text-[color:var(--text-warning-soft)]' : 'text-[color:var(--text-success)]'}>
                  {x.action === 'rollback' ? `Retour arrière (import n°${x.rollbackOf})` : x.status === 'refused' ? 'Refusé' : `Appliqué${x.rolledBackAt ? ' puis annulé' : ''}`}
                </span>
                {x.action === 'import' && x.sourceEnvironment && <span>{x.sourceEnvironment} v{x.sourceVersionNumber ?? '?'} r{x.sourceRevisionNumber ?? '?'}</span>}
                <span className="text-[color:var(--text-muted)]">{x.createdByEmail ?? '—'}</span>
                {x.fileSignature && <span className="font-mono text-[color:var(--text-muted)]" title={x.fileSignature}>{court(x.fileSignature)}</span>}
                {x.status === 'refused' && x.diagnostics[0] && <span className="basis-full text-[color:var(--text-muted)] break-words">{x.diagnostics[0].message}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Prévisualisation et confirmation */}
      <Dialog open={preview !== null || refus !== null} onOpenChange={(o) => { if (!o && !busy) fermer(); }}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{refus ? 'Import impossible' : 'Prévisualisation de l’import'}</DialogTitle>
            <DialogDescription className="break-words">
              {fileName}{preview ? ` · ${preview.file.sourceEnvironment} v${preview.file.version.number ?? '?'}${preview.file.version.name ? ` — ${preview.file.version.name}` : ''} r${preview.file.revision}` : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            {refus && (
              <div className="space-y-2" data-testid="config-import-refus">
                <p className="text-sm text-[color:var(--text-danger)] break-words">{refus.message}</p>
                {refus.issues.length > 0 && (
                  <ul className="space-y-1 text-xs text-[color:var(--text-secondary)]">
                    {refus.issues.map((i, k) => <li key={k} className="break-words">· {CATEGORY_LABELS[i.category] ?? i.category} — {i.message}</li>)}
                  </ul>
                )}
                <p className="text-xs text-[color:var(--text-muted)]">La configuration active est inchangée.</p>
              </div>
            )}
            {preview && (
              <div className="space-y-3" data-testid="config-import-preview">
                <Section title="Fichier">
                  <p className="text-xs text-[color:var(--text-secondary)] break-words">
                    Exporté le {dateHeure(preview.file.exportedAt)}{preview.file.exportedBy ? ` par ${preview.file.exportedBy}` : ''} · format {preview.file.formatVersion}
                    {preview.file.appVersion ? ` · application ${preview.file.appVersion.slice(0, 10)}` : ''}
                  </p>
                  <p className="text-xs font-mono text-[color:var(--text-muted)] break-all">Signature d’intégrité {preview.file.signature}</p>
                  <p className="text-xs text-[color:var(--text-secondary)]">
                    Remplace : {preview.target.active ? `v${preview.target.active.versionNumber ?? preview.target.active.versionId}${preview.target.active.name ? ` — ${preview.target.active.name}` : ''} r${preview.target.active.revisionNumber ?? '?'}` : 'aucune configuration active'} ({preview.target.environment}).
                    Traitements couverts : {preview.treatments.join(', ')}.
                  </p>
                  <p className="text-xs text-[color:var(--text-muted)]">
                    Couples autorisés : {preview.pairs.total} · qualifiés : {preview.pairs.admissible} · qualification technique seulement : {preview.pairs.technicalOnly} · sans preuve : {preview.pairs.withoutEvidence}
                  </p>
                </Section>
                {bloquants.length > 0 && (
                  <Section title={`Contrôles bloquants (${bloquants.length}) — import impossible`} tone="danger">
                    <ul className="space-y-1 text-xs" data-testid="config-import-blocking">
                      {bloquants.map((i, k) => (
                        <li key={k} className="flex gap-1.5 text-[color:var(--text-secondary)] break-words">
                          <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[color:var(--text-danger)]" />
                          <span><span className="font-medium">{CATEGORY_LABELS[i.category]}</span> — {i.message}</span>
                        </li>
                      ))}
                    </ul>
                  </Section>
                )}
                {preview.alreadyApplied && (
                  <p className="text-sm text-[color:var(--text-success)] flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4" /> Ce fichier est déjà la configuration active, sans modification depuis : rien ne sera changé.</p>
                )}
                <Section title={`Écarts avec la configuration active (${preview.diff.changeCount})`}>
                  <DiffList diff={preview.diff} empty="Aucun écart de paramètres." />
                  {preview.masterPromptChanges.length > 0 && (
                    <p className="text-xs text-[color:var(--text-secondary)]">Prompts maîtres remplacés : {preview.masterPromptChanges.map((m) => `${m.treatment} (${court(m.before)} → ${court(m.after)})`).join(', ')}.</p>
                  )}
                </Section>
                <Section title="Modifications locales écrasées" tone={(preview.localChanges.diff && !preview.localChanges.diff.identical) || preview.localChanges.otherVersionActivated || preview.localChanges.masterPromptChanges.length ? 'warning' : undefined}>
                  <p className="text-xs text-[color:var(--text-secondary)]">{preview.localChanges.note}</p>
                  {preview.localChanges.diff && <DiffList diff={preview.localChanges.diff} empty="" />}
                  {preview.localChanges.masterPromptChanges.length > 0 && (
                    <p className="text-xs text-[color:var(--text-secondary)]">Prompts maîtres modifiés localement : {preview.localChanges.masterPromptChanges.map((m) => m.treatment).join(', ')}.</p>
                  )}
                </Section>
                <Section title="Interventions manuelles et routage remis à zéro" tone={preview.lostExclusions.length || preview.liftedFreezes.length || preview.resetPromotions.length ? 'warning' : undefined}>
                  {preview.lostExclusions.length + preview.liftedFreezes.length + preview.resetPromotions.length === 0
                    ? <p className="text-xs text-[color:var(--text-muted)]">Aucune exclusion, aucun gel, aucune promotion en cours.</p>
                    : (
                      <ul className="space-y-0.5 text-xs text-[color:var(--text-secondary)]" data-testid="config-import-lost">
                        {preview.lostExclusions.map((x) => <li key={`e${x.id}`} className="break-words">Exclusion levée : « {x.model} » ({portee(x.treatment)}) — {x.reason}</li>)}
                        {preview.liftedFreezes.map((x) => <li key={`g${x.id}`} className="break-words">Gel levé ({portee(x.treatment)}) — {x.reason}</li>)}
                        {preview.resetPromotions.map((p) => <li key={`p${p.id}`} className="break-words">Promotion remise à zéro : {p.operationCode} → « {p.model} »</li>)}
                      </ul>
                    )}
                  {preview.reauthorizedModels.length > 0 && (
                    <p className="text-xs text-[color:var(--text-warning-soft)] break-words" data-testid="config-import-reauthorized">
                      Modèles réautorisés par le fichier : {preview.reauthorizedModels.map((m) => `« ${m.model} » (${portee(m.treatment)})`).join(', ')}.
                    </p>
                  )}
                </Section>
                <Section title="Non importé (propre à cet environnement)">
                  <ul className="space-y-0.5 text-xs text-[color:var(--text-muted)]">
                    {preview.settingsNotImported.map((s) => <li key={s}>· {s}</li>)}
                  </ul>
                </Section>
                {avertissements.length > 0 && (
                  <Section title={`Avertissements (${avertissements.length})`}>
                    <ul className="space-y-0.5 text-xs text-[color:var(--text-secondary)]">
                      {avertissements.map((i, k) => <li key={k} className="break-words">· {i.message}</li>)}
                    </ul>
                  </Section>
                )}
                {isProduction && preview.ok && !preview.alreadyApplied && (
                  <label className="block space-y-1 text-xs text-[color:var(--text-secondary)]">
                    Environnement de PRODUCTION : saisissez « production » pour confirmer.
                    <Input value={saisie} onChange={(e) => setSaisie(e.target.value)} autoComplete="off" />
                  </label>
                )}
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={fermer} disabled={busy}>{refus || preview?.alreadyApplied ? 'Fermer' : 'Annuler'}</Button>
            {preview && !preview.alreadyApplied && (
              <Button onClick={() => void confirmer()} disabled={busy || !confirmable} data-testid="config-import-confirm">
                {busy && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />} Confirmer l’import complet
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Retour à la configuration antérieure */}
      <Dialog open={rollback !== null} onOpenChange={(o) => { if (!o && !busy) setRollback(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revenir à la configuration antérieure</DialogTitle>
            <DialogDescription>
              La configuration active avant l’import du {dateHeure(rollback?.createdAt)} redevient active (contrôles techniques conservés) ;
              les exclusions et gels levés par cet import et les promotions remises à zéro sont rétablis. Les exécutions déjà terminées et les
              données déjà écrites ne sont pas modifiées.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-2">
            <p className="text-xs text-[color:var(--text-muted)]">Le retour arrière est historisé ; l’import annulé reste consultable.</p>
            {isProduction && (
              <label className="block space-y-1 text-xs text-[color:var(--text-secondary)]">
                Environnement de PRODUCTION : saisissez « production » pour confirmer.
                <Input value={saisie} onChange={(e) => setSaisie(e.target.value)} autoComplete="off" />
              </label>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRollback(null)} disabled={busy}>Annuler</Button>
            <Button onClick={() => void revenir()} disabled={busy || (isProduction && saisie.trim() !== 'production')}>
              {busy && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />} Revenir à la configuration antérieure
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
