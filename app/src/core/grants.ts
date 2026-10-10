/**
 * Write grants — which capability may act on which target (ADR 0004).
 *
 * A write is named `<area>.<verb>` and bound to ONE target. Nothing is granted unless the config
 * lists it: an absent or empty `grants` denies everything, an unknown capability or a malformed
 * entry is a configuration error at load (never a silently ignored line), and a target matches
 * only when it is spelled exactly like the grant. No wildcards, no prefixes, no case folding.
 *
 * Pure, so the decision is tested on both runtimes. This file only decides; the call check that
 * puts it in front of every write handler is the gate's job.
 */

export type Capability = 'xmpp.send' | 'calendar.create' | 'canary.write';

export interface Grant {
  capability: Capability;
  /** Exactly one target; its shape depends on the capability (see `TARGETS`). */
  target: string;
}

/** Capabilities a real configuration may grant. */
export const CAPABILITIES = ['xmpp.send', 'calendar.create'] as const;

/**
 * The test-only capability behind the gate's positive-control canary. It is accepted only while
 * `CURLEW_MCP_GATE_CANARY=1`, so the grant that proves the gate opens cannot be written into a
 * real configuration.
 */
export const CANARY_CAPABILITY = 'canary.write';

export interface ParseGrantsOptions {
  /** Accept `canary.write`. Defaults to `CURLEW_MCP_GATE_CANARY=1`. */
  canary?: boolean;
}

const WILDCARD = /[*?]/;

/** `xmpp.send` names the account AND the address: from where, and to whom. */
function targetProblem(capability: Capability, target: string): string | undefined {
  if (target.length === 0 || target.trim() !== target) return 'must be a non-empty string without surrounding whitespace';
  if (WILDCARD.test(target)) return 'must name exactly one target, wildcards are not allowed';
  if (capability === 'xmpp.send') {
    const slash = target.indexOf('/');
    if (slash <= 0 || slash === target.length - 1) return 'must be "<account>/<address>"';
  }
  return undefined;
}

/** Validate the `grants` value of the config. Throws with the offending entry named. */
export function parseGrants(raw: unknown, options: ParseGrantsOptions = {}): Grant[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('config.grants must be a list of { capability, target }');
  const canary = options.canary ?? process.env.CURLEW_MCP_GATE_CANARY === '1';
  const known: readonly string[] = canary ? [...CAPABILITIES, CANARY_CAPABILITY] : CAPABILITIES;

  return raw.map((entry: unknown, index): Grant => {
    const where = `config.grants[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`${where} must be an object { capability, target }`);
    }
    const fields = entry as Record<string, unknown>;
    for (const key of Object.keys(fields)) {
      if (key !== 'capability' && key !== 'target') throw new Error(`${where}.${key} is not a grant field`);
    }
    const { capability, target } = fields;
    if (typeof capability !== 'string' || !known.includes(capability)) {
      throw new Error(`${where}.capability ${JSON.stringify(capability)} is not a known capability (${known.join(', ')})`);
    }
    if (typeof target !== 'string') throw new Error(`${where}.target must be a string`);
    const problem = targetProblem(capability as Capability, target);
    if (problem) throw new Error(`${where}.target ${problem}`);
    return { capability: capability as Capability, target };
  });
}

/** Does a grant for exactly this capability and exactly this target exist? Missing = deny. */
export function isGranted(grants: readonly Grant[] | undefined, capability: Capability, target: string): boolean {
  return (grants ?? []).some((grant) => grant.capability === capability && grant.target === target);
}

/** Is the capability granted for any target? The registration check of the gate. */
export function hasGrant(grants: readonly Grant[] | undefined, capability: Capability): boolean {
  return (grants ?? []).some((grant) => grant.capability === capability);
}
