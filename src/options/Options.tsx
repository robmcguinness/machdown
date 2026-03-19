import {
  type AppSettings,
  DEFAULT_SETTINGS,
} from '@common/appTypes';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { useSharedSettings } from '@common/useSharedSettings';

export const Options = () => {
  const { settings, setSettings } = useSharedSettings();
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<number | null>(null);

  const showSaved = useCallback(() => {
    setSaved(true);
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setSaved(false), 2000);
  }, []);
  useEffect(() => () => {
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
  }, []);

  const updateSettings = useCallback(
    (patch: Partial<AppSettings>) => {
      setSettings(patch);
      showSaved();
    },
    [setSettings, showSaved],
  );

  const resetSettings = () => {
    setSettings(DEFAULT_SETTINGS);
    setSaved(false);
  };

  return (
    <section className='min-h-screen p-6 font-sans bg-background text-foreground'>
      <div className='max-w-3xl mx-auto py-10'>
        <header className='mb-8'>
          <h1 className='text-3xl md:text-5xl font-bold mt-4'>Options</h1>
          <p className='text-muted-foreground mt-2'>
            Configure how Machdown clips and formats your content.
          </p>
        </header>

        <div className='space-y-6'>
          {/* ── Appearance ── */}
          <h2 className='text-lg font-semibold'>Appearance</h2>

          <Card>
            <CardContent className='space-y-2'>
              <Label htmlFor='theme-select'>Theme</Label>
              <Select
                value={settings.theme}
                onValueChange={(value) => {
                  updateSettings({ theme: value as AppSettings['theme'] });
                }}
              >
                <SelectTrigger id='theme-select' className='w-full'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='system'>System</SelectItem>
                  <SelectItem value='light'>Light</SelectItem>
                  <SelectItem value='dark'>Dark</SelectItem>
                </SelectContent>
              </Select>
              <p className='text-xs text-muted-foreground'>
                Follows your OS theme when set to system.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className='space-y-3'>
              <Label>UI scale</Label>
              <div className='flex items-center gap-4'>
                <Slider
                  min={0.85}
                  max={1.2}
                  step={0.05}
                  value={[settings.scale]}
                  onValueChange={(value) => {
                    const scale = Array.isArray(value) ? value[0] : value;
                    updateSettings({ scale });
                  }}
                />
                <span className='text-sm text-muted-foreground w-16 text-right'>
                  {Math.round(settings.scale * 100)}%
                </span>
              </div>
            </CardContent>
          </Card>

          <Separator />

          {/* ── Markdown Formatting ── */}
          <h2 className='text-lg font-semibold'>Markdown Formatting</h2>

          <Card>
            <CardContent className='space-y-5'>
              <div className='space-y-2'>
                <Label htmlFor='heading-style'>Heading style</Label>
                <Select
                  value={settings.headingStyle}
                  onValueChange={(v) => updateSettings({ headingStyle: v as AppSettings['headingStyle'] })}
                >
                  <SelectTrigger id='heading-style' className='w-full'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='atx'>ATX (# Heading)</SelectItem>
                    <SelectItem value='setext'>Setext (underline)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className='space-y-2'>
                <Label htmlFor='bullet-marker'>Bullet list marker</Label>
                <Select
                  value={settings.bulletListMarker}
                  onValueChange={(v) => updateSettings({ bulletListMarker: v as AppSettings['bulletListMarker'] })}
                >
                  <SelectTrigger id='bullet-marker' className='w-full'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='-'>Dash (-)</SelectItem>
                    <SelectItem value='*'>Asterisk (*)</SelectItem>
                    <SelectItem value='+'>Plus (+)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className='space-y-2'>
                <Label htmlFor='link-style'>Link style</Label>
                <Select
                  value={settings.linkStyle}
                  onValueChange={(v) => updateSettings({ linkStyle: v as AppSettings['linkStyle'] })}
                >
                  <SelectTrigger id='link-style' className='w-full'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='inline'>Inline [text](url)</SelectItem>
                    <SelectItem value='reference'>Reference [text][1]</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className='space-y-2'>
                <Label htmlFor='code-block-style'>Code block style</Label>
                <Select
                  value={settings.codeBlockStyle}
                  onValueChange={(v) => updateSettings({ codeBlockStyle: v as AppSettings['codeBlockStyle'] })}
                >
                  <SelectTrigger id='code-block-style' className='w-full'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='fenced'>Fenced (```)</SelectItem>
                    <SelectItem value='indented'>Indented (4 spaces)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className='space-y-2'>
                <Label htmlFor='fence-char'>Fence character</Label>
                <Select
                  value={settings.fence}
                  onValueChange={(v) => updateSettings({ fence: v as AppSettings['fence'] })}
                >
                  <SelectTrigger id='fence-char' className='w-full'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='```'>Backticks (```)</SelectItem>
                    <SelectItem value='~~~'>Tildes (~~~)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className='space-y-2'>
                <Label htmlFor='hr-style'>Horizontal rule</Label>
                <Select
                  value={settings.hr}
                  onValueChange={(v) => updateSettings({ hr: v as AppSettings['hr'] })}
                >
                  <SelectTrigger id='hr-style' className='w-full'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='---'>Dashes (---)</SelectItem>
                    <SelectItem value='***'>Asterisks (***)</SelectItem>
                    <SelectItem value='___'>Underscores (___)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          <Separator />

          {/* ── Content Control ── */}
          <h2 className='text-lg font-semibold'>Content</h2>

          <Card>
            <CardContent className='space-y-5'>
              <div className='flex items-center justify-between'>
                <div>
                  <Label>Include images</Label>
                  <p className='text-xs text-muted-foreground'>Keep image references in clipped markdown</p>
                </div>
                <Switch
                  checked={settings.includeImages}
                  onCheckedChange={(v) => updateSettings({ includeImages: v })}
                />
              </div>

            </CardContent>
          </Card>

          <Separator />

          {/* ── Behavior ── */}
          <h2 className='text-lg font-semibold'>Behavior</h2>

          <Card>
            <CardContent className='space-y-5'>
              <div className='flex items-center justify-between'>
                <div>
                  <Label>Auto-copy to clipboard</Label>
                  <p className='text-xs text-muted-foreground'>Automatically copy markdown when a page is clipped</p>
                </div>
                <Switch
                  checked={settings.autoCopy}
                  onCheckedChange={(v) => updateSettings({ autoCopy: v })}
                />
              </div>

              <Separator />

              <div className='flex items-center justify-between'>
                <div>
                  <Label>Auto-close popup after save</Label>
                  <p className='text-xs text-muted-foreground'>Close the popup window after saving a clip</p>
                </div>
                <Switch
                  checked={settings.autoClosePopup}
                  onCheckedChange={(v) => updateSettings({ autoClosePopup: v })}
                />
              </div>

              <Separator />

              <div className='space-y-2'>
                <Label htmlFor='filename-pattern'>Filename pattern</Label>
                <Select
                  value={settings.filenamePattern}
                  onValueChange={(v) => updateSettings({ filenamePattern: v as AppSettings['filenamePattern'] })}
                >
                  <SelectTrigger id='filename-pattern' className='w-full'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='{slug}'>Title only (my-article)</SelectItem>
                    <SelectItem value='{date}-{slug}'>Date + title (2026-03-21-my-article)</SelectItem>
                    <SelectItem value='{site}-{slug}'>Site + title (example-com-my-article)</SelectItem>
                    <SelectItem value='{date}-{site}-{slug}'>Date + site + title</SelectItem>
                  </SelectContent>
                </Select>
                <p className='text-xs text-muted-foreground'>
                  Pattern for saved markdown filenames.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className='mt-8 flex items-center gap-4'>
          <Button variant='outline' onClick={resetSettings} className='flex-1'>
            Reset to defaults
          </Button>
          {saved && (
            <span className='text-xs text-muted-foreground'>Saved</span>
          )}
        </div>
      </div>
    </section>
  );
};
