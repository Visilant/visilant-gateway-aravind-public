import { createHash } from 'crypto';
import { Inject, Service } from 'typedi';
import { GatewayConfig } from '../../config';
import { SettingRepository } from '../../infrastructure/database/repositories';
import { CONFIG } from '../../tokens';
import { WorklistFiltersDto, SaveWorklistFiltersDto } from '../dto/worklist-diagnostics.dto';

const KEY = 'worklist.filters.v1';
const KEYS = ['requested_procedure_id', 'modality', 'scheduled_station_ae'] as const;
export class StaleWorklistSettingsError extends Error {
    constructor() { super('Worklist settings changed. Reload this page before saving.'); }
}

export function worklistFilters(node: Partial<WorklistFiltersDto>): WorklistFiltersDto {
    return Object.fromEntries(KEYS.map(key => [key, node[key] ?? ''])) as unknown as WorklistFiltersDto;
}

@Service()
export class WorklistSettingsService {
    private readonly defaults: WorklistFiltersDto;
    private overridden = false;
    private transition: Promise<unknown> = Promise.resolve();
    constructor(@Inject(CONFIG) private readonly config: GatewayConfig, private readonly repository: SettingRepository) {
        this.defaults = worklistFilters(config.mwl ?? {});
    }
    snapshot() {
        const filters = worklistFilters(this.config.mwl);
        const revision = createHash('sha256').update(JSON.stringify([filters, this.overridden])).digest('hex');
        return { filters, defaults: this.defaults, revision, source: this.overridden ? 'operator' : 'config_file' };
    }
    async restoreAtBoot(): Promise<void> {
        const saved = await this.repository.get(KEY);
        if (!saved || saved === 'null') return;
        let value: unknown;
        try { value = JSON.parse(saved); } catch { throw new Error('Saved worklist filters are invalid. Ask support to repair the worklist.filters.v1 setting.'); }
        // Fail closed on damaged saved settings instead of unexpectedly broadening the worklist.
        if (!value || typeof value !== 'object' || Array.isArray(value) ||
            Object.keys(value).length !== KEYS.length || KEYS.some(key =>
                typeof (value as Record<string, unknown>)[key] !== 'string' ||
                !/^[\x20-\x7e]{0,16}$/.test((value as Record<string, string>)[key]))) {
            throw new Error('Saved worklist filters are invalid. Ask support to repair the worklist.filters.v1 setting.');
        }
        this.apply(value as WorklistFiltersDto, true);
    }
    save(input: SaveWorklistFiltersDto, reset = false) {
        const result = this.transition.then(async () => {
            if (input.revision !== this.snapshot().revision) throw new StaleWorklistSettingsError();
            const filters = reset ? this.defaults : worklistFilters(input);
            const normalized = reset ? filters : Object.fromEntries(KEYS.map(key => [key, filters[key].trim()])) as unknown as WorklistFiltersDto;
            await this.repository.set(KEY, JSON.stringify(reset ? null : normalized));
            this.apply(normalized, !reset);
            return this.snapshot();
        });
        this.transition = result.catch(() => undefined);
        return result;
    }
    private apply(filters: WorklistFiltersDto, overridden: boolean) {
        const node = { ...this.config.mwl };
        for (const key of KEYS) { if (filters[key]) node[key] = filters[key]; else delete node[key]; }
        // One replacement: in-flight requests retain their original snapshot.
        this.config.mwl = node;
        this.overridden = overridden;
    }
}
