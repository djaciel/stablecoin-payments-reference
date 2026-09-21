import type { MinorUnits } from '@payments/ledger'
import { COMPLIANCE_DENYLIST } from '../config'

/**
 * MOCK. NOT A COMPLIANCE CHECK. This is the integration point where a real screening provider
 * (sanctions lists, wallet risk scoring) plugs in: replace the body of `screenPayment` with the
 * call to it. The demo only refuses the addresses in `COMPLIANCE_DENYLIST`, which is empty by
 * default, so the refusal branch exists to be seen.
 */

export interface ScreeningRequest {
  readonly destination: string
  readonly amountMinor: MinorUnits
}

export interface ScreeningResult {
  readonly decision: 'pass' | 'reject'
  /** For the audit log: why the screen said no. */
  readonly reason?: string
}

export function screenPayment(request: ScreeningRequest): ScreeningResult {
  // Case-insensitive on purpose: a denylist has to fail closed, whatever case the address was typed in.
  const destination = request.destination.toLowerCase()
  if (COMPLIANCE_DENYLIST.some((address) => address.toLowerCase() === destination)) {
    return { decision: 'reject', reason: 'the destination is on the demo denylist in apps/api/src/config.ts' }
  }
  return { decision: 'pass' }
}
