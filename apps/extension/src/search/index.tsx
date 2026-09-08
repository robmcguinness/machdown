import './index.css';
import { ErrorBoundary } from 'react-error-boundary';
import { ErrorScreen } from '#common/errorScreen.tsx';
import ReactDOM from 'react-dom/client';
import { SearchPage } from './SearchPage';
import { StrictMode } from 'react';
import { Toaster } from '#components/ui/sonner.tsx';

const root = ReactDOM.createRoot(document.querySelector('#searchRoot')!);

root.render(
  <ErrorBoundary
    fallbackRender={({ error, resetErrorBoundary }) => (
      <ErrorScreen error={error} resetErrorBoundary={resetErrorBoundary} />
    )}
  >
    <StrictMode>
      <SearchPage />
      <Toaster />
    </StrictMode>
  </ErrorBoundary>,
);
