import { Authorized, BadRequestError, Body, CurrentUser, Get, HttpError, JsonController, NotFoundError, Param, Post, QueryParams } from 'routing-controllers';
import { Service } from 'typedi';
import { RegisterScreeningDto, ReleaseScreeningDto, ScreeningListQueryDto } from '../../application/dto/screening.dto';
import { UserEntity } from '../../infrastructure/database';
import {
    CaptureScreeningMismatchError, ScreeningConflictError, ScreeningNotFoundError, ScreeningService,
} from '../../application/services/ScreeningService';

// Maps screening domain errors to HTTP. Shared with the capture upload route.
export function mapScreeningError(err: unknown): unknown {
    if (err instanceof ScreeningConflictError) return new HttpError(409, err.message);
    if (err instanceof ScreeningNotFoundError) return new NotFoundError(err.message);
    if (err instanceof CaptureScreeningMismatchError) return new BadRequestError(err.message);
    return err;
}

@JsonController('/screenings')
@Authorized()
@Service()
export class ScreeningController {
    constructor(private readonly service: ScreeningService) {}

    @Get('/capabilities')
    capabilities() { return this.service.capability(); }

    @Post('/')
    async register(@Body() input: RegisterScreeningDto) {
        try { return await this.service.register(input); } catch (err) { throw mapScreeningError(err); }
    }

    @Get('/')
    list(@QueryParams() query: ScreeningListQueryDto) {
        return query.view === 'unfinished' ? this.service.listUnfinished() : this.service.list(query.view === 'all');
    }

    @Get('/:id')
    async status(@Param('id') id: string) {
        try { return await this.service.status(id); } catch (err) { throw mapScreeningError(err); }
    }

    // Any signed-in user may release; the row records who did.
    @Post('/:id/release')
    async release(@Param('id') id: string, @Body() input: ReleaseScreeningDto, @CurrentUser() user: UserEntity) {
        try { return await this.service.release(id, user.id, input.reason); } catch (err) { throw mapScreeningError(err); }
    }
}
