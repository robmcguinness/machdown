import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type { ClipResponse, ClipResult, ClipSettings } from '../types/clip';
import { copyMarkdown, downloadMarkdown, downloadTabLinks } from '@lib/markdown';
import { useCallback, useEffect, useState } from 'react';
import type { AppSettings } from '@common/appTypes';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@lib/icon/component';
import { Separator } from '@/components/ui/separator';
import { useSharedSettings } from '@common/useSharedSettings';

type ClipState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; clip: ClipResult }
  | { status: 'error'; message: string };

const toClipSettings = (s: AppSettings): ClipSettings => ({
  headingStyle: s.headingStyle,
  bulletListMarker: s.bulletListMarker,
  linkStyle: s.linkStyle,
  codeBlockStyle: s.codeBlockStyle,
  fence: s.fence,
  hr: s.hr,
  includeImages: s.includeImages,
});

export const Popup = () => {
  const [state, setState] = useState<ClipState>({ status: 'idle' });
  const [copied, setCopied] = useState(false);
  const { settings } = useSharedSettings();

  const extractClip = useCallback(async () => {
    setState({ status: 'loading' });

    if (typeof chrome === 'undefined' || !chrome.tabs?.query) {
      setState({
        status: 'error',
        message: 'Chrome extension APIs not available',
      });
      return;
    }

    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab?.id) {
        setState({ status: 'error', message: 'No active tab found' });
        return;
      }

      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['clipper.js'],
      });

      const response = await chrome.tabs.sendMessage<{ type: string; settings?: ClipSettings }, ClipResponse>(tab.id, {
        type: 'clip:extract',
        settings: toClipSettings(settings),
      });

      if (response.type === 'clip:result') {
        setState({ status: 'done', clip: response.payload });
      } else {
        setState({ status: 'error', message: response.error });
      }
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to clip page',
      });
    }
  }, [settings]);

  useEffect(() => {
    extractClip();
  }, [extractClip]);

  // Auto-copy when clip is done
  useEffect(() => {
    if (state.status !== 'done' || !settings.autoCopy) return;
    copyMarkdown(state.clip).then((ok) => {
      if (ok) setCopied(true);
    });
  }, [state, settings.autoCopy]);

  const handleSave = () => {
    if (state.status !== 'done') return;

    downloadMarkdown(state.clip, {
      settings: {
        filenamePattern: settings.filenamePattern,
      },
      onError: (error) => {
        setState({ status: 'error', message: error.message });
      },
      onSuccess: () => {
        if (settings.autoClosePopup) {
          setTimeout(() => window.close(), 300);
        }
      },
    });
  };

  const handleCopy = async () => {
    if (state.status !== 'done') return;
    const ok = await copyMarkdown(state.clip);
    if (ok) {
      setCopied(true);
      setTimeout(() => window.close(), 500);
    }
  };

  return (
    <div className='p-4 min-h-[120px]'>
      {state.status === 'loading' && (
        <div className='flex items-center gap-2.5 py-6 justify-center text-muted-foreground text-[13px]'>
          <div className='w-[18px] h-[18px] border-2 border-border border-t-primary rounded-full animate-spin' />
          <span>Extracting article...</span>
        </div>
      )}

      {state.status === 'error' && (
        <div className='flex items-center gap-2.5 py-6 justify-center text-[13px] flex-col text-destructive'>
          <Badge variant='destructive' className='size-7 rounded-full text-base font-bold'>
            !
          </Badge>
          <span>{state.message}</span>
          <Button variant='outline' size='sm' className='mt-2' onClick={extractClip}>
            Retry
          </Button>
        </div>
      )}

      {state.status === 'done' && (
        <Card>
          <CardHeader>
            <CardTitle className='line-clamp-2' title={state.clip.title}>
              {state.clip.title}
            </CardTitle>
            <CardDescription className='text-[11px]'>{state.clip.siteName}</CardDescription>
          </CardHeader>

          <CardContent className='space-y-3.5'>
            <Button className='w-full' onClick={handleSave}>
              Save clip
            </Button>

            <Separator />

            <div>
              <span className='block text-xs text-muted-foreground mb-2'>Clip format</span>
              <div className='flex flex-col gap-0.5'>
                <div className='flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm bg-primary/10 text-foreground'>
                  <Icon name='article' size='base' className='text-foreground' />
                  <span>{state.clip.mode === 'selection' ? 'Selection' : 'Article'}</span>
                  <Icon name='check' size='base' className='ml-auto text-primary' />
                </div>
              </div>
            </div>

            <Separator />

            <Button variant='outline' className='w-full' onClick={handleCopy}>
              {copied ? 'Copied!' : 'Copy to clipboard'}
            </Button>

            {settings.autoCopy && copied && (
              <p className='text-xs text-muted-foreground text-center'>Auto-copied to clipboard</p>
            )}

            <Separator />

            <div className='flex gap-2'>
              <Button
                variant='outline'
                className='flex-1'
                onClick={async () => {
                  const tabs = await chrome.tabs.query({});
                  const links = tabs
                    .filter((t): t is chrome.tabs.Tab & { url: string } => !!t.url)
                    .map((t) => ({ title: t.title || t.url, url: t.url }));
                  downloadTabLinks(links, {
                    onError: (error) =>
                      setState({ status: 'error', message: error.message }),
                  });
                }}
              >
                Save Links
              </Button>
              <Button
                variant='outline'
                className='flex-1'
                onClick={() => {
                  chrome.tabs.create({ url: chrome.runtime.getURL('src/tabs/index.html') });
                  window.close();
                }}
              >
                Save Multiple Clips
              </Button>
            </div>

            {state.clip.excerpt && (
              <div>
                <span className='block text-[11px] text-muted-foreground mb-1.5 uppercase tracking-[0.5px]'>
                  Preview
                </span>
                <p className='m-0 text-xs text-muted-foreground leading-relaxed line-clamp-3'>
                  {state.clip.excerpt}
                </p>
              </div>
            )}
          </CardContent>

          <CardFooter>
            <Button
              variant='ghost'
              size='sm'
              className='text-xs text-muted-foreground'
              onClick={() => chrome.runtime.openOptionsPage()}
            >
              Settings
            </Button>
          </CardFooter>
        </Card>
      )}
    </div>
  );
};
