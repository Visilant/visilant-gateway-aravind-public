import { readFileSync } from 'fs';
import path from 'path';
import { plainToInstance } from 'class-transformer';
import { ValidationError, validateSync } from 'class-validator';
import { GatewayConfig } from './config.schema';

export { GatewayConfig, DicomNodeConfig, MwlNodeConfig } from './config.schema';

const DEFAULT_CONFIG_PATH = 'config.json';

// Flattens class-validator's nested error tree into "mwl.called_ae: reason" lines.
// The person reading this is a field engineer with Notepad open, so the path has to
// point at the key they need to fix.
function describeIssues(errors: ValidationError[], prefix = ''): string[] {
    return errors.flatMap((error) => {
        const key = prefix ? `${prefix}.${error.property}` : error.property;
        const own = Object.values(error.constraints ?? {}).map((reason) => `  ${key}: ${reason}`);
        return [...own, ...describeIssues(error.children ?? [], key)];
    });
}

// Connection settings are saved by the first-run wizard or supplied by a field
// engineer. Generated values (including JWT secrets) remain in SQLite.
export function loadConfig(configPath = process.env.GATEWAY_CONFIG ?? DEFAULT_CONFIG_PATH): GatewayConfig {
    const resolved = path.resolve(configPath);

    let raw: string;
    try {
        raw = readFileSync(resolved, 'utf8');
    } catch {
        throw new Error(
            `Could not read gateway config at ${resolved}. ` +
            `Copy config.example.json to config.json, or set GATEWAY_CONFIG to its path.`
        );
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new Error(`Gateway config at ${resolved} is not valid JSON: ${(err as Error).message}`);
    }

    return validateConfig(parsed);
}

export function validateConfig(parsed: unknown): GatewayConfig {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Configuration must be an object.');
    const config = plainToInstance(GatewayConfig, parsed, { exposeDefaultValues: true });

    // whitelist strips unknown keys; forbidNonWhitelisted turns a typo'd key into an
    // error rather than a setting that silently does nothing.
    const errors = validateSync(config, {
        whitelist: true,
        forbidNonWhitelisted: true,
        forbidUnknownValues: true,
        validationError: { target: false, value: false },
    });

    if (errors.length > 0) {
        throw new Error(`Gateway config is invalid:\n${describeIssues(errors).join('\n')}`);
    }

    return config;
}
