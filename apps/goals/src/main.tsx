import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme, systemTheme } from './theme';
import './styles.css';

applyTheme(systemTheme());
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => applyTheme(systemTheme()));

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/goals/sw.js', { scope: '/goals/' }).catch(() => {});
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
