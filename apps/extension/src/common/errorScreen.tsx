import { Icon } from '#lib/icon/component.tsx';

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
    <div className='h-screen place-content-center text-center w-full place-items-center flex flex-col'>
      <div className='font-semibold'>Something went wrong</div>
      <div className='text-sm'>
        <span className='italic'>{message}</span>
      </div>
      <Icon color='red-500' name='reload' onClick={() => resetErrorBoundary()} />
    </div>
  );
};
