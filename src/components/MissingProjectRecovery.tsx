import { useState } from 'react';
import { navigate } from '../app/navigation';
import { OpenProjectFileButton } from './OpenProjectFileButton';
import { RecoveryState } from './RecoveryState';

export function MissingProjectRecovery() {
  const [error, setError] = useState<string | null>(null);
  return (
    <RecoveryState
      heading="This project is not stored on this device."
      actions={
        <>
          <OpenProjectFileButton
            className="button-primary"
            onError={setError}
          />
          <button
            type="button"
            className="button-quiet"
            onClick={() => navigate({ name: 'projects' })}
          >
            Back to projects
          </button>
        </>
      }
      colophon="Parallax Print · Digital alpha · Local to this browser"
    >
      <p role="alert">
        Open a project file saved on another device, or return to your projects.
      </p>
      {error ? (
        <p role="alert" className="field-error">
          {error}
        </p>
      ) : null}
    </RecoveryState>
  );
}
