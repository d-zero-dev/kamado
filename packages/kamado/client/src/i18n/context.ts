import type { Language, Translate } from './translate.js';

import { createContext, useContext } from 'react';

import { english } from './translate.js';

/** The language the screen speaks and how it says a message in it. */
export interface I18n {
	readonly language: Language;
	readonly t: Translate;
}

/** English until the screen says otherwise (a component drawn without the provider speaks it). */
export const I18nContext = createContext<I18n>({ language: 'en', t: english });

/** The language of the screen and its translator, for a component. */
export function useI18n(): I18n {
	return useContext(I18nContext);
}
