import { useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { openProjectArchive } from '../features/projects/importArchive';

export function OpenProjectFileButton({
  className = 'button-link',
  children,
  onError,
}: {
  readonly className?: string;
  readonly children?: ReactNode;
  readonly onError?: (message: string | null) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [opening, setOpening] = useState(false);
  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => fileRef.current?.click()}
        disabled={opening}
      >
        <Icon name="upload" size={16} />
        {opening ? 'Opening…' : (children ?? 'Open project file')}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".zip,.parallax,application/zip"
        className="visually-hidden"
        aria-label="Project archive file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          setOpening(true);
          onError?.(null);
          void openProjectArchive(file).catch((err: unknown) => {
            onError?.(
              err instanceof Error
                ? err.message
                : 'That file is not a valid project archive.',
            );
            setOpening(false);
          });
        }}
      />
    </>
  );
}
