import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { PreviewPlayerProvider } from './lib/preview-player.jsx';
import './fonts.css';
import './styles.css';
import './workspaces.css';
import './typography.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <PreviewPlayerProvider>
      <App />
    </PreviewPlayerProvider>
  </React.StrictMode>
);
