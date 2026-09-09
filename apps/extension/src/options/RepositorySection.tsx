import { type AppSettings, type SaveTarget } from '#common/appTypes.ts';
import { Alert, AlertDescription, AlertTitle } from '#components/ui/alert.tsx';
import { Card, CardContent } from '#components/ui/card.tsx';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '#components/ui/field.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select.tsx';
import { describeFailure, toDaemonFailure } from '#common/daemonClient.ts';
import { validateCategory } from '#common/categories.ts';
import { configSeedFromSettings } from '#common/configSeed.ts';
import { clearPairing, getExtensionId, savePairing } from '#common/daemonStorage.ts';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '#components/ui/badge.tsx';
import { Button } from '#components/ui/button.tsx';
import { DirectoryPicker } from '#components/DirectoryPicker.tsx';
import { FolderOpen } from 'lucide-react';
import { Input } from '#components/ui/input.tsx';
import { Separator } from '#components/ui/separator.tsx';
import { Switch } from '#components/ui/switch.tsx';
import { TriangleAlert } from 'lucide-react';
import { X } from 'lucide-react';
import { cn } from '#lib/utils.ts';
import { toast } from 'sonner';
import { isOneOf } from '#lib/select.ts';

const SAVE_TARGETS = ['auto', 'repo', 'download'] as const satisfies readonly SaveTarget[];
import type { UseDaemonStatus } from '#common/useDaemonStatus.ts';
import { asHandler } from '#lib/async.ts';

type RepositorySectionProps = {
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  /**
   * Passed in rather than polled here: the status badge now lives beside the
   * options tab list, and a second `useDaemonStatus()` would give it a separate
   * poller that `refresh()` below could not reach.
   */
  daemon: UseDaemonStatus;
};

type Busy = { kind: 'pairing' | 'init' | 'categories' | 'sync' | 'embed' } | null;

/** How long an armed remove button waits for its confirming second click. */
const REMOVE_CONFIRM_MS = 4000;

