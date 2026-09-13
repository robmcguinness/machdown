import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '#components/ui/empty.tsx';
import { OctagonX, RefreshCw } from 'lucide-react';
import { Button } from '#components/ui/button.tsx';

const isString = (value: unknown): value is string => typeof value === 'string';

export const ErrorScreen = ({
  error,
  resetErrorBoundary,
}: {
  error: unknown;
  resetErrorBoundary: () => void;
}) => {
  const message = error instanceof Error ? error.message : isString(error) ? error : String(error);

  return (
    <Empty className='h-screen'>
      <EmptyHeader>
        <EmptyMedia variant='icon'>
          <OctagonX />
        </EmptyMedia>
        <EmptyTitle>Something went wrong</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant='outline' onClick={resetErrorBoundary}>
          <RefreshCw data-icon='inline-start' />
          Try again
        </Button>
      </EmptyContent>
    </Empty>
  );
};
