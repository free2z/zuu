// See https://kit.svelte.dev/docs/types#app
// for information about these interfaces
declare global {
	namespace App {
		interface Error {
			code?: number;
		}
	}

	interface HTMLElementTagNameMap {
		'rtk-meeting': HTMLElement & { meeting?: unknown };
		'rtk-participants-audio': HTMLElement & { meeting?: unknown };
	}
}

export { };
