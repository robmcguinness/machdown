import type { ClipResponse, ClipResult, ClipSettings } from '../types/clip';
import { useCallback, useEffect, useState } from 'react';
import type { AppSettings } from '@common/appTypes';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { buildFilename, generateMarkdown } from '@lib/markdown';
import { zipSync, strToU8 } from 'fflate';
import { useSharedSettings } from '@common/useSharedSettings';

type TabEntry = {
  id: number;
  title: string;
  url: string;
  favIconUrl?: string;
  selected: boolean;
  clippable: boolean;
};

type ExportState =
  | { phase: 'idle' }
  | { phase: 'clipping'; current: number; total: number; errors: string[] }
  | { phase: 'done'; errors: string[] };

const NON_CLIPPABLE = /^(chrome|chrome-extension|chrome-untrusted|edge|brave|vivaldi|opera|about|devtools|file):|^https?:\/\/chrome\.google\.com\/webstore/;

const toClipSettings = (s: AppSettings): ClipSettings => ({
  headingStyle: s.headingStyle,
  bulletListMarker: s.bulletListMarker,
  linkStyle: s.linkStyle,
  codeBlockStyle: s.codeBlockStyle,
  fence: s.fence,
  hr: s.hr,
  includeImages: s.includeImages,
});

const clipTab = async (tabId: number, clipSettings: ClipSettings): Promise<ClipResult> => {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['clipper.js'],
  });

  const response = await chrome.tabs.sendMessage<{ type: string; settings?: ClipSettings }, ClipResponse>(tabId, {
    type: 'clip:extract',
    settings: clipSettings,
  });

  if (response.type === 'clip:result') {
    return response.payload;
  }
  throw new Error(response.error);
};

