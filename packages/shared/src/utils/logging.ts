export interface LoggerInstance {
  info(message: string, data?: object): void;
  warn(message: string, data?: object): void;
  error(message: string, error?: Error, data?: object): void;
}

export function createLogger(
  serviceName: string,
  context: {
    projectId?: string;
    waveNumber?: number;
    artifactId?: string;
  } = {}
): LoggerInstance {
  const baseLog = {
    service: serviceName,
    timestamp: new Date().toISOString(),
    ...context,
  };

  return {
    info(message: string, data?: object): void {
      console.log(JSON.stringify({
        ...baseLog,
        level: 'info',
        message,
        ...data,
      }));
    },

    warn(message: string, data?: object): void {
      console.log(JSON.stringify({
        ...baseLog,
        level: 'warn',
        message,
        ...data,
      }));
    },

    error(message: string, error?: Error, data?: object): void {
      console.log(JSON.stringify({
        ...baseLog,
        level: 'error',
        message,
        error: error ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
        } : undefined,
        ...data,
      }));
    },
  };
}