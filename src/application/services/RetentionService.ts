import { Inject, Service } from 'typedi';
import type { GatewayConfig } from '../../config';
import { CaptureRepository } from '../../infrastructure/database/repositories';
import type { Logger } from '../../infrastructure/logger';
import { LocalDiskStorage } from '../../infrastructure/storage';
import { CONFIG, LOGGER } from '../../tokens';

const PAGE = 200;

// Keeps disk use bounded under retention KEEP: the files of the newest
// retention_keep_count SENT captures stay, older sent files go. Rows are never touched —
// SENT rows are the audit trail (see Capture.entity.ts).
@Service()
export class RetentionService {
    constructor(
        @Inject(CONFIG) private readonly config: GatewayConfig,
        @Inject(LOGGER) private readonly logger: Logger,
        private readonly captureRepository: CaptureRepository,
        private readonly storage: LocalDiskStorage,
    ) {}

    // 'incremental' looks at one page past the window (after each send). 'full' walks
    // every row past it (at boot), so a box that ran with unbounded KEEP before this
    // release is brought down to the window on its first start.
    async prune(scope: 'incremental' | 'full'): Promise<{ removed: number }> {
        if (this.config.retention !== 'KEEP') return { removed: 0 };

        let removed = 0;
        let offset = this.config.retention_keep_count;
        for (;;) {
            const rows = await this.captureRepository.findSentBeyond(offset, PAGE);
            for (const row of rows) {
                if (!(await this.storage.exists(row.dicom_path))) continue;
                try {
                    await this.storage.remove(row.dicom_path);
                    removed++;
                } catch (err) {
                    // A path under storage_root, never patient data.
                    this.logger.error(`retention: could not remove the file of capture ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            if (scope === 'incremental' || rows.length < PAGE) break;
            offset += PAGE;
        }

        if (removed > 0) {
            this.logger.info(`retention: removed ${removed} sent file(s) beyond the last ${this.config.retention_keep_count}`);
        }
        return { removed };
    }
}
