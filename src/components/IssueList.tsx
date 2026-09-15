import { Icon } from './Icon';
import type { Issue } from '../core/types';
import { applyIssueTarget, resolveIssueTarget } from '../features/editor/issueTargets';
import { STEP_LABELS } from '../features/editor/stepStatus';

const SEVERITY_LABEL: Record<Issue['severity'], string> = {
  blocker: 'Blocker',
  warning: 'Warning',
  info: 'Note',
};

export function IssueList({ issues }: { readonly issues: readonly Issue[] }) {
  if (issues.length === 0) {
    return (
      <p className="issue-empty">
        <Icon name="check" size={14} />
        All clear at this revision.
      </p>
    );
  }
  const order: Issue['severity'][] = ['blocker', 'warning', 'info'];
  const sorted = [...issues].sort(
    (a, b) => order.indexOf(a.severity) - order.indexOf(b.severity),
  );
  return (
    <ul className="issue-list" aria-label="Preflight issues">
      {sorted.map((issue, i) => {
        const target = resolveIssueTarget(issue);
        return (
          <li
            key={`${issue.code}-${i}`}
            className={`issue issue-${issue.severity}`}
          >
            <span className="issue-tag">{SEVERITY_LABEL[issue.severity]}</span>
            {issue.surfaceId ? (
              <span className="issue-surface">Surface {issue.surfaceId}</span>
            ) : null}
            <p className="issue-message">{issue.message}</p>
            <p className="issue-remedy">{issue.remedy}</p>
            {target ? (
              <button
                type="button"
                className="button-quiet issue-fix"
                onClick={() => void applyIssueTarget(target)}
              >
                Fix in {STEP_LABELS[target.step]}
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
