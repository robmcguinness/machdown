import { Icon } from '@lib/icon/component';

export const ErrorScreen = ({
  error,
  resetErrorBoundary,
}: {
  error: unknown;
  resetErrorBoundary: () => void;
}) => {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);

  return (
    <div className='h-screen place-content-center text-center w-full place-items-center flex flex-col'>
      <div className='font-semibold'>Something went wrong</div>
      <div className='text-sm'>
        <span className='italic'>{message}</span>
      </div>
      <Icon name='reload' color='red-500' onClick={() => resetErrorBoundary()} />
    </div>
  );
};
