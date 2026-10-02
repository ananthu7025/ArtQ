import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AdminApi } from './api/client';
import { App } from './App';

const api = new AdminApi({ baseUrl: import.meta.env.VITE_API_URL ?? 'http://localhost:4000/v1' });
createRoot(document.getElementById('root')!).render(<StrictMode><App api={api} /></StrictMode>);
