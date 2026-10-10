import { createHash } from 'crypto';
import type { GatewayConfig } from '../../config';

interface OrderIdentity { accession_number: string; study_instance_uid: string; step_id?: string | null }

// Names the hospital order namespace this gateway completes orders in.
//
// Built from the centre and the worklist's AE title only. Network location (MWL host and
// port) is deliberately left out: a DHCP lease or a moved server must not strand every
// screening a phone has in flight. Our own calling AE is left out for the same reason —
// it names this box, not the order namespace. Pointing the gateway at a different
// worklist AE, or a different centre, is a deliberate change of order namespace and
// starts a new scope.
export function sourceScope(config: GatewayConfig): string {
    return hash([config.centre_code, config.mwl.called_ae]);
}

// Exact order identity within a scope. An absent step is null and matches only another
// absent step — never a wildcard.
export function orderKey(scope: string, order: OrderIdentity): string {
    return hash([scope, order.accession_number, order.study_instance_uid, order.step_id ?? null]);
}

function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
