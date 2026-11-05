"use client"

/**
 * Lot 111F — icône d'information d'un indicateur du coût de possession
 * (« – » non calculable, ou définition du calcul). Survol au bureau, toucher
 * sur mobile (même composant : Popover ouvert au survol ET au clic / toucher),
 * accessible au clavier. Le texte vient du serveur (moteur TCO) : aucune règle
 * ici. Charte Sérénité : jetons de couleur seulement.
 */
import { useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export function TcoInfoTip({ text, label }: { text: string; label: string }) {
  const [open, setOpen] = useState(false);
  const fermeture = useRef<ReturnType<typeof setTimeout> | null>(null);
  const annuler = () => { if (fermeture.current) clearTimeout(fermeture.current); fermeture.current = null; };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Information : ${label}`}
          className="inline-flex items-center justify-center rounded-full min-w-[28px] min-h-[28px] md:min-w-[20px] md:min-h-[20px] text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--primary)] shrink-0"
          onPointerEnter={(e) => { if (e.pointerType === 'mouse') { annuler(); setOpen(true); } }}
          onPointerLeave={(e) => { if (e.pointerType === 'mouse') { annuler(); fermeture.current = setTimeout(() => setOpen(false), 150); } }}
          data-tco-info-tip
        >
          <Info className="w-3.5 h-3.5" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        className="w-72 max-w-[calc(100vw-32px)] p-3 text-xs leading-relaxed text-[color:var(--text-primary)]"
        onPointerEnter={annuler}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') setOpen(false); }}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {text}
      </PopoverContent>
    </Popover>
  );
}
