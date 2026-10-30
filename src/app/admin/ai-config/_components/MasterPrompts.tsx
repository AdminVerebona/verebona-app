'use client';

/**
 * Prompts maîtres T1, T2, T3, T4 et T6 — administration MANUELLE depuis le
 * BO. Ticket BO-IA-PROMPTS-01 ; lot 49 : T5 (Prompt Control) supprimé ;
 * lot 53 (D24) : son historique reste consultable en lecture seule, libellé
 * « retiré ».
 *
 * Parcours nominal : Modifier → Enregistrer → (éventuellement Tester) →
 * Activer. En cas de problème : Historique → Réactiver cette version.
 *
 * Ce que l'écran garantit :
 *   · l'Actif n'est jamais modifié en place : « Modifier » ouvre un brouillon
 *     (AC01, AC02) ;
 *   · « Activer » reste disponible sans test, ou avec des tests en échec : un
 *     badge « Non testé » / « 3 scénarios en échec sur 50 » informe, une seule
 *     confirmation légère, aucune procédure (AC03 à AC05) ;
 *   · chaque prompt s'administre seul, sans regard sur les autres (AC06) ;
 *   · aucune commande, aucun chemin, aucune empreinte dans le parcours : ces
 *     informations sont dans le volet replié « Détails techniques » (AC07, AC08) ;
 *   · seuls les contrôles techniques (prompt vide, emplacement inconnu…)
 *     empêchent l'activation, avec leur motif en clair (AC09) ;
 *   · historique, réactivation et journal des activations (AC10, AC11) ;
 *   · « Tester avec le corpus » facultatif, résultats par version, et
 *     « Cette version n'a pas encore été testée » dès que le texte change
 *     (AC12 à AC14).
 *
 * Composants et jetons existants uniquement (« garde mon design »).
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
import { MasterPromptExecutionPanel, executionSummary, type ExecutionConfig, type StructuredInfo } from './MasterPromptExecutionPanel';

// ─── Types rendus par /api/admin/ai/master-prompts ────────────────────────────

interface TestFailure { scenario: string; description: string; branch: string; expected: string; obtained: string }
interface TestRun {
  id: number; status: 'RUNNING' | 'DONE' | 'ERROR'; startedAt: string; finishedAt: string | null;
  total: number; passed: number; failed: number; failures: TestFailure[]; error: string | null; current: boolean;
  requestedBy: string | null;
}
type TestState =
  | { state: 'never'; label: string; message: string; previous: TestRun | null }
  | { state: 'running' | 'done' | 'error'; label: string; message: string; run: TestRun };

interface VersionView {
  id: number; versionNumber: number; status: 'DRAFT' | 'ACTIVE' | 'PREVIOUS'; statusLabel: string;
  originLabel: string; createdAt: string; createdBy: string | null; updatedAt: string;
  activatedAt: string | null; activatedBy: string | null; basedOnVersionNumber: number | null;
  test: TestState;
  technical: { masterPromptCode: string; contentSha256: string; runtimeVersion: string; versionId: number };
  /** Lot 34D : configuration d'exécution (T4) ; `null` pour les autres prompts. */
  execution?: ExecutionConfig | null;
}
interface Issue { code: string; message: string; blocking: boolean }
interface Activation {
  id: number; action: 'activate' | 'rollback'; actionLabel: string; fromVersionNumber: number | null;
  toVersionNumber: number; user: string | null; at: string; testSummary: string | null;
}
interface Detail {
  treatment: string; label: string; masterPromptCode: string; environment: string; initial: boolean;
  active: (VersionView & { content: string }) | null;
  initialContent: { content: string; source: 'config' | 'file' } | null;
  draft: (VersionView & { content: string; issues: Issue[]; warnings: Issue[] }) | null;
  history: VersionView[];
  activations: Activation[];
  limits: { maxChars: number };
  /** Lot 34D : texte livré avec l'application (rechargeable dans le brouillon). */
  reference?: { content: string; execution: ExecutionConfig | null };
  /** Lot 34D : contexte structuré (T4). */
  structured?: StructuredInfo | null;
  /** Lot 59 (#419) : contrôle du prompt maître T2 actif / brouillon. */
  t2Capabilities?: {
    active: T2Capabilities; draft: T2Capabilities | null;
    activeOrigin?: { kind: 'BO_VERSION' | 'INITIAL_CONFIG' | 'REPOSITORY_FILE'; versionNumber: number | null };
  } | null;
  /** Lot 98A (P0-B) : compatibilité T4 de la version active et du brouillon. */
  t4Compatibility?: { active: T4Compatibility; draft: T4Compatibility | null } | null;
}
/** Lot 98A (P0-B) — compatibilité T4 avec le moteur « À traiter » (service `assessT4Compatibility`). */
interface T4Compatibility {
  compatible: boolean; textReady: boolean;
  issues: Array<{ code: string; message: string }>;
  remedy: 'NONE' | 'PREPARE_SAME_TEXT' | 'RESTART_FROM_REFERENCE';
  target: ExecutionConfig;
}
interface T2Capabilities {
  checks: Array<{ code: string; label: string; present: boolean }>; arbitration: boolean; interaction: boolean; message: string | null;
  /** Lot 75J : compatibilité avec les variables injectées et les branches. */
  compatibility?: { compatible: boolean; missingVariables: string[]; unknownPlaceholders: string[]; missingBranches: string[] };
}

