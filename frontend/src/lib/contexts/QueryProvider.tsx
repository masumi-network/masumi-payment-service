import { QueryClientProvider } from '@tanstack/react-query';
import { getQueryClient } from '@/lib/queries/get-query-client';

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const queryClient = getQueryClient();

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
