import { createRoot } from 'react-dom/client';
import { App } from './App.js';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Options page root element #root not found');
}

createRoot(rootEl).render(<App />);
