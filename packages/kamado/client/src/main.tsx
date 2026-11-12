import type { SettingsView } from './types.js';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { columnDefaults, fetchSettings } from './api.js';
import { App } from './app.js';

import './style.css';

const root = document.querySelector('#root');
if (root === null) {
	throw new Error('kamado ui: the page has no #root');
}

// The settings are read before the first drawing, so that the screen is not shown in one
// language and then changed to another. If they cannot be read the screen starts with the
// defaults and says so; so does a server that does not answer within a few seconds (a settings
// file on a stalled disk), which would otherwise leave the page blank.
const SETTINGS_WAIT_MS = 3000;
const DEFAULTS: SettingsView = {
	global: { locale: 'auto' },
	project: null,
	warning: null,
};
let settings = DEFAULTS;
let settingsUnreadable = false;
try {
	settings = await fetchSettings(AbortSignal.timeout(SETTINGS_WAIT_MS));
} catch {
	settingsUnreadable = true;
}

createRoot(root).render(
	<StrictMode>
		<App
			settings={settings}
			settingsUnreadable={settingsUnreadable}
			columnDefaults={columnDefaults()}
		/>
	</StrictMode>,
);
