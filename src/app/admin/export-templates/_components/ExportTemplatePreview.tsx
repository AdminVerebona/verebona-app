"use client"

/**
 * Prévisualisation d'un modèle d'export — CDC Back-Office V1 §11.2
 * (EXP-008 à EXP-012, REC-MOD-05).
 *
 * L'administrateur choisit un bien de SON compte (EXP-009, EXP-010), voit le
 * rendu final dans la page (EXP-008), la liste des données manquantes
 * (EXP-011) et peut télécharger le fichier (EXP-012).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Download, Eye, Loader2, AlertTriangle, Info } from 'lucide-react';
import { EcranEnErreur } from '@/components/admin/EcranEnErreur';

interface PreviewAsset {
  id: number;
  name: string;
  category: string;
  ineligibleReason: string | null;
}

interface PreviewContext {
  supported: boolean;
  message?: string;
  exportType?: string;
  output?: 'PDF' | 'ZIP';
  templateActive?: boolean;
  assets: PreviewAsset[];
}

interface RenderedPreview {
  url: string;
  fileName: string;
  contentType: string;
  missing: string[];
  notice: string | null;
}

function decodeHeader(value: string | null): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function ExportTemplatePreview({ templateId }: { templateId: number }) {
  const [ctx, setCtx] = useState<PreviewContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [assetId, setAssetId] = useState<number | null>(null);
  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [preview, setPreview] = useState<RenderedPreview | null>(null);
  const urlRef = useRef<string | null>(null);

  const loadContext = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch(`/api/admin/export-templates/${templateId}/preview`, { credentials: 'include' });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message ?? 'Chargement de la prévisualisation impossible.');
      setCtx(data as PreviewContext);
      const eligible = (data as PreviewContext).assets.filter((a) => !a.ineligibleReason);
      if (eligible.length === 1) setAssetId(eligible[0].id);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Erreur inconnue');
    }
  }, [templateId]);

  useEffect(() => {
    loadContext();
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, [loadContext]);

  const render = async () => {
    if (!assetId || rendering) return;
    setRendering(true);
    setRenderError(null);
    try {
      const res = await fetch(`/api/admin/export-templates/${templateId}/preview`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.message ?? 'Le rendu de la prévisualisation a échoué.');
      }
      const blob = await res.blob();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      let missing: string[] = [];
      try {
        missing = JSON.parse(decodeHeader(res.headers.get('X-Preview-Missing')) ?? '[]');
      } catch {
        missing = [];
      }
      setPreview({
        url,
        fileName: res.headers.get('X-Preview-Filename') ?? 'apercu',
        contentType: res.headers.get('Content-Type') ?? blob.type,
        missing,
        notice: decodeHeader(res.headers.get('X-Preview-Notice')),
      });
    } catch (e) {
      setRenderError(e instanceof Error ? e.message : 'Erreur inconnue');
    } finally {
      setRendering(false);
    }
  };

  if (loadError) {
    return <EcranEnErreur titre="Prévisualisation indisponible" message={loadError} onRetry={loadContext} />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <Eye className="h-4 w-4" /> Prévisualisation du rendu final
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!ctx ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Chargement…
          </p>
        ) : !ctx.supported ? (
          <p className="text-sm text-muted-foreground">{ctx.message}</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              La prévisualisation utilise uniquement les données de votre propre compte Verebona. Aucun export
              n’est enregistré.
              {ctx.templateActive === false && ' Ce modèle est inactif : le rendu est affiché pour contrôle, sans effet pour les utilisateurs.'}
            </p>
            {ctx.assets.length === 0 ? (
              <p className="text-sm text-amber-600 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                Votre compte ne contient aucun bien : prévisualisation impossible. Créez un bien dans votre propre
                compte pour contrôler ce modèle.
              </p>
            ) : (
              <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
                <label className="flex-1 text-sm space-y-1">
                  <span className="text-xs text-muted-foreground">Bien utilisé pour la prévisualisation</span>
                  <select
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    value={assetId ?? ''}
                    onChange={(e) => {
                      setAssetId(e.target.value ? Number(e.target.value) : null);
                      setPreview(null);
                    }}
                  >
                    <option value="">Choisissez un bien…</option>
                    {ctx.assets.map((a) => (
                      <option key={a.id} value={a.id} disabled={!!a.ineligibleReason}>
                        {a.name}
                        {a.ineligibleReason ? ` — ${a.ineligibleReason}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <Button onClick={render} disabled={!assetId || rendering}>
                  {rendering ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Eye className="h-4 w-4 mr-2" />}
                  {rendering ? 'Rendu en cours…' : 'Générer la prévisualisation'}
                </Button>
              </div>
            )}
            {ctx.assets.length > 0 && ctx.assets.every((a) => a.ineligibleReason) && (
              <p className="text-sm text-amber-600">Aucun bien de votre compte n’est compatible avec ce modèle.</p>
            )}
            {renderError && (
              <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm flex items-center justify-between gap-3">
                <span className="text-red-600">{renderError}</span>
                <Button size="sm" variant="outline" onClick={render} disabled={rendering}>Réessayer</Button>
              </div>
            )}
            {preview && (
              <div className="space-y-3">
                {preview.missing.length > 0 ? (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm space-y-1">
                    <p className="font-medium flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-amber-600" /> Prévisualisation partielle : données manquantes
                    </p>
                    <ul className="list-disc pl-6 text-muted-foreground">
                      {preview.missing.map((m) => <li key={m}>{m}</li>)}
                    </ul>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Toutes les données attendues par le modèle sont présentes.</p>
                )}
                {preview.notice && (
                  <p className="text-xs text-muted-foreground flex items-center gap-2">
                    <Info className="h-3.5 w-3.5" /> {preview.notice}
                  </p>
                )}
                <div className="flex justify-end">
                  <a href={preview.url} download={preview.fileName}>
                    <Button variant="outline" size="sm">
                      <Download className="h-4 w-4 mr-2" /> Télécharger la prévisualisation
                    </Button>
                  </a>
                </div>
                {preview.contentType.includes('pdf') ? (
                  <iframe title="Prévisualisation de l’export" src={preview.url} className="w-full h-[800px] rounded-md border" />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Ce modèle produit une archive ZIP : téléchargez-la pour contrôler son contenu.
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
