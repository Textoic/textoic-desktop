import { useCallback, useEffect, useRef, useState } from "react";

export const useAsync = <T>(load: () => Promise<T>, deps: unknown[]) => {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    generation.current += 1;
    const mine = generation.current;
    setLoading(true);
    try {
      const result = await load();
      if (mine === generation.current) {
        setValue(result);
        setError(null);
      }
    } catch (cause) {
      if (mine === generation.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (mine === generation.current) {
        setLoading(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { value, error, loading, refresh, setValue };
};

export const useDebounced = (callback: () => void, delayMs: number, deps: unknown[]) => {
  const saved = useRef(callback);
  saved.current = callback;
  useEffect(() => {
    const timer = window.setTimeout(() => saved.current(), delayMs);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
};
