import 'reflect-metadata';

// Tests must never pick up a developer .env pointing at the main database.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'warn';
