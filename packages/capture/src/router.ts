import { plain } from './twilio-request.ts';

/**
 * One Supabase function serves every Twilio voice callback. Routing looks only at the last path
 * segment; which URL is authenticated is decided inside each handler from configuration.
 */
export function createTwilioRouter(handlers: {
  voice: (request: Request) => Promise<Response>;
  recordingStatus: (request: Request) => Promise<Response>;
}): (request: Request) => Promise<Response> {
  return (request) => {
    const last = new URL(request.url).pathname.replace(/\/+$/, '').split('/').pop() ?? '';
    if (last === 'recording-status') return handlers.recordingStatus(request);
    return last === '' ? Promise.resolve(plain(404, 'Not Found')) : handlers.voice(request);
  };
}
