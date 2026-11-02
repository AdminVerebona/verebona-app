'use client';

/**
 * Prompt maître T4 — UN PROMPT, UNE ACTIVATION. Lot 105C (ticket « BO T4 :
 * simplification, configuration automatique, activation unifiée »).
 *
 * Écran normal :
 *   · « Prompt maître T4 » : UNE zone de texte complète et libre ;
 *   · statut, numéro de version, date ; historique et réactivation ;
 *   · bouton principal « Activer la version » : prend le texte ÉDITÉ (même
 *     non enregistré) — le serveur l'enregistre, associe et valide la
 *     configuration technique complète, puis active atomiquement (ou rien) ;
 *   · « Enregistrer le brouillon » et « Tester T4 » FACULTATIFS ;
 *   · « Détails techniques » repliés, en LECTURE SEULE.
 *
 * Aucun choix de mode, de contrat d'entrée ou de sortie, ni de case TASK :
 * la configuration est gérée par Verebona. Une erreur du moteur s'affiche
 * « Impossible d'activer T4 : configuration du moteur incompatible », le
 * détail replié — jamais une consigne de sélection.
 *
 * Composants, jetons et classes existants uniquement (charte Sérénité) ;
 * desktop et mobile (boutons pleine largeur et cibles de 44 px au téléphone).
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { Loader2, Pencil, Save, FlaskConical, CheckCircle2, RotateCcw, Trash2, AlertTriangle, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { MasterPromptExecutionPanel } from './MasterPromptExecutionPanel';
import {
  TestBadge, StatusPill, FailureList, TechnicalDetails, dateHeure, errMessage,
  type Detail, type VersionView, type TestRun, type TestState,
} from './MasterPrompts';

/** Fonction T4 et sa disponibilité technique (service `t4FunctionsOf`). */
interface T4Function { task: string; label: string; available: boolean; partial: boolean; reason: string | null }
interface BundleView {
  id: string; mode?: string; inputContractVersion?: string; outputContractVersion?: string;
  tasks?: string[]; outputs?: Record<string, string>; promptSha256?: string; frozenAt?: string;
}
type T4Version = VersionView & { functions?: T4Function[] | null; bundle?: BundleView | null };
type T4Detail = Omit<Detail, 'active' | 'draft' | 'history'> & {
  active: (T4Version & { content: string }) | null;
  draft: (T4Version & { content: string; issues: Array<{ code: string; message: string }>; warnings: Array<{ code: string; message: string }> }) | null;
  history: T4Version[];
  unified?: {
    bundle: BundleView | null;
    bundleIssues: Array<{ code: string; message: string; task?: string }>;
    activeFunctions: T4Function[];
  } | null;
};
/** Refus d'activation rendu par le serveur (aucune version activée). */
interface ActivationFailure { message: string; issues: Array<{ code: string; message: string; task?: string }>; draftSaved: boolean; engine: boolean }

/** Message de repli d'une erreur technique (le serveur envoie le même). */
export const T4_ENGINE_ERROR = 'Impossible d’activer T4 : configuration du moteur incompatible';

