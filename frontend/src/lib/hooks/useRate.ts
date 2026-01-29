import { useQuery } from '@tanstack/react-query';

type RateResponse = {
  cardano?: {
    usd?: number;
  };
};

const fetchRate = async (): Promise<number> => {
  const response = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=cardano&vs_currencies=usd',
  );

  if (!response.ok) {
    throw new Error('Failed to fetch rate');
  }

  const data: RateResponse = await response.json();
  const usdRate = data.cardano?.usd;

  if (typeof usdRate !== 'number') {
    throw new Error('Invalid rate data');
  }

  return usdRate;
};

export function useRate() {
  const { data, error, isPending, isFetching, refetch } = useQuery<number>({
    queryKey: ['ada-usd-rate'],
    queryFn: fetchRate,
    refetchInterval: 5 * 60 * 1000,
    refetchIntervalInBackground: true,
    staleTime: 5 * 60 * 1000,
  });

  return {
    rate: data ?? null,
    isLoading: isPending || (!data && isFetching),
    error: error ? (error instanceof Error ? error.message : 'Failed to fetch rate') : null,
    refetch,
  };
}
