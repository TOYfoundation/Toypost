// The shared package runs in Node.js (API), in browsers (web build) and in
// Hermes (Expo app). All three provide the WHATWG TextEncoder, but the
// platform-neutral lib "ES2022" does not declare it. This declares only the
// part the package uses, so the code stays free of Node or DOM types.
// Only this package's tsconfig includes this file; the API and the app get
// TextEncoder from @types/node and their own libs instead.

declare class TextEncoder {
  constructor();
  readonly encoding: string;
  encode(input?: string): Uint8Array;
}