/** Fonctions de la version, en clair (vert : complètes ; avertissement : limitées). */
function FunctionsSummary({ functions, titre }: { functions: T4Function[]; titre: string }) {
  const completes = functions.every((f) => f.available && !f.partial);
  return (
    <div className={`rounded border p-2 text-xs space-y-1 ${completes ? 'border-[color:var(--border-success)] bg-[color:var(--bg-success)]' : 'border-[color:var(--border-warning)] bg-[color:var(--bg-warning)]'}`}
      data-testid="t4-functions">
      <p className="font-medium flex items-center gap-1.5 text-[color:var(--text-primary)]">
        {completes ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-[color:var(--text-success)]" /> : <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-[color:var(--text-warning-soft)]" />}
        <span className="min-w-0 break-words">
          {titre} : {completes ? `les ${functions.length} fonctions T4 sont disponibles` : 'fonctions limitées'}
        </span>
      </p>
      <ul className="space-y-0.5">
        {functions.map((f) => (
          <li key={f.task} className="flex items-start gap-1 break-words text-[color:var(--text-secondary)]">
            {f.available && !f.partial
              ? <CheckCircle2 className="w-3 h-3 mt-0.5 shrink-0 text-[color:var(--text-success)]" />
              : f.available
                ? <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0 text-[color:var(--text-warning-soft)]" />
                : <XCircle className="w-3 h-3 mt-0.5 shrink-0 text-[color:var(--text-danger)]" />}
            <span className="min-w-0">{f.label}{f.reason ? <span className="text-[color:var(--text-muted)]"> — {f.reason}</span> : null}</span>
          </li>
        ))}
      </ul>
      {!completes && (
        <p className="text-[color:var(--text-muted)] break-words">
          Pour retrouver les quatre fonctions : « Modifier », puis « Activer la version ». La configuration technique est appliquée automatiquement.
        </p>
      )}
    </div>
  );
}

/** Configuration technique figée (lecture seule). */
function BundleDetails({ bundle, titre }: { bundle: BundleView | null | undefined; titre: string }) {
  if (!bundle) return <p className="text-xs text-[color:var(--text-muted)]">{titre} : version antérieure, sans configuration complète figée.</p>;
  return (
    <div className="text-xs text-[color:var(--text-muted)] space-y-1">
      <p className="text-[color:var(--text-secondary)]">{titre}</p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 break-all">
        <dt>Configuration</dt><dd>{bundle.id}</dd>
        {bundle.mode && (<><dt>Mode</dt><dd>{bundle.mode}</dd></>)}
        {bundle.inputContractVersion && (<><dt>Contrat d’entrée</dt><dd>{bundle.inputContractVersion}</dd></>)}
        {bundle.outputContractVersion && (<><dt>Contrat de sortie</dt><dd>{bundle.outputContractVersion}</dd></>)}
        {bundle.tasks && (<><dt>TASK</dt><dd>{bundle.tasks.join(', ')}</dd></>)}
        {bundle.outputs && Object.entries(bundle.outputs).map(([t, o]) => (<span key={t} className="contents"><dt>Sortie {t}</dt><dd>{o}</dd></span>))}
        {bundle.frozenAt && (<><dt>Figée le</dt><dd>{dateHeure(bundle.frozenAt)}</dd></>)}
      </dl>
    </div>
  );
}