/** Lot 75J (#419 §3) — libellé de la version contrôlée (celle réellement utilisée). */
function origineT2(o: NonNullable<Detail['t2Capabilities']>['activeOrigin']): string {
  if (!o) return 'Version active';
  if (o.kind === 'BO_VERSION') return `Version active v${o.versionNumber ?? '?'} (BO)`;
  return o.kind === 'INITIAL_CONFIG' ? 'Version active : texte initial (configuration)' : 'Version active : texte livré avec l’application';
}

/** Lot 59 (#419) — contrôle visible du prompt maître T2 (arbitrage, informations apportées). */
function T2CapabilitiesPanel({ caps, titre, recette = false }: { caps: T2Capabilities; titre: string; recette?: boolean }) {
  const compat = caps.compatibility;
  const ok = caps.arbitration && caps.interaction && (compat?.compatible ?? true);
  return (
    <div className={`rounded border p-2 text-xs space-y-1 ${ok ? 'border-[color:var(--border-success)] bg-[color:var(--bg-success)]' : 'border-[color:var(--border-warning)] bg-[color:var(--bg-warning)]'}`}
      data-testid="t2-capabilities">
      <p className="font-medium flex items-center gap-1.5 text-[color:var(--text-primary)]">
        {ok ? <CheckCircle2 className="w-3.5 h-3.5 text-[color:var(--text-success)]" /> : <AlertTriangle className="w-3.5 h-3.5 text-[color:var(--text-warning-soft)]" />}
        <span className="min-w-0 break-words">
          {titre} : {compat ? (compat.compatible ? 'compatible avec le serveur' : 'INCOMPATIBLE avec le serveur') + ' · ' : ''}arbitrage sémantique {caps.arbitration ? 'disponible' : 'IMPOSSIBLE'} · informations apportées {caps.interaction ? 'comprises' : 'non comprises'}
        </span>
      </p>
      <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-[color:var(--text-muted)]">
        {caps.checks.map((c) => (
          <li key={c.code} className="flex items-center gap-1">
            {c.present ? <CheckCircle2 className="w-3 h-3 text-[color:var(--text-success)]" /> : <XCircle className="w-3 h-3 text-[color:var(--text-danger)]" />}{c.label}
          </li>
        ))}
      </ul>
      {caps.message && <p className="text-[color:var(--text-warning-soft)] break-words">{caps.message}</p>}
      {recette && (
        <details className="text-[color:var(--text-secondary)] break-words" data-testid="t2-recette-419">
          <summary className="cursor-pointer text-[color:var(--text-primary)]">Vérifier le fonctionnement réel (recette du ticket 419)</summary>
          <ol className="list-decimal pl-5 space-y-0.5 mt-1">
            <li>La présence d’une règle dans le texte ne prouve pas son fonctionnement : posez les questions de recette à l’assistant avec un compte de test Premium.</li>
            <li>Ouvrez « Exécutions IA » → onglet « Requêtes T2 », puis la cascade de chaque demande (rubrique <code>semantic</code>).</li>
            <li>Vérifiez la version utilisée (<code>t2PromptAtUnderstand.version</code>, <code>t2PromptCapabilities.version</code>) : elle doit être celle affichée ici.</li>
            <li>Vérifiez la décision : sources envisagées et capacité (<code>semanticCandidates</code>), exclusions (<code>candidatesExcluded</code>), décision T2 (<code>semanticDecision</code>), validation serveur (<code>candidateRefValidated</code>), source servie (<code>selectedSource</code>).</li>
            <li>Informations apportées : <code>interactionMode</code>, <code>contextFactsUsed</code>, <code>contextFactsRejected</code>, <code>updateFactsRefused</code> ; aucune écriture sans confirmation.</li>
          </ol>
        </details>
      )}
    </div>
  );
}
/**
 * Lot 98A (P0-B) — diagnostic visible : la version T4 donne-t-elle au moteur
 * « À traiter » l'évaluation structurée d'une intervention (`t4_output_v3`) ?
 * Sinon, ce qui manque et le chemin (bouton de préparation d'un brouillon
 * conforme au même texte, ou « Repartir du texte de référence »). Jamais
 * d'activation automatique.
 */
