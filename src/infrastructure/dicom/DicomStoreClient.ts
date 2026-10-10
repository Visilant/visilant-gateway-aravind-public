import { Inject, Service } from 'typedi';
import type { DicomNodeConfig } from '../../config';
import { LOGGER } from '../../tokens';
import type { Logger } from '../logger';
import { DicomClient } from './DicomClient';
import { BIN, NETWORK_TIMEOUT_MS } from './dicom.constants';

// Pushes a finished DICOM object to the archive over C-STORE.
@Service()
export class DicomStoreClient extends DicomClient {
    constructor(@Inject(LOGGER) logger: Logger) {
        super(logger);
    }

    async store(dicomPath: string, node: DicomNodeConfig): Promise<void> {
        // -xy proposes JPEG Baseline as the transfer syntax. Without it storescu only
        // offers uncompressed syntaxes, then tries to transcode the encapsulated JPEG
        // pixel data and fails.
        await this.run(
            BIN.storescu,
            [node.host, String(node.port), '-aec', node.called_ae, '-aet', node.calling_ae, '-xy', dicomPath],
            'C-STORE',
            NETWORK_TIMEOUT_MS
        );
    }
}
