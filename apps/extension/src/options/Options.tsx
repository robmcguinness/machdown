import { type AppSettings, DEFAULT_SETTINGS } from '#common/appTypes.ts';
import { Card, CardContent } from '#components/ui/card.tsx';
import {
  Field,
  FieldContent,
  FieldDescription,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#components/ui/tabs.tsx';
import { Button } from '#components/ui/button.tsx';
import { DaemonStatus } from '#components/DaemonStatus.tsx';
import { BookmarksSection } from '#components/BookmarksSection.tsx';
import { RepositorySection } from './RepositorySection';
import { Separator } from '#components/ui/separator.tsx';
import { Slider } from '#components/ui/slider.tsx';
import { Switch } from '#components/ui/switch.tsx';
import { toast } from 'sonner';
import { useCallback } from 'react';
import { useDaemonStatus } from '#common/useDaemonStatus.ts';
import { useSharedSettings } from '#common/useSharedSettings.ts';
import { isOneOf } from '#lib/select.ts';

const THEMES = ['system', 'light', 'dark'] as const satisfies readonly AppSettings['theme'][];
const HEADING_STYLES = ['atx', 'setext'] as const satisfies readonly AppSettings['headingStyle'][];
const BULLET_LIST_MARKERS = [
  '-',
  '*',
  '+',
] as const satisfies readonly AppSettings['bulletListMarker'][];
const LINK_STYLES = ['inline', 'reference'] as const satisfies readonly AppSettings['linkStyle'][];
const CODE_BLOCK_STYLES = [
  'fenced',
  'indented',
] as const satisfies readonly AppSettings['codeBlockStyle'][];
const FENCES = ['```', '~~~'] as const satisfies readonly AppSettings['fence'][];
const HR_STYLES = ['---', '***', '___'] as const satisfies readonly AppSettings['hr'][];
const FILENAME_PATTERNS = [
  '{slug}',
  '{date}-{slug}',
  '{site}-{slug}',
  '{date}-{site}-{slug}',
] as const satisfies readonly AppSettings['filenamePattern'][];

const isSingleSliderValue = (value: number | readonly number[]): value is number =>
  typeof value === 'number';

/**
 * Every setting saves on change, so the confirmation is the same every time.
 * A fixed id lets sonner replace the open toast instead of stacking one per
 * step of the UI-scale slider.
 */
const SAVED_TOAST_ID = 'settings-saved';

export const Options = () => {
  const { setSettings, settings } = useSharedSettings();
  // One poller for the whole page: the badge beside the tab list and the
  // repository panel have to agree, and `refresh()` after pairing must move
  // both.
  const daemon = useDaemonStatus();

  const updateSettings = useCallback(
    (patch: Partial<AppSettings>) => {
      setSettings(patch);
      toast.success('Saved', { id: SAVED_TOAST_ID });
    },
    [setSettings],
  );

  const resetSettings = () => {
    setSettings(DEFAULT_SETTINGS);
    toast.success('Reset to defaults', { id: SAVED_TOAST_ID });
  };

  return (
    <section className='min-h-screen p-6 font-sans bg-background text-foreground'>
      <div className='max-w-3xl mx-auto py-10'>
        <header className='mb-8'>
          <h1 className='font-heading text-lg font-medium'>Options</h1>
          <p className='text-muted-foreground mt-2 text-xs'>
            Configure how Machdown clips and formats your content.
          </p>
        </header>

        <Tabs defaultValue='repository'>
          {/*
           * The daemon badge sits beside the tab list rather than inside the
           * repository panel: "where will this clip go?" is the one answer that
           * stays relevant no matter which tab you are reading.
           */}
          <div className='flex items-center justify-between gap-3 mb-6'>
            <TabsList>
              <TabsTrigger value='repository'>Repository</TabsTrigger>
              <TabsTrigger value='appearance'>Appearance</TabsTrigger>
              <TabsTrigger value='formatting'>Formatting</TabsTrigger>
              <TabsTrigger value='behavior'>Behavior</TabsTrigger>
            </TabsList>
            <DaemonStatus status={daemon.status} />
          </div>

          <TabsContent className='space-y-6' value='repository'>
            <RepositorySection
              daemon={daemon}
              settings={settings}
              updateSettings={updateSettings}
            />
            {/* Below the repository card, but not part of it: a bookmarks
                folder is set independently and needs no repository. */}
            {daemon.status.state === 'ready' && <BookmarksSection daemon={daemon} />}
          </TabsContent>

          <TabsContent className='space-y-6' value='appearance'>
            <Card>
              <CardContent>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor='theme-select'>Theme</FieldLabel>
                    <Select
                      value={settings.theme}
                      onValueChange={(value) => {
                        if (isOneOf(THEMES, value)) {
                          updateSettings({ theme: value });
                        }
                      }}
                    >
                      <SelectTrigger className='w-full' id='theme-select'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value='system'>System</SelectItem>
                        <SelectItem value='light'>Light</SelectItem>
                        <SelectItem value='dark'>Dark</SelectItem>
                      </SelectContent>
                    </Select>
                    <FieldDescription>Follows your OS theme when set to system.</FieldDescription>
                  </Field>

                  <Separator />

                  <Field>
                    <FieldLabel>UI scale</FieldLabel>
                    <div className='flex items-center gap-4'>
                      <Slider
                        max={1.2}
                        min={0.85}
                        step={0.05}
                        value={[settings.scale]}
                        onValueChange={(next: number | readonly number[]) => {
                          // `Array.isArray` here widens `readonly number[]` to `any[]`
                          // under the type-aware linter, the same tradeoff documented
                          // in components/ui/slider.tsx — `isSingleSliderValue` keeps
                          // the typeof check behind a named guard instead.
                          const scale = isSingleSliderValue(next) ? next : next[0];
                          if (scale !== undefined) {
                            updateSettings({ scale });
                          }
                        }}
                      />
                      <span className='text-sm text-muted-foreground w-16 text-right'>
                        {Math.round(settings.scale * 100)}%
                      </span>
                    </div>
                  </Field>
                </FieldGroup>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent className='space-y-6' value='formatting'>
            <Card>
              <CardContent>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor='heading-style'>Heading style</FieldLabel>
                    <Select
                      value={settings.headingStyle}
                      onValueChange={(v) => {
                        if (isOneOf(HEADING_STYLES, v)) {
                          updateSettings({ headingStyle: v });
                        }
                      }}
                    >
                      <SelectTrigger className='w-full' id='heading-style'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value='atx'>ATX (# Heading)</SelectItem>
                        <SelectItem value='setext'>Setext (underline)</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>

                  <Field>
                    <FieldLabel htmlFor='bullet-marker'>Bullet list marker</FieldLabel>
                    <Select
                      value={settings.bulletListMarker}
                      onValueChange={(v) => {
                        if (isOneOf(BULLET_LIST_MARKERS, v)) {
                          updateSettings({ bulletListMarker: v });
                        }
                      }}
                    >
                      <SelectTrigger className='w-full' id='bullet-marker'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value='-'>Dash (-)</SelectItem>
                        <SelectItem value='*'>Asterisk (*)</SelectItem>
                        <SelectItem value='+'>Plus (+)</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>

                  <Field>
                    <FieldLabel htmlFor='link-style'>Link style</FieldLabel>
                    <Select
                      value={settings.linkStyle}
                      onValueChange={(v) => {
                        if (isOneOf(LINK_STYLES, v)) {
                          updateSettings({ linkStyle: v });
                        }
                      }}
                    >
                      <SelectTrigger className='w-full' id='link-style'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value='inline'>Inline [text](url)</SelectItem>
                        <SelectItem value='reference'>Reference [text][1]</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>

                  <Field>
                    <FieldLabel htmlFor='code-block-style'>Code block style</FieldLabel>
                    <Select
                      value={settings.codeBlockStyle}
                      onValueChange={(v) => {
                        if (isOneOf(CODE_BLOCK_STYLES, v)) {
                          updateSettings({ codeBlockStyle: v });
                        }
                      }}
                    >
                      <SelectTrigger className='w-full' id='code-block-style'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value='fenced'>Fenced (```)</SelectItem>
                        <SelectItem value='indented'>Indented (4 spaces)</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>

                  <Field>
                    <FieldLabel htmlFor='fence-char'>Fence character</FieldLabel>
                    <Select
                      value={settings.fence}
                      onValueChange={(v) => {
                        if (isOneOf(FENCES, v)) {
                          updateSettings({ fence: v });
                        }
                      }}
                    >
                      <SelectTrigger className='w-full' id='fence-char'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value='```'>Backticks (```)</SelectItem>
                        <SelectItem value='~~~'>Tildes (~~~)</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>

                  <Field>
                    <FieldLabel htmlFor='hr-style'>Horizontal rule</FieldLabel>
                    <Select
                      value={settings.hr}
                      onValueChange={(v) => {
                        if (isOneOf(HR_STYLES, v)) {
                          updateSettings({ hr: v });
                        }
                      }}
                    >
                      <SelectTrigger className='w-full' id='hr-style'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value='---'>Dashes (---)</SelectItem>
                        <SelectItem value='***'>Asterisks (***)</SelectItem>
                        <SelectItem value='___'>Underscores (___)</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </FieldGroup>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent className='space-y-6' value='behavior'>
            <Card>
              <CardContent>
                <FieldGroup>
                  <Field orientation='horizontal'>
                    <FieldContent>
                      <FieldLabel>Include images</FieldLabel>
                      <FieldDescription>
                        Keep image references in clipped markdown.
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      checked={settings.includeImages}
                      onCheckedChange={(v) => updateSettings({ includeImages: v })}
                    />
                  </Field>

                  <Separator />

                  <Field orientation='horizontal'>
                    <FieldContent>
                      <FieldLabel>Auto-copy to clipboard</FieldLabel>
                      <FieldDescription>
                        Automatically copy markdown when a page is clipped.
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      checked={settings.autoCopy}
                      onCheckedChange={(v) => updateSettings({ autoCopy: v })}
                    />
                  </Field>

                  <Separator />

                  <Field orientation='horizontal'>
                    <FieldContent>
                      <FieldLabel>Auto-close popup after save</FieldLabel>
                      <FieldDescription>
                        Close the popup window after saving a clip.
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      checked={settings.autoClosePopup}
                      onCheckedChange={(v) => updateSettings({ autoClosePopup: v })}
                    />
                  </Field>

                  <Separator />

                  <Field>
                    <FieldLabel htmlFor='filename-pattern'>Filename pattern</FieldLabel>
                    <Select
                      value={settings.filenamePattern}
                      onValueChange={(v) => {
                        if (isOneOf(FILENAME_PATTERNS, v)) {
                          updateSettings({ filenamePattern: v });
                        }
                      }}
                    >
                      <SelectTrigger className='w-full' id='filename-pattern'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value='{slug}'>Title only (my-article)</SelectItem>
                        <SelectItem value='{date}-{slug}'>
                          Date + title (2026-03-21-my-article)
                        </SelectItem>
                        <SelectItem value='{site}-{slug}'>
                          Site + title (example-com-my-article)
                        </SelectItem>
                        <SelectItem value='{date}-{site}-{slug}'>Date + site + title</SelectItem>
                      </SelectContent>
                    </Select>
                    <FieldDescription>Pattern for saved markdown filenames.</FieldDescription>
                  </Field>
                </FieldGroup>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <div className='mt-8 flex items-center gap-4'>
          <Button className='flex-1' variant='outline' onClick={resetSettings}>
            Reset to defaults
          </Button>
        </div>
      </div>
    </section>
  );
};
