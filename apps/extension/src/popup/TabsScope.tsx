import { buildTabLinksMarkdown, downloadTabLinks } from '#lib/markdown.ts';
import {
  type ExtractedTabs,
  downloadClipsZip,
  ensureHostPermission,
  extractTabs,
  tabLinks,
  useTabSuggestions,
} from '#common/tabBatch.ts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { hostOf, toClipPayload } from '#common/clipTab.ts';
import { describeFailure, toDaemonFailure } from '#common/daemonClient.ts';
import { ActionFooter } from './ActionFooter.tsx';
import type { AppSettings } from '#common/appTypes.ts';
import { Button } from '#components/ui/button.tsx';
import { CategoryPicker } from '#components/CategoryPicker.tsx';
import { Checkbox } from '#components/ui/checkbox.tsx';
import type { ClipPayload } from '@machdown/contract';
import type { DaemonClient } from '#common/daemonClient.ts';
import { asHandler } from '#lib/async.ts';
import { plural } from '#lib/plural.ts';
import { toast } from 'sonner';
import { useActionShortcuts } from './useActionShortcuts.ts';
import { useActionState } from './useActionState.ts';
import { useClipSettings } from '#common/useClipSettings.ts';

/** A clippable tab of the current window, as the popup lists it. */
export type PopupTab = {
  favIconUrl?: string;
  id: number;
  title: string;
  url: string;
};

type TabsScopeProps = {
  canSaveBookmarks: boolean;
  canSaveToRepo: boolean;
  client: DaemonClient;
  /** Lets the parent lock the scope toggle: leaving mid-batch would drop the work. */
  onBusyChange: (busy: boolean) => void;
  onCreateCategory: (name: string) => void;
  setSettings: (patch: Partial<AppSettings>) => void;
  settings: AppSettings;
  tabs: readonly PopupTab[];
};

/**
 * The open tabs as a batch, with the same footer as the single page.
 *
 * Kept deliberately smaller than the full tabs page: one category set for the
 * batch, no per-tab overrides. The work runs inside the popup, so it is lost if
 * the popup closes mid-way; the "…" menu still offers the full page for that.
 */
