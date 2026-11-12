/** What the conversation search looks at; persisted as `ui.searchScope`. */
export const SEARCH_SCOPES = ['all', 'names', 'messages'] as const;

export type SearchScope = (typeof SEARCH_SCOPES)[number];

export const DEFAULT_SEARCH_SCOPE: SearchScope = 'all';

export const isSearchScope = (value: unknown): value is SearchScope =>
  typeof value === 'string' && (SEARCH_SCOPES as readonly string[]).includes(value);
