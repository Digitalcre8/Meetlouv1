import { z } from 'zod';

const voiceEnv = z.object({
  TWILIO_AUTH_TOKEN: z.string().min(16),
  /** The public URL of the function as Twilio calls it, e.g. https://<ref>.supabase.co/functions/v1/twilio-voice */
  TWILIO_VOICE_BASE_URL: z.url().refine((u) => !u.endsWith('/') && !u.includes('?'), {
    message: 'no trailing slash and no query string',
  }),
});

export interface VoiceConfig {
  authToken: string;
  baseUrl: string;
}

/** Names of the settings that are missing or malformed. Never their values. */
export function readVoiceConfig(
  get: (name: string) => string | undefined,
): { ok: true; value: VoiceConfig } | { ok: false; invalid: string[] } {
  const parsed = voiceEnv.safeParse({
    TWILIO_AUTH_TOKEN: get('TWILIO_AUTH_TOKEN'),
    TWILIO_VOICE_BASE_URL: get('TWILIO_VOICE_BASE_URL'),
  });
  if (!parsed.success) {
    return { ok: false, invalid: parsed.error.issues.map((i) => String(i.path[0])) };
  }
  return {
    ok: true,
    value: {
      authToken: parsed.data.TWILIO_AUTH_TOKEN,
      baseUrl: parsed.data.TWILIO_VOICE_BASE_URL,
    },
  };
}
