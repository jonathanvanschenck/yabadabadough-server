import { useLocation, useNavigate } from 'react-router';
import { useEffect, useCallback, useMemo, useRef } from 'react';

export function useUrlFragment({ onFragmentChange } = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  const fragmentRef = useRef(null);
  
  // Memo NOT state, so that only changes to location.hash trigger updates, and the trigger is
  //  synced with the URL change itself, not delayed by state updates.
  // Additionally, keep a ref to the current fragment for use in callbacks/effects
  // without having to add it to dependency arrays
  const fragment = useMemo(() => {
    fragmentRef.current = location.hash.slice(1);
    return fragmentRef.current;
  }, [location.hash]);

  // Provide a callback when the fragment changes
  useEffect(() => {
    onFragmentChange?.(fragment);
  }, [fragment, onFragmentChange]);

  const clearFragment = useCallback(({ replace=true } = {}) => {
    const url = `${location.pathname}${location.search}`;
    navigate(url, { replace });
  }, [location.pathname, location.search, navigate]);

  const setFragment = useCallback((newFragment, { replace=true } = {}) => {
    if (!newFragment || typeof newFragment !== 'string') {
      clearFragment({ replace });
      return;
    }

    const cleanFragment = newFragment.startsWith('#') ? newFragment.slice(1) : newFragment;
    const url = `${location.pathname}${location.search}#${cleanFragment}`;
    navigate(url, { replace });
  }, [location.pathname, location.search, navigate, clearFragment]);

  return {
    fragment,
    fragmentRef,
    setFragment,
    clearFragment
  };
}