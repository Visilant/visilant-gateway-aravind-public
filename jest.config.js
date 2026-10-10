/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/src', '<rootDir>/tests'],
    testMatch: ['**/*.test.ts'],
    clearMocks: true,
    // Decorator metadata is read at module load, so this has to be in place before any
    // entity, DTO or @Service class is imported.
    setupFiles: ['reflect-metadata'],
};
