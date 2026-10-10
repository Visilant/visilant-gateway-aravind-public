import { diagnostics, profile } from '../../infrastructure/diagnostics';
import { statfs } from 'fs/promises';
import path from 'path';
import { Inject, Service } from 'typedi';
import type { DataSource } from 'typeorm';
import type { GatewayConfig } from '../../config';
import { CaptureRepository } from '../../infrastructure/database/repositories';
import type { CaptureStatus } from '../../infrastructure/database';
import { DicomClient } from '../../infrastructure/dicom';
import { CONFIG, DATABASE } from '../../tokens';

export interface NodeHealth {
    reachable: boolean;
    detail?: string;
}

export interface HealthReport {
    status: 'ok' | 'degraded';
    centre_code: string;
    detail?: string;
    database: { reachable: boolean; detail?: string };
    queue: Record<CaptureStatus, number> | null;
    storage: { path: string; free_bytes: number | null; detail?: string };
    dicom: { mwl: NodeHealth; store: NodeHealth };
}

// "Is this box working?" answered in one call, for an operator with no other tooling.
// Every probe is independently fallible and none of them throw — a health endpoint
// that 500s when the PACS is down tells you nothing you could not already guess.
@Service()
export class HealthService {
    constructor(
        @Inject(CONFIG) private readonly config: GatewayConfig,
        @Inject(DATABASE) private readonly database: DataSource,
        private readonly captureRepository: CaptureRepository,
        private readonly dicomClient: DicomClient,
    ) {}

    @profile('health.report')
    async report(): Promise<HealthReport> {
        const [database, queue, storage, mwl, store] = await Promise.all([
            this.checkDatabase(),
            this.checkQueue(),
            this.checkStorage(),
            this.checkNode('mwl'),
            this.checkNode('store'),
        ]);

        diagnostics.event('health.snapshot', { free_bytes: storage.free_bytes, ...(queue ? { pending: queue.PENDING, sending: queue.SENDING, sent: queue.SENT, failed: queue.FAILED } : {}) });
        const failed = queue?.FAILED ?? 0;
        const healthy = database.reachable && queue !== null && mwl.reachable &&
            store.reachable && storage.free_bytes !== null && failed === 0;

        return {
            status: healthy ? 'ok' : 'degraded',
            centre_code: this.config.centre_code,
            ...(failed > 0 ? { detail: `${failed} captures need attention` } : {}),
            database,
            queue,
            storage,
            dicom: { mwl, store },
        };
    }

    private async checkDatabase(): Promise<HealthReport['database']> {
        try {
            await this.database.query('SELECT 1');
            return { reachable: true };
        } catch (err) {
            return { reachable: false, detail: (err as Error).message };
        }
    }

    private async checkQueue(): Promise<Record<CaptureStatus, number> | null> {
        try {
            return await this.captureRepository.countByStatus();
        } catch {
            return null;
        }
    }

    // Free space matters here in a way it does not in the cloud: if the archive is
    // unreachable for long enough, built DICOM objects accumulate until the disk fills.
    private async checkStorage(): Promise<HealthReport['storage']> {
        const target = path.resolve(this.config.storage_root);
        try {
            const stats = await statfs(target);
            return { path: target, free_bytes: Number(stats.bavail) * Number(stats.bsize) };
        } catch (err) {
            return { path: target, free_bytes: null, detail: (err as Error).message };
        }
    }

    private async checkNode(which: 'mwl' | 'store'): Promise<NodeHealth> {
        try {
            await this.dicomClient.echo(this.config[which]);
            return { reachable: true };
        } catch (err) {
            return { reachable: false, detail: (err as Error).message };
        }
    }
}