export const RepositorySection = ({ daemon, settings, updateSettings }: RepositorySectionProps) => {
  const { client, refresh, status } = daemon;
  const [pairingCode, setPairingCode] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [adopt, setAdopt] = useState(true);
  const [browsing, setBrowsing] = useState(false);
  const [newCategory, setNewCategory] = useState('');
  const [editing, setEditing] = useState<{ draft: string; original: string } | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  // Validation is anchored to the category field rather than toasted, because
  // the message names the value still sitting in the input next to it.
  const [categoryError, setCategoryError] = useState<string | null>(null);

  const paired = status.state === 'ready';
  const repo = status.state === 'ready' ? status.health.repo : null;

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

  const handlePair = () =>
    run('pairing', async () => {
      const { token } = await client.pair({
        code: pairingCode.trim().toUpperCase(),
        extensionId: getExtensionId(),
        label: 'Machdown extension',
      });
      await savePairing({
        baseUrl: settings.daemonBaseUrl,
        extensionId: getExtensionId(),
        pairedAt: new Date().toISOString(),
        token,
      });
      setPairingCode('');
      return 'Paired with the daemon.';
    });

  /**
   * Drops this browser's token only; the daemon keeps its own record. Pairing
   * again needs a fresh code, which is the point — the token is the credential.
   */
  const handleUnpair = () =>
    run('pairing', async () => {
      await clearPairing();
      return 'Unpaired. Enter a new code to pair again.';
    });

  const handleInit = () =>
    run('init', async () => {
      // Always send the seed: the daemon ignores it when a config file exists,
      // keeping the repository authoritative (D4).
      const result = await client.repo.init({
        adoptFlatClips: adopt,
        config: configSeedFromSettings(settings),
        path: repoPath.trim(),
      });

      const parts: string[] = ['Repository ready.'];
      // Informational only (Q3): the seed is saved in the init commit, so no
      // follow-up config update is needed or can race the status poll.
      if (result.configCreated) {
        parts.push(
          `Saved your ${settings.categories.length} ${
            settings.categories.length === 1 ? 'category' : 'categories'
          } into the new repository.`,
        );
      }
      if (result.migrated > 0) {
        parts.push(`Adopted ${result.migrated} existing clip${result.migrated === 1 ? '' : 's'}.`);
      }
      if (result.layout) {
        parts.push(
          `Moved ${result.layout.flattened} file${
            result.layout.flattened === 1 ? '' : 's'
          } into one folder.`,
        );
        // Flattening can force a rename when two categories held the same
        // title; saying so beats letting a file quietly become "foo-2.md".
        if (result.layout.renamed.length > 0) {
          parts.push(
            `${result.layout.renamed.length} file${
              result.layout.renamed.length === 1 ? ' was' : 's were'
            } renamed to avoid a name clash.`,
          );
        }
      }
      return parts.join(' ');
    });

  const handleEmbed = () =>
    run('embed', async () => {
      const result = await client.index.update({ embed: true });
      return `Embedded ${result.embedded} document${result.embedded === 1 ? '' : 's'}.`;
    });

  const setSuggestCategories = (value: boolean) =>
    run('categories', async () => {
      const config = await client.config.update({ suggestCategories: value });
      updateSettings({ suggestCategories: config.suggestCategories });
      return value ? 'Category suggestions on.' : 'Category suggestions off.';
    });

  /**
   * Category edits go to the repository first, then into the local cache. The
   * repo is authoritative (D4), so a failed write must not leave the extension
   * showing a list the repository does not have.
   */
  const commitCategories = (
    categories: string[],
    defaultCategory?: string,
    rename?: { from: string; to: string },
  ) =>
    run('categories', async () => {
      const config = await client.config.update({ categories, defaultCategory });
      updateSettings({
        categories: config.categories,
        defaultCategory: config.defaultCategory,
        // A stale entry here would have the popup pre-select a category the
        // repository no longer knows about. Unchanged when there is no rename.
        lastUsedCategories: rename
          ? settings.lastUsedCategories.map((entry) => (entry === rename.from ? rename.to : entry))
          : settings.lastUsedCategories,
      });
      setPendingRemoval(null);
      setCategoryError(null);
      return 'Categories updated.';
    });

  const addCategory = () => {
    const value = newCategory.trim();
    if (!value) {
      return;
    }

    const error = validateCategory(value, settings.categories);
    if (error) {
      setCategoryError(error);
      return;
    }

    setNewCategory('');
    setCategoryError(null);
    void commitCategories([...settings.categories, value]);
  };

  const renameCategory = (original: string, next: string) => {
    const value = next.trim();
    setEditing(null);
    if (!value || value === original) {
      return;
    }

    const error = validateCategory(value, settings.categories, original);
    if (error) {
      // A rename commits on blur, so the input this refers to is already gone.
      // A toast is the only place left to say why nothing happened.
      toast.error(error);
      return;
    }

    // Map rather than filter-and-append: order decides the picker layout and
    // the section order of the generated README.
    void commitCategories(
      settings.categories.map((entry) => (entry === original ? value : entry)),
      settings.defaultCategory === original ? value : settings.defaultCategory,
      { from: original, to: value },
    );
  };

  const removeCategory = (category: string) => {
    const next = settings.categories.filter((entry) => entry !== category);
    if (next.length === 0) {
      return;
    }
    void commitCategories(
      next,
      category === settings.defaultCategory ? next[0] : settings.defaultCategory,
    );
  };

  // Stable so the ref only fires on mount; an inline callback would re-select
  // the text on every keystroke.
  const focusRenameInput = useCallback((node: HTMLInputElement | null) => {
    node?.select();
  }, []);

  // An armed remove button should not stay armed indefinitely: a stray click
  // minutes later must not be the one that deletes a category.
  useEffect(() => {
    if (!pendingRemoval) {
      return;
    }

    const timer = setTimeout(() => setPendingRemoval(null), REMOVE_CONFIRM_MS);
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPendingRemoval(null);
      }
    };

    window.addEventListener('keydown', onEscape);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', onEscape);
    };
  }, [pendingRemoval]);

  const handleSync = () =>
    run('sync', async () => {
      const result = await client.git.sync({ push: true });
      return result.pushed ? 'Pushed to the remote.' : 'Nothing to push (no remote configured).';
    });

  return (
    <>
      <Card>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor='daemon-url'>Daemon address</FieldLabel>
              <Input
                id='daemon-url'
                placeholder='http://127.0.0.1:41998'
                value={settings.daemonBaseUrl}
                onChange={(event) => updateSettings({ daemonBaseUrl: event.target.value })}
              />
              <FieldDescription>
                Start it with <code>pnpm daemon</code>. It listens on loopback only.
              </FieldDescription>
            </Field>

            {!paired && (
              <>
                <Separator />
                <Field>
                  <FieldLabel htmlFor='pairing-code'>Pairing code</FieldLabel>
                  <div className='flex gap-2'>
                    <Input
                      autoComplete='off'
                      id='pairing-code'
                      placeholder='ABCD-2345'
                      spellCheck={false}
                      value={pairingCode}
                      onChange={(event) => setPairingCode(event.target.value)}
                    />
                    {/*
                     * Deliberately not gated on the health poll: a daemon on a
                     * different port than the address above reads as offline, and
                     * gating here would leave the button permanently disabled with
                     * no way to find out why. Let the attempt run and report.
                     */}
                    <Button
                      disabled={pairingCode.trim().length < 4 || busy !== null}
                      onClick={asHandler(handlePair)}
                    >
                      {busy?.kind === 'pairing' ? 'Pairing…' : 'Pair'}
                    </Button>
                  </div>
                  <FieldDescription>
                    The daemon prints a code when it starts. It expires after ten minutes and works
                    once. Run <code>pnpm daemon</code> again to print a fresh one.
                  </FieldDescription>
                </Field>

                {/*
                 * Persistent, not a toast: this is the standing state of the
                 * daemon address above, and it stays wrong until it is fixed.
                 */}
                {status.state === 'offline' && (
                  <Alert variant='destructive'>
                    <TriangleAlert />
                    <AlertTitle>Nothing is answering at {settings.daemonBaseUrl}</AlertTitle>
                    <AlertDescription>
                      Check the address above against the one the daemon printed on start.
                    </AlertDescription>
                  </Alert>
                )}
              </>
            )}

            {paired && (
              <>
                <Separator />
                <Field orientation='horizontal'>
                  <FieldContent>
                    <FieldLabel>Pairing</FieldLabel>
                    <FieldDescription>
                      This browser holds a token for the daemon. Unpair to enter a new code.
                    </FieldDescription>
                  </FieldContent>
                  <Button
                    disabled={busy !== null}
                    variant='outline'
                    onClick={asHandler(handleUnpair)}
                  >
                    Unpair
                  </Button>
                </Field>

                <Separator />
                <Field>
                  <FieldLabel htmlFor='repo-path'>Clip repository</FieldLabel>
                  {repo ? (
                    <p className='text-sm'>
                      <code>{repo.path}</code>
                      <span className='ml-2 text-xs text-muted-foreground'>
                        on {repo.branch}
                        {repo.dirty ? ' · uncommitted changes' : ''}
                        {repo.hasRemote ? ' · has remote' : ' · no remote'}
                      </span>
                    </p>
                  ) : (
                    <FieldDescription>
                      No repository yet. Point the daemon at a folder to create or adopt one.
                    </FieldDescription>
                  )}
                  <div className='flex gap-2'>
                    <Input
                      id='repo-path'
                      value={repoPath}
                      onChange={(event) => setRepoPath(event.target.value)}
                    />
                    <Button
                      disabled={busy !== null}
                      variant='outline'
                      onClick={() => setBrowsing(true)}
                    >
                      <FolderOpen aria-hidden />
                      Browse…
                    </Button>
                    <Button
                      disabled={repoPath.trim().length === 0 || busy !== null}
                      variant={repo ? 'outline' : 'default'}
                      onClick={asHandler(handleInit)}
                    >
                      {busy?.kind === 'init' ? 'Working…' : repo ? 'Change' : 'Initialize'}
                    </Button>
                  </div>
                  <DirectoryPicker
                    client={client}
                    initialPath={repoPath.trim() || repo?.path}
                    open={browsing}
                    onOpenChange={setBrowsing}
                    onSelect={setRepoPath}
                  />
                </Field>

                <Field orientation='horizontal'>
                  <FieldContent>
                    <FieldLabel>Adopt existing markdown files</FieldLabel>
                    <FieldDescription>
                      Move loose <code>.md</code> files in that folder into <code>clips/</code>.
                    </FieldDescription>
                  </FieldContent>
                  <Switch checked={adopt} onCheckedChange={setAdopt} />
                </Field>
              </>
            )}

            {repo && (
              <>
                <Separator />
                <Field orientation='horizontal'>
                  <FieldContent>
                    <FieldLabel>Push to remote</FieldLabel>
                    <FieldDescription>
                      Clips commit automatically. Pushing stays manual.
                    </FieldDescription>
                  </FieldContent>
                  <Button
                    disabled={busy !== null}
                    variant='outline'
                    onClick={asHandler(handleSync)}
                  >
                    {busy?.kind === 'sync' ? 'Syncing…' : 'Sync now'}
                  </Button>
                </Field>
              </>
            )}
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel>Categories</FieldLabel>
              <FieldDescription>
                Stored in the repository, so they travel with a clone.
                {!repo && ' Connect a repository to edit them.'}
              </FieldDescription>
            </Field>

            <Alert variant='destructive'>
              <TriangleAlert />
              <AlertTitle>Editing this list does not re-file existing clips</AlertTitle>
              <AlertDescription>
                Renaming or removing a category changes this list, not the files already saved.
                Those keep the old name in their frontmatter, and it keeps its heading in the
                generated README until you re-file them.
              </AlertDescription>
            </Alert>

            <div className='flex flex-wrap items-center gap-1.5'>
              {settings.categories.map((category) => {
                if (editing?.original === category) {
                  return (
                    <Input
                      aria-label={`Rename ${category}`}
                      className='h-7 w-40 px-2 py-0 text-xs'
                      key={category}
                      ref={focusRenameInput}
                      value={editing.draft}
                      onBlur={() => renameCategory(category, editing.draft)}
                      onChange={(event) =>
                        setEditing({ draft: event.target.value, original: category })
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          renameCategory(category, editing.draft);
                        }
                        if (event.key === 'Escape') {
                          setEditing(null);
                        }
                      }}
                    />
                  );
                }

                // Read-only: without a repository there is nothing to click, so
                // a plain badge is the honest thing to render.
                if (!repo) {
                  return (
                    <Badge
                      className='h-7 font-normal'
                      key={category}
                      variant={category === settings.defaultCategory ? 'default' : 'outline'}
                    >
                      {category}
                    </Badge>
                  );
                }

                const armed = pendingRemoval === category;
                const isDefault = category === settings.defaultCategory;

                // Two sibling buttons in a bordered row rather than buttons
                // nested inside a Badge: a badge is not a button, and nesting
                // interactive elements inside one made the two hit targets
                // fight over the same click.
                return (
                  <div
                    className={cn(
                      'inline-flex items-center rounded-lg border',
                      armed
                        ? 'border-destructive/40 bg-destructive/10'
                        : isDefault
                          ? 'border-primary/40 bg-primary/5'
                          : 'border-border',
                    )}
                    key={category}
                  >
                    <Button
                      title={
                        isDefault
                          ? 'Default category for new clips — click to rename'
                          : 'Click to rename'
                      }
                      className='font-normal'
                      size='sm'
                      variant='ghost'
                      onClick={() => {
                        setPendingRemoval(null);
                        setEditing({ draft: category, original: category });
                      }}
                    >
                      {category}
                    </Button>
                    {settings.categories.length > 1 && (
                      <Button
                        aria-label={armed ? `Confirm removal of ${category}` : `Remove ${category}`}
                        className={cn('size-7', armed && 'w-auto px-2 text-destructive')}
                        size={armed ? 'sm' : 'icon-sm'}
                        variant='ghost'
                        onClick={() =>
                          armed ? removeCategory(category) : setPendingRemoval(category)
                        }
                      >
                        {armed ? 'Remove?' : <X aria-hidden />}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>

            <Field data-invalid={categoryError !== null}>
              <div className='flex gap-2'>
                <Input
                  aria-invalid={categoryError !== null}
                  disabled={!repo || busy !== null}
                  placeholder='Add a category, e.g. Observability'
                  value={newCategory}
                  onChange={(event) => {
                    setNewCategory(event.target.value);
                    setCategoryError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      addCategory();
                    }
                  }}
                />
                <Button
                  disabled={!repo || newCategory.trim().length === 0 || busy !== null}
                  variant='outline'
                  onClick={addCategory}
                >
                  Add
                </Button>
              </div>
              {categoryError && <FieldError>{categoryError}</FieldError>}
            </Field>

            <Field>
              <FieldLabel htmlFor='default-category'>Default category</FieldLabel>
              <Select
                value={settings.defaultCategory}
                onValueChange={(value) => {
                  if (value) {
                    void commitCategories(settings.categories, value);
                  }
                }}
              >
                <SelectTrigger className='w-full' disabled={!repo} id='default-category'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {settings.categories.map((category) => (
                    <SelectItem key={category} value={category}>
                      {category}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <FieldGroup>
            <Field orientation='horizontal'>
              <FieldContent>
                <FieldLabel>Suggest categories</FieldLabel>
                <FieldDescription>
                  Recommends where a page belongs by comparing it to what you have already saved.
                  Suggestions are only ever a starting point.
                </FieldDescription>
              </FieldContent>
              <Switch
                checked={settings.suggestCategories}
                disabled={!repo || busy !== null}
                onCheckedChange={(value) => void setSuggestCategories(value)}
              />
            </Field>

            <Separator />

            <Field orientation='horizontal'>
              <FieldContent>
                <FieldLabel>Semantic matching</FieldLabel>
                <FieldDescription>
                  Without embeddings, suggestions fall back to keyword search and the sites you
                  usually file together. Building them runs a local model and can take a few
                  minutes.
                </FieldDescription>
              </FieldContent>
              <Button
                disabled={!repo || busy !== null}
                variant='outline'
                onClick={asHandler(handleEmbed)}
              >
                {busy?.kind === 'embed' ? 'Building…' : 'Build embeddings'}
              </Button>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Field>
            <FieldLabel htmlFor='save-target'>Where to save clips</FieldLabel>
            <Select
              value={settings.saveTarget}
              onValueChange={(value) => {
                if (isOneOf(SAVE_TARGETS, value)) {
                  updateSettings({ saveTarget: value });
                }
              }}
            >
              <SelectTrigger className='w-full' id='save-target'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='auto'>Repository when available, otherwise download</SelectItem>
                <SelectItem value='repo'>Always the repository</SelectItem>
                <SelectItem value='download'>Always a browser download</SelectItem>
              </SelectContent>
            </Select>
            <FieldDescription>
              On <strong>auto</strong>, a stopped daemon silently falls back to the download dialog.
            </FieldDescription>
          </Field>
        </CardContent>
      </Card>
    </>
  );
};
