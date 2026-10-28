/**
 * View facade: the kernel tree's React face. The kernel root is the
 * whole public surface — the components below it are tree-internal,
 * reached through the kernel snapshot, and never import the screen,
 * the session projection or the terminal.
 */
export { TuiKernelRoot, type TuiIntroSource, type TuiKernelRootProps } from "./kernel-root.js"
