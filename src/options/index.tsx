import './index.css';
import { ErrorBoundary } from 'react-error-boundary';
import { ErrorScreen } from '@common/errorScreen';
import { Options } from './Options';
import ReactDOM from 'react-dom/client';
import { StrictMode } from 'react';

const root = ReactDOM.createRoot(document.getElementById('optionsRoot')!);

export const OptionsRoot = () => {
  return (
    <StrictMode>
      <Options />
    </StrictMode>
  );
};

root.render(
  <ErrorBoundary
    fallbackRender={({ error, resetErrorBoundary }) => (
      <ErrorScreen error={error} resetErrorBoundary={resetErrorBoundary} />
    )}
  >
    <OptionsRoot />
  </ErrorBoundary>,
);