/** « Tester T4 » : bilan global, synthèse par fonction, détail sur demande. */
function T4TestPanel({ test, labels, busy, onRun }: {
  test: TestState; labels: Record<string, string>; busy: boolean; onRun: () => void;
}) {
  const [voir, setVoir] = useState(false);
  const run: TestRun | null = test.state === 'never' ? null : test.run;
  return (
    <div className="rounded-lg border border-[color:var(--border-subtle)] p-3 space-y-2" data-testid="t4-test">
      {!run ? (
        <p className="text-sm text-[color:var(--text-secondary)]">{test.message}</p>
      ) : (
        <>
          <p className="text-sm text-[color:var(--text-primary)]">
            Dernier test : {dateHeure(run.startedAt)}
            {test.state === 'done' && <span className="text-[color:var(--text-secondary)]"> · {run.failed === 0 ? `${run.passed}/${run.total} scénarios réussis` : `${run.failed} scénario${run.failed > 1 ? 's' : ''} en échec sur ${run.total}`}</span>}
          </p>
          {test.state !== 'done' && <p className="text-sm text-[color:var(--text-warning-soft)]">{test.message}</p>}
          {test.state === 'done' && run.byBranch && Object.keys(run.byBranch).length > 0 && (
            <ul className="text-xs space-y-0.5">
              {Object.entries(run.byBranch).map(([b, r]) => (
                <li key={b} className="flex items-start gap-1 break-words text-[color:var(--text-secondary)]">
                  {r.failed === 0 ? <CheckCircle2 className="w-3 h-3 mt-0.5 shrink-0 text-[color:var(--text-success)]" /> : <XCircle className="w-3 h-3 mt-0.5 shrink-0 text-[color:var(--text-danger)]" />}
                  <span className="min-w-0">{labels[b] ?? b} : {r.total - r.failed}/{r.total} scénarios réussis</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="flex flex-wrap gap-2">
        {test.state === 'done' && run && run.failed > 0 && (
          <Button size="sm" variant="ghost" className="min-h-[44px] sm:min-h-0" onClick={() => setVoir((v) => !v)}>
            {voir ? 'Masquer le détail' : 'Voir le détail par scénario'}
          </Button>
        )}
        <Button size="sm" variant="outline" className="min-h-[44px] sm:min-h-0" disabled={busy} onClick={onRun}>
          {busy ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <FlaskConical className="w-3.5 h-3.5 mr-1.5" />}
          Tester T4
        </Button>
      </div>
      {voir && run && <FailureList failures={run.failures} />}
      <p className="text-xs text-[color:var(--text-muted)]">
        Facultatif : rejoue les scénarios de référence des quatre fonctions, sans appel au modèle (aucun coût). Il n’empêche jamais l’activation.
      </p>
    </div>
  );
}

export function T4MasterPromptEditor({ treatment, onChanged }: { treatment: string; onChanged: () => void }) {
  const [detail, setDetail] = useState<T4Detail | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [texte, setTexte] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<null | 'draft' | 'save' | 'test' | 'activate' | 'discard' | 'reactivate'>(null);
  const [confirm, setConfirm] = useState<null | { kind: 'activate' } | { kind: 'reactivate'; version: T4Version } | { kind: 'discard' }>(null);
  const [a1, setA1] = useState<{ allowed: boolean; notices: string[] } | null>(null);
  const [apercu, setApercu] = useState<null | (T4Version & { content: string })>(null);
  const [echec, setEchec] = useState<ActivationFailure | null>(null);

  const appliquer = useCallback((d: T4Detail) => {
    setDetail(d);
    setTexte(d.draft?.content ?? '');
    setDirty(false);
  }, []);

  const charger = useCallback(async () => {
    setErreur(null);
    try {
      appliquer(await apiClient.get<T4Detail>(`/api/admin/ai/master-prompts/${treatment}`));
    } catch (e) {
      setErreur(errMessage(e, 'Prompt indisponible.'));
    }
  }, [treatment, appliquer]);

  useEffect(() => { void charger(); }, [charger]);

  // Saisie non enregistrée : le navigateur demande confirmation avant de quitter.
  useEffect(() => {
    if (!dirty) return;
    const avant = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', avant);
    return () => window.removeEventListener('beforeunload', avant);
  }, [dirty]);

  if (erreur) {
    return (
      <div role="alert" className="space-y-2">
        <p className="text-sm text-[color:var(--text-danger)]">{erreur}</p>
        <Button size="sm" variant="outline" onClick={() => void charger()}><RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Réessayer</Button>
      </div>
    );
  }
  if (!detail) {
    return <p className="text-xs text-[color:var(--text-muted)] flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Chargement…</p>;
  }

  const draft = detail.draft;
  const active = detail.active;
  const nomActive = active ? `v${active.versionNumber}` : 'version initiale';
  const fonctionsActives = detail.unified?.activeFunctions ?? [];
  const labels = Object.fromEntries(fonctionsActives.map((f) => [f.task, f.label]));
  const tropLong = texte.length > detail.limits.maxChars;
  const vide = texte.trim() === '';

  const modifier = async () => {
    setBusy('draft');
    try {
      const r = await apiClient.post<{ detail: T4Detail }>(`/api/admin/ai/master-prompts/${treatment}/draft`, {});
      appliquer(r.detail);
      onChanged();
    } catch (e) { toast.error(errMessage(e, 'Le brouillon n’a pas pu être créé.')); } finally { setBusy(null); }
  };

  /** Facultatif : garde le travail sans l'activer. */
  const enregistrer = async (silencieux = false): Promise<T4Detail | null> => {
    if (!draft) return null;
    setBusy('save');
    try {
      const r = await apiClient.put<{ detail: T4Detail }>(`/api/admin/ai/master-prompts/${treatment}/draft`, { versionId: draft.id, content: texte });
      appliquer(r.detail);
      if (!silencieux) toast.success(`Brouillon v${draft.versionNumber} enregistré`);
      onChanged();
      return r.detail;
    } catch (e) {
      toast.error(errMessage(e, 'Le brouillon n’a pas pu être enregistré.'));
      return null;
    } finally { setBusy(null); }
  };

  const tester = async (cible: number | 'active') => {
    if (cible !== 'active' && dirty && !(await enregistrer(true))) return;
    setBusy('test');
    try {
      const run = await apiClient.post<TestRun>(`/api/admin/ai/master-prompts/${treatment}/versions/${cible}/tests`, {}, { policy: 'long' });
      if (run.status === 'DONE') toast[run.failed === 0 ? 'success' : 'warning'](`Test T4 terminé : ${run.passed}/${run.total} scénarios réussis`);
      else toast.error(run.error ?? 'Le test n’a pas abouti.');
      await charger();
      onChanged();
    } catch (e) { toast.error(errMessage(e, 'Le test n’a pas pu être lancé.')); } finally { setBusy(null); }
  };

  const demanderActivation = () => {
    setEchec(null);
    setConfirm({ kind: 'activate' });
    // Lot 100B (#345, arbitrage A1) : matrice et manques de couverture affichés, jamais bloquants.
    setA1(null);
    apiClient.get<{ allowed: boolean; notices: string[] }>(`/api/admin/ai/corpus/a1?treatment=${treatment}`).then(setA1).catch(() => setA1(null));
  };

  /** « Activer la version » : le texte ÉDITÉ part tel quel, le serveur fait le reste. */
  const activer = async () => {
    setBusy('activate');
    setEchec(null);
    try {
      const r = await apiClient.post<{ activeVersionNumber: number; notices: string[]; detail: T4Detail }>(
        `/api/admin/ai/master-prompts/${treatment}/activate`, { content: texte, draftId: draft?.id ?? null },
      );
      appliquer(r.detail);
      toast.success(`T4 : version v${r.activeVersionNumber} active, avec ses quatre fonctions. Les prochains traitements l’utilisent.`);
      onChanged();
    } catch (e) {
      const err = e as { code?: string; message?: string; details?: { issues?: ActivationFailure['issues']; draftSaved?: boolean } };
      const engine = err.code === 'ENGINE_INCOMPATIBLE';
      setEchec({
        message: engine ? T4_ENGINE_ERROR : errMessage(e, 'Activation impossible.'),
        issues: err.details?.issues ?? [], draftSaved: Boolean(err.details?.draftSaved), engine,
      });
      // Le texte a été conservé dans le brouillon : l'écran le relit, la saisie reste affichée.
      if (err.details?.draftSaved) {
        const garde = texte;
        try {
          const d = await apiClient.get<T4Detail>(`/api/admin/ai/master-prompts/${treatment}`);
          setDetail(d);
          setTexte(garde);
          setDirty(garde !== (d.draft?.content ?? ''));
        } catch { /* l'erreur reste affichée */ }
      }
    } finally { setBusy(null); }
  };

  const reactiver = async (v: T4Version) => {
    setBusy('reactivate');
    try {
      const r = await apiClient.post<{ activeVersionNumber: number; notices: string[]; detail: T4Detail }>(
        `/api/admin/ai/master-prompts/${treatment}/versions/${v.id}/reactivate`, {},
      );
      appliquer(r.detail);
      const limites = r.notices.find((n) => n.includes('Fonctions limitées'));
      if (limites) toast.warning(`T4 : version v${r.activeVersionNumber} réactivée. ${limites}`);
      else toast.success(`T4 : version v${r.activeVersionNumber} réactivée.`);
      onChanged();
    } catch (e) { toast.error(errMessage(e, 'Réactivation impossible.')); } finally { setBusy(null); }
  };

  const abandonner = async () => {
    if (!draft) return;
    setBusy('discard');
    try {
      const r = await apiClient.delete<{ detail: T4Detail }>(`/api/admin/ai/master-prompts/${treatment}/draft?versionId=${draft.id}`);
      appliquer(r.detail);
      setEchec(null);
      toast.success('Brouillon abandonné');
      onChanged();
    } catch (e) { toast.error(errMessage(e, 'Abandon impossible.')); } finally { setBusy(null); }
  };

  const voirVersion = async (v: T4Version) => {
    try {
      setApercu(await apiClient.get<T4Version & { content: string }>(`/api/admin/ai/master-prompts/${treatment}/versions/${v.id}`));
    } catch (e) { toast.error(errMessage(e, 'Version illisible.')); }
  };

  const limitesDe = (v: T4Version) => (v.functions ?? []).filter((f) => !f.available || f.partial);

  return (
    <div className="space-y-4" data-testid="t4-unified-editor">
      {/* Statut de la version active */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-[color:var(--text-primary)]">Version active : {nomActive}</span>
          {active ? <TestBadge test={active.test} /> : <TestBadge test={{ state: 'never', label: 'Non testé', message: '', previous: null }} />}
          {active?.activatedAt && (
            <span className="text-xs text-[color:var(--text-muted)]">
              activée le {dateHeure(active.activatedAt)}{active.activatedBy ? ` par ${active.activatedBy}` : ''}
            </span>
          )}
        </div>
        {fonctionsActives.length > 0 && <FunctionsSummary functions={fonctionsActives} titre={`Version active ${nomActive}`} />}
        {!draft && (
          <>
            <p className="text-sm font-medium text-[color:var(--text-primary)]">Prompt maître T4</p>
            <pre className="max-h-72 overflow-auto rounded bg-[color:var(--bg-page)] p-2 text-xs font-mono whitespace-pre-wrap break-words text-[color:var(--text-secondary)]">
              {active?.content ?? detail.initialContent?.content ?? ''}
            </pre>
            <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2">
              <Button size="sm" className="min-h-[44px] sm:min-h-0 w-full sm:w-auto" onClick={modifier} disabled={busy !== null}>
                {busy === 'draft' ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Pencil className="w-3.5 h-3.5 mr-1.5" />}
                Modifier
              </Button>
            </div>
            <T4TestPanel
              test={active?.test ?? { state: 'never', label: 'Non testé', message: 'Cette version n’a pas encore été testée.', previous: null }}
              labels={labels} busy={busy === 'test'} onRun={() => void tester(active ? active.id : 'active')}
            />
          </>
        )}
      </div>

      {/* Brouillon : UNE zone de texte, UNE activation */}
      {draft && (
        <div className="rounded-lg border border-[color:var(--border-subtle)] p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status="DRAFT" label={`Brouillon v${draft.versionNumber}`} />
            <TestBadge test={dirty ? { state: 'never', label: 'Non testé', message: '', previous: null } : draft.test} />
            {dirty && <span className="text-xs text-[color:var(--text-warning-soft)]">• modifications non enregistrées (prises en compte par « Activer la version »)</span>}
            <span className="text-xs text-[color:var(--text-muted)]">
              {draft.basedOnVersionNumber ? `à partir de v${draft.basedOnVersionNumber} · ` : ''}modifié le {dateHeure(draft.updatedAt)}
            </span>
          </div>
          <label className="block text-sm font-medium text-[color:var(--text-primary)]" htmlFor={`t4-texte-${draft.id}`}>Prompt maître T4</label>
          <p className="text-xs text-[color:var(--text-muted)]">
            Un seul texte pour les quatre fonctions T4. Le brouillon n’est jamais utilisé tant qu’il n’est pas activé : la version active continue de servir.
          </p>
          <Textarea
            id={`t4-texte-${draft.id}`}
            aria-label="Texte du prompt maître T4"
            value={texte}
            disabled={busy !== null}
            onChange={(e) => { setTexte(e.target.value); setDirty(true); }}
            className="min-h-[320px] font-mono text-xs bg-[color:var(--bg-input)]"
          />
          <p className={`text-xs ${tropLong ? 'text-[color:var(--text-danger)]' : 'text-[color:var(--text-muted)]'}`}>
            {texte.length.toLocaleString('fr-FR')} / {detail.limits.maxChars.toLocaleString('fr-FR')} caractères
          </p>
          {detail.reference?.content && detail.reference.content !== texte && (
            <Button size="sm" variant="ghost" className="min-h-[44px] sm:min-h-0" disabled={busy !== null}
              onClick={() => { setTexte(detail.reference!.content); setDirty(true); }}>
              Repartir du texte livré avec l’application
            </Button>
          )}

          {!dirty && draft.warnings.length > 0 && (
            <div className="rounded-lg border border-[color:var(--border-warning)] bg-[color:var(--bg-warning)] p-3 space-y-1">
              {draft.warnings.map((i, k) => (
                <p key={k} className="text-xs text-[color:var(--text-secondary)] flex items-start gap-1.5 break-words">
                  <AlertTriangle className="w-3.5 h-3.5 text-[color:var(--text-warning-soft)] mt-0.5 shrink-0" /> <span className="min-w-0">{i.message}</span>
                </p>
              ))}
            </div>
          )}

          {echec && (
            <div role="alert" className="rounded-lg border border-[color:var(--border-danger)] bg-[color:var(--bg-danger)] p-3 space-y-1" data-testid="t4-activation-error">
              <p className="text-sm font-medium text-[color:var(--text-primary)] flex items-start gap-1.5 break-words">
                <XCircle className="w-4 h-4 text-[color:var(--text-danger)] mt-0.5 shrink-0" /> <span className="min-w-0">{echec.message}</span>
              </p>
              <p className="text-xs text-[color:var(--text-secondary)]">
                Aucune version n’a été activée : la {nomActive} continue de servir.{echec.draftSaved ? ' Votre texte est conservé dans le brouillon.' : ''}
              </p>
              {echec.issues.length > 0 && (
                <details className="text-xs text-[color:var(--text-secondary)]">
                  <summary className="cursor-pointer text-[color:var(--text-primary)]">{echec.engine ? 'Détail technique (à transmettre à l’équipe technique)' : 'Détail'}</summary>
                  <ul className="mt-1 space-y-0.5 break-words">
                    {echec.issues.map((i, k) => <li key={k}><span className="font-mono">{i.code}</span> — {i.message}</li>)}
                  </ul>
                </details>
              )}
            </div>
          )}

          <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2">
            <Button size="sm" className="min-h-[44px] sm:min-h-0 w-full sm:w-auto" onClick={demanderActivation} disabled={busy !== null || vide || tropLong}>
              {busy === 'activate' ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />}
              Activer la version
            </Button>
            <Button size="sm" variant="outline" className="min-h-[44px] sm:min-h-0 w-full sm:w-auto" onClick={() => void enregistrer()} disabled={!dirty || busy !== null}>
              {busy === 'save' ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-1.5" />}
              Enregistrer le brouillon
            </Button>
            <span className="hidden sm:block flex-1" />
            <Button size="sm" variant="ghost" className="min-h-[44px] sm:min-h-0 w-full sm:w-auto" onClick={() => setConfirm({ kind: 'discard' })} disabled={busy !== null}>
              <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Abandonner le brouillon
            </Button>
          </div>
          <p className="text-xs text-[color:var(--text-muted)]">
            « Activer la version » enregistre le texte affiché, applique automatiquement la configuration technique complète et active les quatre fonctions ensemble — ou n’active rien.
            « Enregistrer le brouillon » et « Tester T4 » sont facultatifs.
          </p>

          <T4TestPanel
            test={dirty ? { state: 'never', label: 'Non testé', message: 'Cette version n’a pas encore été testée. « Tester T4 » enregistre d’abord le brouillon.', previous: null } : draft.test}
            labels={labels} busy={busy === 'test'} onRun={() => void tester(draft.id)}
          />
        </div>
      )}

      {/* Historique et restauration (AC10, AC11) */}
      {detail.history.length > 0 && (
        <details>
          <summary className="text-sm text-[color:var(--text-secondary)] cursor-pointer">Historique des versions ({detail.history.length})</summary>
          <ul className="mt-2 space-y-2">
            {detail.history.map((v) => {
              const limites = limitesDe(v);
              return (
                <li key={v.id} className="rounded-md border border-[color:var(--border-subtle)] p-2 text-xs space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[color:var(--text-primary)]">v{v.versionNumber}</span>
                    <StatusPill status={v.status} label={v.statusLabel} />
                    <span className="text-[color:var(--text-secondary)]">{dateHeure(v.activatedAt ?? v.createdAt)}</span>
                    <TestBadge test={v.test} />
                  </div>
                  <p className={limites.length ? 'text-[color:var(--text-warning-soft)] break-words' : 'text-[color:var(--text-muted)]'}>
                    {limites.length ? `Fonctions limitées : ${limites.map((f) => f.label).join(', ')}` : 'Quatre fonctions T4'}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="ghost" className="min-h-[44px] sm:min-h-0" onClick={() => void voirVersion(v)}>Voir</Button>
                    {v.status === 'PREVIOUS' && (
                      <Button size="sm" variant="outline" className="min-h-[44px] sm:min-h-0" disabled={busy !== null} onClick={() => setConfirm({ kind: 'reactivate', version: v })}>
                        <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Réactiver cette version
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </details>
      )}

      {detail.activations.length > 0 && (
        <details>
          <summary className="text-sm text-[color:var(--text-secondary)] cursor-pointer">Journal des activations</summary>
          <ul className="mt-2 space-y-1 text-xs text-[color:var(--text-secondary)] break-words">
            {detail.activations.map((a) => (
              <li key={a.id}>
                {dateHeure(a.at)} — {a.actionLabel} : {a.fromVersionNumber ? `v${a.fromVersionNumber}` : 'version initiale'} → v{a.toVersionNumber}
                {a.user ? ` · ${a.user}` : ''}{a.testSummary ? ` · ${a.testSummary}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Détails techniques : repliés, LECTURE SEULE (aucun sélecteur) */}
      <details className="text-xs text-[color:var(--text-muted)]" data-testid="t4-technical">
        <summary className="cursor-pointer">Détails techniques (lecture seule)</summary>
        <div className="mt-2 space-y-3">
          <p>
            Configuration gérée automatiquement par Verebona : modèles, fonctions (TASK), versions de contrats et traces. Rien n’est à choisir ici.
          </p>
          <BundleDetails bundle={detail.unified?.bundle} titre="Configuration complète du moteur déployé" />
          {detail.unified && detail.unified.bundleIssues.length > 0 && (
            <div role="alert" className="text-[color:var(--text-danger)] break-words">
              <p>{T4_ENGINE_ERROR} :</p>
              <ul className="list-disc pl-5">{detail.unified.bundleIssues.map((i, k) => <li key={k}>{i.message}</li>)}</ul>
            </div>
          )}
          {active && <BundleDetails bundle={active.bundle} titre={`Configuration figée avec la version active ${nomActive}`} />}
          {active && <TechnicalDetails v={active} environment={detail.environment} />}
          {draft && <TechnicalDetails v={draft} environment={detail.environment} />}
          {detail.structured && (
            <MasterPromptExecutionPanel
              treatment={treatment} info={detail.structured} managed
              execution={active?.execution ?? (detail.initialContent?.source === 'config'
                ? { mode: 'LEGACY_TEMPLATE', inputContractVersion: null, outputContractVersion: null, allowedTasks: null }
                : detail.reference?.execution ?? null)}
              editable={false} versionTarget="active"
            />
          )}
        </div>
      </details>

      {/* Aperçu d'une version de l'historique */}
      <Dialog open={apercu !== null} onOpenChange={(o) => { if (!o) setApercu(null); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>T4 — v{apercu?.versionNumber} ({apercu?.statusLabel})</DialogTitle>
            <DialogDescription>{apercu?.originLabel}</DialogDescription>
          </DialogHeader>
          {apercu && (
            <div className="space-y-3">
              {apercu.functions && <FunctionsSummary functions={apercu.functions} titre={`Version v${apercu.versionNumber}`} />}
              <pre className="max-h-80 overflow-auto rounded bg-[color:var(--bg-page)] p-2 text-xs font-mono whitespace-pre-wrap break-words text-[color:var(--text-secondary)]">
                {apercu.content}
              </pre>
              <BundleDetails bundle={apercu.bundle} titre="Configuration figée" />
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Une seule confirmation, légère et informative */}
      <Dialog open={confirm !== null} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm?.kind === 'activate' ? 'Activer la version de T4'
                : confirm?.kind === 'reactivate' ? `Réactiver la version v${confirm.version.versionNumber} de T4`
                  : 'Abandonner le brouillon'}
            </DialogTitle>
            <DialogDescription>
              {confirm?.kind === 'activate'
                ? `Le texte affiché devient la version active, avec les quatre fonctions T4. La ${nomActive} reste dans l’historique et peut être réactivée.`
                : confirm?.kind === 'reactivate'
                  ? `Cette version redevient active immédiatement, à l’identique (texte et configuration d’origine). La ${nomActive} reste dans l’historique.`
                  : 'Le texte du brouillon sera supprimé. La version active n’est pas modifiée.'}
              {confirm?.kind === 'reactivate' && limitesDe(confirm.version).length > 0 && (
                <span className="block mt-2 text-[color:var(--text-warning-soft)] break-words" data-testid="t4-rollback-limits">
                  Version ancienne aux fonctions limitées : {limitesDe(confirm.version).map((f) => `${f.label}${f.reason ? ` (${f.reason})` : ''}`).join(' ; ')}.
                </span>
              )}
              {confirm?.kind === 'activate' && (dirty || draft?.test.state === 'never') && (
                <span className="block mt-2 text-[color:var(--text-warning-soft)]">Cette version n’a pas encore été testée avec le corpus.</span>
              )}
              {confirm?.kind === 'activate' && !dirty && draft?.test.state === 'done' && draft.test.run.failed > 0 && (
                <span className="block mt-2 text-[color:var(--text-warning-soft)]">{draft.test.message}</span>
              )}
              {confirm?.kind === 'activate' && a1 && !a1.allowed && (
                <span className="block mt-2 text-xs text-[color:var(--text-warning-soft)] max-h-40 overflow-y-auto break-words" data-testid="a1-notices">
                  {a1.notices.slice(0, 7).map((n, k) => <span key={k} className="block">{n}</span>)}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setConfirm(null)}>Annuler</Button>
            <Button
              variant={confirm?.kind === 'discard' ? 'destructive' : 'default'}
              onClick={() => {
                const c = confirm;
                setConfirm(null);
                if (c?.kind === 'activate') void activer();
                else if (c?.kind === 'reactivate') void reactiver(c.version);
                else if (c?.kind === 'discard') void abandonner();
              }}
            >
              {confirm?.kind === 'discard' ? 'Abandonner' : confirm?.kind === 'reactivate' ? 'Réactiver' : 'Activer la version'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
