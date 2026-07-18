// Minimal global shims for Svelte compile-time helpers used by some UI
// primitives in this project. These are lightweight and temporary; a
// long-term fix is to update the UI primitives or project types so
// these helpers are not necessary.
// Svelte compile-time helpers used by some UI primitives. Declare them
// as functions so svelte-check/TypeScript can typecheck components that
// use the $props() / $bindable() patterns.
declare function $props(): any;
declare function $bindable<T = any>(value?: T): any;
export {};
