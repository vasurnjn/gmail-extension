import {
  GMAIL_HISTORY_ENDPOINT,
  GMAIL_MESSAGES_ENDPOINT,
  GMAIL_PROFILE_ENDPOINT,
} from '../../shared/constants';
import { getAuthToken, removeCachedAuthToken } from './auth';
import { GmailRawMessage } from './parser';

export class GmailAuthError extends Error {
  constructor(message = 'Gmail authentication failed or token expired (401).') {
    super(message);
    this.name = 'GmailAuthError';
  }
}

export class GmailNotFoundError extends Error {
  constructor(message = 'Requested Gmail resource was not found (404).') {
    super(message);
    this.name = 'GmailNotFoundError';
  }
}

export class GmailRateLimitError extends Error {
  constructor(message = 'Gmail API rate limit exceeded (429/403).') {
    super(message);
    this.name = 'GmailRateLimitError';
  }
}

export class GmailApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(`Gmail API error (${status}): ${message}`);
    this.name = 'GmailApiError';
    this.status = status;
  }
}

export interface ListMessagesResponse {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface HistoryMessageAdded {
  message: {
    id: string;
    threadId: string;
    labelIds?: string[];
  };
}

export interface HistoryRecord {
  id: string;
  messages?: Array<{ id: string; threadId: string }>;
  messagesAdded?: HistoryMessageAdded[];
  messagesDeleted?: Array<{ message: { id: string } }>;
  labelsAdded?: unknown[];
  labelsRemoved?: unknown[];
}

export interface ListHistoryResponse {
  history?: HistoryRecord[];
  nextPageToken?: string;
  historyId?: string;
}

export interface GmailProfileResponse {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}

/**
 * Authenticated fetch helper for Gmail REST API endpoints.
 * Automatically manages Bearer token injection and handles 401 token invalidation.
 */
async function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
  const token = await getAuthToken(false);

  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('Accept', 'application/json');

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    await removeCachedAuthToken(token);
    throw new GmailAuthError();
  }

  if (response.status === 404) {
    throw new GmailNotFoundError();
  }

  if (response.status === 429 || (response.status === 403 && response.statusText.includes('Rate'))) {
    throw new GmailRateLimitError();
  }

  if (!response.ok) {
    let errorDetail = response.statusText;
    try {
      const errJson = await response.json();
      errorDetail = errJson.error?.message || response.statusText;
    } catch {
      // Ignore JSON parse error and fallback to statusText
    }
    throw new GmailApiError(response.status, errorDetail);
  }

  return response;
}

export const gmailClient = {
  /**
   * Retrieves user's Gmail profile containing current historyId.
   */
  async getProfile(): Promise<GmailProfileResponse> {
    const response = await fetchWithAuth(GMAIL_PROFILE_ENDPOINT);
    return response.json();
  },

  /**
   * Lists message IDs matching an optional query filter.
   */
  async listMessages(options: {
    q?: string;
    maxResults?: number;
    pageToken?: string;
    labelIds?: string[];
  } = {}): Promise<ListMessagesResponse> {
    const params = new URLSearchParams();
    if (options.q) params.set('q', options.q);
    if (options.maxResults) params.set('maxResults', options.maxResults.toString());
    if (options.pageToken) params.set('pageToken', options.pageToken);
    if (options.labelIds && options.labelIds.length > 0) {
      for (const label of options.labelIds) {
        params.append('labelIds', label);
      }
    }

    const url = `${GMAIL_MESSAGES_ENDPOINT}?${params.toString()}`;
    const response = await fetchWithAuth(url);
    return response.json();
  },

  /**
   * Fetches full message payload for a given message ID.
   */
  async getMessage(id: string, format = 'full'): Promise<GmailRawMessage> {
    const url = `${GMAIL_MESSAGES_ENDPOINT}/${encodeURIComponent(id)}?format=${encodeURIComponent(format)}`;
    const response = await fetchWithAuth(url);
    return response.json();
  },

  /**
   * Fetches history records since startHistoryId for incremental synchronization.
   */
  async listHistory(options: {
    startHistoryId: string;
    historyTypes?: string;
    maxResults?: number;
    pageToken?: string;
    labelId?: string;
  }): Promise<ListHistoryResponse> {
    const params = new URLSearchParams();
    params.set('startHistoryId', options.startHistoryId);
    if (options.historyTypes) params.set('historyTypes', options.historyTypes);
    if (options.maxResults) params.set('maxResults', options.maxResults.toString());
    if (options.pageToken) params.set('pageToken', options.pageToken);
    if (options.labelId) params.set('labelId', options.labelId);

    const url = `${GMAIL_HISTORY_ENDPOINT}?${params.toString()}`;
    const response = await fetchWithAuth(url);
    return response.json();
  },
};
