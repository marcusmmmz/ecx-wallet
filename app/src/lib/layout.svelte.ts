// How the wallet lays itself out. `wide`: the web wallet on a desktop-sized window with no app
// docked, where the bottom bar becomes a rail down the left and home shows Assets and Activity
// side by side. Everywhere else (the extension, a phone, a narrow window, beside a docked app) it
// is the one compact column. The root layout sets it; screens read it.
export const layout = $state<{ wide: boolean }>({ wide: false });

/** The narrowest window the wide layout takes. */
export const WIDE_MIN_PX = 1100;
