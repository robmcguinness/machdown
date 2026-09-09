/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AppSettings, DEFAULT_SETTINGS } from '../src/common/appTypes.ts';
import { configSeedFromSettings } from '../src/common/configSeed.ts';

for (const suggestCategories of [false, true]) {
  await test(`config seed picks only repository settings with suggestions ${suggestCategories}`, () => {
    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      categories: ['Research', 'Recipes'],
      daemonBaseUrl: 'http://127.0.0.1:42000',
      defaultCategory: 'Recipes',
      lastUsedCategories: ['Research'],
      saveTarget: 'download',
      suggestCategories,
      theme: 'dark',
    };
    const original = structuredClone(settings);

    assert.deepEqual(configSeedFromSettings(settings), {
      categories: ['Research', 'Recipes'],
      defaultCategory: 'Recipes',
      suggestCategories,
    });
    assert.deepEqual(settings, original);
  });
}
