import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/instrument-sans/400.css';
import '@fontsource/instrument-sans/500.css';
import '@fontsource/instrument-sans/600.css';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/global.css';
import { App } from './app/App';
import { loadFontBytes } from './assets/fonts';

void loadFontBytes().catch(() => undefined);

const root = document.getElementById('root');
if (!root) {
  throw new Error('missing #root');
}
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
