import { useState, useRef, useCallback } from "react";
import type { MutableRefObject } from "react";

type SetSyncedState<T> = (v: T | ((prev: T) => T)) => void;

/**
 * useState that also keeps a ref in sync, so keyboard handlers
 * (which capture stale closures in OpenTUI) always read the latest value.
 */
export function useSyncedState<T>(initial: T): [T, SetSyncedState<T>, MutableRefObject<T>] {
  const [state, setState] = useState(initial);
  const ref = useRef(initial);

  const setSynced: SetSyncedState<T> = useCallback((v: T | ((prev: T) => T)) => {
    setState((prev) => {
      const next = typeof v === "function" ? (v as (prev: T) => T)(prev) : v;
      ref.current = next;
      return next;
    });
  }, []);

  return [state, setSynced, ref];
}
