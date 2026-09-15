import { Icon, type IconName } from './Icon';
import type { ViewMode } from '../persistence/types';

export type PreviewMode = ViewMode | 'photo';

const MODES: {
  value: ViewMode;
  label: string;
  name: string;
  hint: string;
  icon: IconName;
}[] = [
  { value: 'resolved', label: 'Resolved', name: 'Resolved (view from the design eye)', hint: 'The piece as seen from the design eye.', icon: 'eye' },
  { value: 'orbit', label: 'Orbit', name: 'Orbit (move around the installation)', hint: 'Orbit the installation — the image breaks.', icon: 'orbit' },
  { value: 'pieces', label: 'Pieces', name: 'Pieces (printable flat pieces)', hint: 'Printable piece shapes in surface coordinates.', icon: 'pieces' },
];

const PHOTO_MODE: {
  value: 'photo';
  label: string;
  name: string;
  hint: string;
  icon: IconName;
} = {
  value: 'photo',
  label: 'Photo',
  name: 'Photo (review the captured room)',
  hint: 'Review the captured room with computed print pieces.',
  icon: 'artwork',
};

export interface ViewModeSwitchProps<TMode extends PreviewMode = PreviewMode> {
  readonly value: TMode;
  readonly onChange: (mode: TMode) => void;
  /** Public/sample previews omit Photo; editor enables it after registration. */
  readonly photoAvailable?: boolean;
}

export function ViewModeSwitch<TMode extends PreviewMode>({
  value,
  onChange,
  photoAvailable = false,
}: ViewModeSwitchProps<TMode>) {
  const modes: readonly {
    value: PreviewMode;
    label: string;
    name: string;
    hint: string;
    icon: IconName;
  }[] = photoAvailable ? [...MODES, PHOTO_MODE] : MODES;
  return (
    <div
      className="mode-switch"
      data-photo-available={photoAvailable ? 'true' : 'false'}
      role="group"
      aria-label="Preview mode"
    >
      {modes.map((m) => (
        <button
          key={m.value}
          type="button"
          className="mode-button"
          aria-label={m.name}
          aria-pressed={value === m.value}
          title={m.hint}
          onClick={() => onChange(m.value as TMode)}
        >
          <span className="mode-icon" aria-hidden="true">
            <Icon name={m.icon} size={17} />
          </span>
          <span className="mode-label">{m.label}</span>
        </button>
      ))}
    </div>
  );
}
