import { GatewayConfig } from '../src/config';
import { WorklistSettingsService } from '../src/application/services/WorklistSettingsService';

const config = () => Object.assign(new GatewayConfig(), { mwl: { host: 'synthetic', port: 104, called_ae: 'MWL', calling_ae: 'VISILANT', requested_procedure_id: '*' } });
const filters = { requested_procedure_id: '', modality: '', scheduled_station_ae: 'VISILANT' };

test('saving filters is durable, atomic for readers, and restored before serving after restart', async () => {
    let saved: string | null = null;
    const repository = { get: async () => saved, set: async (_key: string, value: string) => { saved = value; } };
    const settings = config(), originalNode = settings.mwl;
    const service = new WorklistSettingsService(settings, repository as never);
    await service.save({ ...filters, revision: service.snapshot().revision });
    expect(settings.mwl).toEqual({ host: 'synthetic', port: 104, called_ae: 'MWL', calling_ae: 'VISILANT', scheduled_station_ae: 'VISILANT' });
    expect(originalNode.requested_procedure_id).toBe('*');
    const reboot = new WorklistSettingsService(config(), repository as never);
    await reboot.restoreAtBoot();
    expect(reboot.snapshot()).toEqual(service.snapshot());
    await reboot.save({ ...filters, revision: reboot.snapshot().revision }, true);
    expect(reboot.snapshot()).toMatchObject({ source: 'config_file', filters: { requested_procedure_id: '*', scheduled_station_ae: '' } });
    const afterReset = new WorklistSettingsService(config(), repository as never);
    await afterReset.restoreAtBoot();
    expect(afterReset.snapshot().source).toBe('config_file');
});

test('failed persistence leaves live settings unchanged and a later save can succeed', async () => {
    const repository = { set: jest.fn().mockRejectedValueOnce(new Error('disk unavailable')).mockResolvedValue(undefined) };
    const settings = config(), service = new WorklistSettingsService(settings, repository as never);
    const original = service.snapshot();
    await expect(service.save({ ...filters, revision: original.revision })).rejects.toThrow();
    expect(service.snapshot()).toEqual(original);
    await service.save({ ...filters, revision: original.revision });
    expect(settings.mwl.scheduled_station_ae).toBe('VISILANT');
});

test('concurrent edits cannot silently overwrite one another', async () => {
    const repository = { set: jest.fn().mockResolvedValue(undefined) };
    const service = new WorklistSettingsService(config(), repository as never);
    const revision = service.snapshot().revision;
    const results = await Promise.allSettled([
        service.save({ ...filters, revision }), service.save({ ...filters, modality: 'OP', revision }),
    ]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(repository.set).toHaveBeenCalledTimes(1);
});

test.each(['{}', '{"modality":true}', '{"modality":"OP","scheduled_station_ae":"V","requested_procedure_id":"","unknown":"x"}'])('damaged saved settings fail closed: %s', async value => {
    const service = new WorklistSettingsService(config(), { get: async () => value } as never);
    await expect(service.restoreAtBoot()).rejects.toThrow('Saved worklist filters are invalid');
});
