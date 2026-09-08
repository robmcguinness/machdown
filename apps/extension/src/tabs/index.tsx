import './index.css';
import { ErrorBoundary } from 'react-error-boundary';
import { ErrorScreen } from '#common/errorScreen.tsx';
import ReactDOM from 'react-dom/client';
import { StrictMode } from 'react';
import { TabsPage } from './TabsPage';
import { Toaster } from '#components/ui/sonner.tsx';

const root = ReactDOM.createRoot(document.querySelector('#tabsRoot')!);

root.render(
  <ErrorBoundary
    fallbackRender={({ error, resetErrorBoundary }) => (
      <ErrorScreen error={error} resetErrorBoundary={resetErrorBoundary} />
    )}
  >
    <StrictMode>
      <TabsPage />
      <Toaster />
    </StrictMode>
  </ErrorBoundary>,
);
