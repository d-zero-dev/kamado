import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app.js';

import './style.css';

const root = document.querySelector('#root');
if (root === null) {
	throw new Error('kamado ui: the page has no #root');
}
createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
