import { profile } from '../diagnostics';
import { promises as fs } from 'fs';
import path from 'path';
import { Inject, Service } from 'typedi';
import type { GatewayConfig } from '../../config';
import { CONFIG } from '../../tokens';

// Files waiting to be sent, under config.storage_root.
//
// Object keys are relative throughout — the database stores a key, never an absolute
// path, so the storage root can move between installs without rewriting rows.
@Service()
export class LocalDiskStorage {
    private readonly root: string;

    constructor(@Inject(CONFIG) config: GatewayConfig) {
        this.root = path.resolve(config.storage_root);
    }

    // Confined to the storage root: a key containing "../" that would escape it is
    // rejected rather than resolved.
    absolutePath(objectKey: string): string {
        const target = path.resolve(this.root, objectKey);
        if (target !== this.root && !target.startsWith(this.root + path.sep)) {
            throw new Error('resolved object path escapes the storage root');
        }
        return target;
    }

    @profile('storage.ensureDirectory')
    async ensureDirectory(objectKey: string): Promise<string> {
        const target = this.absolutePath(objectKey);
        await fs.mkdir(path.dirname(target), { recursive: true });
        return target;
    }

    @profile('storage.remove')
    async remove(objectKey: string): Promise<void> {
        await fs.rm(this.absolutePath(objectKey), { force: true });
    }

    @profile('storage.exists')
    async exists(objectKey: string): Promise<boolean> {
        try {
            await fs.access(this.absolutePath(objectKey));
            return true;
        } catch {
            return false;
        }
    }
}
