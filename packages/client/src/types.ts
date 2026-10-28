/**
 * Types in the public API. Kept free of imports from the private
 * @via443/protocol package, which isn't published: the build bundles its code
 * into the JavaScript, but declarations can't refer to it.
 */

export interface LocalTarget {
  host: string;
  port: number;
}

/** One request served through the tunnel, as reported by the `request` event. */
export interface RequestLogEntry {
  method: string;
  path: string;
  /** The local server's status, or undefined if it couldn't be reached. */
  status: number | undefined;
  durationMs: number;
  error?: string;
}

/** The JSON body of a relay's refusal to open a tunnel. */
export interface ConnectRefusal {
  code?: string;
  message?: string;
}