export const TabsScope = ({
  canSaveBookmarks,
  canSaveToRepo,
  client,
  onBusyChange,
  onCreateCategory,
  setSettings,
  settings,
  tabs,
}: TabsScopeProps) => {
  const [deselected, setDeselected] = useState<ReadonlySet<number>>(new Set());
  const [categories, setCategories] = useState<string[] | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const { busy, fail, finish, start, statusOf } = useActionState();
  const clipSettings = useClipSettings(settings);

  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);

  const selected = useMemo(() => tabs.filter((tab) => !deselected.has(tab.id)), [tabs, deselected]);
  const allSelected = selected.length === tabs.length;

  const toggleTab = useCallback((id: number) => {
    setDeselected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setDeselected(allSelected ? new Set(tabs.map((tab) => tab.id)) : new Set());
  }, [allSelected, tabs]);

  const activeCategories = useMemo(
    () =>
      categories ??
      (settings.lastUsedCategories.length > 0
        ? settings.lastUsedCategories
        : [settings.defaultCategory]),
    [categories, settings.lastUsedCategories, settings.defaultCategory],
  );

  const { suggestedFor } = useTabSuggestions(
    client,
    tabs,
    canSaveToRepo && settings.suggestCategories,
  );

  /** What a tab is filed under: the daemon's suggestion, else the batch default. */
  const categoriesFor = useCallback(
    (tab: PopupTab): string[] => suggestedFor(tab.id) ?? activeCategories,
    [suggestedFor, activeCategories],
  );

  /**
   * The permission prompt may take focus from the popup; when that happens the
   * grant still lands, and the next click runs.
   */
  const ensurePermission = useCallback(() => ensureHostPermission(selected), [selected]);

  const extractSelected = useCallback(async (): Promise<ExtractedTabs<PopupTab>> => {
    const total = selected.length;
    setProgress(`Clipping 0/${total}…`);
    return extractTabs(selected, clipSettings, (completed) =>
      setProgress(`Clipping ${completed}/${total}…`),
    );
  }, [selected, clipSettings]);

  /** Partial failure still counts: the pages that worked are saved and reported. */
  const reportErrors = useCallback((errors: string[]) => {
    if (errors.length > 0) {
      toast.error(`${plural(errors.length, 'tab')} could not be clipped`, {
        description: errors[0],
      });
    }
  }, []);

  const handleSaveToRepo = useCallback(async () => {
    if (selected.length === 0 || !canSaveToRepo) {
      return;
    }
    start('repo');
    try {
      if (!(await ensurePermission())) {
        fail('Host permission is needed to clip these tabs');
        return;
      }
      const { clips, errors } = await extractSelected();
      if (clips.length === 0) {
        fail(errors[0] ?? 'No tab could be clipped');
        return;
      }

      // One batched request, one reviewable commit, rather than one per tab.
      const payloads: ClipPayload[] = clips.map(({ clip, tab }) =>
        toClipPayload(clip, categoriesFor(tab), settings.filenamePattern),
      );
      setProgress(`Saving ${payloads.length}…`);
      const saved = await client.clips.save({
        clips: payloads,
        commit: { message: `clip: ${plural(payloads.length, 'page')}` },
      });
      setSettings({ lastUsedCategories: activeCategories });

      for (const result of saved.results) {
        if (result.status === 'failed') {
          errors.push(`${result.url}: ${result.error ?? 'could not be saved'}`);
        }
      }
      reportErrors(errors);
      finish('repo', settings.autoClosePopup && errors.length === 0);
    } catch (error) {
      fail(describeFailure(toDaemonFailure(error)));
    } finally {
      setProgress(null);
    }
  }, [
    selected.length,
    canSaveToRepo,
    start,
    ensurePermission,
    fail,
    extractSelected,
    categoriesFor,
    settings.filenamePattern,
    settings.autoClosePopup,
    client,
    setSettings,
    activeCategories,
    reportErrors,
    finish,
  ]);

  /** Every selected page as markdown, in one ZIP in the downloads folder. */
  const handleDownload = useCallback(async () => {
    if (selected.length === 0) {
      return;
    }
    start('download');
    try {
      if (!(await ensurePermission())) {
        fail('Host permission is needed to clip these tabs');
        return;
      }
      const { clips, errors } = await extractSelected();
      if (clips.length === 0) {
        fail(errors[0] ?? 'No tab could be clipped');
        return;
      }

      setProgress('Compressing…');
      downloadClipsZip(clips, settings.filenamePattern);

      reportErrors(errors);
      finish('download', settings.autoClosePopup && errors.length === 0);
    } catch (error) {
      fail(error instanceof Error ? error.message : 'The ZIP could not be built');
    } finally {
      setProgress(null);
    }
  }, [
    selected.length,
    start,
    ensurePermission,
    fail,
    extractSelected,
    settings.filenamePattern,
    settings.autoClosePopup,
    reportErrors,
    finish,
  ]);

  const links = useMemo(() => tabLinks(selected), [selected]);

  /** Only the links: no extraction, no permission, one request whatever the count. */
  const handleBookmark = useCallback(async () => {
    if (links.length === 0) {
      return;
    }
    start('bookmark');
    if (!canSaveBookmarks) {
      try {
        await downloadTabLinks(links);
        finish('bookmark', settings.autoClosePopup);
      } catch (error) {
        fail(error instanceof Error ? error.message : 'Download could not be started');
      }
      return;
    }
    try {
      await client.bookmarks.append({ links });
      finish('bookmark', settings.autoClosePopup);
    } catch (error) {
      fail(describeFailure(toDaemonFailure(error)));
    }
  }, [links, start, canSaveBookmarks, finish, settings.autoClosePopup, fail, client]);

  const handleCopy = useCallback(async () => {
    if (links.length === 0) {
      return;
    }
    start('copy');
    try {
      await navigator.clipboard.writeText(buildTabLinksMarkdown(links));
      finish('copy', true);
    } catch {
      fail('The clipboard could not be written');
    }
  }, [links, start, finish, fail]);

  const none = selected.length === 0;
  const canSaveClip = !busy && !none && canSaveToRepo && activeCategories.length > 0;

  useActionShortcuts({
    onBookmark: busy || none ? null : asHandler(handleBookmark),
    onCopy: busy || none ? null : asHandler(handleCopy),
    onDownload: busy || none ? null : asHandler(handleDownload),
    onSave: canSaveClip ? asHandler(handleSaveToRepo) : null,
  });

  const n = selected.length;
  const saveTitle = canSaveToRepo
    ? activeCategories.length === 0
      ? 'Pick at least one category'
      : 'Extract every selected tab and save the batch in one commit'
    : 'Connect the daemon and pick a repository to save here';

  return (
    <>
      <div className='min-h-0 flex-1 overflow-y-auto'>
        <div className='flex items-center gap-2 border-t px-4 pt-2 pb-1'>
          <span className='font-heading text-xs tracking-wider text-muted-foreground uppercase'>
            {progress ?? `${n} of ${tabs.length} selected`}
          </span>
          <Button className='ml-auto' disabled={busy} size='xs' variant='ghost' onClick={toggleAll}>
            {allSelected ? 'Deselect all' : 'Select all'}
          </Button>
        </div>

        <ul className='m-0 flex list-none flex-col p-0 px-3 pb-1'>
          {tabs.map((tab) => (
            <li className='flex items-center gap-2.5 px-1 py-1.5 text-xs' key={tab.id}>
              <Checkbox
                aria-label={`Include ${tab.title}`}
                checked={!deselected.has(tab.id)}
                disabled={busy}
                onCheckedChange={() => toggleTab(tab.id)}
              />
              {tab.favIconUrl && (
                <img
                  alt=''
                  className='size-3.5 shrink-0'
                  src={tab.favIconUrl}
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                  }}
                />
              )}
              <span className='min-w-0 flex-1 truncate' title={tab.title}>
                {tab.title}
              </span>
              <span className='max-w-32 shrink-0 truncate font-heading text-muted-foreground'>
                {hostOf(tab.url) || tab.url}
              </span>
            </li>
          ))}
        </ul>

        {canSaveToRepo && (
          <div className='flex items-center gap-2 border-t px-4 py-2.5'>
            <span className='shrink-0 text-xs text-muted-foreground'>Categories</span>
            <CategoryPicker
              available={settings.categories}
              className='min-w-0 flex-1'
              disabled={busy}
              selected={activeCategories}
              onChange={setCategories}
              onCreate={onCreateCategory}
            />
          </div>
        )}
      </div>

      <ActionFooter
        bookmark={{
          disabled: busy || none,
          doneLabel: `${n} bookmarked`,
          onClick: asHandler(handleBookmark),
          status: statusOf('bookmark'),
          title: canSaveBookmarks
            ? `Add ${plural(n, 'link')} to bookmarks.md (⌘B)`
            : `Download ${plural(n, 'link')} as one markdown file (⌘B)`,
        }}
        copy={{
          disabled: busy || none,
          doneLabel: 'Copied',
          onClick: asHandler(handleCopy),
          status: statusOf('copy'),
          title: `Copy ${plural(n, 'link')} as markdown (⇧⌘C)`,
        }}
        download={{
          disabled: busy || none,
          doneLabel: `${n} files`,
          label: `Download · ${n}`,
          onClick: asHandler(handleDownload),
          status: statusOf('download'),
          title: `Extract every selected tab and download one ZIP (⌘D)`,
        }}
        save={{
          disabled: !canSaveClip,
          doneLabel: `${n} saved`,
          label: `KB · ${n}`,
          onClick: asHandler(handleSaveToRepo),
          status: statusOf('repo'),
          title: saveTitle,
        }}
      />
    </>
  );
};
