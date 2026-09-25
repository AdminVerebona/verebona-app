"use client";

/**
 * Admin — Configuration IA (BO IA) — CDC BO IA SCR-01 à SCR-06.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE VERSION, CINQ ONGLETS
 *
 * Le GEN-002 veut un instantané cohérent de T1 à T5. Les cinq onglets pointent
 * donc vers la MÊME version : on n'édite pas cinq configurations mais une
 * seule, vue par traitement. C'est ce que le WF-01 décrit — « tous les onglets
 * pointent vers le même Brouillon global » — et c'est pourquoi le sélecteur de
 * version est au-dessus des onglets, jamais dans l'un d'eux.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE L'ÉCRAN DOIT EMPÊCHER
 *
 * Perdre une saisie. Le WF-01 exige les trois choix — enregistrer, quitter sans
 * enregistrer, annuler — quand on quitte un onglet modifié. Ils sont ici, y
 * compris en changeant de version.
 *
 * Confondre activer et restaurer. Le WF-05 laisse terminer les exécutions en
 * cours, le WF-06 les interrompt. Deux boutons distincts, et une confirmation
 * renforcée sur le second, qui nomme la conséquence au lieu de demander « êtes-
 * vous sûr ».
 *
 * Croire qu'on modifie ce qui tourne. Une Active est en lecture seule (VER-002).
 * Les champs sont désactivés, et l'écran propose de créer un Brouillon.
 */

import { useState, useEffect, useCallback } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import {
  Loader2, Plus, GitCompare, CheckCircle2, AlertTriangle, RotateCcw,
  Archive, Play, Save, Lock,
} from 'lucide-react';
import { toast } from 'sonner';
import { EcranEnErreur } from '@/components/admin/EcranEnErreur';
import { apiClient } from '@/lib/api-client';

// ─── Types de l'écran ─────────────────────────────────────────────────────────

type Treatment = 'T1' | 'T2' | 'T3' | 'T4' | 'T5';
type Status = 'DRAFT' | 'TO_TEST' | 'ACTIVE' | 'VALIDATED' | 'ARCHIVED';

interface GuardrailDef { code: string; label: string; description: string; unit: string }
interface TriggerDef { code: string; label: string; kind: 'event' | 'schedule' }

interface TreatmentCatalog {
  code: Treatment;
  label: string;
  batch: boolean;
  guardrails: GuardrailDef[];
  triggers: TriggerDef[];
}

interface Catalogs {
  models: Array<{ model: string; available: boolean; priced: boolean; verified: boolean }>;
  reasoningLevels: string[];
  guardrailReactions: string[];
  treatments: TreatmentCatalog[];
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
}

interface Version {
  id: number;
  status: Status;
  visibleNumber: number | null;
  label: string | null;
  isStale: boolean;
  activatedAt: string | null;
  createdAt: string;
}

interface VersionDetail extends Version {
  entries: Entry[];
  readOnly: boolean;
  executing: boolean;
  /** Modèles que le fournisseur ne sert plus. N'empêche rien : informe. */
  unavailableModels: Array<{ treatment: string; model: string; rank: string }>;
}

interface DiffLine { kind: 'added' | 'removed' | 'unchanged'; text: string }

interface T5Analysis {
  mode: 'analyze' | 'modify';
  treatment: Treatment;
  verdict: 'prompt' | 'code' | 'donnees' | 'configuration';
  analysis: string;
  proposedContent: string | null;
  risks: string[];
  recommendations: string[];
  diff: { lines: DiffLine[]; added: number; removed: number; identical: boolean } | null;
  rejected?: string;
  applied: boolean;
  draftId: number | null;
  draftCreated: boolean;
  traceId: string;
}

interface DraftChoice { id: number; label: string | null; isStale: boolean; createdAt: string }

interface Metric {
  key: string;
  label: string;
  value: number | null;
  unit?: 'count' | 'percent' | 'ms';
  missingReason?: string;
}

interface Issue {
  treatment: Treatment;
  field: string;
  label: string;
  message: string;
  blocking: boolean;
}

interface DiffResponse {
  diff: { treatments: Array<{ treatment: Treatment; changes: Array<{ label: string; before: string | null; after: string | null }> }>; identical: boolean; changeCount: number };
  text: string;
  validation: { issues: Issue[]; valid: boolean };
  promotable: boolean;
  activeVisibleNumber: number | null;
}

// ─── Libellés ─────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<Status, string> = {
  DRAFT: 'Brouillon',
  TO_TEST: 'À tester',
  ACTIVE: 'Active',
  VALIDATED: 'Validée',
  ARCHIVED: 'Archivée',
};

const STATUS_STYLE: Record<Status, string> = {
  DRAFT: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
  TO_TEST: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
  ACTIVE: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
  VALIDATED: 'bg-sky-500/10 text-sky-500 border-sky-500/20',
  ARCHIVED: 'bg-[color:var(--bg-page)] text-[color:var(--text-muted)] border-[color:var(--border-subtle)]',
};

