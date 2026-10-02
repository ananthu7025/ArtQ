import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { Toaster } from 'sonner';
import { ApiError, type AdminApi } from './api/client';
import { AuthProvider } from './auth/AuthProvider';
import { StepUpDialog } from './components/dialogs';
import { routes } from './router';

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      // 4xx answers are final; only network/5xx failures are worth one retry.
      queries: { retry: (n, e) => n < 1 && !(e instanceof ApiError && e.status >= 400 && e.status < 500), refetchOnWindowFocus: false, staleTime: 15_000 },
      mutations: { retry: false },
    },
  });
}

export function App({ api }: { api: AdminApi }) {
  const [queryClient] = useState(makeQueryClient);
  const [router] = useState(() => createBrowserRouter(routes));
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider api={api}>
        <RouterProvider router={router} />
        <StepUpDialog api={api} />
        <Toaster position="top-right" richColors closeButton />
      </AuthProvider>
    </QueryClientProvider>
  );
}
