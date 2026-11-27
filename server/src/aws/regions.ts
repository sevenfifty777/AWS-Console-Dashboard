import type { SessionState } from '../../../shared/types';
import { classifyCliError } from './auth';
import { runAws, type CliTarget, type RunOptions } from './cli';

const CACHE_MS = 10 * 60_000;

/** Regions every account has without opting in. Used when the account's own list cannot be read. */
export const STANDARD_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'ca-central-1',
  'sa-east-1',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-central-1',
  'eu-north-1',
  'ap-south-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-northeast-3',
];

export type RegionList =
  | { ok: true; regions: string[]; standardList: boolean }
  | { ok: false; state: SessionState; message: string };

/** Finds the regions enabled in an account, with a short cache per identity. */
export class RegionService {
  private cache = new Map<string, { at: number; regions: string[] }>();

  /** cacheKey names who is asking (profile and role); options say how to run the CLI as them. */
  async list(cli: CliTarget, cacheKey: string, options: RunOptions): Promise<RegionList> {
    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_MS) return { ok: true, regions: hit.regions, standardList: false };

    const result = await runAws(cli, ['ec2', 'describe-regions', '--query', 'Regions[].RegionName', '--output', 'json'], {
      ...options,
      timeoutMs: 30_000,
    });
    if (result.code === 0) {
      try {
        const regions: unknown = JSON.parse(result.stdout);
        if (Array.isArray(regions) && regions.length > 0 && regions.every((r) => typeof r === 'string')) {
          const sorted = (regions as string[]).sort();
          this.cache.set(cacheKey, { at: Date.now(), regions: sorted });
          return { ok: true, regions: sorted, standardList: false };
        }
      } catch {
        // Fall through to the standard list.
      }
      return { ok: true, regions: STANDARD_REGIONS, standardList: true };
    }
    if (result.timedOut) return { ok: false, state: 'network', message: 'No answer from AWS after 30 seconds' };
    const problem = classifyCliError(result.stderr);
    // Not being allowed to list regions is no reason to give up: try the usual ones.
    if (problem.state === 'access-denied' || problem.state === 'error') return { ok: true, regions: STANDARD_REGIONS, standardList: true };
    return { ok: false, ...problem };
  }
}

/** Runs a task for every item, at most `limit` at a time, keeping the order of the results. */
export async function mapLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
