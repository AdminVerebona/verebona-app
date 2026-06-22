"use client";

/**
 * Administration de l'IA documentaire — CDC §19
 * Deux sous-onglets :
 *   - Fonctions documentaires : propositions IA retainedFunctionCode
 *   - Dates déduites : propositions IA documentDate (field + derived_date)
 * Chaque groupe = une carte : ce que l'IA a lu, ce qu'elle propose d'écrire, Accept / Reject.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  Sparkles, CheckCircle2, XCircle, Loader2, RefreshCw,
  ToggleLeft, ToggleRight, FileText, Calendar, Tag,
  ArrowRight, Database, Brain, AlertTriangle, Wand2,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';

// ─── Types ───────────────────────────────────────────────────────────────────

interface AiInstruction {
  id: number;
  instruction: string;
  status: 'pending' | 'applied' | 'dismissed';
  geminiAnalysis: string | null;
  promptsPatched: string | null;
  createdAt: string;
  appliedAt: string | null;
}

interface ProposalAggregate {
  canonicalCode: string | null;
  proposalType: string;
  targetKey: string;
  displayLabel: string | null;
  total: number;
  sampleValue: string | null;
  avgConfidence: string | null;
}

interface TaxonomyMapping {
  id: number;
  mappingType: 'function_code' | 'date_label';
  rawLabel: string;
  canonicalCode: string;
  canonicalLabel: string;
  confidenceThreshold: string;
  source: 'gemini' | 'openai' | 'manual';
  status: 'active' | 'inactive';
  disabledAt: string | null;
  createdAt: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CANONICAL_FUNCTION_LABELS: Record<string, string> = {
  PHOTO_BIEN: 'Photo du bien',
  ASSURANCE: 'Assurance',
  CONTRAT: 'Contrat',
  GARANTIE: 'Garantie',
  ENTRETIEN_INTERVENTION: 'Entretien / Intervention',
  CONTROLE_CONFORMITE: 'Contrôle / Conformité',
  TRAVAUX_INSTALLATION: 'Travaux / Installation',
  ACHAT_JUSTIFICATIF: 'Achat / Justificatif',
  DOCUMENT_ADMINISTRATIF: 'Document administratif',
  SINISTRE_INCIDENT: 'Sinistre / Incident',
  FINANCEMENT: 'Financement',
  AUTRE: 'Autre',
};

const TARGET_KEY_LABELS: Record<string, string> = {
  retainedFunctionCode: 'Type de document',
  documentDate: 'Date du document',
  supplier: 'Fournisseur',
  amountCents: 'Montant',
  retainedTitle: 'Titre du document',
  description: 'Description',
  matchedAssetId: 'Bien associé',
  roomReference: 'Pièce associée',
  equipmentReference: 'Équipement associé',
};

const DB_EFFECT_LABELS: Record<string, string> = {
  retainedFunctionCode: 'Écrit asset_files.retained_function_code',
  documentDate: 'Écrit asset_files.document_date',
  supplier: 'Écrit asset_files.supplier',
  amountCents: 'Écrit asset_files.amount_cents',
  retainedTitle: 'Écrit asset_files.retained_title',
  description: 'Écrit asset_files.description',
};

// ─── Value decoder ────────────────────────────────────────────────────────────

function decodeProposedValue(targetKey: string, proposalType: string, sampleValue: string | null): string {
  if (!sampleValue) return '—';
  try {
    const parsed = JSON.parse(sampleValue);
    if (targetKey === 'retainedFunctionCode') {
      return CANONICAL_FUNCTION_LABELS[parsed] ?? parsed;
    }
    if (targetKey === 'documentDate' || targetKey === 'amountCents') {
      if (targetKey === 'amountCents') {
        const cents = typeof parsed === 'number' ? parsed : parseInt(parsed);
        return isNaN(cents) ? sampleValue : (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
      }
      if (typeof parsed === 'string' && parsed.match(/^\d{4}-\d{2}-\d{2}/)) {
        try {
          return new Date(parsed).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
        } catch { return parsed; }
      }
      // derived_date: { label, dateValue, dateType }
      if (typeof parsed === 'object' && parsed !== null) {
        const dv = parsed.dateValue ?? parsed.date_value;
        const lbl = parsed.label ?? '';
        const dateStr = dv ? (() => { try { return new Date(dv).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }); } catch { return dv; } })() : '';
        return [lbl, dateStr].filter(Boolean).join(' → ');
      }
    }
    if (typeof parsed === 'string') return parsed;
    if (typeof parsed === 'number') return String(parsed);
    return JSON.stringify(parsed);
  } catch {
    return sampleValue;
  }
}

// ─── ProposalGroupRow ─────────────────────────────────────────────────────────

function ProposalGroupRow({
  proposal,
  onAction,
}: {
  proposal: ProposalAggregate;
  onAction: () => void;
}) {
  const [loading, setLoading] = useState<'accept' | 'reject' | null>(null);

  const isDerived = proposal.proposalType === 'derived_date';
  const targetLabel = TARGET_KEY_LABELS[proposal.targetKey] ?? proposal.targetKey;
  const decodedValue = decodeProposedValue(proposal.targetKey, proposal.proposalType, proposal.sampleValue);
  const dbEffect = isDerived
    ? 'Crée un élément dans l\'agenda du bien'
    : (DB_EFFECT_LABELS[proposal.targetKey] ?? `Écrit asset_files.${proposal.targetKey}`);
  const confidence = proposal.avgConfidence ? Math.round(parseFloat(proposal.avgConfidence) * 100) : null;

  const handleAction = async (action: 'accept' | 'reject') => {
    setLoading(action);
    try {
      await apiClient.patch('/api/admin/document-ai/proposals', {
        action,
        targetKey: proposal.targetKey,
        canonicalCode: proposal.canonicalCode,
        displayLabel: proposal.displayLabel,
        proposalType: proposal.proposalType,
      });
      if (action === 'accept') {
        toast.success(`${proposal.total} proposition(s) acceptée(s)${proposal.targetKey === 'retainedFunctionCode' || (proposal.targetKey === 'documentDate' && isDerived) ? ' — mapping créé' : ''}`);
      } else {
        toast.success(`${proposal.total} proposition(s) rejetée(s)`);
      }
      onAction();
    } catch {
      toast.error('Erreur lors de l\'action');
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] overflow-hidden">
      {/* Header strip */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-page)]/50">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {isDerived
            ? <Calendar className="w-4 h-4 text-[#a78bfa] shrink-0" />
            : <FileText className="w-4 h-4 text-[#3b82f6] shrink-0" />}
          <span className="font-semibold text-sm text-[color:var(--text-primary)]">{targetLabel}</span>
          <Badge
            variant="outline"
            className={`text-[10px] h-4 shrink-0 ${isDerived ? 'border-[#a78bfa]/40 text-[#a78bfa]' : 'border-[#3b82f6]/40 text-[#3b82f6]'}`}
          >
            {isDerived ? 'DÉDUIT' : 'CHAMP'}
          </Badge>
        </div>
        <Badge variant="outline" className="text-[10px] h-5 shrink-0 border-[color:var(--border-subtle)]">
          {proposal.total} occurrence{proposal.total > 1 ? 's' : ''}
        </Badge>
        {confidence !== null && (
          <div className="flex items-center gap-1.5 shrink-0">
            <div className="w-16 h-1.5 rounded-full bg-[color:var(--border-subtle)] overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${confidence}%`,
                  background: confidence >= 80 ? '#22c55e' : confidence >= 60 ? '#f59e0b' : '#ef4444',
                }}
              />
            </div>
            <span className="text-[10px] text-[color:var(--text-muted)]">{confidence}%</span>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="px-4 py-3 space-y-2.5">
        {/* What the AI read */}
        <div className="flex items-start gap-2.5">
          <Brain className="w-3.5 h-3.5 text-[#a78bfa] shrink-0 mt-0.5" />
          <div className="min-w-0">
            <span className="text-[10px] uppercase tracking-wider text-[color:var(--text-muted)] font-semibold">Ce que l'IA a lu</span>
            <p className="text-sm text-[color:var(--text-secondary)] mt-0.5">
              {proposal.displayLabel ?? proposal.targetKey}
              {proposal.canonicalCode && proposal.canonicalCode !== proposal.displayLabel && (
                <span className="ml-2 text-[10px] font-mono text-[color:var(--text-muted)] bg-[color:var(--bg-page)] px-1.5 py-0.5 rounded">
                  {proposal.canonicalCode}
                </span>
              )}
            </p>
          </div>
        </div>

        {/* What it proposes */}
        <div className="flex items-start gap-2.5">
          <ArrowRight className="w-3.5 h-3.5 text-[#3b82f6] shrink-0 mt-0.5" />
          <div className="min-w-0">
            <span className="text-[10px] uppercase tracking-wider text-[color:var(--text-muted)] font-semibold">Valeur proposée</span>
            <p className="text-sm font-medium text-[color:var(--text-primary)] mt-0.5 break-words">{decodedValue}</p>
          </div>
        </div>

        {/* DB effect */}
        <div className="flex items-start gap-2.5">
          <Database className="w-3.5 h-3.5 text-[color:var(--text-muted)] shrink-0 mt-0.5" />
          <div className="min-w-0">
            <span className="text-[10px] uppercase tracking-wider text-[color:var(--text-muted)] font-semibold">Effet en base de données</span>
            <p className="text-xs text-[color:var(--text-muted)] mt-0.5 font-mono">{dbEffect}</p>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-[color:var(--border-subtle)] bg-[color:var(--bg-page)]/30">
        <p className="flex-1 text-[11px] text-[color:var(--text-muted)]">
          {proposal.total} document{proposal.total > 1 ? 's' : ''} concerné{proposal.total > 1 ? 's' : ''}
          {proposal.targetKey === 'retainedFunctionCode' ? ' — Accepter créera un mapping réutilisable' : ''}
          {isDerived ? ' — Accepter valide la règle de déduction' : ''}
        </p>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-3 text-xs text-[#ef4444] border-[#ef4444]/30 hover:bg-[#ef4444]/5 shrink-0"
          disabled={loading !== null}
          onClick={() => handleAction('reject')}
        >
          {loading === 'reject'
            ? <Loader2 className="w-3 h-3 animate-spin mr-1" />
            : <XCircle className="w-3 h-3 mr-1" />}
          Rejeter
        </Button>
        <Button
          size="sm"
          className="h-7 px-3 text-xs bg-[#22c55e]/10 text-[#22c55e] border border-[#22c55e]/30 hover:bg-[#22c55e]/20 shrink-0"
          variant="outline"
          disabled={loading !== null}
          onClick={() => handleAction('accept')}
        >
          {loading === 'accept'
            ? <Loader2 className="w-3 h-3 animate-spin mr-1" />
            : <CheckCircle2 className="w-3 h-3 mr-1" />}
          Accepter
        </Button>
      </div>
    </div>
  );
}

