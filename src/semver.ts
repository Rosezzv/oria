
export type UpdateChannel = 'stable' | 'preview';

export interface ParsedSemVer {
  raw: string;
  canonical: string;
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease: readonly (bigint | string)[];
  build: readonly string[];
}

export interface OfficialReleaseRecord {
  tag: string;
  version: string;
  prerelease: boolean;
  channel: UpdateChannel;
  published_at?: string;
  release_url: string;
}

const numericId = /^(?:0|[1-9]\d*)$/;
const prereleaseId = /^[0-9A-Za-z-]+$/;
const buildId = /^[0-9A-Za-z-]+$/;
const strictIsoDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const officialTagUrlPrefix = 'https://github.com/Rosezzv/oria/releases/tag/';
const previewTrains = new Set(['alpha', 'beta', 'rc']);

export function normalizeStrictIsoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !strictIsoDate.test(value)) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

export function parseSemVer(raw: string, options: { allowVPrefix?: boolean } = {}): ParsedSemVer | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128 || trimmed !== raw) return null;

  let body = trimmed;
  if (body.startsWith('v')) {
    if (!options.allowVPrefix) return null;
    body = body.slice(1);
  }
  if (!body) return null;

  let buildPart: string | undefined;
  const plusIndex = body.indexOf('+');
  if (plusIndex !== -1) {
    buildPart = body.slice(plusIndex + 1);
    body = body.slice(0, plusIndex);
    if (!buildPart || buildPart.includes('+')) return null;
  }

  let prePart: string | undefined;
  const dashIndex = body.indexOf('-');
  if (dashIndex !== -1) {
    prePart = body.slice(dashIndex + 1);
    body = body.slice(0, dashIndex);
    if (!prePart) return null;
  }

  const core = body.split('.');
  if (core.length !== 3) return null;
  const [majorStr, minorStr, patchStr] = core as [string, string, string];
  if (!numericId.test(majorStr) || !numericId.test(minorStr) || !numericId.test(patchStr)) return null;

  const major = BigInt(majorStr);
  const minor = BigInt(minorStr);
  const patch = BigInt(patchStr);

  const prerelease: (bigint | string)[] = [];
  if (prePart !== undefined) {
    for (const part of prePart.split('.')) {
      if (!part || !prereleaseId.test(part)) return null;
      if (/^\d+$/.test(part)) {
        if (!numericId.test(part)) return null; // SemVer 2.0.0 §9 forbids leading zeros on numeric prerelease IDs.
        prerelease.push(BigInt(part));
      } else {
        prerelease.push(part);
      }
    }
  }

  const build: string[] = [];
  if (buildPart !== undefined) {
    for (const part of buildPart.split('.')) {
      if (!part || !buildId.test(part)) return null;
      build.push(part);
    }
  }

  const canonical = `${major.toString()}.${minor.toString()}.${patch.toString()}` +
    (prerelease.length ? '-' + prerelease.map(id => id.toString()).join('.') : '');

  return { raw, canonical, major, minor, patch, prerelease, build };
}

export function compareSemVer(left: ParsedSemVer, right: ParsedSemVer): number {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;

  const lPre = left.prerelease;
  const rPre = right.prerelease;
  if (lPre.length === 0 && rPre.length === 0) return 0;
  if (lPre.length === 0) return 1;
  if (rPre.length === 0) return -1;

  const len = Math.min(lPre.length, rPre.length);
  for (let i = 0; i < len; i++) {
    const a = lPre[i]!;
    const b = rPre[i]!;
    if (a === b) continue;
    const aNum = typeof a === 'bigint';
    const bNum = typeof b === 'bigint';
    if (aNum && bNum) return a < b ? -1 : 1;
    if (aNum && !bNum) return -1; // SemVer 2.0.0 §11.4.3: numeric < non-numeric.
    if (!aNum && bNum) return 1;
    return (a as string) < (b as string) ? -1 : 1;
  }
  if (lPre.length === rPre.length) return 0;
  return lPre.length < rPre.length ? -1 : 1;
}