/** Miroir de `isPromptAdministrable` (services/ai/config/treatments) : T5 n'a pas de prompt BO. */
function isPromptAdministrable(t: Treatment): boolean {
  return t !== 'T5';
}

function versionName(v: Version): string {
  if (v.visibleNumber) return `v${v.visibleNumber}${v.label ? ` — ${v.label}` : ''}`;
  return v.label ?? `Brouillon ${v.id}`;
}

// ─── Fragments ────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border ${STATUS_STYLE[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-[color:var(--text-primary)]">{label}</span>
      {children}
      {hint && <span className="block text-xs text-[color:var(--text-muted)]">{hint}</span>}
    </label>
  );
}

/**
 * Zone de supervision d'un traitement — CDC BO IA SCR-02 à SCR-06.
 *
 * ⚠️ Un indicateur non mesuré affiche « pas encore mesuré », jamais zéro. Un
 * zéro serait lu comme une absence de problème, ce qui est exactement le
 * contraire de ce qu'on sait — c'est la même règle que sur l'écran Coûts.
 *
 * La raison est affichée avec l'indicateur : elle dit ce qu'il faudrait
 * instrumenter, et évite qu'on redécouvre chaque fois pourquoi la case est vide.
 */
function Supervision({
  metrics, windowDays, onWindowChange,
}: { metrics: Metric[]; windowDays: number; onWindowChange: (d: number) => void }) {
  const format = (m: Metric): string => {
    if (m.value === null) return '—';
    if (m.unit === 'percent') return `${m.value} %`;
    if (m.unit === 'ms') return m.value >= 1000 ? `${(m.value / 1000).toFixed(1)} s` : `${m.value} ms`;
    return m.value.toLocaleString('fr-FR');
  };

  return (
    <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Supervision</h3>
        {/*
          Fenêtre réglable plutôt que compteurs remis à zéro. Ces indicateurs
          comptent des traces réelles : les effacer pour assainir l'écran
          reviendrait à supprimer la preuve de ce qui s'est passé. Regarder de
          plus près suffit, et n'altère rien.
        */}
        <div className="flex gap-1">
          {[
            { d: 1, label: '24 h' },
            { d: 7, label: '7 j' },
            { d: 30, label: '30 j' },
          ].map((f) => (
            <button
              key={f.d}
              onClick={() => onWindowChange(f.d)}
              className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                windowDays === f.d
                  ? 'border-[color:var(--accent)] text-[color:var(--accent)] bg-[color:var(--accent-soft)]'
                  : 'border-[color:var(--border-subtle)] text-[color:var(--text-muted)]'}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {metrics.map((m) => (
          <div key={m.key} className="space-y-0.5">
            <p className="text-xs text-[color:var(--text-muted)]">{m.label}</p>
            <p className={`text-lg font-semibold ${m.value === null
              ? 'text-[color:var(--text-muted)]' : 'text-[color:var(--text-primary)]'}`}>
              {format(m)}
            </p>
            {m.value === null && m.missingReason && (
              <p className="text-xs text-amber-500 leading-snug">{m.missingReason}</p>
            )}
          </div>
        ))}
      </div>

      <a href="/admin/ai-executions"
        className="inline-block text-xs text-[color:var(--accent)] hover:underline">
        Voir les appels correspondants
      </a>
    </div>
  );
}

/**
 * Conversation Prompt Control (T5) — CDC BO IA SCR-06, WF-20, T5-UI-01 à T5-UI-09.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN CHAMP EN LANGAGE NATUREL, PAS UN ÉDITEUR DE PROMPT
 *
 * L'administrateur décrit un comportement attendu ou un problème. T5 analyse
 * la demande et, sur « Modifier le prompt », réécrit lui-même le prompt du
 * traitement ciblé (T1, socle T2, T3, T4). Personne ne tape de prompt ici.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX ACTIONS, UN GESTE CHACUNE — T5-UI-03, T5-UI-04, écart E-01
 *
 * · « Analyser » : diagnostic seul, sur toute version, rien n'est écrit.
 * · « Modifier le prompt » : T5 écrit directement dans le Brouillon, puis
 *   l'écran montre résumé et diff. Pas de bouton d'approbation en plus : le
 *   filet est le cycle Brouillon → À tester → Active.
 *
 * Le verdict vient avant tout le reste, et il peut venir seul : si le problème
 * est dans le code, les données ou un réglage (T5-011), l'écran doit le rendre
 * aussi lisible qu'une modification — sinon l'administrateur reformule jusqu'à
 * obtenir un changement de prompt qui ne réglera rien.
 */
function PromptControl({
  versionId, readOnly, treatment, hasUnsaved, onModified, onOpenVersion,
}: {
  versionId: number;
  /** La version affichée n'est pas un Brouillon : T5 en créera ou en demandera un. */
  readOnly: boolean;
  /** Traitement de l'onglet (cible préremplie). Absent = onglet T5, cible à choisir. */
  treatment?: Treatment;
  /** Des saisies non enregistrées existent-elles sur ce traitement ? */
  hasUnsaved: (t: Treatment) => boolean;
  /** Une modification a été écrite dans ce Brouillon. */
  onModified: (draftId: number, t: Treatment) => void | Promise<void>;
  /** Ouvrir une version (choix d'un Brouillon existant). */
  onOpenVersion: (id: number) => void;
}) {
  const [cible, setCible] = useState<Treatment>(treatment ?? 'T1');
  const [instruction, setInstruction] = useState('');
  const [resultat, setResultat] = useState<T5Analysis | null>(null);
  const [encours, setEncours] = useState<null | 'analyze' | 'modify'>(null);
  const [choixBrouillon, setChoixBrouillon] = useState<DraftChoice[] | null>(null);
  const [refus, setRefus] = useState<string | null>(null);

  const VERDICT_LABEL: Record<T5Analysis['verdict'], string> = {
    prompt: 'Le prompt est en cause',
    code: 'Le comportement vient du code',
    donnees: 'Les données du compte sont en cause',
    configuration: 'Un réglage est en cause',
  };

  const TARGET_LABEL: Record<'T1' | 'T2' | 'T3' | 'T4', string> = {
    T1: 'T1 · Sources — prompt maître',
    T2: 'T2 · Assistant — socle commun',
    T3: 'T3 · Rationalisation',
    T4: 'T4 · Échéances',
  };

  const unsaved = hasUnsaved(cible);
  const demandeValide = instruction.trim().length >= 5;

  const envoyer = async (action: 'analyze' | 'modify', createDraft = false) => {
    setEncours(action);
    setResultat(null);
    setChoixBrouillon(null);
    setRefus(null);
    try {
      const r = await apiClient.post<T5Analysis>('/api/admin/ai/prompt-control', {
        action, versionId, treatment: cible, instruction: instruction.trim(),
        ...(action === 'modify' && createDraft ? { createDraft: true } : {}),
      });
      setResultat(r);
      if (r.applied && r.draftId) {
        toast.success(r.draftCreated
          ? `Brouillon créé depuis l'Active, prompt ${r.treatment} modifié`
          : `Prompt ${r.treatment} modifié dans le brouillon`);
        await onModified(r.draftId, r.treatment);
      }
    } catch (e) {
      const err = e as { code?: string; message?: string; details?: { drafts?: DraftChoice[] } };
      if (err.code === 'DRAFT_SELECTION_REQUIRED' && err.details?.drafts) {
        // T5-007 : jamais de choix arbitraire. L'administrateur désigne.
        setChoixBrouillon(err.details.drafts);
      } else {
        setRefus(err.message ?? "La demande n'a pas abouti.");
      }
    } finally { setEncours(null); }
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">
          {treatment ? `Demander à Prompt Control de faire évoluer ${treatment}` : 'Conversation Prompt Control'}
        </h3>
        <p className="text-xs text-[color:var(--text-muted)]">
          Décrivez en français le comportement attendu ou le problème constaté — pas le
          prompt lui-même. Prompt Control dira d&apos;abord si le prompt est en cause, puis
          le réécrira dans le brouillon si vous le demandez.
        </p>
      </div>

      {/*
        T5-UI-02 : cible préremplie depuis l'onglet d'un traitement, à choisir
        depuis l'onglet T5. T5 n'est jamais proposé (T5-002).
      */}
      {!treatment && (
        <Field label="Prompt à faire évoluer">
          <select className={`${selectClass} max-w-[320px]`} value={cible} disabled={encours !== null}
            onChange={(e) => { setCible(e.target.value as Treatment); setResultat(null); setChoixBrouillon(null); }}>
            {(['T1', 'T2', 'T3', 'T4'] as const).map((t) => (
              <option key={t} value={t}>{TARGET_LABEL[t]}</option>
            ))}
          </select>
        </Field>
      )}

      <Field label="Votre demande">
        <Textarea
          value={instruction}
          disabled={encours !== null}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder={'Ex. : « Les numéros de série en pied de facture ne sont pas extraits. »\n'
            + 'Ex. : « Pourquoi ce contrat d’assurance est-il classé en facture ? »'}
          className="min-h-[110px] bg-[color:var(--bg-input)]"
        />
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => envoyer('analyze')}
          disabled={encours !== null || !demandeValide}>
          {encours === 'analyze' && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
          Analyser
        </Button>
        <Button size="sm" onClick={() => envoyer('modify')}
          disabled={encours !== null || !demandeValide || unsaved}>
          {encours === 'modify' && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
          Modifier le prompt
        </Button>
      </div>

      <p className="text-xs text-[color:var(--text-muted)]">
        « Analyser » ne modifie rien. « Modifier le prompt » écrit directement dans le
        brouillon{readOnly ? ' — la version affichée étant en lecture seule, un brouillon sera créé depuis l’Active s’il n’en existe aucun' : ''}.
        Modèles, replis et garde-fous ne sont jamais modifiés.
      </p>

      {unsaved && (
        <p className="text-xs text-amber-500">
          {cible} a des modifications non enregistrées : enregistrez-les ou annulez-les avant
          de demander une modification, pour que Prompt Control parte du bon texte.
        </p>
      )}

      {refus && <p className="text-sm text-amber-500">{refus}</p>}

      {choixBrouillon && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
          <p className="text-sm text-[color:var(--text-secondary)]">
            La version affichée est en lecture seule et des brouillons existent déjà.
            Choisissez celui dans lequel écrire — Prompt Control ne choisit pas à votre place.
            Votre demande est conservée.
          </p>
          <div className="flex flex-wrap gap-2">
            {choixBrouillon.map((d) => (
              <Button key={d.id} size="sm" variant="outline"
                onClick={() => { setChoixBrouillon(null); onOpenVersion(d.id); }}>
                Ouvrir {d.label ?? `Brouillon ${d.id}`}
                {d.isStale && <span className="ml-1 text-amber-500">(base dépassée)</span>}
              </Button>
            ))}
            <Button size="sm" onClick={() => envoyer('modify', true)} disabled={encours !== null}>
              <Plus className="w-3.5 h-3.5 mr-1.5" /> Nouveau brouillon depuis l&apos;Active
            </Button>
          </div>
        </div>
      )}

      {resultat && (
        <div className="rounded-lg border border-[color:var(--border-subtle)] p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className={`text-sm font-medium ${resultat.verdict === 'prompt'
              ? 'text-[color:var(--text-primary)]' : 'text-amber-500'}`}>
              {VERDICT_LABEL[resultat.verdict]}
            </p>
            {resultat.applied ? (
              <span className="text-xs px-2 py-0.5 rounded-full border bg-emerald-500/10 text-emerald-500 border-emerald-500/20">
                Écrit dans le brouillon{resultat.draftCreated ? ' (créé depuis l’Active)' : ''}
              </span>
            ) : (
              <span className="text-xs px-2 py-0.5 rounded-full border border-[color:var(--border-subtle)] text-[color:var(--text-muted)]">
                {resultat.mode === 'analyze' ? 'Analyse seule — rien n’a été modifié' : 'Aucune modification écrite'}
              </span>
            )}
          </div>

          <p className="text-sm text-[color:var(--text-secondary)] whitespace-pre-wrap">
            {resultat.analysis}
          </p>

          {resultat.rejected && (
            <p className="text-sm text-amber-500">{resultat.rejected}</p>
          )}

          {resultat.risks.length > 0 && (
            <div>
              <p className="text-xs font-medium text-[color:var(--text-primary)]">Risques signalés</p>
              <ul className="text-xs text-[color:var(--text-muted)] list-disc pl-4">
                {resultat.risks.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </div>
          )}

          {resultat.recommendations.length > 0 && (
            <div>
              <p className="text-xs font-medium text-[color:var(--text-primary)]">
                Recommandations — non appliquées, à faire vous-même dans les réglages
              </p>
              <ul className="text-xs text-[color:var(--text-muted)] list-disc pl-4">
                {resultat.recommendations.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </div>
          )}

          {resultat.applied && resultat.diff && !resultat.diff.identical && (
            <div className="space-y-1">
              <p className="text-xs text-[color:var(--text-muted)]">
                Prompt {resultat.treatment} : {resultat.diff.added} ligne(s) ajoutée(s),{' '}
                {resultat.diff.removed} retirée(s)
              </p>
              <pre className="text-xs font-mono max-h-64 overflow-auto rounded bg-[color:var(--bg-page)] p-2">
                {resultat.diff.lines.map((l, i) => (
                  <div key={i} className={
                    l.kind === 'added' ? 'text-emerald-500'
                      : l.kind === 'removed' ? 'text-red-400'
                        : 'text-[color:var(--text-muted)]'}>
                    {l.kind === 'added' ? '+' : l.kind === 'removed' ? '-' : ' '} {l.text}
                  </div>
                ))}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const selectClass =
  'w-full rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-input)] '
  + 'px-3 py-2 text-sm text-[color:var(--text-primary)] disabled:opacity-50';

// ─── Éditeur d'un traitement ──────────────────────────────────────────────────

function TreatmentEditor({
  entry, catalog, catalogs, readOnly, onChange,
}: {
  entry: Entry;
  catalog: TreatmentCatalog;
  catalogs: Catalogs;
  readOnly: boolean;
  onChange: (next: Entry) => void;
}) {
  const set = <K extends keyof Entry>(key: K, value: Entry[K]) => onChange({ ...entry, [key]: value });

  const modelOptions = (
    <>
      <option value="">—</option>
      {catalogs.models.map((m) => (
        <option key={m.model} value={m.model}>
          {m.model}{m.priced ? '' : ' (sans tarif)'}
        </option>
      ))}
    </>
  );

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

  const toggleTrigger = (t: TriggerDef) => {
    const present = entry.triggers.find((x) => x.code === t.code);
    set('triggers', present
      ? entry.triggers.filter((x) => x.code !== t.code)
      : [...entry.triggers, { kind: t.kind, code: t.code, active: true }]);
  };

  return (
    <div className="space-y-6">
      {/*
        ══════════════════════════════════════════════════════════════════
        L'ÉDITEUR DIRECT EST REPLIÉ, ET C'EST DÉLIBÉRÉ
        ══════════════════════════════════════════════════════════════════
        Le geste normal est de décrire ce qu'on veut en français, dans la zone
        Prompt Control : l'administrateur n'a pas à rédiger un prompt pour
        obtenir un changement de comportement.

        ⚠️ Mais pour T1 à T4 l'éditeur RESTE ACCESSIBLE. Prompt Control dépend
        d'un modèle : fournisseur en panne ou arrêt d'urgence, et un
        administrateur privé d'édition directe n'aurait plus aucun moyen de
        corriger un prompt. Le SCR-02 le prévoit : « Éditeur du prompt T1
        unique, versionné, sans limite artificielle imposée par le BO ».

        Pour T5, aucun éditeur (T5-003, T5-UI-09, écart E-02) : son
        comportement est dans le code. Le serveur vide de toute façon ce champ
        à l'écriture et l'ignore à l'exécution.
      */}
      {isPromptAdministrable(entry.treatment) ? (
        <details className="rounded-lg border border-[color:var(--border-subtle)] p-3">
          <summary className="text-sm text-[color:var(--text-secondary)] cursor-pointer">
            Modifier le prompt directement
          </summary>
          <div className="pt-3 space-y-2">
            <p className="text-xs text-[color:var(--text-muted)]">
              Édition manuelle du prompt, versionnée avec le reste de la configuration.
              À réserver aux cas où Prompt Control ne peut pas aider — panne du
              fournisseur, correction urgente.
            </p>
            <Textarea
              value={entry.prompt}
              disabled={readOnly}
              onChange={(e) => set('prompt', e.target.value)}
              className="min-h-[220px] font-mono text-xs bg-[color:var(--bg-input)]"
            />
          </div>
        </details>
      ) : (
        <p className="text-xs text-[color:var(--text-muted)]">
          Le comportement de Prompt Control est défini dans le code : il n&apos;a pas de
          prompt modifiable. Seuls ses réglages de modèle se configurent ici.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Modèle principal">
          <select className={selectClass} value={entry.primaryModel ?? ''} disabled={readOnly}
            onChange={(e) => set('primaryModel', e.target.value || null)}>{modelOptions}</select>
        </Field>
        <Field label="Niveau de raisonnement">
          {reasoning(entry.reasoningPrimary, (v) => set('reasoningPrimary', v), false)}
        </Field>

        <Field label="Repli 1" hint="Facultatif. Sollicité sur échec technique du principal.">
          <select className={selectClass} value={entry.fallback1 ?? ''} disabled={readOnly}
            onChange={(e) => set('fallback1', e.target.value || null)}>{modelOptions}</select>
        </Field>
        <Field label="Niveau de raisonnement du repli 1">
          {reasoning(entry.reasoningFallback1, (v) => set('reasoningFallback1', v), !entry.fallback1)}
        </Field>

        <Field label="Repli 2" hint="Facultatif.">
          <select className={selectClass} value={entry.fallback2 ?? ''} disabled={readOnly}
            onChange={(e) => set('fallback2', e.target.value || null)}>{modelOptions}</select>
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

      {catalog.batch ? (
        <div className="space-y-2">
          <span className="text-sm font-medium text-[color:var(--text-primary)]">Déclencheurs</span>
          {catalog.triggers.map((t) => {
            const chosen = entry.triggers.find((x) => x.code === t.code);
            return (
              <div key={t.code} className="flex items-center gap-2.5">
                <input type="checkbox" checked={Boolean(chosen)} disabled={readOnly}
                  onChange={() => toggleTrigger(t)} />
                <span className="text-sm text-[color:var(--text-primary)] flex-1">{t.label}</span>
                {chosen && (
                  <label className="flex items-center gap-1.5 text-xs text-[color:var(--text-muted)]">
                    <input type="checkbox" checked={chosen.active} disabled={readOnly}
                      onChange={() => set('triggers', entry.triggers.map((x) =>
                        x.code === t.code ? { ...x, active: !x.active } : x))} />
                    actif
                  </label>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-[color:var(--text-muted)]">
          Ce traitement répond aux demandes en direct : il n&apos;a pas de déclencheur.
        </p>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AiConfigPage() {
  const [catalogs, setCatalogs] = useState<Catalogs | null>(null);
  const [environment, setEnvironment] = useState('');
  const [versions, setVersions] = useState<Version[]>([]);
  const [current, setCurrent] = useState<VersionDetail | null>(null);
  const [tab, setTab] = useState<Treatment>('T1');
  const [drafts, setDrafts] = useState<Record<string, Entry>>({});
  const [dirty, setDirty] = useState<Set<Treatment>>(new Set());
  const [loading, setLoading] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [confirm, setConfirm] = useState<null | { kind: 'rollback' | 'validate' | 'activate'; onOk: () => void }>(null);
  const [leaving, setLeaving] = useState<null | (() => void)>(null);
  const [metrics, setMetrics] = useState<Record<string, { metrics: Metric[]; windowDays: number }>>({});
  // Fenêtre choisie par traitement : on observe rarement T1 et T2 à la même
  // échelle, et imposer une fenêtre commune obligerait à la régler deux fois.
  const [fenetres, setFenetres] = useState<Record<string, number>>({});

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
      // Message ET code du serveur. Le code — VERSION_NOT_FOUND,
      // CONFIG_OPERATION_FAILED — est stable et cherchable dans le dépôt ;
      // le message seul obligerait à ouvrir les outils de développement.
      const err = e as { message?: string; code?: string; status?: number };
      setErreur([err.message, err.code && `(${err.code}${err.status ? ` — ${err.status}` : ''})`]
        .filter(Boolean).join(' ') || null);
      toast.error('Chargement impossible.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Chargés à l'ouverture de l'onglet, et non tous d'un coup : cinq requêtes
  // d'agrégation à chaque affichage de l'écran seraient payées même par qui
  // vient seulement corriger un prompt.
  const fenetre = fenetres[tab] ?? 30;

  useEffect(() => {
    if (metrics[tab]?.windowDays === fenetre) return;
    let annule = false;
    apiClient
      .get<{ metrics: Metric[]; windowDays: number }>(
        `/api/admin/ai/treatments/${tab}/metrics?days=${fenetre}`,
      )
      .then((r) => { if (!annule) setMetrics((m) => ({ ...m, [tab]: r })); })
      // Silencieux : la supervision est un complément, son absence ne doit pas
      // empêcher de configurer.
      .catch(() => {});
    return () => { annule = true; };
  }, [tab, fenetre, metrics]);

  const openVersion = useCallback(async (id: number) => {
    try {
      const v = await apiClient.get<VersionDetail>(`/api/admin/ai/config-versions/${id}`);
      setCurrent(v);
      setDrafts(Object.fromEntries(v.entries.map((e) => [e.treatment, e])));
      setDirty(new Set());
      setDiff(null);
    } catch {
      toast.error('Version introuvable.');
    }
  }, []);

  /**
   * Après une écriture de Prompt Control.
   *
   * Dans le Brouillon affiché : seul le traitement modifié est relu. Recharger
   * toute la version effacerait les saisies non enregistrées des AUTRES onglets
   * — celle du traitement ciblé est, elle, bloquée avant l'envoi.
   *
   * Dans un autre Brouillon (créé depuis l'Active) : on l'ouvre. La version
   * quittée était en lecture seule, il n'y a rien à perdre.
   */
  const afterT5Modification = async (draftId: number, t: Treatment) => {
    if (current?.id !== draftId) {
      await load();
      await openVersion(draftId);
      return;
    }
    try {
      const v = await apiClient.get<VersionDetail>(`/api/admin/ai/config-versions/${draftId}`);
      const entry = v.entries.find((e) => e.treatment === t);
      if (entry) setDrafts((d) => ({ ...d, [t]: entry }));
      setCurrent((c) => (c && c.id === v.id ? { ...c, entries: v.entries } : c));
      setDiff(null);
    } catch {
      toast.error('Le prompt a été modifié, mais l’écran n’a pas pu le relire : rechargez la version.');
    }
  };

  /** WF-01 — trois choix quand une saisie n'est pas enregistrée. */
  const guardUnsaved = (go: () => void) => {
    if (dirty.size === 0) { go(); return; }
    setLeaving(() => go);
  };

  const saveTreatment = async (t: Treatment): Promise<boolean> => {
    if (!current) return false;
    const entry = drafts[t];
    try {
      await apiClient.put(`/api/admin/ai/config-versions/${current.id}/entries/${t}`, entry);
      setDirty((d) => { const n = new Set(d); n.delete(t); return n; });
      setDiff(null);
      toast.success(`${t} enregistré`);
      return true;
    } catch {
      toast.error(`${t} n'a pas pu être enregistré.`);
      return false;
    }
  };

  const saveAllDirty = async () => {
    for (const t of dirty) {
      if (!(await saveTreatment(t))) return false;
    }
    return true;
  };

  const createDraft = async () => {
    setBusy(true);
    try {
      const d = await apiClient.post<VersionDetail>('/api/admin/ai/config-versions', {});
      toast.success('Brouillon créé');
      await load();
      await openVersion(d.id);
    } catch {
      toast.error('Création impossible.');
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

  const act = async (path: string, success: string) => {
    if (!current) return;
    setBusy(true);
    try {
      const r = await apiClient.post<Record<string, unknown>>(
        `/api/admin/ai/config-versions/${current.id}/${path}`, {},
      );
      if (path === 'promote' && r.promoted === false) {
        setDiff({ ...(r as unknown as DiffResponse), promotable: false, activeVisibleNumber: null });
        toast.error(r.reason === 'IDENTICAL_TO_ACTIVE'
          ? 'Cette version est identique à l\'Active : rien à tester.'
          : 'Des contrôles ont échoué. Le détail est affiché sous les onglets.');
        return;
      }
      toast.success(success);
      await load();
      await openVersion(current.id);
    } catch {
      toast.error("L'opération n'a pas abouti.");
    } finally { setBusy(false); }
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

  const readOnly = current ? current.status !== 'DRAFT' : true;
  const issuesFor = (t: Treatment) => diff?.validation.issues.filter((i) => i.treatment === t) ?? [];

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[color:var(--text-primary)]">Configuration IA</h1>
          <p className="text-sm text-[color:var(--text-muted)]">
            Une version couvre les cinq traitements. Environnement : {environment}.
          </p>
        </div>
        <Button size="sm" onClick={createDraft} disabled={busy}>
          <Plus className="w-3.5 h-3.5 mr-1.5" /> Créer un brouillon
        </Button>
      </div>

      {/* Versions */}
      <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] divide-y divide-[color:var(--border-subtle)]">
        {versions.length === 0 && (
          <p className="p-6 text-sm text-[color:var(--text-muted)]">
            Aucune version pour l&apos;instant. Créez un brouillon pour commencer.
          </p>
        )}
        {versions.map((v) => (
          <button
            key={v.id}
            onClick={() => guardUnsaved(() => openVersion(v.id))}
            className={`w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-[color:var(--accent-soft)] transition-colors ${
              current?.id === v.id ? 'bg-[color:var(--accent-soft)]' : ''}`}
          >
            <StatusBadge status={v.status} />
            <span className="text-sm text-[color:var(--text-primary)] flex-1 truncate">
              {versionName(v)}
            </span>
            {v.isStale && (
              <span className="text-xs text-amber-500 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> base dépassée
              </span>
            )}
            <span className="text-xs text-[color:var(--text-muted)]">
              {new Date(v.createdAt).toLocaleDateString('fr-FR')}
            </span>
          </button>
        ))}
      </div>

      {current && catalogs && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={current.status} />
            <span className="text-sm text-[color:var(--text-primary)]">{versionName(current)}</span>
            {readOnly && (
              <span className="text-xs text-[color:var(--text-muted)] flex items-center gap-1">
                <Lock className="w-3 h-3" /> lecture seule — créez un brouillon pour modifier
              </span>
            )}
            <span className="flex-1" />

            <Button size="sm" variant="outline" onClick={showDiff} disabled={busy}>
              <GitCompare className="w-3.5 h-3.5 mr-1.5" /> Comparer à l&apos;Active
            </Button>

            {current.status === 'DRAFT' && (
              <Button size="sm" onClick={() => act('promote', 'Version passée à l’essai')} disabled={busy}>
                <Play className="w-3.5 h-3.5 mr-1.5" /> Mettre à l&apos;essai
              </Button>
            )}
            {current.status === 'TO_TEST' && (
              <Button size="sm" disabled={busy}
                onClick={() => setConfirm({ kind: 'validate', onOk: () => act('validate', 'Version validée et activée') })}>
                <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" /> Valider et activer
              </Button>
            )}
            {current.status === 'VALIDATED' && (
              <>
                <Button size="sm" variant="outline" disabled={busy}
                  onClick={() => setConfirm({ kind: 'activate', onOk: () => act('activate', 'Version activée') })}>
                  Activer
                </Button>
                {current.activatedAt && (
                  <Button size="sm" variant="outline" disabled={busy}
                    onClick={() => setConfirm({ kind: 'rollback', onOk: () => act('rollback', 'Version restaurée') })}>
                    <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Restaurer
                  </Button>
                )}
              </>
            )}
            {current.status !== 'ACTIVE' && current.status !== 'ARCHIVED' && (
              <Button size="sm" variant="ghost" disabled={busy}
                onClick={() => act('archive', 'Version archivée')}>
                <Archive className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>

          <Tabs value={tab} onValueChange={(v) => guardUnsaved(() => setTab(v as Treatment))}>
            <TabsList>
              {catalogs.treatments.map((t) => (
                <TabsTrigger key={t.code} value={t.code}>
                  {t.code} · {t.label}
                  {dirty.has(t.code) && <span className="ml-1.5 text-amber-500">•</span>}
                </TabsTrigger>
              ))}
            </TabsList>

            {catalogs.treatments.map((t) => (
              <TabsContent key={t.code} value={t.code} className="mt-6 space-y-4">
                {issuesFor(t.code).length > 0 && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-1">
                    {issuesFor(t.code).map((i, k) => (
                      <p key={k} className="text-sm text-[color:var(--text-secondary)]">
                        <span className={i.blocking ? 'text-red-400' : 'text-amber-500'}>
                          {i.blocking ? 'Bloquant' : 'À vérifier'}
                        </span>
                        {' · '}{i.label} : {i.message}
                      </p>
                    ))}
                  </div>
                )}

                {/*
                  Zone en langage naturel — SCR-06, T5-UI-01.

                  · Onglet T5 : la « Conversation T5 », avec choix de la cible
                    T1–T4. C'est l'emplacement que le SCR-06 lui donne, et le
                    seul champ de saisie de l'onglet qui ne soit pas un réglage
                    de modèle — il n'y a pas de prompt T5 à éditer.
                  · Onglets T1–T4 : la même zone, cible préremplie sur le
                    traitement affiché (T5-UI-02, « selon point d'entrée »).
                */}
                {current && (
                  <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4">
                    <PromptControl
                      versionId={current.id}
                      readOnly={readOnly}
                      treatment={t.code === 'T5' ? undefined : t.code}
                      hasUnsaved={(x) => dirty.has(x)}
                      onModified={afterT5Modification}
                      onOpenVersion={(id) => guardUnsaved(() => openVersion(id))}
                    />
                  </div>
                )}

                {t.code === 'T5' && (
                  <h3 className="text-sm font-semibold text-[color:var(--text-primary)] pt-2">
                    Réglages du modèle de Prompt Control
                  </h3>
                )}

                {drafts[t.code] && (
                  <TreatmentEditor
                    entry={drafts[t.code]}
                    catalog={t}
                    catalogs={catalogs}
                    readOnly={readOnly}
                    onChange={(next) => {
                      setDrafts((d) => ({ ...d, [t.code]: next }));
                      setDirty((s) => new Set(s).add(t.code));
                    }}
                  />
                )}

                {!readOnly && (
                  <div className="flex justify-end">
                    <Button size="sm" onClick={() => saveTreatment(t.code)} disabled={!dirty.has(t.code) || busy}>
                      <Save className="w-3.5 h-3.5 mr-1.5" /> Enregistrer {t.code}
                    </Button>
                  </div>
                )}

                {metrics[t.code] && (
                  <Supervision
                    metrics={metrics[t.code].metrics}
                    windowDays={metrics[t.code].windowDays}
                    onWindowChange={(d) => setFenetres((f) => ({ ...f, [t.code]: d }))}
                  />
                )}
              </TabsContent>
            ))}
          </Tabs>

          {diff && (
            <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-2">
              <h2 className="text-sm font-semibold text-[color:var(--text-primary)]">
                Écarts avec la version active
              </h2>
              {diff.diff.identical ? (
                <p className="text-sm text-[color:var(--text-muted)]">
                  Cette version est identique à l&apos;Active.
                </p>
              ) : (
                <pre className="text-xs text-[color:var(--text-secondary)] whitespace-pre-wrap font-mono">
                  {diff.text}
                </pre>
              )}
            </div>
          )}
        </>
      )}

      {/* WF-01 — trois choix, jamais deux */}
      <Dialog open={leaving !== null} onOpenChange={(o) => !o && setLeaving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Des modifications ne sont pas enregistrées</DialogTitle>
            <DialogDescription>
              {[...dirty].join(', ')} {dirty.size > 1 ? 'ont' : 'a'} été modifié sans être enregistré.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setLeaving(null)}>Annuler</Button>
            <Button variant="outline" onClick={() => { const go = leaving; setDirty(new Set()); setLeaving(null); go?.(); }}>
              Quitter sans enregistrer
            </Button>
            <Button onClick={async () => { if (await saveAllDirty()) { const go = leaving; setLeaving(null); go?.(); } }}>
              Enregistrer puis continuer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirmations — elles nomment la conséquence, pas « êtes-vous sûr » */}
      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm?.kind === 'rollback' ? 'Restaurer cette version'
                : confirm?.kind === 'validate' ? 'Valider et activer'
                  : 'Activer cette version'}
            </DialogTitle>
            <DialogDescription>
              {confirm?.kind === 'rollback'
                ? 'Les exécutions en cours seront interrompues et les traitements par lots repris depuis le début avec cette version.'
                : 'Les exécutions en cours se termineront avec la configuration actuelle. Les suivantes utiliseront celle-ci.'}
              {(current?.unavailableModels?.length ?? 0) > 0 && (
                <span className="block mt-2 text-amber-500">
                  Attention : {current!.unavailableModels.map((m) =>
                    `${m.treatment} utilise « ${m.model} » (${m.rank})`).join(', ')} — le
                  fournisseur ne sert plus {current!.unavailableModels.length > 1
                    ? 'ces modèles' : 'ce modèle'}. Cette version échouera à moins qu&apos;un
                  repli ne prenne le relais.
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setConfirm(null)}>Annuler</Button>
            <Button
              variant={confirm?.kind === 'rollback' ? 'destructive' : 'default'}
              onClick={() => { const ok = confirm?.onOk; setConfirm(null); ok?.(); }}
            >
              {confirm?.kind === 'rollback' ? 'Restaurer' : 'Activer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
