import type { DiagnosticRecorder } from './infrastructure/diagnostics';
import { Token } from 'typedi';
import type { DataSource } from 'typeorm';
import type { GatewayConfig } from './config';
import type { Logger } from './infrastructure/logger';

// Values that are constructed during bootstrap rather than by the container: they need
// a config file, a filesystem, and an open database before they exist. Classes are
// injected by type; these are injected by token.
export const CONFIG = new Token<GatewayConfig>('config');
export const LOGGER = new Token<Logger>('logger');
export const DATABASE = new Token<DataSource>('database');
export const RECORDER = new Token<DiagnosticRecorder>('recorder');
