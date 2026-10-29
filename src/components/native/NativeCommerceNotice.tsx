'use client';

/**
 * Message sobre affiché dans l'application à la place d'un bouton ou d'un lien
 * commercial (lot 97B, `lib/native/commerce`) : texte seul, sans lien ni
 * adresse (règles des stores). Jamais rendu dans un navigateur par les
 * appelants (`useNativeCommerceHidden`).
 */
import { NATIVE_COMMERCE_MESSAGE } from '@/lib/native/commerce';

export function NativeCommerceNotice({ className }: { className?: string }) {
  return (
    <p className={className ?? 'text-xs text-[color:var(--text-muted)]'} data-testid="native-commerce-notice">
      {NATIVE_COMMERCE_MESSAGE}
    </p>
  );
}
