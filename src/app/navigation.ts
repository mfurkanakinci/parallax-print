import { useSyncExternalStore } from 'react';
import type { EditorStep } from '../persistence/types';

let editorEntryIntent: { id: string; step: EditorStep } | null = null;

export type Route =
  | { name: 'projects' }
  | { name: 'editor'; id: string }
  | { name: 'install'; id: string }
  | { name: 'not-found'; hash: string };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  const [head, id] = path.split('/');
  if (head === 'editor') {
    return id ? { name: 'editor', id } : { name: 'not-found', hash };
  }
  if (head === 'install') {
    return id ? { name: 'install', id } : { name: 'not-found', hash };
  }
  if (head === '' || (head === 'projects' && !id)) {
    return { name: 'projects' };
  }
  return { name: 'not-found', hash };
}

export function routeHash(route: Route): string {
  switch (route.name) {
    case 'projects':
      return '#/projects';
    case 'editor':
      return `#/editor/${route.id}`;
    case 'install':
      return `#/install/${route.id}`;
    case 'not-found':
      return '#/not-found';
  }
}

export function navigate(route: Route): void {
  editorEntryIntent = null;
  window.location.hash = routeHash(route);
}

/** A one-shot task intent consumed after the actual editor document loads. */
export function navigateToEditorStep(id: string, step: EditorStep): void {
  navigate({ name: 'editor', id });
  editorEntryIntent = { id, step };
}

export function consumeInitialEditorStep(id: string): EditorStep | null {
  if (!editorEntryIntent || editorEntryIntent.id !== id) return null;
  const route = parseHash(window.location.hash);
  if (route.name !== 'editor' || route.id !== id) {
    editorEntryIntent = null;
    return null;
  }
  const step = editorEntryIntent.step;
  editorEntryIntent = null;
  return step;
}

function subscribe(callback: () => void): () => void {
  const onChange = () => {
    if (editorEntryIntent && window.location.hash !== routeHash({ name: 'editor', id: editorEntryIntent.id })) editorEntryIntent = null;
    callback();
  };
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => '',
  );
  return parseHash(hash);
}
