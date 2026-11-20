/**
 * Carte #806 (volet B) — remplaçant de `next/link` pour le harnais NAVIGATEUR (hors application Next) : un vrai
 * lien `<a href>`, dont la navigation est retenue et notée (`window.__806Liens`). Jamais importé par l'application.
 */
import * as React from 'react';

declare global { interface Window { __806Liens: string[] } }

export default function Link({ href, onClick, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a href={href} {...rest} onClick={(e) => {
      onClick?.(e);
      e.preventDefault();
      (window.__806Liens ??= []).push(href);
    }}>{children}</a>
  );
}
