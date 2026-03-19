import './index.css';
import { ErrorBoundary } from 'react-error-boundary';
import { ErrorScreen } from '@common/errorScreen';
import { TabsPage } from './TabsPage';
import ReactDOM from 'react-dom/client';
import { StrictMode } from 'react';

const root = ReactDOM.createRoot(document.getElementById('tabsRoot')!);

root.render(
  <ErrorBoundary
    fallbackRender={({ error, resetErrorBoundary }) => (
      <ErrorScreen error={error} resetErrorBoundary={resetErrorBoundary} />
    )}
  >
    <StrictMode>
      <TabsPage />
    </StrictMode>
  </ErrorBoundary>,
);
