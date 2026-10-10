import type { Action } from 'routing-controllers';
import { Interceptor, InterceptorInterface } from 'routing-controllers';
import { Service } from 'typedi';

// Wraps successful responses as { data: ... }.
//
// The Android app's whole service layer already reads response.data — that is the shape
// visilant_api returns — so matching it means the login screen works untouched and new
// screens follow the pattern the app already has.
//
// /health is exempt: it is consumed by operators and monitoring rather than the app,
// and a probe wants a flat body it can read at a glance.
@Interceptor()
@Service()
export class ResponseEnvelopeInterceptor implements InterceptorInterface {
    intercept(action: Action, content: unknown): unknown {
        if (String(action.request?.path ?? '').startsWith('/health')) return content;
        if (content === undefined || content === null) return content;

        // Already handled by the controller writing to the response itself.
        if (content === action.response || action.response?.headersSent) return content;

        return { data: content };
    }
}
