import type { RepoInitConfigSeed } from '@machdown/contract';
import type { AppSettings } from './appTypes.ts';

export const configSeedFromSettings = (settings: AppSettings): RepoInitConfigSeed => ({
  categories: settings.categories,
  defaultCategory: settings.defaultCategory,
  suggestCategories: settings.suggestCategories,
});
