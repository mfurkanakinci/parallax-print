import type { PreviewStatus } from '../state/jobController';

const LABEL: Record<PreviewStatus, string> = {
  idle: 'No preview',
  updating: 'Updating preview…',
  ready: 'Preview up to date',
  error: 'Preview failed',
};

export function PreviewStatusLine({
  status,
  error,
  onRetry,
}: {
  readonly status: PreviewStatus;
  readonly error: string | null;
  readonly onRetry?: () => void;
}) {
  return (
    <div
      className={`preview-status preview-${status}`}
      role="status"
      aria-live="polite"
    >
      <span className="status-dot" aria-hidden="true" />
      <span>
        {status === 'error' && error ? `Preview failed: ${error}` : LABEL[status]}
      </span>
      {status === 'error' && onRetry ? (
        <button type="button" className="button-quiet" onClick={onRetry}>
          Retry preview
        </button>
      ) : null}
    </div>
  );
}
