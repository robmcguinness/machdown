import './index.css';
import { ErrorBoundary } from 'react-error-boundary';
import { ErrorScreen } from '#common/errorScreen.tsx';
import { Popup } from './Popup';
import ReactDOM from 'react-dom/client';
import { StrictMode } from 'react';
import { Toaster } from '#components/Toaster.tsx';

const root = ReactDOM.createRoot(document.querySelector('#popupRoot')!);

root.render(
  <ErrorBoundary
    fallbackRender={({ error, resetErrorBoundary }) => (
      <ErrorScreen error={error} resetErrorBoundary={resetErrorBoundary} />
    )}
  >
    <StrictMode>
      <Popup />
      {/* The popup is 400px wide, so the toast has to sit inside it. */}
      <Toaster position='bottom-center' />
    </StrictMode>
  </ErrorBoundary>,
);
