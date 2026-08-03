import type { Route } from './types.ts';

/**
 * A big site is not a big design. 312 pages of a marketing site is usually
 * ~11 layouts plus 186 blog posts that share one. Shooting twenty arbitrary
 * pages is an apology; shooting one page per layout is a truer picture of
 * the site than all 312 tiles would be — and it costs nothing, because the
 * grouping is derived from the URLs before a browser ever opens.
 */

export interface RouteGroup {
  /** `/blog/:slug`, or the literal path when the group has one member. */
  pattern: string;
  /** The page actually shot to stand for this group. */
  representative: Route;
  members: Route[];
}

/** A segment is variable when enough siblings differ at that position. */
const MIN_SIBLINGS_TO_COLLAPSE = 3;

function segmentsOf(path: string): string[] {
  return path === '/' ? [] : path.replace(/^\//, '').split('/');
}

function placeholderFor(values: string[]): string {
  // Date-shaped before merely numeric: 2021/2022/2023 is an archive, not an id.
  if (values.every((v) => /^\d{4}(-\d{2})?$/.test(v))) return ':date';
  if (values.every((v) => /^\d+$/.test(v))) return ':id';
  return ':slug';
}

/**
 * Rewrite paths into patterns by finding positions where siblings sharing a
 * prefix take many different values. `/blog/a`, `/blog/b`, `/blog/c` all
 * become `/blog/:slug`; `/about` stays `/about`.
 */
export function patternOf(path: string, allPaths: string[]): string {
  const segs = segmentsOf(path);
  if (segs.length === 0) return '/';

  const out: string[] = [];
  for (let depth = 0; depth < segs.length; depth++) {
    const prefix = out.join('/');
    // Siblings: same depth, and same (already-generalized) prefix.
    const siblings = new Set<string>();
    for (const other of allPaths) {
      const otherSegs = segmentsOf(other);
      if (otherSegs.length !== segs.length) continue;
      const otherPrefix = otherSegs
        .slice(0, depth)
        .map((seg, i) => (out[i]!.startsWith(':') ? seg : out[i]!))
        .join('/');
      const matchesPrefix = out.every((token, i) => token.startsWith(':') || token === otherSegs[i]);
      if (!matchesPrefix || otherPrefix.length === 0 !== (prefix.length === 0)) continue;
      siblings.add(otherSegs[depth]!);
    }
    // Never collapse the first segment. /about, /pricing, /contact are the
    // site's main sections — four distinct designs, not a template. Real
    // templates live deeper, under a section that names them.
    const collapsible = depth > 0 && siblings.size >= MIN_SIBLINGS_TO_COLLAPSE;
    out.push(collapsible ? placeholderFor([...siblings]) : segs[depth]!);
  }
  return `/${out.join('/')}`;
}

/** The page that best stands for a group: shortest, then alphabetical. */
function pickRepresentative(members: Route[]): Route {
  return [...members].sort(
    (a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path, undefined, { numeric: true }),
  )[0]!;
}

/**
 * Collapse routes into layout groups. Groups smaller than
 * MIN_SIBLINGS_TO_COLLAPSE keep every member as its own group, because
 * collapsing two pages saves nothing and hides one of them.
 */
export function groupRoutes(routes: Route[]): RouteGroup[] {
  const allPaths = routes.map((r) => r.path);
  const byPattern = new Map<string, Route[]>();
  for (const route of routes) {
    const pattern = patternOf(route.path, allPaths);
    const list = byPattern.get(pattern);
    if (list) list.push(route);
    else byPattern.set(pattern, [route]);
  }

  const groups: RouteGroup[] = [];
  for (const [pattern, members] of byPattern) {
    if (members.length < MIN_SIBLINGS_TO_COLLAPSE && pattern.includes(':')) {
      // Not enough evidence that this is a template — keep them separate.
      for (const member of members) {
        groups.push({ pattern: member.path, representative: member, members: [member] });
      }
      continue;
    }
    groups.push({ pattern, representative: pickRepresentative(members), members });
  }

  // Shallow first, then the biggest families, then alphabetically.
  return groups.sort((a, b) => {
    const depth = (p: string): number => (p === '/' ? 0 : p.split('/').length - 1);
    return (
      depth(a.pattern) - depth(b.pattern) ||
      b.members.length - a.members.length ||
      a.pattern.localeCompare(b.pattern, undefined, { numeric: true })
    );
  });
}

/** Groups that stand for more than one page — the site's real templates. */
export function families(groups: RouteGroup[]): RouteGroup[] {
  return groups.filter((g) => g.members.length > 1);
}

/** Turn a glob like `/blog/*` or `/docs/**` into a matcher. */
export function globToRegex(glob: string): RegExp {
  const source = glob
    .split(/(\*\*|\*)/)
    .map((part) => {
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      return part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${source}/?$`);
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegex(g).test(path));
}
