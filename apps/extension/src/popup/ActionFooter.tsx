import { ActionButton, type ActionStatus } from '#components/ActionButton.tsx';
import { Bookmark, ChevronDown, Copy, Download, FileText, Library, Package } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#components/ui/dropdown-menu.tsx';
import { Button } from '#components/ui/button.tsx';
import { ButtonGroup } from '#components/ui/button-group.tsx';

export type FooterAction = {
  disabled?: boolean;
  /** What the button says once the action has finished, e.g. "Saved". */
  doneLabel: string;
  /** Idle label. Omitted for the icon-only buttons. */
  label?: string;
  onClick: () => void;
  status: ActionStatus;
  title: string;
};

/**
 * The download action, optionally with a second format: one markdown file of
 * links rather than a ZIP of full clips. Both land in the Downloads folder, so
 * the alternative rides a dropdown on the button instead of a fifth footer
 * button. The single-page scope has no batch, so it omits `onSingleFile` and
 * the dropdown does not appear.
 */
export type DownloadAction = FooterAction & { onSingleFile?: () => void };

type ActionFooterProps = {
  bookmark: FooterAction;
  copy: FooterAction;
  download: DownloadAction;
  save: FooterAction;
};

/**
 * The two destinations, pinned to the bottom so they never scroll away.
 *
 * Knowledge base and Downloads folder are separate buttons rather than one
 * button with a mode, so "where does this go" is answered before the click.
 * Copy and Bookmark are icon-only: still one click, but out of the eye line.
 */
export const ActionFooter = ({ bookmark, copy, download, save }: ActionFooterProps) => {
  const { onSingleFile, ...downloadButton } = download;
  const downloadIsBusy = download.disabled === true || download.status !== 'idle';
  return (
    <div className='flex shrink-0 items-center gap-1.5 border-t px-3 py-2.5'>
      <ActionButton
        className='min-w-0 flex-1'
        icon={<Library data-icon='inline-start' />}
        shortcut='⌘↵'
        {...save}
      />
      {onSingleFile ? (
        <ButtonGroup className='min-w-0 flex-1'>
          <ActionButton
            className='min-w-0 flex-1'
            icon={<Download data-icon='inline-start' />}
            shortcut='⌘D'
            variant='outline'
            {...downloadButton}
          />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  aria-label='Choose download format'
                  disabled={downloadIsBusy}
                  size='icon'
                  variant='outline'
                />
              }
            >
              <ChevronDown />
            </DropdownMenuTrigger>
            <DropdownMenuContent align='end'>
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={download.onClick}>
                  <Package />
                  ZIP of full clips
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onSingleFile}>
                  <FileText />
                  Single markdown of links
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </ButtonGroup>
      ) : (
        <ActionButton
          className='min-w-0 flex-1'
          icon={<Download data-icon='inline-start' />}
          shortcut='⌘D'
          variant='outline'
          {...downloadButton}
        />
      )}
      <ActionButton icon={<Copy />} size='icon' variant='outline' {...copy} />
      <ActionButton icon={<Bookmark />} size='icon' variant='outline' {...bookmark} />
    </div>
  );
};
