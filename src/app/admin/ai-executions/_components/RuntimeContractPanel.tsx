"use client";

/**
 * Contrat runtime d'une exécution IA — BO « Exécutions & logs », lot 34D
 * (tickets « contrat runtime source unique de vérité » et « T4 : découpler
 * le contrat d'exécution du texte du prompt maître »).
 *
 * Permet de vérifier immédiatement QUEL contrat a été transmis au modèle et
 * LEQUEL a servi à la validation :
 *   · par exécution : contract ID, contract version, schema version, schema
 *     hash (identiques pour le principal, les réparations et les replis) ;
 *   · par appel : structured output oui / non, empreinte du schéma
 *     fournisseur dérivé, transformations appliquées (normalisations,
 *     mappings de compatibilité, passe de réparation) ;
 *   · RUNTIME_CONTRACT_MISMATCH (défaut interne, jamais montré à l'utilisateur) ;
 *   · T4 : mode d'exécution, TASK, versions prompt / contrat d'entrée /
 *     contrat de sortie, empreintes du prompt et du contexte construit.
 *
 * Composant DÉDIÉ (coordination lot 34C, qui fait évoluer la page) : la page
 * ne fait que l'insérer. Composants et jetons existants uniquement.
 */

export interface RuntimeContractTraceView {
  contractId: string;
  contractVersion: number;
  schemaVersion: string;
  schemaHash: string;
  structuredOutput: boolean;
  providerSchemaHash: string | null;
  compatTableVersion: number;
  mismatch?: { generationHash: string; validationHash: string; validationVersion: string };
}
export interface TransformationsView {
  normalizations: string[];
  compatMappings: string[];
  repair: 'SUCCESS' | 'FAILED' | null;
  pruned: string[];
}
export interface StructuredContextView {
  mode: 'LEGACY_TEMPLATE' | 'STRUCTURED_CONTEXT';
  task: string;
  promptVersion: string;
  promptHash: string;
  inputContractVersion: string | null;
  outputContractVersion: string | null;
  contextHash: string | null;
}
export interface ContractCallView {
  id: number;
  model: string | null;
  modelRank: string | null;
  callKind?: 'analysis' | 'repair';
  status: string;
  errorCode: string | null;
  runtimeContract?: RuntimeContractTraceView | null;
  transformations?: TransformationsView | null;
  structuredContext?: StructuredContextView | null;
}

const RANG: Record<string, string> = { primary: 'Principal', fallback_1: 'Repli 1', fallback_2: 'Repli 2' };

function Ligne({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-[color:var(--text-muted)]">{label}</dt>
      <dd className="text-[color:var(--text-secondary)] break-all">{children}</dd>
    </>
  );
}

export function RuntimeContractPanel({ calls }: { calls: ContractCallView[] }) {
  const avec = calls.filter((c) => c.runtimeContract);
  if (avec.length === 0) return null;
  const ref = avec[0].runtimeContract!;
  // Même contrat pour toute l'exécution (principal, réparations, replis) ?
  const identiques = avec.every((c) => c.runtimeContract!.contractId === ref.contractId
    && c.runtimeContract!.contractVersion === ref.contractVersion && c.runtimeContract!.schemaHash === ref.schemaHash);
  const mismatch = avec.find((c) => c.runtimeContract!.mismatch || c.errorCode === 'RUNTIME_CONTRACT_MISMATCH');
  const sc = calls.find((c) => c.structuredContext)?.structuredContext ?? null;
  const contrat = calls.find((c) => c.errorCode?.startsWith('T4_'));

  return (
    <section className="space-y-2" data-testid="execution-runtime-contract">
      <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Contrat runtime</h3>
      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-xs">
        <Ligne label="Contract ID">{ref.contractId}</Ligne>
        <Ligne label="Contract version">{ref.contractVersion}</Ligne>
        <Ligne label="Schema version">{ref.schemaVersion}</Ligne>
        <Ligne label="Schema hash">{ref.schemaHash}</Ligne>
        <Ligne label="Table de compatibilité">v{ref.compatTableVersion}</Ligne>
        <Ligne label="Même contrat sur tous les appels">{identiques ? 'oui' : 'NON'}</Ligne>
      </dl>
      {mismatch && (
        <p role="alert" className="text-xs text-red-400">
          RUNTIME_CONTRACT_MISMATCH — défaut interne du moteur (non affiché à l’utilisateur) :
          {mismatch.runtimeContract?.mismatch
            ? ` schéma transmis ${ref.schemaHash} ≠ schéma de validation ${mismatch.runtimeContract.mismatch.validationHash} (${mismatch.runtimeContract.mismatch.validationVersion}).`
            : ' schéma de génération et de validation différents.'}
        </p>
      )}

      {sc && (
        <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-xs" data-testid="execution-structured-context">
          <Ligne label="Mode d’exécution">{sc.mode === 'STRUCTURED_CONTEXT' ? 'Contexte structuré' : 'Legacy (emplacements)'}</Ligne>
          <Ligne label="TASK">{sc.task}</Ligne>
          <Ligne label="Prompt">{sc.promptVersion} · empreinte {sc.promptHash}</Ligne>
          <Ligne label="Contrat d’entrée">{sc.inputContractVersion ?? '—'}</Ligne>
          <Ligne label="Contrat de sortie">{sc.outputContractVersion ?? '—'}</Ligne>
          <Ligne label="Contexte construit">{sc.contextHash ? `empreinte ${sc.contextHash}` : '—'}</Ligne>
        </dl>
      )}
      {contrat && (
        <p role="alert" className="text-xs text-red-400">
          {contrat.errorCode} — contrat T4 refusé avant tout appel fournisseur (aucun coût).
        </p>
      )}

      <ul className="space-y-1 text-xs">
        {avec.map((c) => {
          const r = c.runtimeContract!;
          const t = c.transformations;
          return (
            <li key={c.id} className="rounded-md border border-[color:var(--border-subtle)] p-2 space-y-0.5">
              <p className="text-[color:var(--text-primary)]">
                {RANG[c.modelRank ?? ''] ?? 'Rang inconnu'} · {c.model ?? '—'}{c.callKind === 'repair' ? ' · réparation' : ''}
              </p>
              <p className="text-[color:var(--text-secondary)]">
                Structured output : {r.structuredOutput ? 'Oui' : 'Non'}
                {r.structuredOutput && r.providerSchemaHash ? ` · schéma fournisseur ${r.providerSchemaHash} (dérivé de ${r.schemaVersion})` : ''}
                {!r.structuredOutput ? ' · schéma dérivé joint au prompt' : ''}
              </p>
              {t?.normalizations.length ? <p className="text-[color:var(--text-muted)]">Normalisation : {t.normalizations.join(' ; ')}</p> : null}
              {t?.compatMappings.length ? <p className="text-[color:var(--text-muted)]">Compatibility mapping : {t.compatMappings.join(' ; ')}</p> : null}
              {t?.repair ? <p className={t.repair === 'SUCCESS' ? 'text-[color:var(--text-muted)]' : 'text-amber-500'}>Repair pass : {t.repair}</p> : null}
              {t?.pruned.length ? <p className="text-[color:var(--text-muted)]">Champs retirés : {t.pruned.join(' ; ')}</p> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
