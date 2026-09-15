import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { Icon } from './Icon';

export function Disclosure({
  title,
  description,
  children,
  defaultOpen = false,
  className = '',
  id,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
  readonly defaultOpen?: boolean;
  readonly className?: string;
  readonly id?: string;
}) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const [mounted, setMounted] = useState(defaultOpen);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const onSummaryClick = (e: MouseEvent<HTMLElement>) => {
    e.preventDefault();
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!expanded) {
      setMounted(true);
      timerRef.current = setTimeout(() => setExpanded(true), 20);
    } else {
      setExpanded(false);
      timerRef.current = setTimeout(() => setMounted(false), 240);
    }
  };

  return (
    <details
      id={id}
      className={`disclosure ${className}`}
      open={mounted}
      data-expanded={expanded ? 'true' : 'false'}
    >
      <summary
        className="disclosure-summary"
        aria-expanded={expanded}
        onClick={onSummaryClick}
      >
        <Icon name="chevron" size={16} className="disclosure-chevron" />
        <span className="disclosure-heading">
          <span className="disclosure-title">{title}</span>
          {description ? (
            <span className="disclosure-desc">{description}</span>
          ) : null}
        </span>
      </summary>
      <div className="disclosure-grid">
        <div className="disclosure-body">{children}</div>
      </div>
    </details>
  );
}
