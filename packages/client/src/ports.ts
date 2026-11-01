export interface PortSpec {
  /** Label for this port in the CLI output and the URLs file. Defaults to the port number. */
  name: string;
  port: number;
}

const NAME = /^[A-Za-z0-9_-]+$/;

/** Parses `--port` values of the form `3000` or `api=3001`. Throws on invalid or duplicate entries. */
export function parsePorts(values: string[]): PortSpec[] {
  const specs: PortSpec[] = [];
  for (const value of values) {
    const sep = value.indexOf('=');
    const name = sep === -1 ? undefined : value.slice(0, sep);
    const raw = sep === -1 ? value : value.slice(sep + 1);
    const port = Number(raw);
    if (!/^\d+$/.test(raw) || port < 1 || port > 65535) throw new Error(`invalid port "${value}"`);
    if (name !== undefined && !NAME.test(name)) {
      throw new Error(`invalid port name "${name}": use letters, digits, "-" and "_"`);
    }
    const spec = { name: name ?? String(port), port };
    if (specs.some((s) => s.name === spec.name)) throw new Error(`port name "${spec.name}" is used twice`);
    specs.push(spec);
  }
  return specs;
}
