import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { DatabaseGate } from './system/DatabaseGate';
import './styles/index.css';

const container = document.getElementById('root');

if (!container) {
  throw new Error('[Never87] Root container #root was not found in index.html');
}

createRoot(container).render(
  <StrictMode>
    <DatabaseGate>
      <App />
    </DatabaseGate>
  </StrictMode>,
);
