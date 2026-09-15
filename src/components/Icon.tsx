import type { CSSProperties } from 'react';

export type IconName =
  | 'arrow-right'
  | 'artwork'
  | 'check'
  | 'chevron'
  | 'download'
  | 'eye'
  | 'folder'
  | 'layers'
  | 'lock'
  | 'orbit'
  | 'pieces'
  | 'print'
  | 'redo'
  | 'ruler'
  | 'surfaces'
  | 'undo'
  | 'upload'
  | 'warning';

const SOURCES: Record<IconName, string> = {
  'arrow-right': 'arrow-right.svg',
  artwork: 'image.svg',
  check: 'check.svg',
  chevron: 'chevron-right.svg',
  download: 'file-down.svg',
  eye: 'eye.svg',
  folder: 'folder.svg',
  layers: 'layers-2.svg',
  lock: 'lock.svg',
  orbit: 'move.svg',
  pieces: 'grid-2x2.svg',
  print: 'printer.svg',
  redo: 'rotate-cw.svg',
  ruler: 'drafting-compass.svg',
  surfaces: 'columns-3.svg',
  undo: 'rotate-ccw.svg',
  upload: 'folder-up.svg',
  warning: 'triangle-alert.svg',
};

export function Icon({
  name,
  size = 18,
  className = '',
}: {
  readonly name: IconName;
  readonly size?: number;
  readonly className?: string;
}) {
  const style = {
    width: size,
    height: size,
    '--icon-mask': `url("/icons/runeicons/${SOURCES[name]}")`,
  } as CSSProperties;
  return (
    <span
      className={`icon${className ? ` ${className}` : ''}`}
      style={style}
      aria-hidden="true"
    />
  );
}
