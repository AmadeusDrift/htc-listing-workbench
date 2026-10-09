import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { defaultAppearancePreferences } from '../shared/appearance-contracts';
import type { AppearancePreferences } from '../shared/appearance-contracts';
import { errorText } from './utils';

export function useAppearance() {
  const [preferences, setPreferences] = useState(defaultAppearancePreferences);
  const current = useRef(preferences);
  const pending = useRef(false);
  const lastAttempt = useRef<AppearancePreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  const resolvedTheme = preferences.theme === 'system' ? (systemDark ? 'dark' : 'light') : preferences.theme;

  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const changed = () => setSystemDark(media.matches);
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    let active = true;
    if (!window.red) { setLoading(false); return; }
    void window.red.getAppearance().then(value => {
      if (active) { current.current = value; setPreferences(value); }
    }).catch(cause => { if (active) setError(errorText(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    root.dataset.density = preferences.density;
    root.dataset.motion = preferences.motion;
  }, [resolvedTheme, preferences.density, preferences.motion]);
  const update = useCallback(async (patch: Partial<AppearancePreferences>) => {
    if (pending.current || !window.red) return;
    pending.current = true; setSaving(true); setError('');
    const attempted = { ...current.current, ...patch };
    lastAttempt.current = attempted;
    try {
      const saved = await window.red.saveAppearance(attempted);
      current.current = saved; lastAttempt.current = null; setPreferences(saved);
    } catch (cause) { setError(errorText(cause)); }
    finally { pending.current = false; setSaving(false); }
  }, []);
  const retry = useCallback(() => update(lastAttempt.current ?? {}), [update]);
  return { preferences, resolvedTheme, loading, saving, error, update, retry };
}
export type AppearanceController = ReturnType<typeof useAppearance>;