function T4CompatibilityPanel({ compat, titre, busy, onPrepare }: {
  compat: T4Compatibility; titre: string; busy?: boolean; onPrepare?: () => void;
}) {
  const ok = compat.compatible && compat.textReady;
  return (
    <div className={`rounded border p-2 text-xs space-y-1 ${ok ? 'border-[color:var(--border-success)] bg-[color:var(--bg-success)]' : 'border-[color:var(--border-warning)] bg-[color:var(--bg-warning)]'}`}
      data-testid="t4-compatibility">
      <p className="font-medium flex items-center gap-1.5 text-[color:var(--text-primary)]">
        {ok ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-[color:var(--text-success)]" /> : <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-[color:var(--text-warning-soft)]" />}
        <span className="min-w-0 break-words">
          {titre} : {ok
            ? 'compatible avec le moteur « À traiter » (évaluation structurée de l’intervention, t4_output_v3 ou suivant)'
            : compat.compatible
              ? 'contrat compatible, mais le texte ne décrit pas l’évaluation de l’intervention'
              : 'INCOMPATIBLE avec le moteur « À traiter » : les cartes de date inconnue ou d’échéance passée restent en attente (T4_INCOMPATIBLE)'}
        </span>
      </p>
      {compat.issues.length > 0 && (
        <ul className="space-y-0.5 text-[color:var(--text-secondary)]">
          {compat.issues.map((i) => (
            <li key={i.code} className="flex items-start gap-1 break-words">
              <XCircle className="w-3 h-3 mt-0.5 shrink-0 text-[color:var(--text-danger)]" /><span className="min-w-0">{i.message}</span>
            </li>
          ))}
        </ul>
      )}
      {!ok && (
        <p className="text-[color:var(--text-muted)] break-words">Configuration attendue : {executionSummary(compat.target)}</p>
      )}
      {compat.remedy === 'PREPARE_SAME_TEXT' && onPrepare && (
        <div className="space-y-1">
          <p className="text-[color:var(--text-secondary)] break-words">
            Le texte actif porte déjà l’évaluation : un brouillon avec le même texte et la configuration attendue peut être préparé. Il n’est pas activé : vérifiez-le, puis cliquez sur « Activer ».
          </p>
          <Button size="sm" variant="outline" className="min-h-[44px] sm:min-h-0" disabled={busy} onClick={onPrepare}>
            {busy ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Pencil className="w-3.5 h-3.5 mr-1.5" />}
            Préparer une version conforme
          </Button>
        </div>
      )}
      {compat.remedy === 'RESTART_FROM_REFERENCE' && (
        <p className="text-[color:var(--text-secondary)] break-words">
          Cliquez sur « Modifier », choisissez le mode « Contexte structuré », puis « Repartir du texte de référence (Contexte structuré) », enregistrez et activez (guide du PO, étape 8).
        </p>
      )}
    </div>
  );
}

interface Summary {
  treatment: string; label: string; masterPromptCode: string;
  active: { versionNumber: number | null; initial: boolean; activatedAt: string | null; test: TestState };
  draft: { versionNumber: number; updatedAt: string; test: TestState } | null;
}

// ─── Fragments ────────────────────────────────────────────────────────────────

/** « 05/10/2026 à 21:42 » */
function dateHeure(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString('fr-FR')} à ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
}

const errMessage = (e: unknown, defaut: string) => (e as { message?: string })?.message || defaut;

/** Badge léger, jamais bloquant. */
function TestBadge({ test }: { test: TestState }) {
  const style = test.state === 'done' && test.run.failed === 0
    ? 'bg-[color:var(--bg-success)] text-[color:var(--text-success)] border-[color:var(--border-success)]'
    : test.state === 'done' || test.state === 'error'
      ? 'bg-[color:var(--bg-warning)] text-[color:var(--text-warning-soft)] border-[color:var(--border-warning)]'
      : 'bg-[color:var(--bg-subtle)] text-[color:var(--text-muted)] border-[color:var(--border)]';
  return <span className={`text-xs px-2 py-0.5 rounded-full border ${style}`}>{test.label}</span>;
}

function StatusPill({ status, label }: { status: VersionView['status']; label: string }) {
  const style = status === 'ACTIVE'
    ? 'bg-[color:var(--bg-success)] text-[color:var(--text-success)] border-[color:var(--border-success)]'
    : status === 'DRAFT'
      ? 'bg-[color:var(--bg-subtle)] text-[color:var(--text-muted)] border-[color:var(--border)]'
      : 'bg-[color:var(--bg-page)] text-[color:var(--text-muted)] border-[color:var(--border-subtle)]';
  return <span className={`text-xs px-2 py-0.5 rounded-full border ${style}`}>{label}</span>;
}

function FailureList({ failures }: { failures: TestFailure[] }) {
  if (failures.length === 0) return <p className="text-xs text-[color:var(--text-muted)]">Aucun scénario en échec.</p>;
  return (
    <ul className="space-y-2">
      {failures.map((f) => (
        <li key={f.scenario} className="rounded-md border border-[color:var(--border-subtle)] p-2 text-xs space-y-1">
          <p className="font-medium text-[color:var(--text-primary)]">
            {f.scenario} <span className="text-[color:var(--text-muted)] font-normal">· branche {f.branch}</span>
          </p>
          {f.description && <p className="text-[color:var(--text-muted)]">{f.description}</p>}
          <p><span className="text-[color:var(--text-secondary)]">Résultat attendu :</span> {f.expected}</p>
          <p><span className="text-[color:var(--text-secondary)]">Résultat obtenu :</span> <span className="text-[color:var(--text-danger)]">{f.obtained}</span></p>
        </li>
      ))}
    </ul>
  );
}

/**
 * Bloc « Dernier test » d'une version : date, résultat, échecs, actions
 * « Voir les résultats » et « Relancer les tests » (AC12, AC13). Un test
 * d'un contenu antérieur n'est jamais présenté comme celui du texte actuel (AC14).
 */
