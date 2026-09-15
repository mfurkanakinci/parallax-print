import { useCallback, useEffect, useRef, useState } from 'react';
import { LIMITS } from '../../core/limits';
import { navigate, type Route } from '../../app/navigation';
import { BrandLockup } from '../../components/Brand';
import { Icon } from '../../components/Icon';
import { SaveStatusBadge } from '../../components/SaveStatus';
import { resolvePendingDraft } from '../../components/MeasurementField';
import { downloadProjectCopy } from '../../persistence/download';
import { useProjectStore } from '../../state/projectStore';

const TITLE_DRAFT_ID = 'project-title';

/**
 * The single commit/discard decision for the title field: returns the trimmed
 * title to commit, or null when there is nothing to commit (no pending draft,
 * a stale draft, empty text, or unchanged text). Callers must resolve the
 * pending draft synchronously from the store so a programmatic blur fired
 * right after Enter/Escape cannot re-commit a stale draft.
 */
export function resolveTitleCommit(
  pendingText: string | null,
  title: string,
): string | null {
  const next = (pendingText ?? title).trim();
  return next !== '' && next !== title ? next : null;
}

export function EditorHeader({
  onNavigate = navigate,
}: {
  readonly onNavigate?: (route: Route) => void;
}) {
  const document = useProjectStore((s) => s.document);
  const saveStatus = useProjectStore((s) => s.saveStatus);
  const readOnly = useProjectStore((s) => s.readOnly);
  const canUndo = useProjectStore((s) => s.past.length > 0);
  const canRedo = useProjectStore((s) => s.future.length > 0);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const commit = useProjectStore((s) => s.commit);
  const titleDraft = useProjectStore((s) => s.drafts[TITLE_DRAFT_ID]);
  const setFieldDraft = useProjectStore((s) => s.setFieldDraft);
  const [exportBusy, setExportBusy] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const currentTitle = document?.project.title ?? '';
  const draft =
    titleDraft && titleDraft.displayValue === currentTitle
      ? titleDraft.text
      : null;

  // Drop a stored draft once the committed title it was based on no longer
  // matches (external commit or undo/redo underneath it).
  useEffect(() => {
    if (titleDraft && titleDraft.displayValue !== currentTitle) {
      setFieldDraft(TITLE_DRAFT_ID, null);
    }
  }, [titleDraft, currentTitle, setFieldDraft]);

  const closeMenu = useCallback((returnFocus = false) => {
    setMenuOpen(false);
    if (returnFocus) {
      // Focus return is part of the menu contract for Escape and menu
      // actions. Queue it after React has removed the menu so the trigger is
      // always the next visible target.
      requestAnimationFrame(() => menuButtonRef.current?.focus());
    }
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>(
      'button:not([disabled])',
    );
    first?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || !menuRef.current?.contains(target)) {
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu(true);
        return;
      }
      const items = Array.from(
        menuRef.current.querySelectorAll<HTMLButtonElement>(
          '[role="menuitem"]:not([disabled])',
        ),
      );
      if (items.length === 0) return;
      const current = items.indexOf(target as HTMLButtonElement);
      let next = -1;
      if (event.key === 'ArrowDown') {
        next = current < 0 ? 0 : (current + 1) % items.length;
      } else if (event.key === 'ArrowUp') {
        next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
      } else if (event.key === 'Home') {
        next = 0;
      } else if (event.key === 'End') {
        next = items.length - 1;
      }
      if (next >= 0) {
        event.preventDefault();
        items[next]?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || menuButtonRef.current?.contains(target)) {
        return;
      }
      closeMenu(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [closeMenu, menuOpen]);

  if (!document) return null;
  const title = document.project.title;

  const commitTitle = () => {
    const pending = resolvePendingDraft(
      useProjectStore.getState().drafts[TITLE_DRAFT_ID],
      title,
    );
    const next = resolveTitleCommit(pending, title);
    setFieldDraft(TITLE_DRAFT_ID, null);
    if (next !== null) {
      commit((doc) => ({
        ...doc,
        project: { ...doc.project, title: next },
      }));
    }
  };

  const download = async () => {
    setExportBusy(true);
    setDownloadError(null);
    try {
      const kind = await downloadProjectCopy(document);
      if (kind === 'geometry-only') {
        setDownloadError(
          'Artwork missing — downloaded a geometry-only copy.',
        );
      }
    } catch (e) {
      setDownloadError(
        e instanceof Error ? e.message : 'Could not prepare the project file.',
      );
    } finally {
      setExportBusy(false);
    }
  };

  return (
    <header className="editor-header">
      <button
        type="button"
        className="editor-brand"
        onClick={() => onNavigate({ name: 'projects' })}
      >
        <BrandLockup compact />
      </button>
      <div className="editor-header-title">
        <h1 className="visually-hidden">{title}</h1>
        <label className="visually-hidden" htmlFor="project-title">
          Project title
        </label>
        <input
          ref={inputRef}
          id="project-title"
          className="title-input"
          maxLength={LIMITS.titleMaxLength}
          value={draft ?? title}
          disabled={readOnly}
          onChange={(e) =>
            setFieldDraft(TITLE_DRAFT_ID, {
              text: e.target.value,
              displayValue: title,
              error: null,
            })
          }
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              // commitTitle clears the draft before the programmatic blur,
              // so the blur resolves nothing and cannot commit twice.
              commitTitle();
              inputRef.current?.blur();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setFieldDraft(TITLE_DRAFT_ID, null);
              inputRef.current?.blur();
            }
          }}
        />
        <SaveStatusBadge status={saveStatus} />
        {readOnly ? <span className="readonly-tag">Read-only</span> : null}
      </div>
      <div className="editor-header-actions" aria-label="Project commands">
        <div className="header-history" role="group" aria-label="Edit history">
          <button
            type="button"
            className="header-icon-command"
            onClick={undo}
            disabled={!canUndo || readOnly}
            aria-label="Undo"
            title="Undo"
          >
            <Icon name="undo" size={17} />
          </button>
          <button
            type="button"
            className="header-icon-command"
            onClick={redo}
            disabled={!canRedo || readOnly}
            aria-label="Redo"
            title="Redo"
          >
            <Icon name="redo" size={17} />
          </button>
        </div>
        <span className="header-command-divider" aria-hidden="true" />
        <button
          type="button"
          className="header-command header-command--download"
          onClick={() => void download()}
          disabled={exportBusy}
          aria-label="Backup project"
          title="Backup project"
        >
          <Icon name="download" size={17} />
          <span>{exportBusy ? 'Preparing…' : 'Backup project'}</span>
        </button>
        <button
          type="button"
          className="header-command header-command--guide"
          onClick={() =>
            onNavigate({ name: 'install', id: document.project.id })
          }
          aria-label="Field guide"
          title="Field guide"
        >
          <Icon name="ruler" size={17} />
          <span>Field guide</span>
        </button>
        <button
          ref={menuButtonRef}
          type="button"
          className="editor-mobile-menu-trigger"
          aria-label="Project actions"
          aria-controls="editor-project-actions"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          onClick={() => {
            if (menuOpen) closeMenu(false);
            else setMenuOpen(true);
          }}
        >
          <span aria-hidden="true">…</span>
        </button>
      </div>
      {menuOpen ? (
        <div
          ref={menuRef}
          id="editor-project-actions"
          className="editor-project-menu"
          role="menu"
          aria-label="Project actions"
        >
          <button
            type="button"
            role="menuitem"
            disabled={!canUndo || readOnly}
            onClick={() => {
              undo();
              closeMenu(true);
            }}
          >
            <Icon name="undo" size={17} />
            Undo
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!canRedo || readOnly}
            onClick={() => {
              redo();
              closeMenu(true);
            }}
          >
            <Icon name="redo" size={17} />
            Redo
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={exportBusy}
            onClick={() => {
              void download();
              closeMenu(true);
            }}
          >
            <Icon name="download" size={17} />
            {exportBusy ? 'Preparing…' : 'Backup project'}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeMenu(true);
              onNavigate({ name: 'install', id: document.project.id });
            }}
          >
            <Icon name="ruler" size={17} />
            Field guide
          </button>
        </div>
      ) : null}
      {downloadError ? (
        <p className="field-error editor-header-error" role="alert">
          {downloadError}
        </p>
      ) : null}
    </header>
  );
}
