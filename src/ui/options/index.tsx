import { createRoot } from 'react-dom/client';
import * as AppModule from './App';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Options page root element #root not found');
}

// Resolve component from static namespace import (works for both default- and named-exported App)
const AppComp: any = (AppModule as any).default ?? (AppModule as any).App;
if (!AppComp) {
  // eslint-disable-next-line no-console
  console.error('[Options] Failed to resolve App component exports:', Object.keys(AppModule || {}));
  throw new Error('Options App component not found (default or named export)');
}

createRoot(rootEl as HTMLElement).render(<AppComp />);