function TestPanel({ test, versionLabel, busy, onRun }: {
  test: TestState; versionLabel: string; busy: boolean; onRun: () => void;
}) {
  const [voir, setVoir] = useState(false);
  return (
    <div className="rounded-lg border border-[color:var(--border-subtle)] p-3 space-y-2">
      {test.state === 'never' ? (
        <>
          <p className="text-sm text-[color:var(--text-secondary)]">{test.message}</p>
          {test.previous && (
            <details>
              <summary className="text-xs text-[color:var(--accent)] cursor-pointer">
                Test d’un contenu précédent ({dateHeure(test.previous.startedAt)} — {test.previous.passed}/{test.previous.total} scénarios réussis)
              </summary>
              <p className="text-xs text-[color:var(--text-muted)] mt-1">
                Ce résultat porte sur le texte d’avant la dernière modification : il ne vaut pas pour le texte actuel.
              </p>
              <div className="mt-2"><FailureList failures={test.previous.failures} /></div>
            </details>
          )}
        </>
      ) : (
        <>
          <p className="text-sm text-[color:var(--text-primary)]">
            Dernier test : {dateHeure(test.run.startedAt)} <span className="text-[color:var(--text-muted)]">· {versionLabel}</span>
          </p>
          {test.state === 'done' && (
            <p className="text-sm text-[color:var(--text-secondary)]">
              Résultat : {test.run.passed}/{test.run.total} scénarios réussis
              {test.run.failed > 0 && <span className="text-[color:var(--text-danger)]"> · {test.run.failed} échec{test.run.failed > 1 ? 's' : ''}</span>}
            </p>
          )}
          {test.state !== 'done' && <p className="text-sm text-[color:var(--text-warning-soft)]">{test.message}</p>}
        </>
      )}
      <div className="flex flex-wrap gap-2">
        {test.state === 'done' && (
          <Button size="sm" variant="ghost" onClick={() => setVoir((v) => !v)}>
            {voir ? 'Masquer les résultats' : 'Voir les résultats'}
          </Button>
        )}
        <Button size="sm" variant="outline" disabled={busy} onClick={onRun}>
          {busy ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <FlaskConical className="w-3.5 h-3.5 mr-1.5" />}
          {test.state === 'never' ? 'Tester avec le corpus' : 'Relancer les tests'}
        </Button>
      </div>
      {voir && test.state === 'done' && <FailureList failures={test.run.failures} />}
      <p className="text-xs text-[color:var(--text-muted)]">
        Facultatif : le test rejoue les scénarios de référence sans appeler le modèle (aucun coût). Il n’empêche jamais l’activation.
      </p>
    </div>
  );
}

function TechnicalDetails({ v, environment }: { v: VersionView; environment: string }) {
  return (
    <details className="text-xs text-[color:var(--text-muted)]">
      <summary className="cursor-pointer">Détails techniques</summary>
      <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 break-all">
        <dt>Prompt</dt><dd>{v.technical.masterPromptCode}</dd>
        <dt>Version d’exécution</dt><dd>{v.technical.runtimeVersion}</dd>
        <dt>Empreinte</dt><dd>{v.technical.contentSha256}</dd>
        <dt>Identifiant</dt><dd>{v.technical.versionId}</dd>
        <dt>Environnement</dt><dd>{environment}</dd>
      </dl>
    </details>
  );
}

// ─── Un prompt ────────────────────────────────────────────────────────────────

