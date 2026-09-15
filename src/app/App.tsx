import { Component, useState, type ReactNode } from 'react';
import { navigate, useRoute } from './navigation';
import { ProjectsPage } from '../features/projects/ProjectsPage';
import { EditorPage } from '../features/editor/EditorPage';
import { InstallationPage } from '../features/install/InstallationPage';
import { Disclosure } from '../components/Disclosure';
import { RecoveryState } from '../components/RecoveryState';
import { openSampleProject } from '../features/projects/importArchive';
import { SAMPLE_ARTWORKS } from '../assets/sampleProject';

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    if (this.state.error) {
      return (
        <RecoveryState
          heading="Something went wrong"
          actions={
            <>
              <button
                type="button"
                className="button-primary"
                onClick={() => this.setState({ error: null })}
              >
                Retry
              </button>
              <button
                type="button"
                className="button-quiet"
                onClick={() => {
                  this.setState({ error: null });
                  navigate({ name: 'projects' });
                }}
              >
                Back to projects
              </button>
            </>
          }
          colophon="Parallax Print · Digital alpha · Local to this browser"
        >
          <p role="alert">
            The studio hit an unexpected error. Your projects remain stored on
            this device.
          </p>
          <Disclosure title="Technical details">
            <p className="recovery-error">{this.state.error.message}</p>
          </Disclosure>
        </RecoveryState>
      );
    }
    return this.props.children;
  }
}

function NotFoundPage() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <RecoveryState
      heading="Nothing is projected here."
      actions={
        <>
          <button
            type="button"
            className="button-primary"
            onClick={() => navigate({ name: 'projects' })}
          >
            Back to projects
          </button>
          <button
            type="button"
            className="button-quiet"
            disabled={pending}
            onClick={() => {
              setPending(true);
              setError(null);
              void openSampleProject(SAMPLE_ARTWORKS[0]!).catch(
                (e: unknown) => {
                  setError(
                    e instanceof Error
                      ? e.message
                      : 'Could not load the sample.',
                  );
                  setPending(false);
                },
              );
            }}
          >
            {pending ? 'Preparing sample…' : 'Try a sample'}
          </button>
        </>
      }
      colophon="Parallax Print · Digital alpha · Local to this browser"
    >
      <p role="alert">
        The address does not match a Parallax Print project on this device.
      </p>
      {error ? (
        <p role="alert" className="field-error">
          {error}
        </p>
      ) : null}
    </RecoveryState>
  );
}

export function App() {
  const route = useRoute();
  return (
    <ErrorBoundary>
      {route.name === 'editor' ? (
        <EditorPage key={route.id} projectId={route.id} />
      ) : route.name === 'install' ? (
        <InstallationPage key={route.id} projectId={route.id} />
      ) : route.name === 'not-found' ? (
        <NotFoundPage key={route.hash} />
      ) : (
        <ProjectsPage />
      )}
    </ErrorBoundary>
  );
}
