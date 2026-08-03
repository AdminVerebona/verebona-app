"use client"

import { Check, X } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { SegmentedActionBar } from '@/components/ui/segmented-action-bar';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';

export type AccountEditMode = 'profil' | 'email' | 'password';

interface AccountEditDrawerProps {
  mode: AccountEditMode | null;
  onClose: () => void;
  /** Brancher sur les endpoints réels (/api/users/me, /api/auth/…). */
  onSubmit?: (mode: AccountEditMode, form: FormData) => Promise<void>;
  defaults?: { firstName?: string; lastName?: string; displayName?: string };
}

const TITLES: Record<AccountEditMode, string> = {
  profil: 'Modifier mon profil',
  email: 'Modifier mon adresse e-mail',
  password: 'Modifier mon mot de passe',
};

/**
 * Drawer droit pleine hauteur pour les trois éditions de Mon compte › Informations.
 * Pied = barre segmentée Annuler / Enregistrer (pattern commun des formulaires).
 */
export function AccountEditDrawer({ mode, onClose, onSubmit, defaults }: AccountEditDrawerProps) {
  if (!mode) return null;

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    if (mode === 'password' && form.get('new') !== form.get('confirm')) {
      toast.error('Les deux mots de passe ne correspondent pas');
      return;
    }
    if (onSubmit) await onSubmit(mode, form);
    else toast.success('Modifications enregistrées');
    onClose();
  };

  return (
    <Sheet open onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent side="right" className="w-[440px] max-w-[92vw] p-6">
        <SheetHeader className="mb-4 p-0">
          <SheetTitle className="text-base">{TITLES[mode]}</SheetTitle>
        </SheetHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
          {mode === 'profil' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field><FieldLabel>Prénom</FieldLabel><Input name="firstName" defaultValue={defaults?.firstName ?? ''} /></Field>
                <Field><FieldLabel>Nom</FieldLabel><Input name="lastName" defaultValue={defaults?.lastName ?? ''} /></Field>
              </div>
              <Field><FieldLabel>Nom d'affichage</FieldLabel><Input name="displayName" defaultValue={defaults?.displayName ?? ''} placeholder="Comment Verebona doit-il vous appeler ?" /></Field>
            </>
          )}
          {mode === 'email' && (
            <>
              <Field><FieldLabel>Nouvelle adresse e-mail</FieldLabel><Input name="email" type="email" required placeholder="prenom.nom@exemple.fr" /></Field>
              <Field><FieldLabel>Mot de passe actuel</FieldLabel><Input name="current" type="password" required placeholder="Pour confirmer le changement" /></Field>
              <p className="text-xs leading-relaxed text-[color:var(--text-primary)] px-3.5 py-2.5 rounded-[10px] bg-[color:var(--accent-soft)] border border-blue-500/25">
                Un e-mail de confirmation sera envoyé à la nouvelle adresse. Le changement prend effet après validation.
              </p>
            </>
          )}
          {mode === 'password' && (
            <>
              <Field><FieldLabel>Mot de passe actuel</FieldLabel><Input name="current" type="password" required /></Field>
              <Field><FieldLabel>Nouveau mot de passe</FieldLabel><Input name="new" type="password" required minLength={12} placeholder="12 caractères minimum" /></Field>
              <Field><FieldLabel>Confirmer le nouveau mot de passe</FieldLabel><Input name="confirm" type="password" required /></Field>
            </>
          )}
          <div className="mt-2">
            <SegmentedActionBar
              items={[
                { icon: X, label: 'Annuler', onClick: onClose },
                { icon: Check, label: 'Enregistrer', tone: 'accent', onClick: undefined },
              ]}
            />
            {/* Le bouton Enregistrer de la barre soumet le formulaire : */}
            <button type="submit" hidden />
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
