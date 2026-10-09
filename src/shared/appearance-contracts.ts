export interface AppearancePreferences {
  theme: 'light' | 'dark' | 'system';
  density: 'comfortable' | 'compact';
  motion: 'full' | 'reduced';
}

export function defaultAppearancePreferences(): AppearancePreferences {
  return { theme: 'light', density: 'comfortable', motion: 'full' };
}

export interface AppearanceApi {
  getAppearance(): Promise<AppearancePreferences>;
  saveAppearance(input: AppearancePreferences): Promise<AppearancePreferences>;
}
