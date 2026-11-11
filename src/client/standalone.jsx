import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { createApi } from './api.mjs';
const api = createApi();
createRoot(document.getElementById('root')).render(<App api={api} />);
