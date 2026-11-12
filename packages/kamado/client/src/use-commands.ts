// Buttons send commands (the Invoker Commands API) and not `onClick`: `@d-zero/no-click-event`
// forbids `onClick` and asks for this API. `commandfor` names the id of one element, and the
// `command` event fires at that element only (it does not bubble), so that element is where the
// handlers are. A `div` cannot send a command, so a cell of the grid has a transparent button over it
// (`grid-row.tsx`).
import type { BuiltinCommand, CommandAttributes } from './logic/commands.js';

import { useCallback, useId, useRef, type RefObject } from 'react';

import { builtinCommand, customCommand, runCommand } from './logic/commands.js';

/** What `useCommands` gives the element that handles commands. */
export interface Commands<E extends HTMLElement, Name extends string = string> {
	/** The `ref` of the element: it is where the `command` events arrive. */
	readonly ref: (element: E | null) => (() => void) | undefined;
	/** The `id` of the element, which the buttons name in `commandfor`. */
	readonly id: string;
	/**
	 * The attributes of a button that runs the handler `name`: spread them on the `<button>`.
	 * @param name - The name of a handler
	 */
	readonly run: (name: Name) => CommandAttributes;
	/**
	 * The attributes of a button that has the element, a `<dialog>`, carry out a command by itself.
	 * @param command - What the dialog does
	 */
	readonly builtin: (command: BuiltinCommand) => CommandAttributes;
}

/**
 * Handles the commands that buttons send to one element (the Invoker Commands API). A button
 * with `commandfor` and `command="--name"` makes the browser fire a `command` event at the
 * element with that `id`, and the handler `name` runs with the button as its argument: a
 * handler tells the buttons of a list apart by what the button holds (a `data-*` attribute).
 * The element must be the one the buttons name, and it can be any element: a button inside it,
 * or one that is elsewhere on the screen.
 *
 * The handlers are read when a command arrives, so they may close over the state of the render;
 * the listener is added once, when the element is mounted.
 * @param handlers - What to do, by the name of the command
 * @param own - A ref that holds the element too, for a component that calls its methods
 * (`showModal`, `close`, `focus`) as well as receiving commands
 * @example
 * ```tsx
 * function Counter() {
 * 	const [count, setCount] = useState(0);
 * 	const commands = useCommands({ add: () => setCount(count + 1) });
 * 	return (
 * 		<div ref={commands.ref} id={commands.id}>
 * 			<button type="button" {...commands.run('add')}>
 * 				{count}
 * 			</button>
 * 		</div>
 * 	);
 * }
 * ```
 */
export function useCommands<Name extends string, E extends HTMLElement = HTMLElement>(
	handlers: Readonly<Record<Name, (source: HTMLElement) => void>>,
	own?: RefObject<E | null>,
): Commands<E, Name> {
	const id = useId();
	const latest = useRef(handlers);
	latest.current = handlers;
	const ref = useCallback(
		(element: E | null) => {
			if (element === null) {
				return;
			}
			if (own !== undefined) {
				own.current = element;
			}
			const listen = (event: Event) => {
				const { command, source } = event as Event & {
					readonly command: string;
					readonly source: Element | null;
				};
				if (source instanceof HTMLElement) {
					runCommand(latest.current, command, source);
				}
			};
			element.addEventListener('command', listen);
			return () => {
				element.removeEventListener('command', listen);
				if (own !== undefined) {
					own.current = null;
				}
			};
		},
		[own],
	);
	return {
		ref,
		id,
		run: (name) => customCommand(id, name),
		builtin: (command) => builtinCommand(id, command),
	};
}
