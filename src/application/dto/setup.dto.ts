import { IsBoolean, IsDefined } from 'class-validator';

// Operator attestations for the final setup test. Each must be sent explicitly: an
// absent field is a validation error, never an implicit "true".
export class SetupCompleteDto {
    @IsDefined()
    @IsBoolean()
    synthetic!: boolean;

    @IsDefined()
    @IsBoolean()
    viewer!: boolean;

    @IsDefined()
    @IsBoolean()
    startup!: boolean;
}
