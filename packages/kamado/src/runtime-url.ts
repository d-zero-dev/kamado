/**
 * File URL of the JSX runtime that compiled modules import. The core writes it
 * into the modules it compiles, and the renderers import it; both must name
 * the same file.
 */
export const RUNTIME_URL: string = new URL('jsx/runtime.js', import.meta.url).href;
