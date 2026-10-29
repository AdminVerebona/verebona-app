'use client';

/**
 * « Scanner un document » dans le formulaire d'ajout — lot 95 (CDC 12 SCAN-01..03 ;
 * PO M9). N'apparaît QUE dans l'application iOS / Android embarquant le
 * scanner du système ; sur le Web, rien n'est rendu.
 *
 * Le PDF produit rejoint la liste des fichiers du formulaire (même contrôle
 * que le sélecteur de fichiers) ; scanner indisponible ou caméra refusée :
 * l'import classique est proposé (§20).
 */
import { useEffect, useState } from 'react';
import { ScanLine } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { NATIVE_PLUGINS, nativePlugin } from '@/lib/native/bridge';
import { nativeFeatureOn } from '@/lib/native/features';

export function NativeScanButton({ disabled, onScanned, onFallback }: {
  disabled?: boolean;
  onScanned: (file: File) => void;
  onFallback: () => void;
}) {
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  // Scanner embarqué ET non coupé par le serveur (`MOBILE_FEATURES_OFF=scan`).
  useEffect(() => { setAvailable(nativePlugin(NATIVE_PLUGINS.scanner) !== null && nativeFeatureOn('scan')); }, []);
  if (!available) return null;

  const scanner = async () => {
    setBusy(true);
    try {
      const { scanDocumentToPdf } = await import('@/lib/native/scan');
      const r = await scanDocumentToPdf();
      if (r.status === 'ok') onScanned(r.file);
      else if (r.status === 'unavailable') {
        toast.message('Le scanner n’est pas disponible : choisissez un fichier ou une photo.');
        onFallback();
      } else if (r.status === 'failed') toast.error('Le document scanné n’a pas pu être préparé. Réessayez.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button type="button" variant="outline" className="w-full" onClick={() => void scanner()} disabled={disabled || busy}>
      <ScanLine className="w-4 h-4 mr-2" aria-hidden />
      Scanner un document
    </Button>
  );
}
