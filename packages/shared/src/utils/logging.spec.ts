import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger } from './logging.js';

describe('createLogger', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('creates a logger with service name', () => {
    const logger = createLogger('test-service');
    
    logger.info('test message');
    
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('"service":"test-service"')
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('"level":"info"')
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('"message":"test message"')
    );
  });

  it('includes context in logs', () => {
    const logger = createLogger('test-service', {
      projectId: 'proj-123',
      waveNumber: 1,
      artifactId: 'art-456'
    });
    
    logger.info('test message');
    
    const logCall = consoleSpy.mock.calls[0][0];
    const logData = JSON.parse(logCall);
    
    expect(logData.projectId).toBe('proj-123');
    expect(logData.waveNumber).toBe(1);
    expect(logData.artifactId).toBe('art-456');
  });

  it('logs info messages', () => {
    const logger = createLogger('test-service');
    
    logger.info('info message', { extra: 'data' });
    
    const logCall = consoleSpy.mock.calls[0][0];
    const logData = JSON.parse(logCall);
    
    expect(logData.level).toBe('info');
    expect(logData.message).toBe('info message');
    expect(logData.extra).toBe('data');
  });

  it('logs warn messages', () => {
    const logger = createLogger('test-service');
    
    logger.warn('warning message', { extra: 'data' });
    
    const logCall = consoleSpy.mock.calls[0][0];
    const logData = JSON.parse(logCall);
    
    expect(logData.level).toBe('warn');
    expect(logData.message).toBe('warning message');
    expect(logData.extra).toBe('data');
  });

  it('logs error messages with error objects', () => {
    const logger = createLogger('test-service');
    const error = new Error('test error');
    
    logger.error('error message', error, { extra: 'data' });
    
    const logCall = consoleSpy.mock.calls[0][0];
    const logData = JSON.parse(logCall);
    
    expect(logData.level).toBe('error');
    expect(logData.message).toBe('error message');
    expect(logData.error.name).toBe('Error');
    expect(logData.error.message).toBe('test error');
    expect(logData.error.stack).toBeDefined();
    expect(logData.extra).toBe('data');
  });

  it('logs error messages without error objects', () => {
    const logger = createLogger('test-service');
    
    logger.error('error message', undefined, { extra: 'data' });
    
    const logCall = consoleSpy.mock.calls[0][0];
    const logData = JSON.parse(logCall);
    
    expect(logData.level).toBe('error');
    expect(logData.message).toBe('error message');
    expect(logData.error).toBeUndefined();
    expect(logData.extra).toBe('data');
  });

  it('includes timestamp in logs', () => {
    const logger = createLogger('test-service');
    
    logger.info('test message');
    
    const logCall = consoleSpy.mock.calls[0][0];
    const logData = JSON.parse(logCall);
    
    expect(logData.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});