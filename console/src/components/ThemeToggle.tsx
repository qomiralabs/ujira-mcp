// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { useEffect, useState } from 'react';

import { Icon, type IconName } from './ui';

type Theme = 'system' | 'light' | 'dark';
const THEME_KEY = 'ujira.console.theme';
const NEXT: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_LABEL: Record<Theme, string> = {
  system: 'Theme: follows your device',
  light: 'Theme: light',
  dark: 'Theme: dark',
};
const THEME_ICON: Record<Theme, IconName> = { system: 'auto', light: 'sun', dark: 'moon' };

function readTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** Cycles the theme: the device setting, light, dark. The choice is kept on this device. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try {
      if (theme === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Without storage the choice lasts for this visit only.
    }
  }, [theme]);
  return (
    <button
      type="button"
      className="btn-icon"
      onClick={() => {
        setTheme(NEXT[theme]);
      }}
      title={THEME_LABEL[theme]}
    >
      <Icon name={THEME_ICON[theme]} size={18} />
      <span className="sr-only">{THEME_LABEL[theme]}. Press to change.</span>
    </button>
  );
}
