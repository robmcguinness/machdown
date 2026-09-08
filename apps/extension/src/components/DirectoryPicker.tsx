import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from '#components/ui/breadcrumb.tsx';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#components/ui/dialog.tsx';
import { Item, ItemActions, ItemContent, ItemMedia, ItemTitle } from '#components/ui/item.tsx';
import { ChevronRight, CornerLeftUp, Folder, FolderGit2, Search } from 'lucide-react';
import { type DaemonClient, describeFailure, toDaemonFailure } from '#common/daemonClient.ts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '#components/ui/button.tsx';
import type { DirectoryListResult } from '@machdown/contract';
import { Input } from '#components/ui/input.tsx';
import { Label } from '#components/ui/label.tsx';
import { ScrollArea } from '#components/ui/scroll-area.tsx';
import { Skeleton } from '#components/ui/skeleton.tsx';
import { cn } from '#lib/utils.ts';

type DirectoryPickerProps = {
  client: DaemonClient;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  /** Where to start browsing; falls back to the daemon's roots view. */
  initialPath?: string;
  onSelect: (path: string) => void;
};

/**
 * Browses the daemon's filesystem to pick a knowledge-base location.
 *
 * A Chrome extension page cannot produce a real path — `showDirectoryPicker()`
 * hands back an opaque handle the daemon has no way to resolve — so the daemon
 * lists directories and this renders them. It only ever shows folders, and only
 * under the roots the daemon allows.
 */
export const DirectoryPicker = ({
  client,
  initialPath,
  onOpenChange,
  onSelect,
  open,
}: DirectoryPickerProps) => {
  const [path, setPath] = useState(initialPath ?? '');
  const [listing, setListing] = useState<DirectoryListResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [newFolder, setNewFolder] = useState('');

  const browse = useCallback(
    async (target: string) => {
      setLoading(true);
      setErrorMessage(null);
      try {
        const result = await client.system.listDirectory({ path: target, showHidden: false });
        setListing(result);
        setPath(result.path);
        setFilter('');
      } catch (error) {
        setErrorMessage(describeFailure(toDaemonFailure(error)));
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    // `browse` raises the loading flag before it awaits, which the rule counts
    // as a synchronous setState in an effect. That is the point: the dialog has
    // to show a spinner the moment it opens. `browse` is shared with the
    // navigation handlers, where the same write is plainly correct, so the only
    // way to satisfy the rule is to rebuild the component around a request-key
    // state machine — a lot of risk to save one cheap render on open.
    // oxlint-disable-next-line react/set-state-in-effect
    void browse(initialPath ?? '');
  }, [open, initialPath, browse]);

  const entries = useMemo(() => {
    const all = listing?.entries ?? [];
    const needle = filter.trim().toLowerCase();
    return needle === '' ? all : all.filter((entry) => entry.name.toLowerCase().includes(needle));
  }, [listing, filter]);

  // Typing a folder name that does not exist yet is a legitimate way to create
  // one: `repo.init` does `mkdir -p`, so no extra endpoint is needed.
  const resolved = newFolder.trim() === '' ? path : `${path}/${newFolder.trim()}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>Choose a knowledge base folder</DialogTitle>
          <DialogDescription>
            Machdown will create or adopt a git repository here.
          </DialogDescription>
        </DialogHeader>

        {listing && listing.breadcrumbs.length > 0 && (
          <Breadcrumb>
            <BreadcrumbList className='text-xs'>
              {listing.breadcrumbs.map((crumb, index) => (
                <BreadcrumbItem key={crumb.path}>
                  <BreadcrumbLink
                    className='cursor-pointer'
                    onClick={() => {
                      void browse(crumb.path);
                    }}
                  >
                    {crumb.name}
                  </BreadcrumbLink>
                  {index < listing.breadcrumbs.length - 1 && (
                    <BreadcrumbSeparator>
                      <ChevronRight />
                    </BreadcrumbSeparator>
                  )}
                </BreadcrumbItem>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
        )}

        <div className='relative'>
          <Search
            aria-hidden
            className='pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground'
          />
          <Input
            aria-label='Filter folders'
            className='pl-8'
            placeholder='Filter folders…'
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
            }}
          />
        </div>

        <ScrollArea className='h-56 rounded-md border'>
          <div className='p-1'>
            {loading && (
              <div className='space-y-1 p-1'>
                <Skeleton className='h-7 w-full' />
                <Skeleton className='h-7 w-full' />
                <Skeleton className='h-7 w-2/3' />
              </div>
            )}

            {!loading && errorMessage && (
              <p className='p-3 text-sm text-destructive'>{errorMessage}</p>
            )}

            {!loading && !errorMessage && listing?.parent && (
              <Item
                render={
                  <button
                    aria-label='Up one level'
                    type='button'
                    onClick={() => {
                      void browse(listing.parent ?? '');
                    }}
                  />
                }
                className='text-left hover:bg-accent'
                size='xs'
              >
                <ItemMedia variant='icon'>
                  <CornerLeftUp aria-hidden className='text-muted-foreground' />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Up one level</ItemTitle>
                </ItemContent>
              </Item>
            )}

            {!loading &&
              !errorMessage &&
              entries.map((entry) => (
                <Item
                  className={cn(
                    'text-left hover:bg-accent',
                    !entry.readable && 'cursor-not-allowed opacity-50 hover:bg-transparent',
                  )}
                  render={
                    <button
                      aria-label={`Open ${entry.name}`}
                      disabled={!entry.readable}
                      type='button'
                      onClick={() => {
                        void browse(entry.path);
                      }}
                    />
                  }
                  key={entry.path}
                  size='xs'
                >
                  <ItemMedia variant='icon'>
                    {entry.isMachdownRepo || entry.isGitRepo ? (
                      <FolderGit2 aria-hidden className='text-muted-foreground' />
                    ) : (
                      <Folder aria-hidden className='text-muted-foreground' />
                    )}
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle className='truncate'>{entry.name}</ItemTitle>
                  </ItemContent>
                  {entry.isMachdownRepo && (
                    <ItemActions className='text-[10px] text-muted-foreground'>
                      machdown
                    </ItemActions>
                  )}
                  {!entry.readable && (
                    <ItemActions className='text-[10px] text-muted-foreground'>
                      no access
                    </ItemActions>
                  )}
                </Item>
              ))}

            {!loading && !errorMessage && entries.length === 0 && (
              <p className='p-3 text-sm text-muted-foreground'>
                {filter ? 'No folder matches that name.' : 'No subfolders here.'}
              </p>
            )}
          </div>
        </ScrollArea>

        {listing?.truncated && (
          <p className='text-[11px] text-muted-foreground'>
            Showing the first 500 folders — type to narrow the list.
          </p>
        )}

        {path !== '' && (
          <div className='space-y-1.5'>
            <Label className='text-xs' htmlFor='new-folder'>
              New folder (optional)
            </Label>
            <Input
              id='new-folder'
              placeholder='knowledge-base'
              value={newFolder}
              onChange={(event) => {
                setNewFolder(event.target.value);
              }}
            />
          </div>
        )}

        <p className='truncate font-mono text-xs text-muted-foreground'>{resolved || '—'}</p>

        <DialogFooter>
          <DialogClose render={<Button variant='outline'>Cancel</Button>} />
          <Button
            disabled={path === ''}
            onClick={() => {
              onSelect(resolved);
              onOpenChange(false);
            }}
          >
            Use this folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
