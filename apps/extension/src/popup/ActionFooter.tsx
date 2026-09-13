import { ActionButton, type ActionStatus } from '#components/ActionButton.tsx';
import { Bookmark, Copy, Download, Library } from 'lucide-react';

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

type ActionFooterProps = {
  bookmark: FooterAction;
  copy: FooterAction;
  download: FooterAction;
  save: FooterAction;
};

/**
 * The two destinations, pinned to the bottom so they never scroll away.
 *
 * Knowledge base and Downloads folder are separate buttons rather than one
 * button with a mode, so "where does this go" is answered before the click.
 * Copy and Bookmark are icon-only: still one click, but out of the eye line.
 */
export const ActionFooter = ({ bookmark, copy, download, save }: ActionFooterProps) => (
  <div className='flex shrink-0 items-center gap-1.5 border-t px-3 py-2.5'>
    <ActionButton
      className='min-w-0 flex-1'
      icon={<Library data-icon='inline-start' />}
      shortcut='⌘↵'
      {...save}
    />
    <ActionButton
      className='min-w-0 flex-1'
      icon={<Download data-icon='inline-start' />}
      shortcut='⌘D'
      variant='outline'
      {...download}
    />
    <ActionButton icon={<Copy />} size='icon' variant='outline' {...copy} />
    <ActionButton icon={<Bookmark />} size='icon' variant='outline' {...bookmark} />
  </div>
);
