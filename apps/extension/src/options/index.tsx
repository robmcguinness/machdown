import './index.css';
import { ErrorBoundary } from 'react-error-boundary';
import { ErrorScreen } from '#common/errorScreen.tsx';
import { Options } from './Options.tsx';
import ReactDOM from 'react-dom/client';
import { StrictMode } from 'react';
import { Toaster } from '#components/Toaster.tsx';

const root = ReactDOM.createRoot(document.querySelector('#optionsRoot')!);

export const OptionsRoot = () => {
  return (
    <StrictMode>
      <Options />
      <Toaster />
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
