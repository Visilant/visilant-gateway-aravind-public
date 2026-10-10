import { HttpError } from 'routing-controllers';
import { ErrorHandlerMiddleware } from '../src/presentation/middlewares/error-handler.middleware';

test.each([
    [502, 'pixel data not encapsulated JPEG', 'pixel data not encapsulated JPEG'],
    [502, 'DICOM JSON could not be parsed', 'DICOM JSON could not be parsed'],
    [500, 'recording could not be started; see the gateway log', 'recording could not be started; see the gateway log'],
    [500, 'unexpected sensitive payload', 'internal error'],
])('returns only fixed public server errors (%i)', (code, message, expected) => {
    const json = jest.fn(), status = jest.fn().mockReturnValue({ json });
    const handler = new ErrorHandlerMiddleware({ error: jest.fn() } as never);
    handler.error(new HttpError(code, message), { method: 'GET', path: '/captures/id/tags' } as never, { status } as never, jest.fn());
    expect(status).toHaveBeenCalledWith(code); expect(json).toHaveBeenCalledWith({ error: expected });
});
