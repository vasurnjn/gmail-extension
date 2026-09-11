import { describe, it, expect, beforeEach } from 'vitest';
import { storage } from '../src/shared/storage';
import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS } from '../src/shared/constants';

describe('Storage Module', () => {
  beforeEach(async () => {
    await storage.clearAll();
  });

  it('returns default settings when storage is empty', async () => {
    const settings = await storage.getSettings();
    expect(settings.alertThreshold).toBe(DEFAULT_SETTINGS.alertThreshold);
    expect(settings.pollingIntervalMinutes).toBe(DEFAULT_SETTINGS.pollingIntervalMinutes);
    expect(settings.showBadge).toBe(true);
  });

  it('updates and persists settings changes', async () => {
    await storage.setSettings({ alertThreshold: 75, showBadge: false });
    const updated = await storage.getSettings();
    expect(updated.alertThreshold).toBe(75);
    expect(updated.showBadge).toBe(false);
    expect(updated.pollingIntervalMinutes).toBe(DEFAULT_SETTINGS.pollingIntervalMinutes);
  });

  it('returns default categories including top 3 priority categories', async () => {
    const categories = await storage.getCategories();
    expect(categories.length).toBe(DEFAULT_CATEGORIES.length);

    const careerCat = categories.find((c) => c.id === 'career_placement');
    const financeCat = categories.find((c) => c.id === 'finance_banking');
    const academicCat = categories.find((c) => c.id === 'academic_education');

    expect(careerCat).toBeDefined();
    expect(careerCat?.defaultPriority).toBe('high');
    expect(financeCat).toBeDefined();
    expect(academicCat).toBeDefined();
  });

  it('updates sync state', async () => {
    const defaultSync = await storage.getSyncState();
    expect(defaultSync.authState).toBe('not_connected');

    const now = Date.now();
    await storage.setSyncState({
      historyId: 'test_history_123',
      lastPollTime: now,
      authState: 'connected',
      accountEmail: 'test@gmail.com',
    });

    const syncState = await storage.getSyncState();
    expect(syncState.historyId).toBe('test_history_123');
    expect(syncState.lastPollTime).toBe(now);
    expect(syncState.authState).toBe('connected');
    expect(syncState.accountEmail).toBe('test@gmail.com');
  });

  it('handles session storage items correctly', async () => {
    await storage.setSessionItem('testKey', { foo: 'bar' });
    const retrieved = await storage.getSessionItem<{ foo: string }>('testKey');
    expect(retrieved).toEqual({ foo: 'bar' });
  });
});
