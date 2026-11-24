/**
 * Carte #830 — remplaçants de `next/link`, `next/image` et `next/dynamic` pour le harnais NAVIGATEUR du tiroir
 * du document (hors application Next). Jamais importés par l'application.
 *   · lien : un vrai `<a href>` dont la navigation est retenue et notée (`window.__830Liens`) ;
 *   · image : un `<img>` ordinaire ;
 *   · composant chargé à la demande : un témoin `data-testid="c830-tiroir-evenement"` quand il est ouvert
 *     (le tiroir d'un événement n'est pas l'objet du test ; on prouve seulement qu'il est demandé).
 */
import * as React from 'react';

declare global { interface Window { __830Liens: string[] } }

export default function Link({ href, onClick, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a href={href} {...rest} onClick={(e) => {
      onClick?.(e);
      e.preventDefault();
      (window.__830Liens ??= []).push(href);
    }}>{children}</a>
  );
}

export function Image({ src, alt, className }: { src: string; alt?: string; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt ?? ''} className={className} />;
}

export function dynamic() {
  return function Temoin(props: { open?: boolean; item?: { id?: number } | null }) {
    return props.open ? <div data-testid="c830-tiroir-evenement" data-item={props.item?.id ?? ''} /> : null;
  };
}
