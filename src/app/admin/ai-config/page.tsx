"use client";

/**
 * Admin — Configuration IA — lot 54 (54C), ticket « BO-IA — Refonte de la
 * gestion des versions, restauration et export ».
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE VERSION = TOUTE LA CONFIGURATION (T1, T2, T3, T4, T6 — T5 retiré)
 *
 *   · Versions : nouvelle, dupliquer, modifier, « Activer en préproduction »,
 *     historique, supprimer (non active). Une seule active, clairement
 *     signalée ; elle reste modifiable — plus de Brouillon / À tester /
 *     Validé / Archivé, plus de lecture seule liée au statut.
 *   · Éditeur : version, révision courante, état, « Enregistrer » (UNE
 *     révision pour tous les traitements modifiés), historique.
 *   · Historique : révisions consultables et restaurables (confirmation) ;
 *     restaurer crée une nouvelle révision, rien n'est effacé.
 *   · « Exporter la configuration » : la configuration ACTIVE enregistrée,
 *     fichier validé par le serveur ; avertit si des modifications ne sont
 *     pas enregistrées ; indique si elle a changé depuis le dernier export.
 *   · Aucune publication ni activation vers la production.
 *
 * Desktop et mobile : mêmes composants, actions en `flex-wrap`, listes en
 * colonne sous `sm`.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import {
  Loader2, Plus, GitCompare, CheckCircle2, RotateCcw,
  Save, Lock, Undo2, Copy, History, Trash2, Download, Pencil, Eye,
} from 'lucide-react';
import { toast } from 'sonner';
import { MasterPrompts } from './_components/MasterPrompts';
import { EcranEnErreur } from '@/components/admin/EcranEnErreur';
import { apiClient } from '@/lib/api-client';
import { TreatmentStateControl, type TreatmentRuntimeState } from './_components/TreatmentStateControl';
import { AssistantSettings } from './_components/AssistantSettings';
import { ModelRegistry } from './_components/ModelRegistry';
import { Supervision, type Metric, type MetricTable } from './_components/Supervision';
import { AiEnvBanner } from '../ai-dashboard/_components/AiEnvBanner';
import { CatalogBanners } from './_components/CatalogBanners';
import { ConfigExecutionWarning } from './_components/ConfigExecutionWarning';
import { useUnsavedNavigationGuard } from './_components/useUnsavedNavigationGuard';
import { TriggersEditor } from './_components/TriggersEditor';
import { createEditTracker } from './_components/edit-tracker';
import type { CatalogTrigger } from './_components/triggers-model';
import { chainOptions, unusableRanks, type ChainRank } from '@/services/ai/registry/model-chain';
import { useRouter } from 'next/navigation';

// ─── Types de l'écran ─────────────────────────────────────────────────────────

type Treatment = 'T1' | 'T2' | 'T3' | 'T4' | 'T6';
/** Lot 54 : `ACTIVE` ou non active (anciennes valeurs lues comme non active). */
type Status = string;

interface GuardrailDef { code: string; label: string; description: string; unit: string }
interface TriggerDef { code: string; label: string; kind: 'event' | 'schedule'; help?: string | null }

interface TreatmentCatalog {
  code: Treatment;
  label: string;
  batch: boolean;
  guardrails: GuardrailDef[];
  triggers: TriggerDef[];
  /** Déclencheurs appliqués quand la liste enregistrée est vide (queue/triggers.ts). */
  defaultTriggers?: string[];
  /** CDC 15 D-04 : prompt maître déclaré pour ce traitement, sinon `null`. */
  master?: { masterPromptCode: string; tasks: string[] } | null;
}

/** CDC 15 D-04 : prompt maître unique (lot 16b : `steps` retiré, refusé par le serveur). */
type PromptArchitecture = 'master';

interface Catalogs {
  /** Liste globale (autres écrans) — jamais lue par les sélecteurs de modèles. */
  models: Array<{ model: string; available: boolean; priced: boolean; verified: boolean }>;
  /**
   * Lot 32B : modèles utilisables par traitement (`usableModelsForTreatment`,
   * serveur) — SEULE source des sélecteurs principal / repli 1 / repli 2.
   */
  modelsByTreatment?: Partial<Record<Treatment, Array<{ model: string; status?: string; priced: boolean; verified: boolean; providerVerified?: boolean; operational?: boolean | null }>>>;
  /** Modèles connus non utilisables et leur motif : nomme une valeur enregistrée, jamais un choix. */
  excludedByTreatment?: Partial<Record<Treatment, Array<{ model: string; reasonText: string }>>>;
  reasoningLevels: string[];
  guardrailReactions: string[];
  treatments: TreatmentCatalog[];
  /**
   * Catalogue COMPLET des déclencheurs (libellés, applicabilité, retraits) :
   * sert à nommer et expliquer une entrée enregistrée incompatible.
   */
  triggerCatalog?: CatalogTrigger[];
}

/**
 * Catalogue des déclencheurs exploitable pour ce traitement ? Absent ou
 * malformé (réponse partielle, serveur antérieur) : le BO affiche une erreur
 * et « Réessayer » — jamais une liste vide présentée comme valide.
 */
function triggerCatalogAvailable(catalog: TreatmentCatalog, catalogs: Catalogs): boolean {
  return Array.isArray(catalog.triggers) && Array.isArray(catalogs.triggerCatalog);
}

interface Cascade {
  database: number; text: number; semantic: number; semanticEnabled: boolean;
}

interface Entry {
  treatment: Treatment;
  prompt: string;
  primaryModel: string | null;
  fallback1: string | null;
  fallback2: string | null;
  reasoningPrimary: string | null;
  reasoningFallback1: string | null;
  reasoningFallback2: string | null;
  maxOutputTokens: number | null;
  guardrails: Array<{ code: string; threshold: number; reaction: string }>;
  triggers: Array<{ kind: 'event' | 'schedule'; code: string; active: boolean }>;
  cascade: Cascade | null;
  /** Toujours `master` (lot 16b), renvoyé tel quel à l'enregistrement. */
  promptArchitecture?: PromptArchitecture;
  /** CDC 15 D-03 : texte complet du prompt maître, distinct du préambule. */
  masterPrompt?: string | null;
}

interface Version {
  id: number;
  status: Status;
  active: boolean;
  stateLabel?: string;
  visibleNumber: number | null;
  label: string | null;
  description: string | null;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string | null;
  updatedByEmail?: string | null;
  deletedAt: string | null;
  currentRevisionNumber: number | null;
}

interface MasterPromptRef { versionId: number; versionNumber: number; masterPromptCode: string; contentSha256: string }

interface VersionDetail extends Version {
  entries: Entry[];
  masterPrompts?: Partial<Record<Treatment, MasterPromptRef | null>>;
  readOnly: boolean;
  executing: boolean;
  /** Modèles que le fournisseur ne sert plus. N'empêche rien : informe. */
  unavailableModels: Array<{ treatment: string; model: string; rank: string }>;
  /** Lot 49 : traitements retirés (T5) encore présents dans une version historique. */
  retiredTreatments?: string[];
}

interface Issue {
  treatment: Treatment;
  field: string;
  label: string;
  message: string;
  blocking: boolean;
}

interface DiffResponse {
  diff: { identical: boolean; changeCount: number };
  text: string;
  validation: { issues: Issue[]; valid: boolean };
  activeVisibleNumber: number | null;
}

interface Revision {
  id: number; revisionNumber: number; kind: string; comment: string | null;
  restoredFromRevisionNumber: number | null; createdByEmail: string | null; createdAt: string; snapshotSha256: string;
}

interface ExportRecord {
  id: number; versionNumber: number; revisionNumber: number; fileName: string; contentSha256: string;
  exportedByEmail: string | null; exportedAt: string;
}

