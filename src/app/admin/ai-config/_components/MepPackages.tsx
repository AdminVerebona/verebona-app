"use client";

/**
 * Mise en production — CDC BO IA WF-04, VER-021 à VER-024, VER-012, PKG-01.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX GESTES, DE PART ET D'AUTRE DU DÉPLOIEMENT
 *
 * Préproduction : « Préparer pour MEP » sur l'Active → un fichier JSON
 * `{ uid, payload }`, immuable, téléchargé. Le §1.4 exclut tout push Git depuis
 * le BO : c'est la chaîne GitHub → Scalingo (ou l'administrateur) qui le
 * transporte.
 *
 * Production : « Importer un package » → la version arrive au statut Validé,
 * JAMAIS active (VER-012). La divergence avec l'Active est affichée, sans
 * bloquer (WF-04). L'activation reste le bouton « Activer » de la version
 * importée, avec sa confirmation renforcée en production.
 *
 * Le fichier téléchargé est exactement le corps attendu par la route
 * d'import : pas de transformation entre les deux environnements, donc rien
 * qui puisse diverger en chemin.
 */
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2, Download, Upload, PackageCheck } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';

interface FieldChange { label: string; before: string | null; after: string | null }
interface Divergence {
  treatments: Array<{ treatment: string; changes: FieldChange[] }>;
  identical: boolean;
  changeCount: number;
}

/** Un prompt entier dans une ligne de divergence serait illisible : on l'abrège. */
function court(v: string | null): string {
  if (v === null) return '∅';
  return v.length > 120 ? `${v.slice(0, 117)}…` : v;
}

interface ImportResult {
  outcome: 'created' | 'recognized';
  versionId: number;
  visibleNumber: number;
  divergence: Divergence | null;
}

interface PrepareResponse {
  package: { uid: string; visibleNumber: number; label: string | null; createdAt: string };
  payload: unknown;
}

export function MepPackages({
  environment, active, onImported, onOpenVersion,
}: {
  environment: string;
  /** Active de l'environnement, s'il y en a une. */
  active: { id: number; visibleNumber: number | null; label: string | null } | null;
  onImported: () => void | Promise<void>;
  onOpenVersion: (id: number) => void;
}) {
  const [busy, setBusy] = useState<null | 'prepare' | 'import'>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [refus, setRefus] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const isProduction = environment === 'production';

  const prepare = async () => {
    if (!active) return;
    setBusy('prepare');
    setRefus(null);
    try {
      const r = await apiClient.post<PrepareResponse>(
        `/api/admin/ai/config-versions/${active.id}/package`, {},
      );
      if (!r.payload) throw new Error('Package préparé, mais contenu introuvable.');
      // Même forme que le corps de POST /config-packages/import.
      const body = JSON.stringify({ uid: r.package.uid, payload: r.payload }, null, 2);
      const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `verebona-ia-v${r.package.visibleNumber}-${r.package.uid.slice(0, 8)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Package v${r.package.visibleNumber} prêt`);
    } catch (e) {
      setRefus((e as Error).message || 'Préparation impossible.');
    } finally { setBusy(null); }
  };

  const importFile = async (file: File) => {
    setBusy('import');
    setRefus(null);
    setResult(null);
    try {
      let body: unknown;
      try {
        body = JSON.parse(await file.text());
      } catch {
        throw new Error('Fichier illisible : un package est un fichier JSON produit par « Préparer pour MEP ».');
      }
      const r = await apiClient.post<ImportResult>('/api/admin/ai/config-packages/import', body);
      setResult(r);
      toast.success(r.outcome === 'created'
        ? `Version v${r.visibleNumber} importée au statut Validé`
        : `Package déjà importé : v${r.visibleNumber} reconnue`);
      await onImported();
    } catch (e) {
      const err = e as { code?: string; message?: string };
      setRefus(err.code === 'VERSION_NUMBER_COLLISION'
        ? `${err.message} Aucune version n’a été créée.`
        : err.message || 'Import impossible.');
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <PackageCheck className="w-4 h-4 text-[color:var(--text-muted)]" />
        <h2 className="text-sm font-semibold text-[color:var(--text-primary)]">Mise en production</h2>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {!isProduction && (
          <Button size="sm" variant="outline" onClick={prepare} disabled={busy !== null || !active}
            title={active ? undefined : 'Aucune Active : validez d’abord une version.'}>
            {busy === 'prepare' ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Download className="w-3.5 h-3.5 mr-1.5" />}
            Préparer pour MEP{active?.visibleNumber ? ` (v${active.visibleNumber})` : ''}
          </Button>
        )}
        <input ref={fileRef} type="file" accept="application/json,.json" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); }} />
        <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={busy !== null}>
          {busy === 'import' ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Upload className="w-3.5 h-3.5 mr-1.5" />}
          Importer un package
        </Button>
      </div>

      <p className="text-xs text-[color:var(--text-muted)]">
        {isProduction
          ? 'La version importée arrive au statut Validé ; l’Active de production reste inchangée jusqu’à son activation explicite (VER-012).'
          : 'Le package contient uniquement la configuration versionnée de l’Active (prompts, modèles, paramètres, déclencheurs, garde-fous) — jamais de secret ni d’état d’exploitation.'}
      </p>

      {refus && <p role="alert" className="text-sm text-amber-500 whitespace-pre-wrap">{refus}</p>}

      {result && (
        <div className="rounded-lg border border-[color:var(--border-subtle)] p-3 space-y-2">
          <p className="text-sm text-[color:var(--text-primary)]">
            {result.outcome === 'created' ? 'Version créée' : 'Version déjà présente (import idempotent)'} :
            {' '}<span className="font-medium">v{result.visibleNumber}</span>, statut Validé.
          </p>
          {result.divergence ? (
            <details open>
              <summary className="text-xs text-amber-500 cursor-pointer">
                Divergence avec l&apos;Active : {result.divergence.changeCount} écart(s) — avertissement, non bloquant
              </summary>
              <ul className="mt-2 space-y-1 text-xs font-mono text-[color:var(--text-secondary)]">
                {result.divergence.treatments.flatMap((t) => t.changes.map((c, i) => (
                  <li key={`${t.treatment}-${i}`}>
                    {t.treatment} · {c.label} : {court(c.before)} → {court(c.after)}
                  </li>
                )))}
              </ul>
            </details>
          ) : (
            <p className="text-xs text-[color:var(--text-muted)]">Aucune divergence avec l&apos;Active (ou aucune Active).</p>
          )}
          <Button size="sm" onClick={() => onOpenVersion(result.versionId)}>
            Ouvrir v{result.visibleNumber} pour l&apos;activer
          </Button>
        </div>
      )}
    </div>
  );
}
