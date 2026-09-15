import { useEffect, useRef, type ReactNode } from 'react';
import { ParallaxMark } from './Brand';

export function RecoveryState({
  heading,
  children,
  actions,
  colophon,
}: {
  readonly heading: string;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  readonly colophon?: ReactNode;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  // On recovery-route entry, move focus to the heading so keyboard and
  // assistive-tech users land on the message. tabIndex -1 keeps it out of the
  // tab order; the empty dep list means this runs once on mount, so ordinary
  // rerenders do not steal focus.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  return (
    <main className="page-recovery">
      <ParallaxMark className="recovery-mark" />
      <h1 ref={headingRef} tabIndex={-1} className="recovery-heading">
        {heading}
      </h1>
      <div className="recovery-body">{children}</div>
      {actions ? <div className="recovery-actions">{actions}</div> : null}
      {colophon ? <div className="recovery-colophon">{colophon}</div> : null}
    </main>
  );
}
