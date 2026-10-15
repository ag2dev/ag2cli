/**
 * View facade: the React/Ink
 * tree over the framework-free store. The root is the whole public
 * surface — the components below it are tree-internal, reached through
 * props, and never import the screen, the session projection or the
 * terminal.
 */
export { TuiRoot, type TuiRootProps } from "./root.js"
