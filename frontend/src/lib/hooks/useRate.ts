import { useState, useEffect } from 'react';

export function useRate() {
  const [rate, setRate] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRate = async () => {
    try {
      setIsLoading(true);
      setError(null);
      
      const response = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=cardano&vs_currencies=usd'
      );
      
      if (!response.ok) {
        throw new Error('Failed to fetch rate');
      }

      const data = await response.json();
      if (data.cardano?.usd) {
        setRate(data.cardano.usd);
      } else {
        throw new Error('Invalid rate data');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch rate');
      setRate(null);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchRate();
    const interval = setInterval(fetchRate, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  return {
    rate,
    isLoading,
    error,
    refetch: fetchRate
  };
} 