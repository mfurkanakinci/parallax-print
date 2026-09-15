import type { SaveStatus } from '../persistence/types';

const LABEL: Record<SaveStatus, string> = {
  unsaved: 'Unsaved changes',
  saving: 'Saving locally…',
  saved: 'Saved on this device',
  error: 'Save failed',
  conflict: 'Save conflict',
};

export function SaveStatusBadge({ status }: { readonly status: SaveStatus }) {
  return (
    <span className={`save-status save-${status}`} role="status">
      <span className="save-dot" aria-hidden="true" />
      {LABEL[status]}
    </span>
  );
}
