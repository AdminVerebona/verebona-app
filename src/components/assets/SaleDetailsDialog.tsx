'use client';

/**
 * Vente réalisée demandée au passage d'un bien à VENDU / TRANSMIS — lot 43
 * (O4), décision PO Q5 du 11/10 (CDC Opérations V1 B13.6, C7.6, C18).
 *
 * Petite fenêtre (composant `Dialog` existant, mêmes champs que la fiche :
 * `DatePicker`, `NumberInput`) ouverte après la résolution d'une carte
 * « À traiter » ASSET-STATUS, depuis la file ou la mascotte — même composant
 * sur desktop et sur mobile. Tout est FACULTATIF : « Plus tard » ferme sans
 * rien écrire ; les valeurs restent modifiables dans la fiche (section
 * « Informations générales »). VENDU : date et prix réalisés ; TRANSMIS :
 * date seule (cession sans prix). L'écriture passe par la route de la fiche
 * (`PATCH /api/assets/:id/details/common`, origine USER) : la donnée du bien
 * reste la source de vérité (B1) et établit la Cession côté serveur (C2).
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { NumberInput } from '@/components/ui/number-input';
import { apiClient } from '@/lib/api-client';
import { saleDetailsPatch, type SaleDetailsPrompt } from '@/lib/assets/sale-fields';

export interface SaleFollowUp {
  assetId: number;
  assetName: string | null;
  prompt: SaleDetailsPrompt;
}

interface FormProps {
  followUp: SaleFollowUp;
  busy?: boolean;
  onSubmit: (input: { date: string; price: string }) => void;
  onSkip: () => void;
}

/** Contenu de la fenêtre (rendu testé seul : le `Dialog` passe par un portail). */
export function SaleDetailsForm({ followUp, busy = false, onSubmit, onSkip }: FormProps) {
  const [date, setDate] = useState('');
  const [price, setPrice] = useState('');
  const { prompt } = followUp;
  return (
    <form
      data-sale-details={prompt.status}
      className="space-y-4"
      onSubmit={(e) => { e.preventDefault(); onSubmit({ date, price }); }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">{prompt.dateLabel}</Label>
          <DatePicker value={date} onChange={setDate} />
        </div>
        {prompt.askPrice && (
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Prix de vente réalisé (€)</Label>
            <NumberInput
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              showButtons={false}
            />
          </div>
        )}
      </div>
      <DialogFooterLike>
        <Button type="button" variant="outline" onClick={onSkip} disabled={busy}>Plus tard</Button>
        <Button type="submit" disabled={busy || (!date && !price)}>Enregistrer</Button>
      </DialogFooterLike>
    </form>
  );
}

/** Pied de fenêtre : mêmes classes que `DialogFooter`, sans dépendre du portail. */
function DialogFooterLike({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">{children}</div>;
}

export function SaleDetailsDialog({ followUp, onClose }: { followUp: SaleFollowUp | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false);

  async function enregistrer(input: { date: string; price: string }) {
    if (!followUp) return;
    const patch = saleDetailsPatch(followUp.prompt, input);
    if (patch === null) { onClose(); return; }
    if ('error' in patch) { toast.error(patch.error); return; }
    setBusy(true);
    try {
      await apiClient.patch(`/api/assets/${followUp.assetId}/details/common`, patch);
      toast.success(followUp.prompt.askPrice ? 'Vente complétée' : 'Transmission complétée');
      onClose();
    } catch (e) {
      toast.error((e as { message?: string } | null)?.message ?? 'Enregistrement impossible. Vous pourrez compléter depuis la fiche du bien.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!followUp} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{followUp?.prompt.title ?? ''}</DialogTitle>
          <DialogDescription>
            {followUp?.assetName ? `${followUp.assetName} — ` : ''}{followUp?.prompt.description ?? ''}
          </DialogDescription>
        </DialogHeader>
        {followUp && (
          // Clé : une nouvelle cession repart d'un formulaire vide.
          <SaleDetailsForm key={`${followUp.assetId}-${followUp.prompt.status}`} followUp={followUp} busy={busy} onSubmit={(x) => void enregistrer(x)} onSkip={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}