interface ExportState {
  active: { versionId: number; versionNumber: number | null; name: string | null; revisionNumber: number } | null;
  lastExport: ExportRecord | null;
  changedSinceLastExport: boolean | null;
  changes: Array<'version' | 'revision' | 'content'>;
  exports: ExportRecord[];
}

/** Versions de prompt maître sélectionnables (actives ou anciennes, jamais un brouillon). */
interface PromptChoice { id: number; versionNumber: number; status: string }

// ─── Libellés ─────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<string, string> = {
  migration: 'Reprise automatique',
  create: 'Création',
  duplicate: 'Copie',
  save: 'Enregistrement',
  restore: 'Restauration',
  master_prompt: 'Prompt maître activé',
};

function versionName(v: Pick<Version, 'visibleNumber' | 'label' | 'id'>): string {
  return `v${v.visibleNumber ?? v.id}${v.label ? ` — ${v.label}` : ''}`;
}

const dateHeure = (d: string | null | undefined) => (d ? new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');

function StateBadge({ v, environment }: { v: Pick<Version, 'active' | 'stateLabel'>; environment: string }) {
  const label = v.stateLabel ?? (v.active ? (environment === 'production' ? 'Active en production' : 'Active en préproduction') : 'Non active');
  return (
    <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full border ${v.active
      ? 'bg-[color:var(--bg-success)] text-[color:var(--text-success)] border-[color:var(--border-success)]'
      : 'bg-[color:var(--bg-page)] text-[color:var(--text-muted)] border-[color:var(--border-subtle)]'}`}>
      {label}
    </span>
  );
}

// ─── Fragments ────────────────────────────────────────────────────────────────

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-[color:var(--text-primary)]">{label}</span>
      {children}
      {hint && <span className="block text-xs text-[color:var(--text-muted)]">{hint}</span>}
    </label>
  );
}

const selectClass =
  'w-full rounded-lg border border-[color:var(--input)] bg-[color:var(--bg-input)] '
  + 'px-3 py-2 text-sm text-[color:var(--text-primary)] disabled:opacity-50';

// ─── Éditeur d'un traitement ──────────────────────────────────────────────────

function TreatmentEditor({
  entry, catalog, catalogs, readOnly, onChange, onRetryCatalogs,
}: {
  entry: Entry;
  catalog: TreatmentCatalog;
  catalogs: Catalogs;
  readOnly: boolean;
  onChange: (next: Entry) => void;
  /** Relit le catalogue (déclencheurs) sans recharger la version. */
  onRetryCatalogs: () => void;
}) {
  const set = <K extends keyof Entry>(key: K, value: Entry[K]) => onChange({ ...entry, [key]: value });

  // Lot 32B : uniquement les modèles utilisables pour CE traitement (calculés
  // par le serveur, aucune règle recodée ici). Un modèle déjà choisi à un
  // autre rang est retiré ; une valeur enregistrée devenue inutilisable reste
  // affichée, marquée, sans redevenir un choix.
  const usable = catalogs.modelsByTreatment?.[entry.treatment] ?? [];
  const usableNames = usable.map((m) => m.model);
  const motif = (model: string) => catalogs.excludedByTreatment?.[entry.treatment]?.find((x) => x.model === model)?.reasonText
    ?? 'non utilisable pour ce traitement';
  // Lot 35B : statut Preview et tarif inconnu VISIBLES (informatifs, jamais bloquants).
  const suffixe = (model: string) => {
    const m = usable.find((x) => x.model === model);
    if (!m) return '';
    return [m.status === 'preview' ? 'preview' : null, m.priced ? null : 'tarif inconnu'].filter(Boolean).map((x) => ` · ${x}`).join('');
  };
  const modelOptions = (rank: ChainRank) => (
    <>
      <option value="">—</option>
      {chainOptions(usableNames, entry, rank, { readOnly, reasonOf: motif }).map((o) => (
        <option key={o.model} value={o.model} disabled={o.unusable}>
          {o.label}{o.unusable ? '' : suffixe(o.model)}
        </option>
      ))}
    </>
  );
  const invalides = unusableRanks(usableNames, entry);
  const RANG_LABEL: Record<ChainRank, string> = { primaryModel: 'Modèle principal', fallback1: 'Repli 1', fallback2: 'Repli 2' };

  const reasoning = (value: string | null, onSet: (v: string | null) => void, disabled: boolean) => (
    <select
      className={selectClass}
      value={value ?? ''}
      disabled={readOnly || disabled}
      onChange={(e) => onSet(e.target.value || null)}
    >
      <option value="">—</option>
      {catalogs.reasoningLevels.map((r) => <option key={r} value={r}>{r}</option>)}
    </select>
  );

  const toggleGuardrail = (code: string) => {
    const present = entry.guardrails.find((g) => g.code === code);
    set('guardrails', present
      ? entry.guardrails.filter((g) => g.code !== code)
      : [...entry.guardrails, { code, threshold: 0, reaction: catalogs.guardrailReactions[0] }]);
  };

  return (
    <div className="space-y-6">
      {/*
        Lot 16b : tous les traitements n'ont plus que leur prompt maître —
        aucun choix d'architecture proposé (migrations 0231 à 0234). Lot 49 :
        l'administration des prompts maîtres est MANUELLE (section « Prompts
        maîtres »), Prompt Control (T5) est supprimé.
      */}
      {catalog.master ? (
        <p className="text-xs text-[color:var(--text-muted)] rounded-lg border border-[color:var(--border-subtle)] p-3">
          Le texte du prompt maître de {entry.treatment} s’administre dans la section « Prompts maîtres » (rédaction,
          test facultatif, activation, historique) ; la version retenue par cette configuration se choisit ci-dessus.
        </p>
      ) : null}

      <p className="text-xs text-[color:var(--text-muted)]">
        Les réglages ci-dessous (modèles, replis, garde-fous, déclencheurs) font partie de cette version de configuration.
      </p>

      {invalides.length > 0 ? (
        <p role="status" className="text-xs text-[color:var(--text-warning-soft)]">
          {readOnly
            ? `Modèle(s) devenu(s) indisponible(s) pour ${entry.treatment} : `
            : `Modèle(s) non utilisable(s) pour ${entry.treatment} — à remplacer avant l’activation : `}
          {invalides.map((r) => `${RANG_LABEL[r]} « ${entry[r]} » (${motif(entry[r]!)})`).join(' ; ')}.
        </p>
      ) : null}
      {usable.length === 0 ? (
        <p role="status" className="text-xs text-[color:var(--text-warning-soft)]">
          Aucun modèle n’est actuellement utilisable pour {entry.treatment}. Actualisez le catalogue dans « Fournisseur IA »
          (qualification automatique des modèles disponibles avec la clé active).
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Modèle principal">
          <select className={selectClass} value={entry.primaryModel ?? ''} disabled={readOnly}
            onChange={(e) => set('primaryModel', e.target.value || null)}>{modelOptions('primaryModel')}</select>
        </Field>
        <Field label="Niveau de raisonnement">
          {reasoning(entry.reasoningPrimary, (v) => set('reasoningPrimary', v), false)}
        </Field>

        <Field label="Repli 1" hint="Facultatif. Sollicité sur échec technique du principal.">
          <select className={selectClass} value={entry.fallback1 ?? ''} disabled={readOnly}
            onChange={(e) => set('fallback1', e.target.value || null)}>{modelOptions('fallback1')}</select>
        </Field>
        <Field label="Niveau de raisonnement du repli 1">
          {reasoning(entry.reasoningFallback1, (v) => set('reasoningFallback1', v), !entry.fallback1)}
        </Field>

        <Field label="Repli 2" hint="Facultatif.">
          <select className={selectClass} value={entry.fallback2 ?? ''} disabled={readOnly}
            onChange={(e) => set('fallback2', e.target.value || null)}>{modelOptions('fallback2')}</select>
        </Field>
        <Field label="Niveau de raisonnement du repli 2">
          {reasoning(entry.reasoningFallback2, (v) => set('reasoningFallback2', v), !entry.fallback2)}
        </Field>
      </div>

      <Field
        label="Tokens de sortie"
        hint="S'applique au modèle principal ; les replis en héritent."
      >
        <Input
          type="number" min={1}
          value={entry.maxOutputTokens ?? ''}
          disabled={readOnly}
          onChange={(e) => set('maxOutputTokens', e.target.value === '' ? null : Number(e.target.value))}
          className="bg-[color:var(--bg-input)] max-w-[200px]"
        />
      </Field>

      <div className="space-y-2">
        <span className="text-sm font-medium text-[color:var(--text-primary)]">Garde-fous</span>
        {catalog.guardrails.map((g) => {
          const active = entry.guardrails.find((x) => x.code === g.code);
          return (
            <div key={g.code} className="rounded-lg border border-[color:var(--border-subtle)] p-3 space-y-2">
              <label className="flex items-start gap-2.5">
                <input type="checkbox" checked={Boolean(active)} disabled={readOnly}
                  onChange={() => toggleGuardrail(g.code)} className="mt-1" />
                <span className="min-w-0">
                  <span className="text-sm text-[color:var(--text-primary)] block">{g.label}</span>
                  <span className="text-xs text-[color:var(--text-muted)]">{g.description}</span>
                </span>
              </label>
              {active && (
                <div className="flex gap-3 pl-6">
                  <Input type="number" value={active.threshold} disabled={readOnly}
                    onChange={(e) => set('guardrails', entry.guardrails.map((x) =>
                      x.code === g.code ? { ...x, threshold: Number(e.target.value) } : x))}
                    className="bg-[color:var(--bg-input)] max-w-[140px]" />
                  <span className="text-xs text-[color:var(--text-muted)] self-center">{g.unit}</span>
                  <select className={`${selectClass} max-w-[180px]`} value={active.reaction} disabled={readOnly}
                    onChange={(e) => set('guardrails', entry.guardrails.map((x) =>
                      x.code === g.code ? { ...x, reaction: e.target.value } : x))}>
                    {catalogs.guardrailReactions.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* T2-UI-11 : ce que le BO ne règle pas pour l'assistant. */}
      {entry.treatment === 'T2' && (
        <p className="text-xs text-[color:var(--text-muted)] rounded-lg border border-[color:var(--border-subtle)] p-3">
          Le prompt ci-dessus est le socle commun de l&apos;assistant. Les prompts spécialisés
          (compréhension de la demande, rédaction de la réponse, revalidation d&apos;un fait) sont
          gérés dans le code, avec leur contrat de sortie : ils ne sont pas modifiables ici.
        </p>
      )}

      {/* Cascade coût/qualité — assistant uniquement (§11.2) */}
      {entry.treatment === 'T2' && (
        <div className="space-y-2">
          <div>
            <span className="text-sm font-medium text-[color:var(--text-primary)]">
              Cascade coût/qualité
            </span>
            <p className="text-xs text-[color:var(--text-muted)]">
              Confiance à partir de laquelle un niveau suffit. En deçà, la recherche monte
              d&apos;un cran — et le dernier cran est le modèle, le seul qui coûte.
            </p>
          </div>

          {!entry.cascade ? (
            <Button size="sm" variant="outline" disabled={readOnly}
              onClick={() => set('cascade', {
                database: 0.8, text: 0.7, semantic: 0.6, semanticEnabled: false,
              })}>
              Régler la cascade
            </Button>
          ) : (
            <div className="rounded-lg border border-[color:var(--border-subtle)] p-3 space-y-3">
              {([
                ['database', 'Base structurée', 'Filtres et agrégations. Aucun coût.'],
                ['text', 'Recherche textuelle', 'Plein texte et métadonnées. Aucun coût.'],
                ['semantic', 'Recherche sémantique', 'Coût faible.'],
              ] as const).map(([champ, titre, aide]) => (
                <div key={champ} className="flex items-center gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="text-sm text-[color:var(--text-primary)] block">{titre}</span>
                    <span className="text-xs text-[color:var(--text-muted)]">{aide}</span>
                  </span>
                  <Input type="number" min={0} max={1} step={0.05}
                    value={entry.cascade![champ]}
                    disabled={readOnly || (champ === 'semantic' && !entry.cascade!.semanticEnabled)}
                    onChange={(e) => set('cascade', {
                      ...entry.cascade!, [champ]: Number(e.target.value),
                    })}
                    className="bg-[color:var(--bg-input)] max-w-[110px]" />
                </div>
              ))}

              <label className="flex items-center gap-2 text-sm text-[color:var(--text-secondary)]">
                <input type="checkbox" checked={entry.cascade.semanticEnabled} disabled={readOnly}
                  onChange={() => set('cascade', {
                    ...entry.cascade!, semanticEnabled: !entry.cascade!.semanticEnabled,
                  })} />
                Niveau sémantique disponible
              </label>

              <p className="text-xs text-[color:var(--text-muted)]">
                Un seuil de 1 fait toujours monter d&apos;un cran ; un seuil de 0 arrête
                toujours à ce niveau. Trois seuils à 1 envoient chaque question au modèle.
              </p>

              {!readOnly && (
                <Button size="sm" variant="ghost" onClick={() => set('cascade', null)}>
                  Laisser le code décider
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {/*
        Ticket BO IA / T4 : tout déclencheur ENREGISTRÉ est visible et
        corrigeable — disponibles (sélectionner, activer, désactiver,
        retirer) et enregistrés incompatibles (motif, « Supprimer de la
        configuration »). Catalogue indisponible : erreur et « Réessayer » ;
        la liste enregistrée n'est jamais remplacée par une liste vide.
      */}
      {triggerCatalogAvailable(catalog, catalogs) ? (
        <TriggersEditor
          treatment={entry.treatment}
          batch={catalog.batch}
          saved={entry.triggers}
          applicable={catalog.triggers}
          catalog={catalogs.triggerCatalog}
          defaults={catalog.defaultTriggers ?? []}
          readOnly={readOnly}
          onChange={(next) => set('triggers', next)}
        />
      ) : (
        <div role="alert" className="space-y-2 rounded-lg border border-[color:var(--border-danger)] bg-[color:var(--bg-danger)] p-3">
          <p className="text-sm font-medium text-[color:var(--text-primary)]">Déclencheurs</p>
          <p className="text-sm text-[color:var(--text-secondary)]">
            Le catalogue des déclencheurs n&apos;a pas pu être chargé : les déclencheurs ne sont pas modifiables pour
            l&apos;instant. La configuration enregistrée est conservée telle quelle.
          </p>
          <Button size="sm" variant="outline" onClick={onRetryCatalogs}>
            <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Réessayer
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type ConfirmKind = 'activate' | 'delete' | 'restore' | 'export';

export default function AiConfigPage() {
  const [catalogs, setCatalogs] = useState<Catalogs | null>(null);
  const [environment, setEnvironment] = useState('');
  const [versions, setVersions] = useState<Version[]>([]);
  const [deleted, setDeleted] = useState<Version[] | null>(null);
  const [current, setCurrent] = useState<VersionDetail | null>(null);
  const [tab, setTab] = useState<Treatment>('T1');
  const [drafts, setDrafts] = useState<Record<string, Entry>>({});
  const [dirty, setDirty] = useState<Set<Treatment>>(new Set());
  // Prompt maître retenu par traitement (id de version), modifié localement.
  const [promptChoices, setPromptChoices] = useState<Partial<Record<Treatment, number | null>>>({});
  const [promptOptions, setPromptOptions] = useState<Partial<Record<Treatment, PromptChoice[]>>>({});
  const [meta, setMeta] = useState<{ label: string; description: string }>({ label: '', description: '' });
  const [metaDirty, setMetaDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [confirm, setConfirm] = useState<null | { kind: ConfirmKind; title: string; text: string; onOk: () => void }>(null);
  const [saisieEnv, setSaisieEnv] = useState('');
  const [runtime, setRuntime] = useState<TreatmentRuntimeState[]>([]);
  const [emergencyStop, setEmergencyStop] = useState(false);
  const [leaving, setLeaving] = useState<null | (() => void)>(null);
  const [metrics, setMetrics] = useState<Record<string, { metrics: Metric[]; tables?: MetricTable[]; windowDays: number }>>({});
  const [fenetres, setFenetres] = useState<Record<string, number>>({});
  const [history, setHistory] = useState<null | { version: Version; revisions: Revision[] }>(null);
  const [revisionView, setRevisionView] = useState<null | { revision: Revision; text: string; identical: boolean; masterPromptChanges: Array<{ treatment: string; current: string | null; revision: string | null }>; isCurrent: boolean }>(null);
  const [exportState, setExportState] = useState<ExportState | null>(null);
  const [promptsKey, setPromptsKey] = useState(0);

  const promptsDirty = Object.keys(promptChoices).length > 0;
  const hasUnsaved = dirty.size > 0 || promptsDirty || metaDirty;

  const loadExportState = useCallback(async () => {
    try {
      setExportState(await apiClient.get<ExportState>('/api/admin/ai/config-exports'));
    } catch {
      setExportState(null);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setErreur(null);
    try {
      const [cat, list] = await Promise.all([
        apiClient.get<Catalogs>('/api/admin/ai/config-catalogs'),
        apiClient.get<{ environment: string; versions: Version[] }>('/api/admin/ai/config-versions'),
      ]);
      setCatalogs(cat);
      setEnvironment(list.environment);
      setVersions(list.versions);
    } catch (e) {
      const err = e as { message?: string; code?: string; status?: number };
      setErreur([err.message, err.code && `(${err.code}${err.status ? ` — ${err.status}` : ''})`]
        .filter(Boolean).join(' ') || null);
      toast.error('Chargement impossible.');
    } finally {
      setLoading(false);
    }
    void loadExportState();
  }, [loadExportState]);

  useEffect(() => { load(); }, [load]);

  const reloadList = useCallback(async () => {
    try {
      const list = await apiClient.get<{ environment: string; versions: Version[] }>('/api/admin/ai/config-versions');
      setVersions(list.versions);
      if (deleted !== null) {
        setDeleted((await apiClient.get<{ versions: Version[] }>('/api/admin/ai/config-versions?deleted=only')).versions);
      }
    } catch { /* la liste précédente reste affichée */ }
    void loadExportState();
  }, [deleted, loadExportState]);

  // Ticket T4 : « Réessayer » du bloc Déclencheurs — relit le catalogue seul.
  const reloadCatalogs = useCallback(async () => {
    try {
      setCatalogs(await apiClient.get<Catalogs>('/api/admin/ai/config-catalogs'));
    } catch {
      toast.error('Le catalogue est toujours indisponible. Réessayez dans un instant.');
    }
  }, []);

  useEffect(() => {
    apiClient
      .get<{ states: TreatmentRuntimeState[]; emergencyStop: { active: boolean } }>('/api/admin/ai/queue')
      .then((r) => { setRuntime(r.states); setEmergencyStop(Boolean(r.emergencyStop?.active)); })
      .catch(() => {});
  }, []);

  const fenetre = fenetres[tab] ?? 30;
  useEffect(() => {
    if (metrics[tab]?.windowDays === fenetre) return;
    let annule = false;
    apiClient
      .get<{ metrics: Metric[]; tables?: MetricTable[]; windowDays: number }>(
        `/api/admin/ai/treatments/${tab}/metrics?days=${fenetre}`,
      )
      .then((r) => { if (!annule) setMetrics((m) => ({ ...m, [tab]: r })); })
      .catch(() => {});
    return () => { annule = true; };
  }, [tab, fenetre, metrics]);

  // Versions de prompt maître proposées pour un traitement (à l'ouverture).
  const loadPromptOptions = useCallback(async (t: Treatment) => {
    try {
      const d = await apiClient.get<{ active: PromptChoice | null; history: PromptChoice[] }>(`/api/admin/ai/master-prompts/${t}`);
      const all = [...(d.active ? [d.active] : []), ...(d.history ?? [])].filter((v) => v.status !== 'DRAFT');
      const uniques = [...new Map(all.map((v) => [v.id, v])).values()].sort((a, b) => b.versionNumber - a.versionNumber);
      setPromptOptions((o) => ({ ...o, [t]: uniques }));
    } catch {
      setPromptOptions((o) => ({ ...o, [t]: [] }));
    }
  }, []);

  const openVersion = useCallback(async (id: number) => {
    try {
      const v = await apiClient.get<VersionDetail>(`/api/admin/ai/config-versions/${id}`);
      setCurrent(v);
      setDrafts(Object.fromEntries(v.entries.map((e) => [e.treatment, e])));
      setDirty(new Set());
      setPromptChoices({});
      setMeta({ label: v.label ?? '', description: v.description ?? '' });
      setMetaDirty(false);
      setDiff(null);
    } catch {
      toast.error('Version introuvable.');
    }
  }, []);

  // DRF-01 : le tableau de bord ouvre une version par `?version=<id>`.
  const [versionDemandee, setVersionDemandee] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    if (versionDemandee !== undefined) return;
    const id = Number(new URLSearchParams(window.location.search).get('version'));
    setVersionDemandee(Number.isSafeInteger(id) && id > 0 ? id : null);
  }, [versionDemandee]);
  useEffect(() => {
    if (!versionDemandee || versions.length === 0) return;
    setVersionDemandee(null);
    void openVersion(versionDemandee);
  }, [versionDemandee, versions, openVersion]);

  // VER-007, WF-26 : quitter la page avec des saisies non enregistrées.
  useEffect(() => {
    if (!hasUnsaved) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasUnsaved]);

  /** VER-008 : « Réinitialiser » — annule les modifications locales d'un traitement. */
  const resetTreatment = (t: Treatment) => {
    const saved = current?.entries.find((e) => e.treatment === t);
    if (saved) setDrafts((d) => ({ ...d, [t]: saved }));
    setDirty((s) => { const n = new Set(s); n.delete(t); return n; });
    setPromptChoices((c) => { const n = { ...c }; delete n[t]; return n; });
  };

  const resetAll = () => {
    if (!current) return;
    setDrafts(Object.fromEntries(current.entries.map((e) => [e.treatment, e])));
    setDirty(new Set());
    setPromptChoices({});
    setMeta({ label: current.label ?? '', description: current.description ?? '' });
    setMetaDirty(false);
  };

  const guardUnsaved = (go: () => void) => {
    if (!hasUnsaved) { go(); return; }
    setLeaving(() => go);
  };

  const router = useRouter();
  const askLeave = useCallback((go: () => void) => setLeaving(() => go), []);
  const navigateTo = useCallback((href: string) => router.push(href), [router]);
  useUnsavedNavigationGuard(hasUnsaved, askLeave, navigateTo);

  // Saisies faites PENDANT un enregistrement : jamais écrasées par la réponse.
  const edits = useRef(createEditTracker()).current;

  /**
   * « Enregistrer » : UNE révision pour tous les traitements modifiés, les
   * prompts maîtres retenus, le nom et la description. Révision éditée
   * envoyée : une sauvegarde plus récente n'est jamais écrasée (409).
   */
  const saveAll = async (): Promise<boolean> => {
    if (!current) return false;
    const treatments = [...dirty];
    const reperes = Object.fromEntries(treatments.map((t) => [t, edits.mark(t)]));
    setBusy(true);
    try {
      const r = await apiClient.put<{ revisionNumber: number; changed: boolean; warnings: string[] }>(
        `/api/admin/ai/config-versions/${current.id}`,
        {
          baseRevision: current.currentRevisionNumber ?? 1,
          entries: treatments.map((t) => drafts[t]),
          ...(promptsDirty ? { masterPromptVersionIds: promptChoices } : {}),
          ...(metaDirty ? { label: meta.label, description: meta.description } : {}),
        },
      );
      toast.success(r.changed
        ? `Enregistré : révision ${r.revisionNumber}${current.active ? ' — appliquée aux prochaines exécutions' : ''}`
        : 'Aucune modification à enregistrer.');
      if (r.warnings?.length) toast.warning(`${r.warnings.length} point(s) à vérifier dans la configuration enregistrée.`, { duration: 8_000 });
      // Relecture de ce qui est RÉELLEMENT enregistré ; une saisie faite
      // pendant l'envoi reste « non enregistrée ».
      const v = await apiClient.get<VersionDetail>(`/api/admin/ai/config-versions/${current.id}`);
      setCurrent(v);
      const encore = treatments.filter((t) => !edits.unchangedSince(t, reperes[t]));
      setDrafts((d) => {
        const n = { ...d };
        for (const e of v.entries) if (!encore.includes(e.treatment)) n[e.treatment] = e;
        return n;
      });
      setDirty(new Set(encore));
      setPromptChoices({});
      setMetaDirty(false);
      setDiff(null);
      await reloadList();
      return true;
    } catch (e) {
      const err = e as { message?: string; code?: string };
      if (err.code === 'REVISION_CONFLICT') {
        toast.error(err.message ?? 'La version a été enregistrée entre-temps.', {
          duration: 15_000,
          action: { label: 'Recharger', onClick: () => void openVersion(current.id) },
        });
      } else {
        toast.error(err.message || 'Enregistrement impossible : rien n’a été modifié.');
      }
      return false;
    } finally { setBusy(false); }
  };

  const createVersion = async (body: Record<string, unknown>, message: string) => {
    setBusy(true);
    try {
      const d = await apiClient.post<VersionDetail>('/api/admin/ai/config-versions', body);
      toast.success(message);
      await reloadList();
      await openVersion(d.id);
    } catch (e) {
      toast.error((e as Error).message || 'Création impossible.');
    } finally { setBusy(false); }
  };

  const showDiff = async () => {
    if (!current) return;
    setBusy(true);
    try {
      setDiff(await apiClient.get<DiffResponse>(`/api/admin/ai/config-versions/${current.id}/diff`));
    } catch {
      toast.error('Comparaison impossible.');
    } finally { setBusy(false); }
  };

  const activateVersion = (v: Version) => setConfirm({
    kind: 'activate',
    title: `${environment === 'production' ? 'Activer en production' : 'Activer en préproduction'} — ${versionName(v)}`,
    text: 'Le dernier état enregistré de cette version devient la configuration des nouvelles exécutions ; la version active actuelle '
      + 'est désactivée (conservée, réactivable). Les exécutions déjà démarrées terminent avec leur configuration.',
    onOk: async () => {
      setBusy(true);
      try {
        const r = await apiClient.post<{ warnings?: string[] }>(`/api/admin/ai/config-versions/${v.id}/activate`,
          // Production : bouton actif seulement après la saisie « production ».
          environment === 'production' ? { confirmEnvironment: 'production' } : {});
        toast.success(`${versionName(v)} est active`);
        for (const w of r.warnings ?? []) toast.warning(w, { duration: 10_000 });
        await reloadList();
        if (current?.id === v.id || current?.active) await openVersion(current!.id);
        setPromptsKey((k) => k + 1);
      } catch (e) {
        toast.error((e as Error).message || 'Activation impossible : rien n’a été modifié.');
      } finally { setBusy(false); }
    },
  });

  const deleteVersion = (v: Version) => setConfirm({
    kind: 'delete',
    title: `Supprimer ${versionName(v)}`,
    text: 'La version disparaît de la liste. Ses révisions sont conservées : elle reste récupérable depuis « Versions supprimées ».',
    onOk: async () => {
      setBusy(true);
      try {
        await apiClient.delete(`/api/admin/ai/config-versions/${v.id}`);
        toast.success(`${versionName(v)} supprimée`);
        if (current?.id === v.id) setCurrent(null);
        await reloadList();
      } catch (e) {
        toast.error((e as Error).message || 'Suppression impossible.');
      } finally { setBusy(false); }
    },
  });

  const undeleteVersion = async (v: Version) => {
    setBusy(true);
    try {
      await apiClient.post(`/api/admin/ai/config-versions/${v.id}/undelete`, {});
      toast.success(`${versionName(v)} remise dans la liste (non active)`);
      await reloadList();
    } catch (e) {
      toast.error((e as Error).message || 'Opération impossible.');
    } finally { setBusy(false); }
  };

  const openHistory = async (v: Version) => {
    try {
      const r = await apiClient.get<{ revisions: Revision[] }>(`/api/admin/ai/config-versions/${v.id}/revisions`);
      setHistory({ version: v, revisions: r.revisions });
      setRevisionView(null);
    } catch {
      toast.error('Historique indisponible.');
    }
  };

  const viewRevision = async (rev: Revision) => {
    if (!history) return;
    try {
      const r = await apiClient.get<{ isCurrent: boolean; diffWithCurrent: { identical: boolean; text: string; masterPromptChanges: Array<{ treatment: string; current: string | null; revision: string | null }> } }>(
        `/api/admin/ai/config-versions/${history.version.id}/revisions/${rev.id}`,
      );
      setRevisionView({ revision: rev, text: r.diffWithCurrent.text, identical: r.diffWithCurrent.identical, masterPromptChanges: r.diffWithCurrent.masterPromptChanges, isCurrent: r.isCurrent });
    } catch {
      toast.error('Révision illisible.');
    }
  };

  const restoreRevision = (rev: Revision) => {
    if (!history) return;
    const v = history.version;
    setConfirm({
      kind: 'restore',
      title: `Restaurer la révision ${rev.revisionNumber} de ${versionName(v)}`,
      text: `Toute la configuration de la révision ${rev.revisionNumber} est reprise dans une NOUVELLE révision ; les révisions existantes restent disponibles.`
        + (v.active ? ' Cette version est active : la restauration s’applique aux prochaines exécutions.' : ''),
      onOk: async () => {
        setBusy(true);
        try {
          const r = await apiClient.post<{ revisionNumber: number }>(
            `/api/admin/ai/config-versions/${v.id}/revisions/${rev.id}/restore`, {},
          );
          toast.success(`Révision ${rev.revisionNumber} restaurée en révision ${r.revisionNumber}`);
          await reloadList();
          await openHistory({ ...v, currentRevisionNumber: r.revisionNumber });
          if (current?.id === v.id) await openVersion(v.id);
          setPromptsKey((k) => k + 1);
        } catch (e) {
          toast.error((e as Error).message || 'Restauration impossible : rien n’a été modifié.');
        } finally { setBusy(false); }
      },
    });
  };

  const doExport = async () => {
    setBusy(true);
    try {
      const r = await apiClient.post<{ fileName: string; content: string; warnings?: string[] }>('/api/admin/ai/config-exports', {});
      const url = URL.createObjectURL(new Blob([r.content], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = r.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Configuration exportée : ${r.fileName}`);
      for (const w of r.warnings ?? []) toast.warning(w, { duration: 8_000 });
      await loadExportState();
    } catch (e) {
      // Aucun fichier proposé : export refusé (contrôles) ou impossible.
      toast.error((e as Error).message || 'Export impossible : aucun fichier n’a été produit.', { duration: 15_000 });
    } finally { setBusy(false); }
  };

  const askExport = () => {
    // Des modifications non enregistrées : seuls les paramètres enregistrés partent.
    if (hasUnsaved) {
      setConfirm({
        kind: 'export',
        title: 'Des modifications ne sont pas enregistrées',
        text: 'Seuls les paramètres ENREGISTRÉS de la configuration active sont exportés. Les modifications en cours ne figureront pas dans le fichier.',
        onOk: () => void doExport(),
      });
      return;
    }
    void doExport();
  };

  if (erreur) {
    return <EcranEnErreur titre="Configuration indisponible" message={erreur} onRetry={load} />;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-[color:var(--text-muted)]">
        <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Chargement…
      </div>
    );
  }

  // Lot 54 : aucune lecture seule liée au statut — seule une version
  // supprimée (à remettre dans la liste) n'est pas modifiable.
  const readOnly = current ? current.readOnly : true;
  const isProduction = environment === 'production';
  const issuesFor = (t: Treatment) => diff?.validation.issues.filter((i) => i.treatment === t) ?? [];

  return (
    <div className="space-y-6 max-w-5xl">
      {/* VER-026 / GST-01 : environnement et état global, sur chaque page IA */}
      <AiEnvBanner />
      <CatalogBanners />
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="vb-app-title">Configuration IA</h1>
          <p className="text-sm text-[color:var(--text-muted)]">
            Une version couvre tous les traitements (T1, T2, T3, T4, T6). Environnement : {environment}.
          </p>
        </div>
        <Button size="sm" onClick={() => guardUnsaved(() => void createVersion({}, 'Nouvelle version créée (non active)'))} disabled={busy}>
          <Plus className="w-3.5 h-3.5 mr-1.5" /> Nouvelle version
        </Button>
      </div>

      {/* §4 — Export de la configuration ACTIVE enregistrée */}
      <section data-testid="config-export" className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex-1 min-w-0 space-y-1">
            <h2 className="vb-app-section">Configuration active</h2>
            {exportState?.active ? (
              <p className="text-sm text-[color:var(--text-secondary)] break-words">
                v{exportState.active.versionNumber ?? exportState.active.versionId}
                {exportState.active.name ? ` — ${exportState.active.name}` : ''} · révision {exportState.active.revisionNumber}
              </p>
            ) : (
              <p className="text-sm text-[color:var(--text-warning-soft)]">
                Aucune version active : l’export est indisponible. Activez une version pour pouvoir l’exporter.
              </p>
            )}
            {exportState?.lastExport ? (
              <p className="text-xs text-[color:var(--text-muted)] break-words">
                Dernier export : {dateHeure(exportState.lastExport.exportedAt)}
                {exportState.lastExport.exportedByEmail ? ` par ${exportState.lastExport.exportedByEmail}` : ''}
                {` · v${exportState.lastExport.versionNumber} r${exportState.lastExport.revisionNumber}`}
                {exportState.changedSinceLastExport
                  ? <span className="text-[color:var(--text-warning-soft)]"> · configuration modifiée depuis cet export</span>
                  : <span className="text-[color:var(--text-success)]"> · aucune modification depuis cet export</span>}
              </p>
            ) : exportState?.active ? (
              <p className="text-xs text-[color:var(--text-muted)]">Jamais exportée.</p>
            ) : null}
          </div>
          <Button size="sm" onClick={askExport} disabled={busy || !exportState?.active}
            title={exportState?.active ? undefined : 'Aucune version active : rien à exporter.'}>
            <Download className="w-3.5 h-3.5 mr-1.5" /> Exporter la configuration
          </Button>
        </div>
        {hasUnsaved && exportState?.active && (
          <p role="status" className="text-xs text-[color:var(--text-warning-soft)]">
            Des modifications ne sont pas enregistrées : seuls les paramètres enregistrés seront exportés.
          </p>
        )}
        <p className="text-xs text-[color:var(--text-muted)]">
          Fichier JSON complet et autonome (prompts maîtres, modèles et replis, paramètres, déclencheurs, garde-fous) destiné au
          paramétrage de la production — sans clé API ni secret ; les paramètres sensibles à renseigner séparément y sont listés.
          Aucune opération n’est faite en production.
        </p>
        {(exportState?.exports.length ?? 0) > 0 && (
          <details>
            <summary className="cursor-pointer text-xs text-[color:var(--text-secondary)]">Historique des exports ({exportState!.exports.length})</summary>
            <ul className="mt-2 space-y-1.5">
              {exportState!.exports.map((x) => (
                <li key={x.id} className="text-xs text-[color:var(--text-secondary)] flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span>{dateHeure(x.exportedAt)}</span>
                  <span>v{x.versionNumber} r{x.revisionNumber}</span>
                  <span className="text-[color:var(--text-muted)]">{x.exportedByEmail ?? '—'}</span>
                  <span className="font-mono text-[color:var(--text-muted)]" title={x.contentSha256}>SHA-256 {x.contentSha256.slice(0, 12)}…</span>
                  <a href={`/api/admin/ai/config-exports/${x.id}`} className="text-[color:var(--accent)] hover:underline">Télécharger</a>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {/* BO-IA-PROMPTS-01 : prompts maîtres — une activation crée une révision de la configuration active. */}
      <MasterPrompts refreshKey={promptsKey} onChanged={() => { void reloadList(); if (current?.active && !hasUnsaved) void openVersion(current.id); }} />

      {/* D-J1 (lot 21) : seuils et interrupteurs de l'assistant, administrés et journalisés. */}
      <AssistantSettings />

      {/* Lot 23 (§15.12, §32.6) : registre des modèles, lecture seule. */}
      <ModelRegistry />

      {/* Liste des versions */}
      <section className="space-y-2">
        <h2 className="vb-app-section">Versions</h2>
        <div data-testid="config-versions" className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] divide-y divide-[color:var(--border-subtle)]">
          {versions.length === 0 && (
            <p className="p-6 text-sm text-[color:var(--text-muted)]">
              Aucune version pour l&apos;instant. Créez une version pour commencer.
            </p>
          )}
          {versions.map((v) => (
            <div key={v.id} className={`px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2 ${current?.id === v.id ? 'bg-[color:var(--accent-soft)]' : ''}`}>
              <div className="flex-1 min-w-0 flex flex-wrap items-center gap-2">
                <StateBadge v={v} environment={environment} />
                <span className="text-sm text-[color:var(--text-primary)] break-words">{versionName(v)}</span>
                <span className="text-xs text-[color:var(--text-muted)]">
                  r{v.currentRevisionNumber ?? 1} · modifiée {dateHeure(v.updatedAt ?? v.createdAt)}{v.updatedByEmail ? ` par ${v.updatedByEmail}` : ''}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" variant="outline" disabled={busy} onClick={() => guardUnsaved(() => void openVersion(v.id))}>
                  <Pencil className="w-3.5 h-3.5 mr-1.5" /> Modifier
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => guardUnsaved(() => void createVersion({ sourceVersionId: v.id, label: v.label ? `Copie de ${v.label}` : null }, `${versionName(v)} dupliquée`))}>
                  <Copy className="w-3.5 h-3.5 mr-1.5" /> Dupliquer
                </Button>
                {!v.active && (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => guardUnsaved(() => activateVersion(v))}>
                    <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" /> {isProduction ? 'Activer en production' : 'Activer en préproduction'}
                  </Button>
                )}
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void openHistory(v)}>
                  <History className="w-3.5 h-3.5 mr-1.5" /> Historique
                </Button>
                {!v.active && (
                  <Button size="sm" variant="ghost" disabled={busy} aria-label={`Supprimer ${versionName(v)}`} onClick={() => deleteVersion(v)}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* §3.4 — versions supprimées : récupérables, jamais réactivées implicitement. */}
        <details onToggle={(e) => {
          if ((e.currentTarget as HTMLDetailsElement).open && deleted === null) {
            apiClient.get<{ versions: Version[] }>('/api/admin/ai/config-versions?deleted=only')
              .then((r) => setDeleted(r.versions)).catch(() => setDeleted([]));
          }
        }}>
          <summary className="cursor-pointer text-xs text-[color:var(--text-secondary)]">Versions supprimées</summary>
          <div className="mt-2 rounded-xl border border-[color:var(--border-subtle)] divide-y divide-[color:var(--border-subtle)]">
            {deleted === null && <p className="p-3 text-xs text-[color:var(--text-muted)]">Chargement…</p>}
            {deleted?.length === 0 && <p className="p-3 text-xs text-[color:var(--text-muted)]">Aucune version supprimée.</p>}
            {deleted?.map((v) => (
              <div key={v.id} className="px-3 py-2 flex flex-col sm:flex-row sm:items-center gap-2">
                <span className="flex-1 min-w-0 text-sm text-[color:var(--text-secondary)] break-words">
                  {versionName(v)} · r{v.currentRevisionNumber ?? 1} · supprimée {dateHeure(v.deletedAt)}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void undeleteVersion(v)}>
                    <Undo2 className="w-3.5 h-3.5 mr-1.5" /> Remettre dans la liste
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void openHistory(v)}>
                    <History className="w-3.5 h-3.5 mr-1.5" /> Historique
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </details>
      </section>

      {/* Éditeur de configuration */}
      {current && catalogs && (
        <section data-testid="config-editor" className="space-y-4">
          <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <StateBadge v={current} environment={environment} />
              <span className="text-sm font-medium text-[color:var(--text-primary)] break-words">{versionName(current)}</span>
              <span className="text-xs text-[color:var(--text-muted)]">révision {current.currentRevisionNumber ?? 1}</span>
              {current.deletedAt && (
                <span className="text-xs text-[color:var(--text-muted)] flex items-center gap-1">
                  <Lock className="w-3 h-3" /> version supprimée — remettez-la dans la liste pour la modifier
                </span>
              )}
              {(current.retiredTreatments?.length ?? 0) > 0 && (
                <span data-testid="retired-treatments-note" className="text-xs text-[color:var(--text-muted)] break-words">
                  Version historique : contient {current.retiredTreatments!.join(', ')} (traitement retiré), conservé pour l’audit et jamais appliqué.
                </span>
              )}
            </div>
            {current.active && (
              <p className="text-xs text-[color:var(--text-success)]">
                Version active : chaque enregistrement crée une révision appliquée aux prochaines exécutions, sans réactivation.
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Nom (facultatif)">
                <Input value={meta.label} disabled={readOnly} maxLength={200} className="bg-[color:var(--bg-input)]"
                  onChange={(e) => { setMeta((m) => ({ ...m, label: e.target.value })); setMetaDirty(true); }} />
              </Field>
              <Field label="Description (facultative)">
                <Input value={meta.description} disabled={readOnly} maxLength={2000} className="bg-[color:var(--bg-input)]"
                  onChange={(e) => { setMeta((m) => ({ ...m, description: e.target.value })); setMetaDirty(true); }} />
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => void saveAll()} disabled={readOnly || !hasUnsaved || busy}>
                <Save className="w-3.5 h-3.5 mr-1.5" /> Enregistrer
              </Button>
              <Button size="sm" variant="ghost" onClick={resetAll} disabled={!hasUnsaved || busy}>
                <Undo2 className="w-3.5 h-3.5 mr-1.5" /> Annuler les modifications
              </Button>
              <Button size="sm" variant="outline" onClick={() => void openHistory(current)} disabled={busy}>
                <History className="w-3.5 h-3.5 mr-1.5" /> Historique et restauration
              </Button>
              {!current.active && (
                <Button size="sm" variant="outline" onClick={showDiff} disabled={busy}>
                  <GitCompare className="w-3.5 h-3.5 mr-1.5" /> Comparer à la version active
                </Button>
              )}
              {hasUnsaved && <span className="text-xs text-[color:var(--text-warning-soft)]">• modifications non enregistrées</span>}
            </div>
          </div>

          {/*
            Réglages par traitement — repliés : prompt maître retenu, modèles,
            replis, garde-fous, déclencheurs (T1, T2, T3, T4, T6).
          */}
          <div className="space-y-2">
            <h2 className="vb-app-section">Réglages par traitement</h2>
            {catalogs.treatments.map((t) => {
              const fige = current.masterPrompts?.[t.code] ?? null;
              const choix = promptChoices[t.code];
              const valeur = choix !== undefined ? choix : fige?.versionId ?? null;
              const options = promptOptions[t.code];
              return (
                <details
                  key={t.code}
                  className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)]"
                  onToggle={(e) => {
                    if (!(e.currentTarget as HTMLDetailsElement).open) return;
                    setTab(t.code);
                    if (t.master && !promptOptions[t.code]) void loadPromptOptions(t.code);
                  }}
                >
                  <summary className="cursor-pointer px-4 py-3 flex flex-wrap items-center gap-2 text-sm text-[color:var(--text-primary)]">
                    <span className="font-medium">{t.code} · {t.label}</span>
                    {(dirty.has(t.code) || choix !== undefined) && <span className="text-[color:var(--text-warning-soft)] text-xs">• non enregistré</span>}
                    {issuesFor(t.code).some((i) => i.blocking) && <span className="text-[color:var(--text-danger)] text-xs">• contrôle à revoir</span>}
                  </summary>
                  <div className="px-4 pb-4 space-y-4">
                    {/* Lot 84D (BO-06) : avertissement contextuel seulement, accès aux exécutions en cause. */}
                    {tab === t.code && <ConfigExecutionWarning treatment={t.code} />}
                    <TreatmentStateControl
                      treatment={t.code}
                      batch={t.batch}
                      state={runtime.find((s) => s.treatment === t.code)}
                      emergencyStop={emergencyStop}
                      onChanged={setRuntime}
                    />

                    {t.master && (
                      <Field label="Prompt maître retenu par cette version"
                        hint={current.active
                          ? 'Version active : le prompt choisi est activé à l’enregistrement. Les textes se rédigent dans « Prompts maîtres ».'
                          : 'Activé avec cette version. Les textes se rédigent dans « Prompts maîtres ».'}>
                        <select className={selectClass} disabled={readOnly || !options}
                          value={valeur ?? ''}
                          onChange={(e) => {
                            const id = e.target.value === '' ? null : Number(e.target.value);
                            setPromptChoices((c) => {
                              const n = { ...c };
                              if (id === (fige?.versionId ?? null)) delete n[t.code]; else n[t.code] = id;
                              return n;
                            });
                          }}>
                          {!current.active && <option value="">Non figé — le prompt actif est conservé</option>}
                          {fige && !(options ?? []).some((o) => o.id === fige.versionId) && (
                            <option value={fige.versionId}>v{fige.versionNumber}</option>
                          )}
                          {(options ?? []).map((o) => (
                            <option key={o.id} value={o.id}>v{o.versionNumber}{o.status === 'ACTIVE' ? ' (actif)' : ''}</option>
                          ))}
                        </select>
                      </Field>
                    )}

                    {issuesFor(t.code).length > 0 && (
                      <div className="rounded-lg border border-[color:var(--border-warning)] bg-[color:var(--bg-warning)] p-3 space-y-1">
                        {issuesFor(t.code).map((i, k) => (
                          <p key={k} className="text-sm text-[color:var(--text-secondary)]">
                            <span className={i.blocking ? 'text-[color:var(--text-danger)]' : 'text-[color:var(--text-warning-soft)]'}>
                              {i.blocking ? 'À corriger' : 'À vérifier'}
                            </span>
                            {' · '}{i.label} : {i.message}
                          </p>
                        ))}
                      </div>
                    )}

                    {drafts[t.code] && (
                      <TreatmentEditor
                        entry={drafts[t.code]}
                        catalog={t}
                        catalogs={catalogs}
                        readOnly={readOnly}
                        onRetryCatalogs={reloadCatalogs}
                        onChange={(next) => {
                          setDrafts((d) => ({ ...d, [t.code]: next }));
                          edits.bump(t.code);
                          setDirty((s) => new Set(s).add(t.code));
                        }}
                      />
                    )}

                    {!readOnly && (
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button size="sm" variant="ghost" onClick={() => resetTreatment(t.code)} disabled={!(dirty.has(t.code) || choix !== undefined) || busy}>
                          <Undo2 className="w-3.5 h-3.5 mr-1.5" /> Réinitialiser {t.code}
                        </Button>
                        <Button size="sm" onClick={() => void saveAll()} disabled={!hasUnsaved || busy}>
                          <Save className="w-3.5 h-3.5 mr-1.5" /> Enregistrer
                        </Button>
                      </div>
                    )}

                    {metrics[t.code] && (
                      <Supervision
                        treatment={t.code}
                        metrics={metrics[t.code].metrics}
                        tables={metrics[t.code].tables}
                        windowDays={metrics[t.code].windowDays}
                        onWindowChange={(d) => setFenetres((f) => ({ ...f, [t.code]: d }))}
                      />
                    )}
                  </div>
                </details>
              );
            })}
          </div>

          {diff && (
            <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-2">
              <h2 className="vb-app-section">Écarts avec la version active</h2>
              {diff.diff.identical ? (
                <p className="text-sm text-[color:var(--text-muted)]">Cette version est identique à la version active.</p>
              ) : (
                <pre className="text-xs text-[color:var(--text-secondary)] whitespace-pre-wrap break-words font-mono">{diff.text}</pre>
              )}
            </div>
          )}
        </section>
      )}

      {/* §3 — Historique d'une version : révisions consultables et restaurables */}
      <Dialog open={history !== null} onOpenChange={(o) => { if (!o) { setHistory(null); setRevisionView(null); } }}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Historique — {history ? versionName(history.version) : ''}</DialogTitle>
            <DialogDescription>
              Chaque enregistrement est une révision complète. Restaurer en crée une nouvelle : rien n’est effacé.
            </DialogDescription>
          </DialogHeader>
          <ul className="space-y-2">
            {history?.revisions.map((r) => (
              <li key={r.id} className="rounded-lg border border-[color:var(--border-subtle)] p-3 space-y-1.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  <span className="font-medium text-[color:var(--text-primary)]">Révision {r.revisionNumber}</span>
                  {r.revisionNumber === (history.version.currentRevisionNumber ?? -1) && (
                    <span className="text-xs text-[color:var(--text-success)]">courante</span>
                  )}
                  <span className="text-xs text-[color:var(--text-muted)]">
                    {KIND_LABEL[r.kind] ?? r.kind}{r.restoredFromRevisionNumber ? ` de la révision ${r.restoredFromRevisionNumber}` : ''}
                    {' · '}{dateHeure(r.createdAt)}{r.createdByEmail ? ` · ${r.createdByEmail}` : ''}
                  </span>
                </div>
                {r.comment && <p className="text-xs text-[color:var(--text-secondary)] break-words">{r.comment}</p>}
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => void viewRevision(r)}>
                    <Eye className="w-3.5 h-3.5 mr-1.5" /> Consulter
                  </Button>
                  {history.version.deletedAt ? (
                    <Button size="sm" variant="outline" disabled={busy}
                      onClick={() => { setHistory(null); void createVersion({ sourceRevisionId: r.id, label: history.version.label }, `Nouvelle version créée depuis la révision ${r.revisionNumber}`); }}>
                      <Copy className="w-3.5 h-3.5 mr-1.5" /> Nouvelle version depuis cette révision
                    </Button>
                  ) : r.revisionNumber !== history.version.currentRevisionNumber && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => restoreRevision(r)}>
                      <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Restaurer cette révision
                    </Button>
                  )}
                </div>
                {revisionView?.revision.id === r.id && (
                  <div className="rounded border border-[color:var(--border-subtle)] p-2 space-y-1">
                    <p className="text-xs text-[color:var(--text-muted)]">
                      {revisionView.isCurrent ? 'Révision courante.' : revisionView.identical && revisionView.masterPromptChanges.length === 0
                        ? 'Identique au dernier état enregistré.' : 'Écarts avec le dernier état enregistré :'}
                    </p>
                    {revisionView.masterPromptChanges.map((c) => (
                      <p key={c.treatment} className="text-xs font-mono text-[color:var(--text-secondary)]">
                        {c.treatment} · Prompt maître : {c.current ?? 'non figé'} → {c.revision ?? 'non figé'}
                      </p>
                    ))}
                    {!revisionView.identical && (
                      <pre className="max-h-60 overflow-auto text-xs whitespace-pre-wrap break-words font-mono text-[color:var(--text-secondary)]">{revisionView.text}</pre>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>

      {/* WF-01 — trois choix, jamais deux */}
      <Dialog open={leaving !== null} onOpenChange={(o) => !o && setLeaving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Des modifications ne sont pas enregistrées</DialogTitle>
            <DialogDescription>
              {[...dirty, ...(Object.keys(promptChoices) as Treatment[])].filter((x, i, a) => a.indexOf(x) === i).join(', ') || 'Nom ou description'}
              {' '}: modifications non enregistrées.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setLeaving(null)}>Annuler</Button>
            <Button variant="outline" onClick={() => {
              // WF-26 étape 3 : « Quitter » restaure la dernière valeur persistée.
              const go = leaving; resetAll(); setLeaving(null); go?.();
            }}>
              Quitter sans enregistrer
            </Button>
            <Button onClick={async () => { if (await saveAll()) { const go = leaving; setLeaving(null); go?.(); } }}>
              Enregistrer puis continuer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirmations — elles nomment la conséquence */}
      <Dialog open={confirm !== null} onOpenChange={(o) => { if (!o) { setConfirm(null); setSaisieEnv(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm?.title}</DialogTitle>
            <DialogDescription>
              {confirm?.text}
              {confirm?.kind === 'activate' && current && (current.unavailableModels?.length ?? 0) > 0 && (
                <span className="block mt-2 text-[color:var(--text-warning-soft)]">
                  Attention : {current.unavailableModels.map((m) => `${m.treatment} utilise « ${m.model} » (${m.rank})`).join(', ')} — modèle(s)
                  que le fournisseur ne sert plus.
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          {isProduction && confirm?.kind === 'activate' && (
            <label className="block space-y-1.5">
              <span className="text-sm text-[color:var(--text-danger)]">
                Environnement de PRODUCTION. Saisissez « production » pour confirmer.
              </span>
              <input value={saisieEnv} onChange={(e) => setSaisieEnv(e.target.value)} autoComplete="off"
                className="w-full rounded-lg border border-[color:var(--input)] bg-[color:var(--bg-input)] px-3 py-2 text-sm" />
            </label>
          )}
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => { setConfirm(null); setSaisieEnv(''); }}>Annuler</Button>
            <Button
              variant={confirm?.kind === 'delete' ? 'destructive' : 'default'}
              disabled={isProduction && confirm?.kind === 'activate' && saisieEnv.trim() !== 'production'}
              onClick={() => { const ok = confirm?.onOk; setConfirm(null); ok?.(); setSaisieEnv(''); }}
            >
              {confirm?.kind === 'delete' ? 'Supprimer'
                : confirm?.kind === 'restore' ? 'Restaurer'
                  : confirm?.kind === 'export' ? 'Exporter la configuration enregistrée'
                    : 'Activer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
