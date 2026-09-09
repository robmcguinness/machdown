import { Card, CardContent } from '#components/ui/card.tsx';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '#components/ui/field.tsx';
import { describeFailure, toDaemonFailure } from '#common/daemonClient.ts';
import { Button } from '#components/ui/button.tsx';
import { DirectoryPicker } from '#components/DirectoryPicker.tsx';
import { FolderOpen } from 'lucide-react';
import { Input } from '#components/ui/input.tsx';
import type { UseDaemonStatus } from '#common/useDaemonStatus.ts';
import { asHandler } from '#lib/async.ts';
import { toast } from 'sonner';
import { useCallback, useState } from 'react';

type BookmarksSectionProps = {
  daemon: UseDaemonStatus;
};

/** Which action is in flight, named like `RepositorySection`'s own busy state. */
type Busy = { kind: 'location' } | null;

/**
 * Picks the folder that holds `bookmarks.md`.
 *
 * Separate from the repository card because the two are now independent:
 * bookmarks are appended to one plain markdown file, so this works with no
 * repository at all, and the card is shown as soon as the extension is paired.
 */
export const BookmarksSection = ({ daemon }: BookmarksSectionProps) => {
  const { client, refresh, status } = daemon;
  const [folder, setFolder] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);

  const current = status.state === 'ready' ? status.health.bookmarks.path : null;

  // The same shape as `RepositorySection`'s `run`: one busy flag, the success
  // sentence from the task itself, and a refreshed health poll afterwards.
  const run = useCallback(
    async (kind: NonNullable<Busy>['kind'], task: () => Promise<string>) => {
      setBusy({ kind });
      try {
        toast.success(await task());
        refresh();
      } catch (error) {
        toast.error(describeFailure(toDaemonFailure(error)));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const handleUseFolder = () =>
    run('location', async () => {
      const result = await client.bookmarks.setLocation({ path: folder.trim() });
      setFolder('');
      return `Bookmarks go to ${result.path}/bookmarks.md.`;
    });

  return (
    <Card>
      <CardContent>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor='bookmarks-path'>Bookmarks folder</FieldLabel>
            {current ? (
              <p className='text-sm'>
                <code>{current}</code>
                <span className='ml-2 text-xs text-muted-foreground'>
                  every bookmark is appended to bookmarks.md
                </span>
              </p>
            ) : (
              <FieldDescription>
                No folder yet. Bookmarks download as a file until you pick one.
              </FieldDescription>
            )}
            <div className='flex gap-2'>
              <Input
                id='bookmarks-path'
                value={folder}
                onChange={(event) => setFolder(event.target.value)}
              />
              <Button disabled={busy !== null} variant='outline' onClick={() => setBrowsing(true)}>
                <FolderOpen aria-hidden />
                Browse…
              </Button>
              <Button
                disabled={folder.trim().length === 0 || busy !== null}
                variant={current ? 'outline' : 'default'}
                onClick={asHandler(handleUseFolder)}
              >
                {busy?.kind === 'location' ? 'Working…' : 'Use folder'}
              </Button>
            </div>
            <DirectoryPicker
              client={client}
              initialPath={folder.trim() || current || undefined}
              open={browsing}
              onOpenChange={setBrowsing}
              onSelect={setFolder}
            />
          </Field>
        </FieldGroup>
      </CardContent>
    </Card>
  );
};
