import { type ComponentProps, type ReactNode, StrictMode } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { ErrorScreen } from './errorScreen.tsx';
import ReactDOM from 'react-dom/client';
import { Toaster } from '#components/Toaster.tsx';

/** Every page mounts the same way: error boundary, strict mode, and a toaster. */
export const mountPage = (page: ReactNode, toaster?: ComponentProps<typeof Toaster>) => {
  ReactDOM.createRoot(document.querySelector('#root')!).render(
    <ErrorBoundary
      fallbackRender={({ error, resetErrorBoundary }) => (
        <ErrorScreen error={error} resetErrorBoundary={resetErrorBoundary} />
      )}
    >
      <StrictMode>
        {page}
        <Toaster {...toaster} />
      </StrictMode>
    </ErrorBoundary>,
  );
};
