/** Lot 111E — remplace `next/link` dans le harnais navigateur. */
import * as React from 'react';
type Props = Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { href: string | { pathname?: string }; prefetch?: boolean };
export default function Link({ href, prefetch: _p, ...rest }: Props) {
  return <a href={typeof href === 'string' ? href : href.pathname ?? '#'} {...rest} />;
}
