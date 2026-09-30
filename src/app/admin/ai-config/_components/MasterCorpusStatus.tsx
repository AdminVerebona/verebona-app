'use client';

/**
 * État du corpus des prompts maîtres d'une version — CDC 15 §30, D-17, HC-06.
 *
 * Affiché pour toute version qui met au moins un traitement en `master` :
 * vert, ou la raison exacte pour laquelle la validation / l'activation /
 * la restauration sera refusée (aucun contournement).
 */
import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { apiClient } from '@/lib/api-client';

interface Entry {
  treatment: string;
  masterPromptCode: string;
  textSha256: string;
  textSource: 'config' | 'file';
  branchesRequired: string[];
  status: 'GREEN' | 'NO_RUN' | 'RUN_FAILED' | 'BRANCHES_MISSING' | 'CORPUS_TABLE_MISSING';
  message: string;
  lastRun: { id: number; status: string; branchesPassed: string[]; casesTotal: number; casesPassed: number; source: string; createdAt: string } | null;
}
interface Response { versionId: number; activable: boolean; entries: Entry[]; command: string }

export function MasterCorpusStatus({ versionId, refreshKey }: { versionId: number; refreshKey?: number }) {
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let annule = false;
    setData(null); setError(null);
    apiClient.get<Response>(`/api/admin/ai/config-versions/${versionId}/corpus`)
      .then((r) => { if (!annule) setData(r); })
      .catch((e: { message?: string }) => { if (!annule) setError(e.message ?? 'État du corpus indisponible.'); });
    return () => { annule = true; };
  }, [versionId, refreshKey]);

  if (error) return <p className="text-xs text-red-400">{error}</p>;
  if (!data) return <p className="text-xs text-[color:var(--text-muted)] flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Corpus des masters…</p>;
  if (data.entries.length === 0) return null;

  return (
    <div className={`rounded-lg border px-3 py-2 space-y-1 text-sm ${data.activable
      ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-red-500/40 bg-red-500/5'}`}>
      <p className="font-medium">
        Corpus des prompts maîtres : {data.activable ? 'vert — activation possible' : 'activation refusée (CDC 15 §30)'}
      </p>
      <ul className="space-y-1">
        {data.entries.map((e) => (
          <li key={e.treatment} className="flex items-start gap-2 text-xs">
            {e.status === 'GREEN'
              ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 mt-0.5 shrink-0" />
              : <XCircle className="w-3.5 h-3.5 text-red-400 mt-0.5 shrink-0" />}
            <span>{e.message}</span>
          </li>
        ))}
      </ul>
      {!data.activable && (
        <p className="text-xs text-[color:var(--text-muted)]">
          Exécuter le corpus sur cette version : <code>{data.command}</code>
        </p>
      )}
    </div>
  );
}
