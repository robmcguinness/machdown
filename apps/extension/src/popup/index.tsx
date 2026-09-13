import './index.css';
import { Popup } from './Popup.tsx';
import { mountPage } from '#common/mountPage.tsx';

// The popup is 400px wide, so the toast has to sit inside it.
mountPage(<Popup />, { position: 'bottom-center' });
