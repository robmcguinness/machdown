import './index.css';
import { ErrorBoundary } from 'react-error-boundary';
import { ErrorScreen } from '#common/errorScreen.tsx';
import { Popup } from './Popup';
import ReactDOM from 'react-dom/client';
import { StrictMode } from 'react';

const root = ReactDOM.createRoot(document.querySelector('#popupRoot')!);

root.render(
  <ErrorBoundary
    fallbackRender={({ error, resetErrorBoundary }) => (
      <ErrorScreen error={error} resetErrorBoundary={resetErrorBoundary} />
    )}
  >
    <StrictMode>
      <Popup />
    </StrictMode>
  </ErrorBoundary>,
);
