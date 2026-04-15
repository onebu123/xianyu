import { useCallback, useEffect, useRef, useState } from 'react';

export function useRemoteData<T>(loader: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const dataRef = useRef<T | null>(null);

  const reload = useCallback(async (options?: { silent?: boolean }) => {
    const silent = Boolean(options?.silent && dataRef.current !== null);
    if (!silent) {
      setLoading(true);
    }
    setError(null);
    try {
      const payload = await loader();
      dataRef.current = payload;
      setData(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }, [loader]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  return { data, loading, error, reload };
}