function MasterPromptEditor({ treatment, onChanged }: { treatment: string; onChanged: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [texte, setTexte] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<null | 'draft' | 'conform' | 'save' | 'test' | 'activate' | 'discard' | 'reactivate'>(null);
  const [confirm, setConfirm] = useState<null | { kind: 'activate' } | { kind: 'reactivate'; version: VersionView } | { kind: 'discard' }>(null);
  const [a1, setA1] = useState<{ allowed: boolean; notices: string[] } | null>(null);
  const [apercu, setApercu] = useState<null | (VersionView & { content: string })>(null);
  const [execution, setExecution] = useState<ExecutionConfig | null>(null);

  const appliquer = useCallback((d: Detail) => {
    setDetail(d);
    setTexte(d.draft?.content ?? '');
    setExecution(d.draft?.execution ?? null);
    setDirty(false);
  }, []);

  const charger = useCallback(async () => {
    setErreur(null);
    try {
      appliquer(await apiClient.get<Detail>(`/api/admin/ai/master-prompts/${treatment}`));
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

  const modifier = async () => {
    setBusy('draft');
    try {
      const r = await apiClient.post<{ detail: Detail }>(`/api/admin/ai/master-prompts/${treatment}/draft`, {});
      appliquer(r.detail);
      onChanged();
    } catch (e) { toast.error(errMessage(e, 'Le brouillon n’a pas pu être créé.')); } finally { setBusy(null); }
  };

  /** Lot 98A (P0-B) : brouillon T4 conforme au même texte (jamais activé automatiquement). */
  const preparerConforme = async () => {
    setBusy('conform');
    try {
      const r = await apiClient.post<{ detail: Detail }>(`/api/admin/ai/master-prompts/${treatment}/draft`, { conformT4: true });
      appliquer(r.detail);
      toast.success('Brouillon conforme préparé : vérifiez-le puis cliquez sur « Activer ».');
      onChanged();
    } catch (e) { toast.error(errMessage(e, 'Le brouillon conforme n’a pas pu être préparé.')); } finally { setBusy(null); }
  };

  /** Enregistre le brouillon ; rend le détail à jour (ou null en cas d'échec). */
  const enregistrer = async (silencieux = false): Promise<Detail | null> => {
    if (!draft) return null;
    setBusy('save');
    try {
      const r = await apiClient.put<{ detail: Detail }>(`/api/admin/ai/master-prompts/${treatment}/draft`, {
        versionId: draft.id, content: texte,
        // Lot 34D : mode d'exécution explicite (T4), enregistré avec le texte.
        ...(detail?.structured && execution ? { execution } : {}),
      });
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
      const run = await apiClient.post<TestRun>(
        `/api/admin/ai/master-prompts/${treatment}/versions/${cible}/tests`, {}, { policy: 'long' },
      );
      if (run.status === 'DONE') {
        toast[run.failed === 0 ? 'success' : 'warning'](`Test terminé : ${run.passed}/${run.total} scénarios réussis`);
      } else {
        toast.error(run.error ?? 'Le test n’a pas abouti.');
      }
      await charger();
      onChanged();
    } catch (e) { toast.error(errMessage(e, 'Le test n’a pas pu être lancé.')); } finally { setBusy(null); }
  };

  const demanderActivation = async () => {
    if (dirty && !(await enregistrer(true))) return;
    setConfirm({ kind: 'activate' });
    // Lot 100B (#345, arbitrage A1) : matrice et manques de couverture affichés, jamais bloquants.
    setA1(null);
    apiClient.get<{ allowed: boolean; notices: string[] }>(`/api/admin/ai/corpus/a1?treatment=${treatment}`).then(setA1).catch(() => setA1(null));
  };

  const activer = async () => {
    if (!draft) return;
    setBusy('activate');
    try {
      const r = await apiClient.post<{ activeVersionNumber: number; notices: string[]; detail: Detail }>(
        `/api/admin/ai/master-prompts/${treatment}/versions/${draft.id}/activate`, {},
      );
      appliquer(r.detail);
      toast.success(`${treatment} : version v${r.activeVersionNumber} active. Les prochains traitements l’utilisent.`);
      onChanged();
    } catch (e) { toast.error(errMessage(e, 'Activation impossible.')); } finally { setBusy(null); }
  };

  const reactiver = async (v: VersionView) => {
    setBusy('reactivate');
    try {
      const r = await apiClient.post<{ activeVersionNumber: number; detail: Detail }>(
        `/api/admin/ai/master-prompts/${treatment}/versions/${v.id}/reactivate`, {},
      );
      appliquer(r.detail);
      toast.success(`${treatment} : version v${r.activeVersionNumber} réactivée.`);
      onChanged();
    } catch (e) { toast.error(errMessage(e, 'Réactivation impossible.')); } finally { setBusy(null); }
  };

  const abandonner = async () => {
    if (!draft) return;
    setBusy('discard');
    try {
      const r = await apiClient.delete<{ detail: Detail }>(`/api/admin/ai/master-prompts/${treatment}/draft?versionId=${draft.id}`);
      appliquer(r.detail);
      toast.success('Brouillon abandonné');
      onChanged();
    } catch (e) { toast.error(errMessage(e, 'Abandon impossible.')); } finally { setBusy(null); }
  };

  const voirVersion = async (v: VersionView) => {
    try {
      setApercu(await apiClient.get<VersionView & { content: string }>(`/api/admin/ai/master-prompts/${treatment}/versions/${v.id}`));
    } catch (e) { toast.error(errMessage(e, 'Version illisible.')); }
  };

  const bloquants = draft && !dirty ? draft.issues : [];
  const tropLong = texte.length > detail.limits.maxChars;

  return (
    <div className="space-y-4">
      {/* Version active */}
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
        {detail.initial && (
          <p className="text-xs text-[color:var(--text-muted)]">
            {detail.initialContent?.source === 'config'
              ? 'Texte en service : celui de la configuration IA. Il deviendra la v1 de l’historique à la première modification.'
              : 'Texte en service : celui livré avec l’application. Il deviendra la v1 de l’historique à la première modification.'}
          </p>
        )}
        <details>
          <summary className="text-xs text-[color:var(--accent)] cursor-pointer">Voir le texte actif</summary>
          <pre className="mt-2 max-h-72 overflow-auto rounded bg-[color:var(--bg-page)] p-2 text-xs font-mono whitespace-pre-wrap text-[color:var(--text-secondary)]">
            {active?.content ?? detail.initialContent?.content ?? ''}
          </pre>
        </details>
        {detail.t2Capabilities && <T2CapabilitiesPanel caps={detail.t2Capabilities.active} titre={origineT2(detail.t2Capabilities.activeOrigin)} recette />}
        {detail.t4Compatibility && (
          <T4CompatibilityPanel compat={detail.t4Compatibility.active} titre={`Version active ${nomActive}`}
            busy={busy !== null} onPrepare={draft ? undefined : () => void preparerConforme()} />
        )}
        {!draft && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={modifier} disabled={busy !== null}>
              {busy === 'draft' ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Pencil className="w-3.5 h-3.5 mr-1.5" />}
              Modifier
            </Button>
          </div>
        )}
        {!draft && (
          <TestPanel
            test={active?.test ?? { state: 'never', label: 'Non testé', message: 'Cette version n’a pas encore été testée.', previous: null }}
            versionLabel={nomActive} busy={busy === 'test'} onRun={() => void tester(active ? active.id : 'active')}
          />
        )}
        {!draft && detail.structured && (
          <MasterPromptExecutionPanel
            treatment={treatment} info={detail.structured}
            execution={active?.execution ?? (detail.initialContent?.source === 'config'
              ? { mode: 'LEGACY_TEMPLATE', inputContractVersion: null, outputContractVersion: null, allowedTasks: null }
              : detail.reference?.execution ?? null)}
            editable={false} versionTarget="active"
          />
        )}
      </div>

      {/* Brouillon */}
      {draft && (
        <div className="rounded-lg border border-[color:var(--border-subtle)] p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status="DRAFT" label={`Brouillon v${draft.versionNumber}`} />
            <TestBadge test={dirty ? { state: 'never', label: 'Non testé', message: '', previous: null } : draft.test} />
            {dirty && <span className="text-xs text-[color:var(--text-warning-soft)]">• non enregistré</span>}
            <span className="text-xs text-[color:var(--text-muted)]">
              {draft.basedOnVersionNumber ? `à partir de v${draft.basedOnVersionNumber} · ` : ''}modifié le {dateHeure(draft.updatedAt)}
            </span>
          </div>
          <p className="text-xs text-[color:var(--text-muted)]">
            Le brouillon n’est jamais utilisé par l’application tant qu’il n’est pas activé. La version active continue de servir.
          </p>
          {detail.t2Capabilities?.draft && !dirty && <T2CapabilitiesPanel caps={detail.t2Capabilities.draft} titre="Brouillon" />}
          {detail.t4Compatibility?.draft && !dirty && <T4CompatibilityPanel compat={detail.t4Compatibility.draft} titre={`Brouillon v${draft.versionNumber}`} />}
          <Textarea
            aria-label={`Texte du brouillon ${treatment}`}
            value={texte}
            disabled={busy !== null}
            onChange={(e) => { setTexte(e.target.value); setDirty(true); }}
            className="min-h-[260px] font-mono text-xs bg-[color:var(--bg-input)]"
          />
          <p className={`text-xs ${tropLong ? 'text-[color:var(--text-danger)]' : 'text-[color:var(--text-muted)]'}`}>
            {texte.length.toLocaleString('fr-FR')} / {detail.limits.maxChars.toLocaleString('fr-FR')} caractères
          </p>
          {/* Lot 34D : texte livré avec l'application (nouvelle version du dépôt). */}
          {!detail.structured && detail.reference?.content && detail.reference.content !== texte && (
            <Button size="sm" variant="ghost" disabled={busy !== null}
              onClick={() => { setTexte(detail.reference!.content); setDirty(true); }}>
              Repartir du texte livré avec l’application
            </Button>
          )}
          {detail.structured && (
            <MasterPromptExecutionPanel
              treatment={treatment} info={detail.structured} execution={execution} editable
              versionTarget={draft.id} disabled={busy !== null}
              onChange={(e) => { setExecution(e); setDirty(true); }}
              onLoadReference={(t, e) => { setTexte(t); if (e) setExecution(e); setDirty(true); }}
            />
          )}

          {bloquants.length > 0 && (
            <div role="alert" className="rounded-lg border border-[color:var(--border-danger)] bg-[color:var(--bg-danger)] p-3 space-y-1">
              <p className="text-sm font-medium text-[color:var(--text-primary)]">À corriger avant activation</p>
              {bloquants.map((i, k) => (
                <p key={k} className="text-xs text-[color:var(--text-secondary)] flex items-start gap-1.5">
                  <XCircle className="w-3.5 h-3.5 text-[color:var(--text-danger)] mt-0.5 shrink-0" /> {i.message}
                </p>
              ))}
            </div>
          )}
          {!dirty && draft.warnings.length > 0 && (
            <div className="rounded-lg border border-[color:var(--border-warning)] bg-[color:var(--bg-warning)] p-3 space-y-1">
              {draft.warnings.map((i, k) => (
                <p key={k} className="text-xs text-[color:var(--text-secondary)] flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-[color:var(--text-warning-soft)] mt-0.5 shrink-0" /> {i.message}
                </p>
              ))}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => void enregistrer()} disabled={!dirty || busy !== null}>
              {busy === 'save' ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-1.5" />}
              Enregistrer le brouillon
            </Button>
            <Button size="sm" onClick={() => void demanderActivation()} disabled={busy !== null || bloquants.length > 0 || tropLong}>
              {busy === 'activate' ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />}
              Activer
            </Button>
            <span className="flex-1" />
            <Button size="sm" variant="ghost" onClick={() => setConfirm({ kind: 'discard' })} disabled={busy !== null}>
              <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Abandonner le brouillon
            </Button>
          </div>

          {dirty
            ? <p className="text-xs text-[color:var(--text-muted)]">Cette version n’a pas encore été testée. « Tester » enregistre d’abord le brouillon.</p>
            : null}
          <TestPanel
            test={dirty ? { state: 'never', label: 'Non testé', message: 'Cette version n’a pas encore été testée.', previous: null } : draft.test}
            versionLabel={`brouillon v${draft.versionNumber}`} busy={busy === 'test'} onRun={() => void tester(draft.id)}
          />
          <TechnicalDetails v={draft} environment={detail.environment} />
        </div>
      )}

      {/* Historique (AC10, AC11) */}
      {detail.history.length > 0 && (
        <details>
          <summary className="text-sm text-[color:var(--text-secondary)] cursor-pointer">Historique des versions ({detail.history.length})</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[color:var(--text-muted)]">
                  <th className="py-1 pr-3 font-normal">Version</th>
                  <th className="py-1 pr-3 font-normal">Statut</th>
                  <th className="py-1 pr-3 font-normal">Date</th>
                  <th className="py-1 pr-3 font-normal">Tests</th>
                  <th className="py-1 font-normal" />
                </tr>
              </thead>
              <tbody>
                {detail.history.map((v) => (
                  <tr key={v.id} className="border-t border-[color:var(--border-subtle)]">
                    <td className="py-1.5 pr-3 text-[color:var(--text-primary)]">v{v.versionNumber}</td>
                    <td className="py-1.5 pr-3">
                      <StatusPill status={v.status} label={v.statusLabel} />
                      {v.execution && <span className="block text-[color:var(--text-muted)]">{executionSummary(v.execution)}</span>}
                    </td>
                    <td className="py-1.5 pr-3 text-[color:var(--text-secondary)]">{dateHeure(v.activatedAt ?? v.createdAt)}</td>
                    <td className="py-1.5 pr-3"><TestBadge test={v.test} /></td>
                    <td className="py-1.5 text-right whitespace-nowrap">
                      <Button size="sm" variant="ghost" onClick={() => void voirVersion(v)}>Voir</Button>
                      {v.status === 'PREVIOUS' && (
                        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setConfirm({ kind: 'reactivate', version: v })}>
                          <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Réactiver cette version
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {detail.activations.length > 0 && (
        <details>
          <summary className="text-sm text-[color:var(--text-secondary)] cursor-pointer">Journal des activations</summary>
          <ul className="mt-2 space-y-1 text-xs text-[color:var(--text-secondary)]">
            {detail.activations.map((a) => (
              <li key={a.id}>
                {dateHeure(a.at)} — {a.actionLabel} : {a.fromVersionNumber ? `v${a.fromVersionNumber}` : 'version initiale'} → v{a.toVersionNumber}
                {a.user ? ` · ${a.user}` : ''}{a.testSummary ? ` · ${a.testSummary}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}

      {active && <TechnicalDetails v={active} environment={detail.environment} />}

      {/* Aperçu d'une version de l'historique */}
      <Dialog open={apercu !== null} onOpenChange={(o) => { if (!o) setApercu(null); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{treatment} — v{apercu?.versionNumber} ({apercu?.statusLabel})</DialogTitle>
            <DialogDescription>{apercu?.originLabel}</DialogDescription>
          </DialogHeader>
          {apercu && (
            <div className="space-y-3">
              <TestPanel test={apercu.test} versionLabel={`v${apercu.versionNumber}`} busy={busy === 'test'}
                onRun={() => { const id = apercu.id; setApercu(null); void tester(id); }} />
              <pre className="max-h-80 overflow-auto rounded bg-[color:var(--bg-page)] p-2 text-xs font-mono whitespace-pre-wrap text-[color:var(--text-secondary)]">
                {apercu.content}
              </pre>
              <TechnicalDetails v={apercu} environment={detail.environment} />
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Une seule confirmation, légère et informative */}
      <Dialog open={confirm !== null} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm?.kind === 'activate' ? `Activer la version v${draft?.versionNumber} de ${treatment}`
                : confirm?.kind === 'reactivate' ? `Réactiver la version v${confirm.version.versionNumber} de ${treatment}`
                  : 'Abandonner le brouillon'}
            </DialogTitle>
            <DialogDescription>
              {confirm?.kind === 'activate'
                ? `Les prochains traitements ${treatment} utiliseront cette version. La ${nomActive} reste dans l’historique et peut être réactivée.`
                : confirm?.kind === 'reactivate'
                  ? `Cette version redevient active immédiatement. La ${nomActive} reste dans l’historique.`
                  : 'Le texte du brouillon sera supprimé. La version active n’est pas modifiée.'}
              {confirm?.kind === 'activate' && draft?.test.state === 'never' && (
                <span className="block mt-2 text-[color:var(--text-warning-soft)]">Cette version n’a pas encore été testée avec le corpus.</span>
              )}
              {confirm?.kind === 'activate' && draft?.test.state === 'done' && draft.test.run.failed > 0 && (
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
              {confirm?.kind === 'discard' ? 'Abandonner'
                : confirm?.kind === 'reactivate' ? 'Réactiver'
                  : draft && (draft.test.state !== 'done' || draft.test.run.failed > 0) ? 'Activer quand même' : 'Activer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Traitements retirés (lot 53, retour PO D24) ──────────────────────────────

interface RetiredHistory {
  treatment: string; label: string; statusLabel: string;
  versions: Array<{ id: number; versionNumber: number; status: string; masterPromptCode: string; origin: string; createdAt: string; activatedAt: string | null; content: string }>;
}

/** Historique en LECTURE SEULE d'un traitement retiré (T5) : aucune action. */
function RetiredPromptHistory({ h }: { h: RetiredHistory }) {
  return (
    <details className="rounded-lg border border-[color:var(--border-subtle)]" data-testid={`retired-prompt-${h.treatment}`}>
      <summary className="cursor-pointer px-3 py-2.5 flex flex-wrap items-center gap-2 text-sm text-[color:var(--text-muted)]">
        <span className="font-medium">{h.treatment} · {h.label}</span>
        <span className="text-xs">— {h.statusLabel} · historique en lecture seule ({h.versions.length} version{h.versions.length > 1 ? 's' : ''})</span>
      </summary>
      <div className="px-3 pb-3 space-y-2">
        <p className="text-xs text-[color:var(--text-muted)]">
          Traitement retiré au lot 49 : aucune exécution, aucun déclencheur. Les versions ci-dessous sont conservées pour l’audit
          et ne sont jamais appliquées.
        </p>
        {h.versions.length === 0 && <p className="text-xs text-[color:var(--text-muted)]">Aucune version conservée.</p>}
        {h.versions.map((v) => (
          <details key={v.id} className="rounded-md border border-[color:var(--border-subtle)]">
            <summary className="cursor-pointer px-2 py-1.5 text-xs text-[color:var(--text-muted)] break-words">
              v{v.versionNumber} · {v.status === 'ACTIVE' ? 'dernière active avant le retrait' : v.status === 'DRAFT' ? 'brouillon' : 'ancienne'} · créée le {dateHeure(v.createdAt)}
              {v.activatedAt ? ` · activée le ${dateHeure(v.activatedAt)}` : ''}
            </summary>
            <pre className="px-2 pb-2 text-[11px] whitespace-pre-wrap break-words max-h-64 overflow-y-auto text-[color:var(--text-primary)]">{v.content}</pre>
          </details>
        ))}
      </div>
    </details>
  );
}

// ─── Section ──────────────────────────────────────────────────────────────────

export function MasterPrompts({ refreshKey, onChanged }: {
  refreshKey?: number;
  /** Lot 54 : une activation crée une révision de la configuration active — l'écran la relit. */
  onChanged?: () => void;
}) {
  const [prompts, setPrompts] = useState<Summary[] | null>(null);
  const [retires, setRetires] = useState<RetiredHistory[]>([]);
  const [erreur, setErreur] = useState<string | null>(null);
  const [ouverts, setOuverts] = useState<Set<string>>(new Set());

  const charger = useCallback(async () => {
    setErreur(null);
    try {
      const r = await apiClient.get<{ prompts: Summary[]; retired?: RetiredHistory[] }>('/api/admin/ai/master-prompts');
      setPrompts(r.prompts);
      setRetires(r.retired ?? []);
    } catch (e) {
      setErreur(errMessage(e, 'Prompts maîtres indisponibles.'));
    }
  }, []);

  useEffect(() => { void charger(); }, [charger, refreshKey]);

  return (
    <section className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3">
      <div>
        <h2 className="vb-app-section">Prompts maîtres</h2>
        <p className="text-xs text-[color:var(--text-muted)]">
          Modifier → Enregistrer → (éventuellement Tester) → Activer. Chaque prompt s’administre indépendamment ;
          activer (ou réactiver) un prompt l’applique à la configuration active, dont une nouvelle révision est enregistrée.
        </p>
      </div>
      {erreur && (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-[color:var(--text-danger)]">{erreur}</p>
          <Button size="sm" variant="outline" onClick={() => void charger()}><RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Réessayer</Button>
        </div>
      )}
      {!prompts && !erreur && (
        <p className="text-xs text-[color:var(--text-muted)] flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Chargement…</p>
      )}
      {prompts?.map((p) => (
        <details
          key={p.treatment}
          className="rounded-lg border border-[color:var(--border-subtle)]"
          onToggle={(e) => {
            const open = (e.currentTarget as HTMLDetailsElement).open;
            setOuverts((s) => { const n = new Set(s); if (open) n.add(p.treatment); else n.delete(p.treatment); return n; });
          }}
        >
          <summary className="cursor-pointer px-3 py-2.5 flex flex-wrap items-center gap-2 text-sm text-[color:var(--text-primary)]">
            <span className="font-medium">{p.treatment} · {p.label}</span>
            <span className="text-xs text-[color:var(--text-muted)]">
              Active : {p.active.versionNumber ? `v${p.active.versionNumber}` : 'version initiale'}
            </span>
            <TestBadge test={p.active.test} />
            {p.draft && (
              <>
                <span className="text-xs text-[color:var(--text-muted)]">· Brouillon v{p.draft.versionNumber}</span>
                <TestBadge test={p.draft.test} />
              </>
            )}
          </summary>
          {ouverts.has(p.treatment) && (
            <div className="px-3 pb-3">
              <MasterPromptEditor key={`${p.treatment}-${refreshKey ?? 0}`} treatment={p.treatment} onChanged={() => { void charger(); onChanged?.(); }} />
            </div>
          )}
        </details>
      ))}
      {prompts && retires.map((h) => <RetiredPromptHistory key={h.treatment} h={h} />)}
    </section>
  );
}
