// Buttons send commands (the Invoker Commands API) and not `onClick`: `@d-zero/no-click-event`
// forbids `onClick` and asks for this API. `commandfor` names the id of one element, and the
// `command` event fires at that element only (it does not bubble). A `div` cannot send a command,
// so a cell of the grid has a transparent button over it (`grid-row.tsx`).

/**
 * The attributes of a button of the Invoker Commands API: `commandfor` is the `id` of the element
 * the command is sent to, and `command` is what it is told to do.
 */
export interface CommandAttributes {
	readonly commandfor: string;
	readonly command: string;
}

/** The commands the browser carries out by itself, on a `<dialog>`. */
export type BuiltinCommand = 'show-modal' | 'close' | 'request-close';

/** What a command that is the screen's own begins with (the API reserves the rest of the names). */
const CUSTOM_PREFIX = '--';

/**
 * The attributes of a button that has the browser open or close a dialog.
 * @param target - The `id` of the `<dialog>`
 * @param command - What the dialog is told to do
 * @example
 * ```ts
 * builtinCommand('add-page-dialog', 'show-modal');
 * // { commandfor: 'add-page-dialog', command: 'show-modal' }
 * ```
 */
export function builtinCommand(
	target: string,
	command: BuiltinCommand,
): CommandAttributes {
	return { commandfor: target, command };
}

/**
 * The attributes of a button that sends a command of the screen's own: the element `target` gets
 * a `command` event, and the handler called `name` runs (see `useCommands`).
 * @param target - The `id` of the element that handles the commands
 * @param name - The name of the command
 * @example
 * ```ts
 * customCommand('app', 'next');
 * // { commandfor: 'app', command: '--next' }
 * ```
 */
export function customCommand(target: string, name: string): CommandAttributes {
	return { commandfor: target, command: `${CUSTOM_PREFIX}${name}` };
}

/**
 * The name of a command of the screen's own, or `null` for a command that is not (one the browser
 * carries out, or an empty name).
 * @param command - The `command` of a `command` event
 * @example
 * ```ts
 * customNameOf('--next'); // 'next'
 * customNameOf('close'); // null
 * ```
 */
export function customNameOf(command: string): string | null {
	return command.length > CUSTOM_PREFIX.length && command.startsWith(CUSTOM_PREFIX)
		? command.slice(CUSTOM_PREFIX.length)
		: null;
}

/** The handlers of an element, by the name of the command: each is given the button that was pressed. */
export type CommandHandlers<Source> = Readonly<Record<string, (source: Source) => void>>;

/**
 * Runs the handler a command names.
 * @param handlers - The handlers, by the name of the command
 * @param command - The `command` of a `command` event
 * @param source - The button that sent it
 * @returns Whether a handler ran
 * @example
 * ```ts
 * runCommand({ next: (button) => console.log(button) }, '--next', 'the button'); // true
 * runCommand({ next: () => {} }, '--other', 'the button'); // false
 * ```
 */
export function runCommand<Source>(
	handlers: CommandHandlers<Source>,
	command: string,
	source: Source,
): boolean {
	const name = customNameOf(command);
	if (name === null || !Object.hasOwn(handlers, name)) {
		return false;
	}
	handlers[name]?.(source);
	return true;
}