export function defaultChannelForVersion(version: string): UpdateChannel {
  const parsed = parseSemVer(version, { allowVPrefix: true });
  return parsed && parsed.prerelease.length > 0 ? 'preview' : 'stable';
}

export interface ReleaseClassification {
  effectivePrerelease: boolean;
  effectiveChannel: UpdateChannel;
  eligibleChannels: readonly UpdateChannel[];
}

export function classifyRelease(
  parsed: ParsedSemVer,
  githubPrereleaseFlag?: boolean,
): ReleaseClassification {
  if (parsed.prerelease.length === 0) {
    if (githubPrereleaseFlag === true) {
      // GitHub marked a non-prerelease tag as pre-release: keep it out of stable channel.
      return { effectivePrerelease: true, effectiveChannel: 'preview', eligibleChannels: ['preview'] };
    }
    return { effectivePrerelease: false, effectiveChannel: 'stable', eligibleChannels: ['stable', 'preview'] };
  }
  const train = String(parsed.prerelease[0]).toLowerCase();
  if (!previewTrains.has(train)) {
    return { effectivePrerelease: true, effectiveChannel: 'preview', eligibleChannels: [] };
  }
  // SemVer prereleases are never eligible for stable even if GitHub prerelease flag is false.
  return { effectivePrerelease: true, effectiveChannel: 'preview', eligibleChannels: ['preview'] };
}

export function officialReleaseUrl(tag: string): string {
  return officialTagUrlPrefix + encodeURIComponent(tag);
}

export function normalizeGitHubRelease(raw: unknown): OfficialReleaseRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  if (item.draft === true) return null;
  if (typeof item.tag_name !== 'string') return null;
  const parsed = parseSemVer(item.tag_name, { allowVPrefix: true });
  if (!parsed) return null;
  // Require canonical tag form without build metadata so Git tags stay unambiguous.
  if (parsed.build.length > 0) return null;

  const githubPrerelease = item.prerelease === true;
  const classification = classifyRelease(parsed, githubPrerelease);
  if (classification.eligibleChannels.length === 0) return null;

  return {
    tag: item.tag_name,
    version: parsed.canonical,
    prerelease: classification.effectivePrerelease,
    channel: classification.effectiveChannel,
    published_at: normalizeStrictIsoDate(item.published_at),
    // Always regenerate canonical official release URL from the validated tag.
    release_url: officialReleaseUrl(item.tag_name),
  };
}

export function hasEligibleRelease(
  releases: readonly OfficialReleaseRecord[],
  channel: UpdateChannel,
): boolean {
  for (const record of releases) {
    const parsed = parseSemVer(record.tag, { allowVPrefix: true });
    if (!parsed || parsed.canonical !== record.version) continue;
    if (classifyRelease(parsed, record.prerelease).eligibleChannels.includes(channel)) return true;
  }
  return false;
}

export function selectBestUpdate(
  currentVersion: string,
  releases: readonly OfficialReleaseRecord[],
  channel: UpdateChannel,
): OfficialReleaseRecord | null {
  const current = parseSemVer(currentVersion, { allowVPrefix: true });
  if (!current) return null;

  let best: { record: OfficialReleaseRecord; parsed: ParsedSemVer } | null = null;
  for (const record of releases) {
    const parsed = parseSemVer(record.tag, { allowVPrefix: true });
    if (!parsed || parsed.canonical !== record.version) continue;
    const classification = classifyRelease(parsed, record.prerelease);
    if (!classification.eligibleChannels.includes(channel)) continue;
    if (compareSemVer(parsed, current) <= 0) continue;
    if (!best || compareSemVer(parsed, best.parsed) > 0) {
      best = { record, parsed };
    }
  }
  return best?.record ?? null;
}