// ─── Compact mappings table ───────────────────────────────────────────────────

function MappingsCompact({
  mappings,
  onRefresh,
}: {
  mappings: TaxonomyMapping[];
  onRefresh: () => void;
}) {
  const [togglingId, setTogglingId] = useState<number | null>(null);

  const handleToggle = async (m: TaxonomyMapping) => {
    setTogglingId(m.id);
    try {
      const newStatus = m.status === 'active' ? 'inactive' : 'active';
      await apiClient.patch(`/api/admin/document-ai/mappings/${m.id}`, { status: newStatus });
      onRefresh();
    } catch {
      toast.error('Erreur lors de la mise à jour');
    } finally {
      setTogglingId(null);
    }
  };

  if (mappings.length === 0) return null;

  return (
    <div>
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)] mb-2 flex items-center gap-1.5">
        <CheckCircle2 className="w-3 h-3 text-green-500" />
        Référentiel canonique ({mappings.length} mappings)
      </h3>
      <div className="space-y-1">
        {mappings.map(m => (
          <div
            key={m.id}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs transition-all ${
              m.status === 'inactive'
                ? 'opacity-40 border-[color:var(--border-subtle)]'
                : 'border-[color:var(--border-subtle)] bg-[color:var(--bg-card)]'
            }`}
          >
            <span className="flex-1 text-[color:var(--text-secondary)] truncate">{m.rawLabel}</span>
            <ArrowRight className="w-3 h-3 text-[color:var(--text-muted)] shrink-0" />
            <span className="font-mono text-[10px] text-[color:var(--text-muted)] shrink-0">{m.canonicalCode}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${
              m.source === 'manual' ? 'bg-[#3b82f6]/10 text-[#3b82f6]' : 'bg-[#a78bfa]/10 text-[#a78bfa]'
            }`}>
              {m.source === 'manual' ? 'Manuel' : 'IA'}
            </span>
            <button
              className="shrink-0 p-0.5 rounded hover:bg-[color:var(--bg-hover)] transition-colors"
              disabled={togglingId === m.id}
              onClick={() => handleToggle(m)}
              title={m.status === 'active' ? 'Désactiver' : 'Activer'}
            >
              {togglingId === m.id
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : m.status === 'active'
                ? <ToggleRight className="w-3.5 h-3.5 text-green-500" />
                : <ToggleLeft className="w-3.5 h-3.5 text-[color:var(--text-muted)]" />}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
      <div className="w-12 h-12 rounded-full bg-[color:var(--accent-soft)] flex items-center justify-center">
        <CheckCircle2 className="w-6 h-6 text-green-500" />
      </div>
      <p className="text-sm text-[color:var(--text-muted)]">Aucune proposition IA en attente pour {label}.</p>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DocumentAIAdminPage() {
  const [activeTab, setActiveTab] = useState<'functions' | 'dates' | 'instructions'>('instructions');
  const [functionMappings, setFunctionMappings] = useState<TaxonomyMapping[]>([]);
  const [dateMappings, setDateMappings] = useState<TaxonomyMapping[]>([]);
  const [functionProposals, setFunctionProposals] = useState<ProposalAggregate[]>([]);
  const [dateProposals, setDateProposals] = useState<ProposalAggregate[]>([]);
  const [loading, setLoading] = useState(true);

  // Instructions IA state
  const [instructions, setInstructions] = useState<AiInstruction[]>([]);
  const [newInstruction, setNewInstruction] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Inline preview state after Gemini analysis
  interface GeminiPreview {
    instructionId: number;
    instructionText: string;
    analysis: string;
    patchResults: Array<{ file: string; applied: boolean; reason: string; error?: string }>;
    patchedFiles: string[];
  }
  const [geminiPreview, setGeminiPreview] = useState<GeminiPreview | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [fMappings, dMappings, proposals] = await Promise.all([
        apiClient.get<{ mappings: TaxonomyMapping[] }>('/api/admin/document-ai/mappings?type=function_code'),
        apiClient.get<{ mappings: TaxonomyMapping[] }>('/api/admin/document-ai/mappings?type=date_label'),
        apiClient.get<{ proposals: ProposalAggregate[] }>('/api/admin/document-ai/proposals'),
      ]);
      setFunctionMappings(fMappings.mappings);
      setDateMappings(dMappings.mappings);
      setFunctionProposals(proposals.proposals.filter(p => p.targetKey === 'retainedFunctionCode'));
      setDateProposals(proposals.proposals.filter(p => p.targetKey === 'documentDate'));
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);


  const PROMPT_LABELS: Record<string, string> = {
    'extract_v1.txt': 'Analyse IA documentaire',
    'extract_meta_v1.txt': 'Analyse IA documentaire',
    'extract_detail_v1.txt': 'Analyse IA documentaire',
    'extract_agenda_v1.txt': 'Analyse IA documentaire',
    'agenda_detect_v1.txt': 'Analyse IA documentaire',
    'asset_suggest_v1.txt': 'Suggestions de champs',
    'search_v1.txt': 'Champ recherche',
  };

  const getPromptCategory = (files: string[]): string => {
    const cats = [...new Set(files.map(f => PROMPT_LABELS[f] ?? f))];
    return cats.join(' + ');
  };

  const handleSubmitInstruction = async () => {
    if (!newInstruction.trim()) return;
    setSubmitting(true);
    setGeminiPreview(null);
    try {
      // Save instruction
      const saved = await apiClient.post<{ instruction: AiInstruction }>('/api/admin/ai-instructions', { instruction: newInstruction.trim() });
      const instructionId = saved.instruction.id;
      const instructionText = newInstruction.trim();
      setNewInstruction('');

      // Immediately trigger Gemini analysis
      const data = await apiClient.post<{ analysis: string; patchResults: Array<{ file: string; applied: boolean; reason: string; error?: string }>; patchedFiles: string[] }>(
        '/api/admin/ai-instructions/apply',
        { instructionId }
      );

      // Show inline preview
      setGeminiPreview({
        instructionId,
        instructionText,
        analysis: data.analysis,
        patchResults: data.patchResults,
        patchedFiles: data.patchedFiles,
      });
    } catch {
      toast.error("Erreur lors de l'analyse par Gemini");
    } finally {
      setSubmitting(false);
    }
  };


  useEffect(() => { loadData(); }, [loadData]);

  const totalPending = functionProposals.length + dateProposals.length;
  const totalFunctionOccurrences = functionProposals.reduce((s, p) => s + p.total, 0);
  const totalDateOccurrences = dateProposals.reduce((s, p) => s + p.total, 0);

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[color:var(--text-primary)] flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-[#a78bfa]" />
            Gestion IA
          </h1>
          <p className="text-sm text-[color:var(--text-muted)] mt-1">
            Pilotage de l'IA documentaire — instructions, propositions et référentiel
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={loadData} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
          Actualiser
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-3 text-center">
          <p className="text-2xl font-bold text-[color:var(--text-primary)]">{functionMappings.filter(m => m.status === 'active').length}</p>
          <p className="text-xs text-[color:var(--text-muted)] mt-0.5">Mappings fonctions</p>
        </div>
        <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-3 text-center">
          <p className="text-2xl font-bold text-[color:var(--text-primary)]">{dateMappings.filter(m => m.status === 'active').length}</p>
          <p className="text-xs text-[color:var(--text-muted)] mt-0.5">Mappings dates</p>
        </div>
        <div className="rounded-xl border border-[#a78bfa]/30 bg-[#a78bfa]/5 p-3 text-center">
          <p className="text-2xl font-bold text-[#a78bfa]">{totalPending}</p>
          <p className="text-xs text-[color:var(--text-muted)] mt-0.5">Groupes en attente</p>
        </div>
        <div className="rounded-xl border border-[#a78bfa]/30 bg-[#a78bfa]/5 p-3 text-center">
          <p className="text-2xl font-bold text-[#a78bfa]">{totalFunctionOccurrences + totalDateOccurrences}</p>
          <p className="text-xs text-[color:var(--text-muted)] mt-0.5">Documents concernés</p>
        </div>
      </div>

      {/* Explanation banner */}
      {totalPending > 0 && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-xl border border-[#a78bfa]/20 bg-[#a78bfa]/5 text-sm text-[color:var(--text-secondary)]">
          <AlertTriangle className="w-4 h-4 text-[#a78bfa] shrink-0 mt-0.5" />
          <span>
            Chaque carte ci-dessous représente un groupe de propositions identiques faites par l'IA.
            <strong className="text-[color:var(--text-primary)]"> Accepter</strong> valide la règle et l'enregistre dans le référentiel (les futures analyses utiliseront ce mapping).
            <strong className="text-[color:var(--text-primary)]"> Rejeter</strong> marque toutes les occurrences comme incorrectes.
          </span>
        </div>
      )}

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'functions' | 'dates' | 'instructions')}>
        <TabsList className="bg-[rgba(15,23,42,0.5)] border border-[color:var(--border-subtle)] p-1 rounded-xl w-fit flex-wrap gap-1">
          <TabsTrigger value="instructions" className="rounded-lg data-[state=active]:bg-[#a78bfa] data-[state=active]:text-white">
            <Wand2 className="w-3.5 h-3.5 mr-1.5" />
            Instructions IA
          </TabsTrigger>
          <TabsTrigger value="functions" className="rounded-lg data-[state=active]:bg-[#a78bfa] data-[state=active]:text-white">
            <Tag className="w-3.5 h-3.5 mr-1.5" />
            Fonctions
            {functionProposals.length > 0 && (
              <span className="ml-1.5 text-xs opacity-75">({functionProposals.length})</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="dates" className="rounded-lg data-[state=active]:bg-[#a78bfa] data-[state=active]:text-white">
            <Calendar className="w-3.5 h-3.5 mr-1.5" />
            Dates
            {dateProposals.length > 0 && (
              <span className="ml-1.5 text-xs opacity-75">({dateProposals.length})</span>
            )}
          </TabsTrigger>
        </TabsList>

        {/* ── Instructions IA ── */}
        <TabsContent value="instructions" className="mt-6 space-y-6">
          {/* Explanation */}
          <div className="flex items-start gap-3 px-4 py-3 rounded-xl border border-[#a78bfa]/20 bg-[#a78bfa]/5 text-sm text-[color:var(--text-secondary)]">
            <Wand2 className="w-4 h-4 text-[#a78bfa] shrink-0 mt-0.5" />
            <span>
              Décrivez un comportement attendu ou un problème observé en langage naturel.
              Gemini va interpréter votre instruction et <strong className="text-[color:var(--text-primary)]">mettre à jour automatiquement les prompts d'analyse IA</strong> et/ou la logique de recherche pour correspondre à votre attente.
              <br />
              <span className="text-xs text-[color:var(--text-muted)] mt-1 block">
                Exemple : "Il y a une photo de maison avec des volets. Quand je tape «volet» dans la recherche, la photo doit ressortir."
              </span>
            </span>
          </div>

          {/* New instruction form */}
          <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3">
            <h3 className="text-sm font-semibold text-[color:var(--text-primary)] flex items-center gap-2">
              <Wand2 className="w-4 h-4 text-[#a78bfa]" />
              Nouvelle instruction
            </h3>
            <Textarea
              placeholder="Décrivez le comportement attendu ou le problème observé... Ex : Quand je tape 'volet' dans la recherche, les photos de volets doivent ressortir."
              value={newInstruction}
              onChange={e => setNewInstruction(e.target.value)}
              className="min-h-[100px] resize-none text-sm bg-[color:var(--bg-input)] border-[color:var(--border-subtle)] focus:border-[#a78bfa]/50"
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmitInstruction(); }}
            />
            <div className="flex items-center justify-between">
              <span className="text-xs text-[color:var(--text-muted)]">Ctrl+Entrée pour envoyer</span>
              <Button
                size="sm"
                onClick={handleSubmitInstruction}
                disabled={submitting || !newInstruction.trim()}
                className="bg-[#a78bfa] hover:bg-[#8b5cf6] text-white"
              >
                {submitting ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5 mr-1.5" />}
                {submitting ? 'Analyse en cours…' : 'Analyser avec Gemini'}
              </Button>
            </div>
          </div>

          {/* Gemini preview result */}
          {geminiPreview && (
            <div className="rounded-xl border border-[#a78bfa]/30 bg-[#a78bfa]/5 p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-[color:var(--text-primary)] flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-[#a78bfa]" />
                  Résultat de l'analyse Gemini
                </h3>
                <button onClick={() => setGeminiPreview(null)} className="text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-colors text-lg leading-none">×</button>
              </div>

              {/* Instruction recap */}
              <div className="bg-[color:var(--bg-card)] rounded-lg px-3 py-2 border border-[color:var(--border-subtle)]">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)] mb-1">Instruction analysée</p>
                <p className="text-sm text-[color:var(--text-secondary)] leading-relaxed">{geminiPreview.instructionText}</p>
              </div>

              {/* Analysis */}
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)] mb-1.5">Interprétation</p>
                <p className="text-sm text-[color:var(--text-secondary)] leading-relaxed whitespace-pre-wrap">{geminiPreview.analysis}</p>
              </div>

              {/* Prompts affected */}
              {geminiPreview.patchedFiles.length > 0 ? (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)] mb-2">Prompts modifiés</p>
                  <div className="space-y-1.5">
                    {geminiPreview.patchResults.filter(r => r.applied).map((r, i) => (
                      <div key={i} className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-green-500/10 border border-green-500/20">
                        <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <span className="text-xs font-semibold text-green-500">{getPromptCategory([r.file])}</span>
                          <span className="text-[10px] text-[color:var(--text-muted)] ml-2 font-mono">{r.file}</span>
                        </div>
                        <span className="text-[10px] text-[color:var(--text-muted)] truncate max-w-[160px]">{r.reason}</span>
                      </div>
                    ))}
                    {geminiPreview.patchResults.filter(r => !r.applied).map((r, i) => (
                      <div key={i} className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-[color:var(--bg-page)] border border-[color:var(--border-subtle)] opacity-60">
                        <XCircle className="w-3.5 h-3.5 text-[color:var(--text-muted)] shrink-0" />
                        <div className="flex-1 min-w-0">
                          <span className="text-xs text-[color:var(--text-muted)]">{r.file}</span>
                        </div>
                        <span className="text-[10px] text-[color:var(--text-muted)] truncate max-w-[160px]">{r.error ?? 'Non appliqué'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-[color:var(--bg-page)] border border-[color:var(--border-subtle)]">
                  <CheckCircle2 className="w-4 h-4 text-[color:var(--text-muted)] shrink-0" />
                  <p className="text-sm text-[color:var(--text-muted)]">Les prompts existants satisfont déjà cette instruction — aucune modification nécessaire.</p>
                </div>
              )}
            </div>
          )}

        </TabsContent>

        {/* ── Fonctions documentaires ── */}
        <TabsContent value="functions" className="mt-6 space-y-6">
          {loading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="w-7 h-7 animate-spin text-[color:var(--text-muted)]" />
            </div>
          ) : (
            <>
              {functionProposals.length === 0 ? (
                <EmptyState label="les fonctions documentaires" />
              ) : (
                <div className="space-y-3">
                  <h3 className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)] flex items-center gap-1.5">
                    <Sparkles className="w-3 h-3 text-[#a78bfa]" />
                    Propositions en attente ({functionProposals.length} groupe{functionProposals.length > 1 ? 's' : ''} · {totalFunctionOccurrences} document{totalFunctionOccurrences > 1 ? 's' : ''})
                  </h3>
                  {functionProposals.map((p, i) => (
                    <ProposalGroupRow key={i} proposal={p} onAction={loadData} />
                  ))}
                </div>
              )}
              <MappingsCompact mappings={functionMappings} onRefresh={loadData} />
            </>
          )}
        </TabsContent>

        {/* ── Dates déduites ── */}
        <TabsContent value="dates" className="mt-6 space-y-6">
          {loading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="w-7 h-7 animate-spin text-[color:var(--text-muted)]" />
            </div>
          ) : (
            <>
              {dateProposals.length === 0 ? (
                <EmptyState label="les dates" />
              ) : (
                <div className="space-y-3">
                  <h3 className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)] flex items-center gap-1.5">
                    <Sparkles className="w-3 h-3 text-[#a78bfa]" />
                    Propositions en attente ({dateProposals.length} groupe{dateProposals.length > 1 ? 's' : ''} · {totalDateOccurrences} document{totalDateOccurrences > 1 ? 's' : ''})
                  </h3>
                  {dateProposals.map((p, i) => (
                    <ProposalGroupRow key={i} proposal={p} onAction={loadData} />
                  ))}
                </div>
              )}
              <MappingsCompact mappings={dateMappings} onRefresh={loadData} />
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
