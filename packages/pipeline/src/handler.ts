import { constantTimeEqual, silentLogger } from '@meetlou/domain';
import type { Logger } from '@meetlou/domain';
import { processPending } from './process.ts';
import type { PipelineDeps } from './process.ts';

/**
 * The job runner: POST with the service role key as a bearer token (what a scheduled call from
 * the database or an operator holds), and it works through a bounded number of queued
 * recordings. It is not a webhook and nothing public reaches it. The platform also verifies the
 * JWT; checking the key here as well keeps a local or misconfigured deployment closed.
 */
export function createProcessingHandler(options: {
  deps: PipelineDeps;
  serviceRoleKey: string;
  batchSize?: number;
  logger?: Logger;
}): (request: Request) => Promise<Response> {
  const logger = options.logger ?? silentLogger;
  const batchSize = options.batchSize ?? 3;
  return async (request) => {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    const presented = request.headers.get('authorization') ?? '';
    if (!(await constantTimeEqual(presented, `Bearer ${options.serviceRoleKey}`))) {
      logger.info('pipeline', {
        route: 'process-recordings',
        outcome: 'unauthorised',
        status: 401,
      });
      return new Response('Unauthorized', { status: 401 });
    }
    const result = await processPending(options.deps, batchSize);
    logger.info('pipeline', { route: 'process-recordings', outcome: 'swept', status: 200 });
    return Response.json(result);
  };
}