export const TabsPage = () => {
  const [tabs, setTabs] = useState<TabEntry[]>([]);
  const [exportState, setExportState] = useState<ExportState>({ phase: 'idle' });
  const { settings } = useSharedSettings();

  useEffect(() => {
    const selfUrl = chrome.runtime.getURL('src/tabs/index.html');
    chrome.tabs.query({}).then((chromeTabs) => {
      setTabs(
        chromeTabs
          .filter(
            (t): t is chrome.tabs.Tab & { id: number; url: string } =>
              !!t.id && !!t.url && !t.url.startsWith(selfUrl),
          )
          .map((t) => ({
            id: t.id,
            title: t.title || t.url,
            url: t.url,
            favIconUrl: t.favIconUrl,
            selected: !NON_CLIPPABLE.test(t.url),
            clippable: !NON_CLIPPABLE.test(t.url),
          })),
      );
    });
  }, []);

  const selectedCount = tabs.filter((t) => t.selected).length;
  const clippableCount = tabs.filter((t) => t.clippable).length;
  const allSelected = selectedCount === clippableCount && clippableCount > 0;

  const toggleAll = useCallback(() => {
    setTabs((prev) =>
      prev.map((t) => (t.clippable ? { ...t, selected: !allSelected } : t)),
    );
  }, [allSelected]);

  const toggleTab = useCallback((id: number) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === id && t.clippable ? { ...t, selected: !t.selected } : t)),
    );
  }, []);

  const handleExport = useCallback(async () => {
    const selected = tabs.filter((t) => t.selected);
    if (selected.length === 0) return;

    const hasPermission = await chrome.permissions.contains({ origins: ['<all_urls>'] });
    if (!hasPermission) {
      const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
      if (!granted) {
        setExportState({
          phase: 'done',
          errors: ['Host permission denied. Please allow access to clip these tabs.'],
        });
        return;
      }
    }

    const clipSettings = toClipSettings(settings);
    const errors: string[] = [];
    const files: Record<string, Uint8Array> = {};
    const usedNames = new Set<string>();

    setExportState({ phase: 'clipping', current: 0, total: selected.length, errors: [] });

    for (let i = 0; i < selected.length; i++) {
      const tab = selected[i];
      setExportState({ phase: 'clipping', current: i + 1, total: selected.length, errors: [...errors] });

      try {
        const clip = await clipTab(tab.id, clipSettings);
        let name = buildFilename(clip, settings.filenamePattern);
        if (usedNames.has(name)) {
          name = `${name}-${tab.id}`;
        }
        usedNames.add(name);
        files[`${name}.md`] = strToU8(generateMarkdown(clip));
      } catch (err) {
        const msg = `${tab.title}: ${err instanceof Error ? err.message : 'Failed to clip'}`;
        errors.push(msg);
      }
    }

    if (Object.keys(files).length > 0) {
      const zipped = zipSync(files);
      const blob = new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const date = new Date().toISOString().slice(0, 10);

      chrome.downloads.download({ url, filename: `tabs-${date}.zip`, saveAs: true }, () => {
        URL.revokeObjectURL(url);
      });
    }

    setExportState({ phase: 'done', errors });
  }, [tabs, settings]);

  const isExporting = exportState.phase === 'clipping';

  return (
    <div className='min-h-screen bg-background p-8'>
      <div className='mx-auto max-w-2xl space-y-6'>
        <div>
          <h1 className='text-2xl font-semibold'>Save Multiple Clips</h1>
          <p className='text-sm text-muted-foreground mt-1'>
            Select tabs to clip as markdown. They will be exported as a ZIP file.
          </p>
        </div>

        <Card>
          <CardHeader>
            <div className='flex items-center justify-between'>
              <CardTitle>{tabs.length} tabs open</CardTitle>
              <Button variant='ghost' size='sm' onClick={toggleAll} disabled={isExporting}>
                {allSelected ? 'Deselect all' : 'Select all'}
              </Button>
            </div>
          </CardHeader>

          <CardContent>
            <ul className='divide-y divide-border'>
              {tabs.map((tab) => (
                <li key={tab.id}>
                  <label
                    className={`flex items-center gap-3 py-2.5 px-1 rounded-md cursor-pointer transition-colors hover:bg-muted/50 ${
                      !tab.clippable ? 'opacity-40 cursor-not-allowed' : ''
                    }`}
                  >
                    <input
                      type='checkbox'
                      checked={tab.selected}
                      disabled={!tab.clippable || isExporting}
                      onChange={() => toggleTab(tab.id)}
                      className='size-4 rounded border-border accent-primary shrink-0'
                    />
                    {tab.favIconUrl && (
                      <img
                        src={tab.favIconUrl}
                        alt=''
                        className='size-4 shrink-0 rounded-sm'
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                        }}
                      />
                    )}
                    <div className='min-w-0 flex-1'>
                      <span className='block text-sm truncate'>{tab.title}</span>
                      <span className='block text-xs text-muted-foreground truncate'>
                        {tab.url}
                      </span>
                    </div>
                  </label>
                </li>
              ))}
            </ul>
          </CardContent>

          <CardFooter>
            <div className='flex items-center justify-between w-full'>
              <span className='text-sm text-muted-foreground'>
                {selectedCount} of {clippableCount} selected
              </span>
              <Button
                onClick={handleExport}
                disabled={selectedCount === 0 || isExporting}
              >
                {isExporting
                  ? `Clipping ${exportState.current}/${exportState.total}...`
                  : 'Export ZIP'}
              </Button>
            </div>
          </CardFooter>
        </Card>

        {exportState.phase === 'done' && exportState.errors.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className='text-destructive text-sm'>
                {exportState.errors.length} tab{exportState.errors.length > 1 ? 's' : ''} failed to clip
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className='space-y-1'>
                {exportState.errors.map((err) => (
                  <li key={err} className='text-xs text-muted-foreground'>
                    {err}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {exportState.phase === 'done' && exportState.errors.length === 0 && (
          <p className='text-sm text-muted-foreground text-center'>
            Export complete. You can close this tab.
          </p>
        )}
      </div>
    </div>
  );
};
