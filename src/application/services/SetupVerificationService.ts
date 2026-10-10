import { Service } from 'typedi';
import { SetupRepository, SetupVerification } from '../../infrastructure/database/repositories/SetupRepository';

export type SetupMissingItem = 'setup_started' | 'phone_signin' | 'worklist' | 'pacs_delivery' |
    'synthetic_confirmation' | 'viewer_confirmation' | 'startup_confirmation';
export interface SetupAttestations { synthetic: boolean; viewer: boolean; startup: boolean }

// Carries the exact items still missing. Its message is a fixed internal phrase; the
// caller turns `missing` into operator text.
export class SetupIncompleteError extends Error {
    constructor(readonly missing: SetupMissingItem[]) {
        super('The test is not complete.');
        this.name = 'SetupIncompleteError';
    }
}

// Contains timestamps only. Patient identifiers, passwords and DICOM errors never enter
// the setup record or its downloadable support report.
@Service()
export class SetupVerificationService {
    constructor(private readonly repository: SetupRepository) {}

    // Serialize read/modify/write operations without opening overlapping SQLite
    // transactions on the connection shared with the durable delivery worker.
    private pending: Promise<unknown> = Promise.resolve();
    private update(fn: (value: SetupVerification | null) => Promise<SetupVerification>): Promise<SetupVerification> {
        const operation = this.pending.then(async () => {
            const value = await fn(await this.repository.read());
            await this.repository.save(value);
            return value;
        });
        this.pending = operation.catch(() => undefined);
        return operation;
    }

    async begin(): Promise<void> {
        if (await this.repository.read()) return;
        await this.update(async value => value ?? { started_at: new Date().toISOString() });
    }

    async observe(kind: 'phone_signin_at' | 'worklist_at'): Promise<void> {
        const current = await this.repository.read();
        if (!current || current.completed_at || current[kind]) return;
        await this.update(async value => {
            if (!value) throw new Error('Setup has not started.');
            return value.completed_at || value[kind] ? value : { ...value, [kind]: new Date().toISOString() };
        });
    }

    async report() {
        const verification = await this.repository.read();
        return { ...verification, ...await this.repository.captureCounts(verification?.started_at) };
    }

    // Completion needs both observed evidence and the operator's attestations. Every
    // missing item is named, so one failed check never hides the others.
    async complete(attestations: SetupAttestations): Promise<void> {
        await this.update(async value => {
            if (value?.completed_at) return value;
            if (!value) throw new SetupIncompleteError(['setup_started']);
            const status = await this.report();
            const missing: SetupMissingItem[] = [];
            if (!status.phone_signin_at) missing.push('phone_signin');
            if (!status.worklist_at) missing.push('worklist');
            if (status.sent === 0 || status.waiting > 0 || status.failed > 0) missing.push('pacs_delivery');
            if (!attestations.synthetic) missing.push('synthetic_confirmation');
            if (!attestations.viewer) missing.push('viewer_confirmation');
            if (!attestations.startup) missing.push('startup_confirmation');
            if (missing.length) throw new SetupIncompleteError(missing);
            return { ...value, completed_at: new Date().toISOString() };
        });
    }
}
